/**
 * advance.js — the only writer.
 * ScriptLock (10s; retryable "busy" on failure) → reload snapshot → apply the action
 * rows → loop Sched.engine.advance until no transition, committing each step with a
 * rev check → materialise the rescue slate on landing in PIVOT_PENDING → claim the
 * run's outbox rows atomically (pending → executing) → release → execute only the
 * claimed rows. CREATE_EVENT re-verifies under the lock before booking.
 */

function advancePoll(pollId, action) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { busy: true, retryable: true };

  var claimed = [];
  try {
    var snapshot = Store.loadSnapshot(pollId);
    if (!snapshot) return { error: 'not_found' };

    var now = Date.now();

    // Repair a stranded pivot: any entry that finds the poll already in PIVOT_PENDING with
    // no live slate-2 slots (e.g. a crash after the state commit but before the slate was
    // materialised) materialises it now, so the pivot never sits empty forever.
    if (snapshot.poll.state === 'PIVOT_PENDING' && materializeRescueSlate(snapshot, now)) {
      snapshot = Store.loadSnapshot(pollId);
    }

    var rejection = applyAction(snapshot, action);  // validate + persist new rows
    if (rejection) return rejection;                // decision closed / invalid: released in finally
    snapshot = Store.loadSnapshot(pollId);          // reload with the applied rows

    for (var i = 0; i < 30; i++) {
      var res = Sched.engine.advance(snapshot, now);
      var pollPatch = res.pollPatch || {};
      var slotPatches = res.slotPatches || [];
      var effects = res.effects || [];
      var voteRecords = res.voteRecords || [];
      var stateChanged = res.state && res.state !== snapshot.poll.state;
      var patched = stateChanged || Object.keys(pollPatch).length > 0 || slotPatches.length > 0;

      // Commit the poll patch FIRST — it is the rev-checked gate. Only once it lands do we
      // persist the transition's votes and enqueue its effects, so a stale-rev abort leaves
      // no emails queued (and no prefills recorded) for a transition that never committed.
      if (patched) {
        var patch = {};
        Object.keys(pollPatch).forEach(function (k) { patch[k] = pollPatch[k]; });
        if (stateChanged) patch.state = res.state;
        Store.updatePoll(pollId, patch, snapshot.poll.rev);
        Store.applySlotPatches(pollId, slotPatches);
        Store.appendAudit(pollId, 'advance', { to: res.state || snapshot.poll.state });
      }

      if (voteRecords.length) persistVoteRecords(pollId, voteRecords);
      effects.forEach(function (e) { Store.enqueueEffect(pollId, e); });

      if (!patched) break;           // no transition: effects (if any) already queued
      snapshot = Store.loadSnapshot(pollId);

      // The moment the poll lands in PIVOT_PENDING with no slate-2 slots yet, compute
      // and store the rescue slate so the pivot email/page has something to render.
      if (snapshot.poll.state === 'PIVOT_PENDING' && materializeRescueSlate(snapshot, now)) {
        snapshot = Store.loadSnapshot(pollId);
      }
    }

    claimed = Store.claimOutbox(pollId);          // atomic pending -> executing under lock
    if (isTerminal(snapshot.poll.state)) Store.deleteTokens(pollId);
  } catch (e) {
    if (e && e.stale) return { busy: true, retryable: true };
    throw e;
  } finally {
    lock.releaseLock();
  }

  executeClaimed(pollId, claimed);
  return { ok: true };
}

function isTerminal(state) {
  return state === 'BOOKED' || state === 'CANCELLED';
}

/** Persist transition-created votes exactly like action votes. */
function persistVoteRecords(pollId, records) {
  records.forEach(function (r) {
    Store.appendVotes(pollId, r.inviteeId, [{
      slotId: r.slotId, answer: r.answer, provenance: r.provenance
    }]);
  });
}

/**
 * Shell-side rescue-slate computation. Called under the lock when a poll first enters
 * PIVOT_PENDING: fetch the organizer's free windows, score the candidate universe via
 * the core, promote chosen bench slots in place (votes carry) and append the rest as
 * slate-2 slots, and store the ranked runners-up for a Can't-at-launch swap.
 */
function materializeRescueSlate(snapshot, now) {
  var poll = snapshot.poll;
  var hasSlate2 = snapshot.slots.some(function (s) {
    return s.slateVersion === 2 && s.kind !== 'dropped' && s.kind !== 'rejected';
  });
  if (hasSlate2) return false;

  var freeWindows = safe(function () { return Cal.freeWindows(poll); }, []);
  var rescue = safe(function () { return Sched.pivot.rescueSlate(snapshot, freeWindows, now); }, null);
  if (!rescue || !rescue.slots || !rescue.slots.length) return false;

  var slotPatches = [];
  var newSlots = [];
  rescue.slots.forEach(function (entry, idx) {
    if (entry.benchSlotId) {
      slotPatches.push({ slotId: entry.benchSlotId, kind: 'slate2', slateVersion: 2 });
    } else {
      newSlots.push({
        slotId: 'slate2_' + idx + '_' + Date.now(),
        startUtc: entry.startUtc, endUtc: entry.endUtc,
        kind: 'slate2', slateVersion: 2, proposerInviteeId: ''
      });
    }
  });
  // Store the ranked runners-up BEFORE writing any slate-2 row. The hasSlate2 guard above
  // keys off slate-2 slots existing, so if a partial failure interrupted us the alternates
  // must already be committed — otherwise the guard would skip a retry and leave promoted
  // slate rows with their alternates lost. The slot writes are the retryable tail.
  Store.updatePoll(poll.pollId,
    { rescueAlternatesJson: JSON.stringify(rescue.alternates || []) }, poll.rev);
  Store.appendAudit(poll.pollId, 'rescue_slate',
    { slots: rescue.slots.length, alternates: (rescue.alternates || []).length });
  if (slotPatches.length) Store.applySlotPatches(poll.pollId, slotPatches);
  if (newSlots.length) Store.appendSlots(poll.pollId, newSlots);
  return true;
}

/**
 * Translate a web/cron action into appended rows before the advance loop. Returns a
 * rejection `{ rejected: true, reason }` (rendered by the web layer as the decision-closed
 * / not-accepted page) when the action's state/slot preconditions fail under the lock, or
 * null on success. Validation lives here — under the writer lock, against freshly loaded
 * canonical state — so a decision armed against a now-stale page cannot slip through.
 */
function applyAction(snapshot, action) {
  if (!action || action.kind === 'tick') return null;
  var pollId = snapshot.poll.pollId;

  var rejection = validateActionUnderLock(snapshot, action);
  if (rejection) {
    Store.appendAudit(pollId, 'action_rejected', { kind: action.kind, reason: rejection.reason });
    return rejection;
  }

  switch (action.kind) {
    case 'votes':
      Store.appendVotes(pollId, action.inviteeId, action.votes);
      break;
    case 'constraints':
      Store.appendConstraints(pollId, action.inviteeId, action.constraints);
      break;
    case 'bench':
      var benchSlots = action.slots.map(function (s, idx) {
        return {
          slotId: 'bench_' + action.inviteeId + '_' + Date.now() + '_' + idx,
          startUtc: s.startUtc, endUtc: s.endUtc, kind: 'bench',
          slateVersion: snapshot.poll.slateVersion, proposerInviteeId: action.inviteeId
        };
      });
      Store.appendSlots(pollId, benchSlots);
      // proposer's counter-proposal counts as Works on their own slots.
      Store.appendVotes(pollId, action.inviteeId, benchSlots.map(function (s) {
        return { slotId: s.slotId, answer: 'works', provenance: 'proposal' };
      }));
      break;
    case 'organizerLaunch':
      handleOrganizerLaunch(snapshot, action);
      break;
    case 'calendarBusy':
      // A live recheck found the slot busy; recorded as the (required) organizer's
      // Can't so the pure core marks the slot Blocked without calendar access.
      Store.appendVotes(pollId, action.inviteeId, [{
        slotId: action.slotId, answer: 'cant', provenance: 'prefill'
      }]);
      break;
    case 'demoteRequired':
      Store.demoteInvitee(pollId, action.inviteeId);
      break;
    case 'organizerReject':
      // Rejection = the (required) organizer records a Can't on the held slot, which
      // blocks it and forces a recompute on the ensuing advance.
      Store.appendVotes(pollId, action.inviteeId, [{
        slotId: action.slotId, answer: 'cant', provenance: 'explicit_slate'
      }]);
      break;
    case 'organizerApprove':
      // From HOLD: approve the held slot — the engine books immediately on holdApprovedAtUtc.
      // From ESCALATE (book-least-bad lever): put the chosen slot on hold, pre-approved.
      if (snapshot.poll.state === 'HOLD') {
        Store.updatePoll(pollId, { holdApprovedAtUtc: Date.now() }, snapshot.poll.rev);
      } else {
        // ESCALATE "book least-bad": the chosen slot is infeasible by construction, so arm
        // holdForced to skip advanceHold's feasibility gate (the calendar recheck before
        // CREATE_EVENT still applies) — otherwise the slot would bounce back and recompute.
        var nowMs = Date.now();
        Store.updatePoll(pollId, {
          holdSlotId: action.slotId, state: 'HOLD',
          holdStartedAtUtc: nowMs, holdApprovedAtUtc: nowMs, holdForced: true
        }, snapshot.poll.rev);
      }
      snapshot.poll.rev += 1;
      break;
    case 'retryBooking':
      // BOOKING_FAILED recovery: re-arm the hold with a fresh holdStartedAtUtc so the
      // CREATE_EVENT idempotency key (holdSlotId + holdStartedAtUtc) changes and the old
      // failed outbox row no longer suppresses the retry; re-enter BOOKING to re-create.
      var retryNow = Date.now();
      Store.updatePoll(pollId, {
        state: 'BOOKING', holdStartedAtUtc: retryNow, holdApprovedAtUtc: retryNow
      }, snapshot.poll.rev);
      snapshot.poll.rev += 1;
      break;
    case 'extendGrace':
      // Grant another 24h of required-grace; the engine keeps waiting until it lapses.
      Store.updatePoll(pollId, { requiredGraceUntilUtc: Date.now() + 24 * 3600000 },
        snapshot.poll.rev);
      snapshot.poll.rev += 1;
      break;
    case 'cancel':
      Store.updatePoll(pollId, { state: 'CANCELLED' }, snapshot.poll.rev);
      snapshot.poll.rev += 1;
      break;
    default:
      Store.appendAudit(pollId, 'unknown_action', { kind: action.kind });
  }
  return null;
}

/**
 * State/slot preconditions for the actions that carry them, evaluated under the writer
 * lock against freshly loaded state. Returns a rejection or null. Organizer decisions are
 * valid only in the state that shows them and only for the slot they target; bench
 * counter-proposals only in ROUND1 from an all-Can't proposer, at most 3, no duplicates.
 * (The bench candidate-set membership check is calendar-dependent and stays a display-only
 * pre-check in the web layer; these authoritative state checks re-run here under the lock.)
 */
function validateActionUnderLock(snapshot, action) {
  var st = snapshot.poll.state;
  var poll = snapshot.poll;
  function closed() { return { rejected: true, reason: 'decision_closed' }; }

  switch (action.kind) {
    case 'organizerLaunch':
      if (st !== 'PIVOT_PENDING') return closed();
      break;
    case 'organizerApprove':
      if (st === 'HOLD') {
        if (action.slotId && action.slotId !== poll.holdSlotId) return closed();
      } else if (st === 'ESCALATE') {
        if (!action.slotId || !slotExists(snapshot, action.slotId)) return closed();
      } else {
        return closed();
      }
      break;
    case 'organizerReject':
      if (!(st === 'HOLD' && action.slotId === poll.holdSlotId)) return closed();
      break;
    case 'extendGrace':
      if (st !== 'REQUIRED_GRACE') return closed();
      break;
    case 'retryBooking':
      if (st !== 'BOOKING_FAILED') return closed();
      break;
    case 'bench':
      return validateBenchState(snapshot, action.inviteeId, action.slots || []);
    default:
      return null;
  }
  return null;
}

/** Authoritative bench STATE checks (membership recomputed in the web pre-check). */
function validateBenchState(snapshot, inviteeId, slots) {
  if (snapshot.poll.state !== 'ROUND1') {
    return { rejected: true, reason: 'Counter-proposals are only open during the first round.' };
  }
  if (!proposerAllCant(snapshot, inviteeId)) {
    return { rejected: true, reason: 'Counter-proposals are available once you have marked every proposed slot Can\'t.' };
  }
  if (!slots.length) return { rejected: true, reason: 'Pick at least one time to suggest.' };
  if (slots.length > 3) return { rejected: true, reason: 'Please suggest at most 3 times.' };
  var seen = {};
  for (var i = 0; i < slots.length; i++) {
    var start = slots[i].startUtc;
    if (seen[start]) return { rejected: true, reason: 'Please suggest distinct times.' };
    seen[start] = 1;
  }
  return null;
}

/**
 * Organizer launch (PIVOT_PENDING): record the organizer's votes on the slate-2 slots.
 * For each slot they marked Can't, drop it and pull the best runner-up from
 * rescueAlternatesJson — promoting a bench alternate in place or appending a new
 * slate-2 slot — recording the organizer's Works on the replacement and removing it
 * from the stored alternates. Then arm launchApprovedAtUtc so the engine launches.
 */
function handleOrganizerLaunch(snapshot, action) {
  var pollId = snapshot.poll.pollId;
  var organizerId = action.inviteeId;
  var votes = action.votes || [];

  Store.appendVotes(pollId, organizerId, votes);

  var alternates = safe(function () {
    return JSON.parse(snapshot.poll.rescueAlternatesJson || '[]');
  }, []);
  var slotPatches = [];
  var newSlots = [];
  var swapVotes = [];

  votes.forEach(function (v) {
    if (v.answer !== 'cant') return;
    slotPatches.push({ slotId: v.slotId, kind: 'dropped' });
    var alt = alternates.shift();
    if (!alt) return;
    if (alt.benchSlotId) {
      slotPatches.push({ slotId: alt.benchSlotId, kind: 'slate2', slateVersion: 2 });
      swapVotes.push({ slotId: alt.benchSlotId, answer: 'works', provenance: 'explicit_slate' });
    } else {
      var id = 'slate2_alt_' + Date.now() + '_' + newSlots.length;
      newSlots.push({ slotId: id, startUtc: alt.startUtc, endUtc: alt.endUtc,
        kind: 'slate2', slateVersion: 2, proposerInviteeId: '' });
      swapVotes.push({ slotId: id, answer: 'works', provenance: 'explicit_slate' });
    }
  });

  if (slotPatches.length) Store.applySlotPatches(pollId, slotPatches);
  if (newSlots.length) Store.appendSlots(pollId, newSlots);
  if (swapVotes.length) Store.appendVotes(pollId, organizerId, swapVotes);

  Store.updatePoll(pollId, {
    launchApprovedAtUtc: Date.now(),
    rescueAlternatesJson: JSON.stringify(alternates)
  }, snapshot.poll.rev);
  snapshot.poll.rev += 1;
}

/**
 * Execute only the rows this invocation claimed (already flipped to `executing` under
 * the lock, so a concurrent run cannot double-send). Mail sends via Mail; a daily-budget
 * suppression is left to retry (capped at ~5 attempts). CREATE_EVENT re-verifies under
 * the lock before booking; RECHECK_CALENDAR feeds a calendarBusy action back.
 */
function executeClaimed(pollId, claimed) {
  if (!claimed || !claimed.length) return;
  var snapshot = Store.loadSnapshot(pollId);
  if (!snapshot) return;

  claimed.forEach(function (row) {
    var current = Store.outboxByKey(row.key);
    if (!current || current.status !== 'executing') return; // reconciled elsewhere
    var effect = JSON.parse(row.payloadJson);
    var attempts = row.attempts + 1;

    try {
      if (effect.type === 'CREATE_EVENT') {
        handleCreateEvent(pollId, effect, row.key, attempts);
      } else if (effect.type === 'RECHECK_CALENDAR') {
        handleRecheck(pollId, snapshot, effect, row.key, attempts);
      } else {
        var status = Mail.send(effect, snapshot);
        if (status === 'suppressed') {
          // Daily budget squeeze: keep it pending so the next tick retries when quota
          // returns; give up (and audit) after ~5 attempts.
          if (attempts >= 5) {
            Store.markOutbox(row.key, 'failed', attempts);
            Store.appendAudit(pollId, 'mail_give_up', { key: row.key, type: effect.type });
          } else {
            Store.markOutbox(row.key, 'pending', attempts);
          }
        } else {
          Store.markOutbox(row.key, 'done', attempts);
        }
      }
    } catch (err) {
      Store.markOutbox(row.key, 'failed', attempts);
      Store.appendAudit(pollId, 'outbox_error', { key: row.key, error: String(err) });
    }
  });
}

/**
 * Create the event with the ScriptLock held across verify + Cal.createEvent + the
 * calendarEventId commit, so a cancellation, revision, or calendar change in the gap
 * cannot double-book or book a dead poll. Verify: state is BOOKING, holdSlotId matches,
 * the calendar is still free, and (unless holdForced — the escalate least-bad override)
 * the slot is still feasible. On success commit calendarEventId; on failure flip to
 * BOOKING_FAILED — both under the lock. The lock is released in finally; a subsequent
 * tick then advances BOOKING -> BOOKED or emits the BOOKING_FAILED alert.
 */
function handleCreateEvent(pollId, effect, key, attempts) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // stays 'executing' — reconciled on the next tick

  try {
    var snapshot = Store.loadSnapshot(pollId);
    if (!snapshot) { Store.markOutbox(key, 'failed', attempts); return; }
    var slot = snapshot.slots.filter(function (s) { return s.slotId === effect.slotId; })[0];
    var verified = !!(snapshot.poll.state === 'BOOKING' &&
      snapshot.poll.holdSlotId === effect.slotId && slot &&
      (snapshot.poll.holdForced || Sched.engine.feasible(snapshot, slot.slotId, false)) &&
      Cal.isSlotFree(snapshot.poll, slot));

    if (!verified) {
      Store.markOutbox(key, 'failed', attempts);
      Store.appendAudit(pollId, 'booking_failed', { reason: 'verify_failed' });
      Store.updatePoll(pollId, { state: 'BOOKING_FAILED' }, snapshot.poll.rev);
      return;
    }

    var desc = coreBookingDescription(snapshot);
    try {
      var eventId = Cal.createEvent(snapshot.poll, slot, snapshot.invitees, desc);
      Store.markOutbox(key, 'done', attempts);
      Store.appendAudit(pollId, 'event_created', { eventId: eventId });
      Store.updatePoll(pollId, { calendarEventId: eventId }, snapshot.poll.rev); // -> BOOKED next tick
    } catch (e) {
      Store.markOutbox(key, 'failed', attempts);
      Store.appendAudit(pollId, 'booking_failed', { reason: String(e) });
      Store.updatePoll(pollId, { state: 'BOOKING_FAILED' }, snapshot.poll.rev);
    }
  } finally {
    lock.releaseLock();
  }

  // Outside the lock: advance BOOKING -> BOOKED (calendarEventId now set) or emit the
  // BOOKING_FAILED alert. A plain tick suffices; the transition itself is idempotent.
  advancePoll(pollId, { kind: 'tick' });
}

/**
 * Reconcile crashed `executing` outbox rows (claim older than 10 min), under the lock.
 *
 * CREATE_EVENT: only a row that still matches the CURRENT hold — its key equals
 * pollId:CREATE_EVENT:holdSlotId:holdStartedAtUtc AND the poll is still BOOKING — may touch
 * poll state. It is resolved by an exact calendar match (start AND end AND title): found ->
 * commit calendarEventId; not found -> BOOKING_FAILED. Any other CREATE_EVENT row
 * (cancelled, already booked, or a superseded earlier retry) is just retired to `failed`
 * WITHOUT touching poll state.
 *
 * Other types (mail, RECHECK_CALENDAR): a crash mid-send left them stranded, so re-queue
 * them (attempts++, capped at 5 then failed). A rare duplicate email is preferable to a
 * never-sent one. Re-queued rows are picked up by the next tick's claim.
 *
 * State commits happen under the lock; the affected polls are then advanced (BOOKING ->
 * BOOKED, or the BOOKING_FAILED alert) outside it via a plain tick.
 */
function reconcileOutbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // next tick retries

  var advanceAfter = {};
  try {
    Store.staleExecuting(10 * 60000, 'CREATE_EVENT').forEach(function (row) {
      var pollId = row.pollId;
      var attempts = Number(row.attempts);
      var snapshot = Store.loadSnapshot(pollId);
      if (!snapshot) { Store.markOutbox(row.key, 'failed', attempts); return; }

      var currentKey = pollId + ':CREATE_EVENT:' +
        snapshot.poll.holdSlotId + ':' + snapshot.poll.holdStartedAtUtc;
      if (snapshot.poll.state !== 'BOOKING' || row.key !== currentKey) {
        // Cancelled, already booked, or a superseded retry: retire the row only.
        Store.markOutbox(row.key, 'failed', attempts);
        Store.appendAudit(pollId, 'reconcile_stale_skip', { key: row.key, state: snapshot.poll.state });
        return;
      }

      var effect = safe(function () { return JSON.parse(row.payloadJson); }, {});
      var slot = snapshot.slots.filter(function (s) { return s.slotId === effect.slotId; })[0];
      var eventId = slot ? safe(function () { return Cal.findEvent(snapshot.poll, slot); }, null) : null;
      if (eventId) {
        Store.markOutbox(row.key, 'done', attempts);
        Store.appendAudit(pollId, 'reconcile_found', { key: row.key });
        Store.updatePoll(pollId, { calendarEventId: eventId }, snapshot.poll.rev);
      } else {
        Store.markOutbox(row.key, 'failed', attempts);
        Store.appendAudit(pollId, 'reconcile_not_found', { key: row.key });
        Store.updatePoll(pollId, { state: 'BOOKING_FAILED' }, snapshot.poll.rev);
      }
      advanceAfter[pollId] = 1;
    });

    Store.staleExecuting(10 * 60000, null).forEach(function (row) {
      if (row.type === 'CREATE_EVENT') return; // handled above
      var attempts = Number(row.attempts) + 1;
      if (attempts >= 5) {
        Store.markOutbox(row.key, 'failed', attempts);
        Store.appendAudit(row.pollId, 'reconcile_give_up', { key: row.key, type: row.type });
      } else {
        Store.markOutbox(row.key, 'pending', attempts); // clears the claim -> re-sent next tick
        Store.appendAudit(row.pollId, 'reconcile_requeue', { key: row.key, type: row.type });
      }
    });
  } finally {
    lock.releaseLock();
  }

  Object.keys(advanceAfter).forEach(function (pollId) {
    advancePoll(pollId, { kind: 'tick' });
  });
}

/**
 * Display-agnostic persistent calendar block: on POST (vote submission, organizer
 * decision) and cron ticks, recheck each live slot against the organizer's calendar and,
 * if now busy, record it as the required organizer's Can't so the core marks it Blocked.
 */
function applyCalendarRechecks(pollId) {
  var snapshot = Store.loadSnapshot(pollId);
  if (!snapshot) return;
  var VOTING = { ROUND1: 1, ROUND2: 1, PIVOT_PENDING: 1, HOLD: 1 };
  if (!VOTING[snapshot.poll.state]) return;
  var organizer = snapshot.invitees.filter(function (i) { return i.organizer; })[0];
  if (!organizer) return;
  var latest = safe(function () { return Sched.votes.latest(snapshot); }, new Map());
  liveSlots(snapshot).forEach(function (s) {
    var existing = latest.get ? latest.get(organizer.inviteeId + '|' + s.slotId) : null;
    if (existing && existing.answer === 'cant') return; // already blocked
    if (!safe(function () { return Cal.isSlotFree(snapshot.poll, s); }, true)) {
      advancePoll(pollId, { kind: 'calendarBusy', inviteeId: organizer.inviteeId, slotId: s.slotId });
    }
  });
}

function handleRecheck(pollId, snapshot, effect, key, attempts) {
  var slot = snapshot.slots.filter(function (s) { return s.slotId === effect.slotId; })[0];
  Store.markOutbox(key, 'done', attempts);
  if (slot && !Cal.isSlotFree(snapshot.poll, slot)) {
    var organizer = snapshot.invitees.filter(function (i) { return i.organizer; })[0];
    if (organizer) advancePoll(pollId, {
      kind: 'calendarBusy', inviteeId: organizer.inviteeId, slotId: slot.slotId
    });
  }
}

function coreBookingDescription(snapshot) {
  try {
    var d = Sched.text.email.bookingDescription(snapshot);
    if (d) return d;
  } catch (e) { /* fall through */ }
  return 'Scheduled via group scheduler. Poll responses were advisory; if this time no ' +
    'longer works, decline and contact ' + snapshot.poll.organizerEmail + ' directly.';
}
