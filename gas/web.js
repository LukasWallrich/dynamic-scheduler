/**
 * web.js — the single JSON HTTP dispatcher.
 * Requests arrive as POST with Content-Type text/plain and a JSON body { action, ... }
 * (the CORS simple-request transport). doPost parses e.postData.contents, routes on
 * `action`, and returns ContentService JSON shaped { ok:true, data } or
 * { ok:false, error:{ code, message, fields? } } per API.md. Possession of the token is
 * authorization; every state-changing action is a POST (no CSRF nonce). Reads (getState,
 * getSetupContext) and writes both come through here. Writes re-evaluate deadlines by
 * receipt time, run the single locked advancePoll, and return a fresh getState so the
 * frontend re-renders from authoritative state in one round-trip. doGet is a health probe;
 * the frontend is hosted separately, so no HTML is served.
 */

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonOk(data) { return jsonOut({ ok: true, data: data }); }

function jsonErr(code, message, fields) {
  var err = { code: code, message: message };
  if (fields) err.fields = fields;
  return jsonOut({ ok: false, error: err });
}

function doGet(e) {
  captureExecUrl();
  return jsonOut({ ok: true, service: 'scheduler' });
}

function doPost(e) {
  captureExecUrl();
  var body = parseBody(e);
  if (!body) return jsonErr('bad_request', 'Request body was not valid JSON.');
  var action = body.action;

  try {
    switch (action) {
      // ---- reads ----
      case 'getState':         return handleGetState(body);
      case 'getSetupContext':  return handleGetSetupContext(body);
      // ---- creation ----
      case 'createPoll':       return handleCreatePoll(body);
      // ---- writes (all take token) ----
      case 'submitVotes':
      case 'saveConstraints':
      case 'proposeBench':
      case 'organizerLaunch':
      case 'organizerApprove':
      case 'organizerReject':
      case 'extendGrace':
      case 'demoteRequired':
      case 'retryBooking':
      case 'cancelPoll':
      case 'rotateToken':
        return handleWrite(action, body);
      default:
        return jsonErr('bad_request', 'Unknown action: ' + action);
    }
  } catch (err) {
    return jsonErr('server_error', String(err && err.message ? err.message : err));
  }
}

function parseBody(e) {
  var raw = e && e.postData && e.postData.contents;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

// ---- reads ------------------------------------------------------------------

function handleGetState(body) {
  var ctx = resolveToken(body.token);
  if (ctx.error) return ctx.error;
  var busy = renderBusyMap(ctx.snapshot);
  return jsonOk(Api.buildState(ctx.snapshot, ctx.invitee, busy, Date.now()));
}

function handleGetSetupContext(body) {
  if (body.setupToken !== Security.setupToken()) {
    return jsonErr('unauthorized', 'Invalid setup token.');
  }
  return jsonOk(Api.getSetupContext(body.horizonStartUtc, body.horizonEndUtc));
}

/** Resolve a raw token to { snapshot, invitee, pollId } or { error: <response> }. */
function resolveToken(token) {
  if (!token) return { error: jsonErr('unauthorized', 'Missing token.') };
  var row = Store.findInviteeByTokenAny(token);
  if (!row) return { error: jsonErr('unauthorized', 'This link is not valid.') };
  var snapshot = Store.loadSnapshot(row.pollId);
  if (!snapshot) return { error: jsonErr('not_found', 'Poll not found.') };
  var invitee = attachInvitee(snapshot, row, token);
  if (!invitee) return { error: jsonErr('unauthorized', 'This link is not valid.') };
  return { snapshot: snapshot, invitee: invitee, pollId: row.pollId };
}

// ---- writes -----------------------------------------------------------------

var ORGANIZER_ONLY = { organizerLaunch: 1, organizerApprove: 1, organizerReject: 1,
  cancelPoll: 1, rotateToken: 1, demoteRequired: 1, extendGrace: 1, retryBooking: 1 };

function handleWrite(action, body) {
  var ctx = resolveToken(body.token);
  if (ctx.error) return ctx.error;
  var snapshot = ctx.snapshot;
  var invitee = ctx.invitee;
  var pollId = ctx.pollId;

  if (ORGANIZER_ONLY[action] && !invitee.organizer) {
    return jsonErr('unauthorized', 'Only the organizer can do that.');
  }

  // Terminal polls accept no writes; hand back the authoritative closed state.
  if (snapshot.poll.state === 'CANCELLED' || snapshot.poll.state === 'BOOKED') {
    return freshState(pollId, body.token);
  }

  var now = Date.now();
  var result;

  switch (action) {
    case 'submitVotes':
      if (voteDeadlinePassed(snapshot, now)) {
        return jsonErr('wrong_state', 'Responses for this round are closed.');
      }
      result = submitVotes(snapshot, invitee, body);
      applyCalendarRechecks(pollId); // record any slot the calendar now shows busy
      break;
    case 'saveConstraints':
      result = advancePoll(pollId, { kind: 'constraints', inviteeId: invitee.inviteeId,
        constraints: parseConstraintsJson(body.constraints) });
      break;
    case 'proposeBench':
      if (voteDeadlinePassed(snapshot, now)) {
        return jsonErr('wrong_state', 'Responses for this round are closed.');
      }
      var bench = validateBench(snapshot, invitee, parseBenchJson(snapshot, body.slots));
      if (!bench.ok) return jsonErr('rejected', bench.error);
      result = advancePoll(pollId, { kind: 'bench', inviteeId: invitee.inviteeId, slots: bench.slots });
      break;
    case 'organizerLaunch':
      result = advancePoll(pollId, { kind: 'organizerLaunch', inviteeId: invitee.inviteeId,
        votes: parseOrganizerVotesJson(snapshot, body.votes) });
      break;
    case 'organizerApprove':
      result = advancePoll(pollId, { kind: 'organizerApprove', slotId: body.slotId || null });
      break;
    case 'organizerReject':
      result = advancePoll(pollId, { kind: 'organizerReject', inviteeId: invitee.inviteeId,
        slotId: body.slotId });
      break;
    case 'demoteRequired':
      result = advancePoll(pollId, { kind: 'demoteRequired', inviteeId: body.targetInviteeId });
      break;
    case 'extendGrace':
      result = advancePoll(pollId, { kind: 'extendGrace' });
      break;
    case 'retryBooking':
      result = advancePoll(pollId, { kind: 'retryBooking' });
      break;
    case 'cancelPoll':
      result = advancePoll(pollId, { kind: 'cancel' });
      break;
    case 'rotateToken':
      Store.rotateToken(pollId, body.targetInviteeId);
      result = { ok: true };
      break;
    default:
      return jsonErr('bad_request', 'Unknown action: ' + action);
  }

  var mapped = mapResult(result);
  if (mapped) return mapped;
  return freshState(pollId, body.token);
}

/** Translate an advancePoll result into an error response, or null on success. */
function mapResult(result) {
  if (!result) return jsonErr('server_error', 'No result.');
  if (result.busy) return jsonErr('busy', 'Another update is in progress — retry.');
  if (result.error === 'not_found') return jsonErr('not_found', 'Poll not found.');
  if (result.rejected) {
    return result.reason === 'decision_closed'
      ? jsonErr('wrong_state', 'The poll has moved on; reload to see the current state.')
      : jsonErr('rejected', result.reason || 'That could not be accepted.');
  }
  return null;
}

/** Reload authoritative state for this token and return it as the write response. */
function freshState(pollId, token) {
  var snapshot = Store.loadSnapshot(pollId);
  if (!snapshot) return jsonErr('not_found', 'Poll not found.');
  var row = Store.findInviteeByToken(pollId, token);
  if (!row) return jsonErr('unauthorized', 'This link is not valid.');
  var invitee = attachInvitee(snapshot, row, token);
  var busy = renderBusyMap(snapshot);
  return jsonOk(Api.buildState(snapshot, invitee, busy, Date.now()));
}

// ---- write parsers (JSON body) ----------------------------------------------

function submitVotes(snapshot, invitee, body) {
  var votes = parseSlotVotesJson(snapshot, invitee, body.votes);
  var r = advancePoll(snapshot.poll.pollId, { kind: 'votes', inviteeId: invitee.inviteeId, votes: votes });
  var constraints = parseConstraintsJson(body.constraints);
  if (constraints.length) {
    r = advancePoll(snapshot.poll.pollId, { kind: 'constraints', inviteeId: invitee.inviteeId, constraints: constraints });
  }
  return r;
}

var VALID_ANSWER = { works: 1, ifneeded: 1, cant: 1 };

function parseSlotVotesJson(snapshot, invitee, votesObj) {
  votesObj = votesObj || {};
  var votes = [];
  liveSlots(snapshot).forEach(function (s) {
    var ans = votesObj[s.slotId];
    if (!VALID_ANSWER[ans]) return;
    votes.push({ slotId: s.slotId, answer: ans,
      provenance: s.kind === 'bench' ? 'explicit_bench' : 'explicit_slate' });
  });
  return votes;
}

function parseOrganizerVotesJson(snapshot, votesObj) {
  votesObj = votesObj || {};
  var votes = [];
  liveSlots(snapshot).filter(function (s) { return s.slateVersion === 2; }).forEach(function (s) {
    var ans = votesObj[s.slotId];
    if (!VALID_ANSWER[ans]) ans = 'works'; // prefilled to Works
    votes.push({ slotId: s.slotId, answer: ans, provenance: 'explicit_slate' });
  });
  return votes;
}

var VALID_CONSTRAINT = { dow: 1, week: 1, range: 1 };

function parseConstraintsJson(constraints) {
  if (!Array.isArray(constraints)) return [];
  var out = [];
  constraints.forEach(function (c) {
    if (!c || !VALID_CONSTRAINT[c.type]) return;
    var value = c.type === 'dow' ? Number(c.value) : c.value;
    out.push({ type: c.type, value: value });
  });
  return out;
}

function parseBenchJson(snapshot, slots) {
  if (!Array.isArray(slots)) return [];
  var dur = snapshot.poll.durationMins * 60000;
  return slots.slice(0, 3).map(function (s) {
    var start = Number(s.startUtc);
    return { startUtc: start, endUtc: s.endUtc ? Number(s.endUtc) : start + dur };
  });
}

// ---- bench candidate windows ------------------------------------------------

/** True iff the proposer has recorded Can't on every live slate-1 slot. */
function proposerAllCant(snapshot, inviteeId) {
  var latest = safe(function () { return Sched.votes.latest(snapshot); }, new Map());
  var slate = liveSlots(snapshot).filter(function (s) {
    return s.kind !== 'bench' && s.slateVersion === 1;
  });
  return slate.length > 0 && slate.every(function (s) {
    var v = latest.get ? latest.get(inviteeId + '|' + s.slotId) : null;
    return v && v.answer === 'cant';
  });
}

/**
 * The candidate set a blocked invitee may counter-propose from, recomputed server-side:
 * organizer-free windows inside the horizon/working hours, minus windows the proposer's
 * own vetoes exclude, minus any required attendee's hard veto, deduped against existing
 * slots. Returns a set of aligned start instants (numbers).
 */
function benchCandidateStarts(snapshot, inviteeId) {
  var poll = snapshot.poll;
  var free = safe(function () { return Cal.freeWindows(poll); }, []);
  var starts = safe(function () { return Sched.universe.candidateStarts(poll, free); }, []);
  var taken = {};
  snapshot.slots.forEach(function (s) { taken[s.startUtc] = 1; });

  var excluders = snapshot.constraints.filter(function (c) {
    if (c.inviteeId === inviteeId) return true; // proposer's own vetoes
    var inv = snapshot.invitees.filter(function (i) { return i.inviteeId === c.inviteeId; })[0];
    return inv && inv.required && !inv.demoted; // required attendees' hard exclusions
  });
  var dur = poll.durationMins * 60000;
  var out = [];
  starts.forEach(function (raw) {
    var startUtc = typeof raw === 'number' ? raw : raw.startUtc;
    if (taken[startUtc]) return;
    var slot = { startUtc: startUtc, endUtc: startUtc + dur };
    var vetoed = excluders.some(function (c) {
      return safe(function () { return Sched.constraints.vetoesSlot(c, slot, poll.tz); }, false);
    });
    if (!vetoed) out.push(startUtc);
  });
  return out;
}

/** Counter-proposal windows (only offered to an all-Can't proposer): [{startUtc,endUtc}]. */
function benchOptions(snapshot, invitee) {
  if (!proposerAllCant(snapshot, invitee.inviteeId)) return [];
  var dur = snapshot.poll.durationMins * 60000;
  return benchCandidateStarts(snapshot, invitee.inviteeId).slice(0, 12).map(function (startUtc) {
    return { startUtc: startUtc, endUtc: startUtc + dur };
  });
}

/**
 * Display-only pre-check of a bench counter-proposal: confirm each suggested window is
 * still in the proposer's offered candidate set. This membership test is calendar-
 * dependent (an expensive free/busy recompute), so it stays in the web layer. The
 * authoritative STATE checks — ROUND1, all-Can't proposer, at most 3, no duplicates —
 * re-run inside applyAction under the writer lock.
 */
function validateBench(snapshot, invitee, proposals) {
  var allowed = {};
  benchCandidateStarts(snapshot, invitee.inviteeId).forEach(function (s) { allowed[s] = 1; });
  for (var i = 0; i < proposals.length; i++) {
    if (!allowed[proposals[i].startUtc]) {
      return { ok: false, error: 'One of the suggested times is no longer available. Reload and try again.' };
    }
  }
  return { ok: true, slots: proposals };
}

function slotExists(snapshot, slotId) {
  return snapshot.slots.some(function (s) { return s.slotId === slotId; });
}

// ---- poll creation ----------------------------------------------------------

function handleCreatePoll(body) {
  if (body.setupToken !== Security.setupToken()) {
    return jsonErr('unauthorized', 'Invalid setup token.');
  }
  var poll = body.poll || {};
  var tz = poll.tz;
  // Validate the timezone BEFORE any tz-dependent work (DST probe uses Intl): an unknown
  // zone would otherwise throw and escape past validation instead of a clean field error.
  if (!validTimezone(tz)) {
    return jsonErr('bad_request', 'Please fix these:',
      ['Unknown timezone ' + (tz || '(blank)') + ' — pick a valid IANA zone (e.g. Europe/London).']);
  }

  var dur = Number(poll.durationMins);
  var horizonStartUtc = Number(poll.horizonStartUtc);
  var horizonEndUtc = Number(poll.horizonEndUtc);
  var wh = poll.workingHours || {};
  var whDays = (wh.days || []).map(Number);
  var round1DeadlineUtc = Number(poll.round1DeadlineUtc);
  var now = Date.now();

  // The deployer IS the organizer: free/busy and event creation both run on their default
  // calendar, so the organizer identity is taken from the session, never from the request.
  var organizerEmail = safe(function () { return Session.getEffectiveUser().getEmail(); }, '');

  var inviteeLines = (poll.invitees || []).map(function (i) {
    return { name: String(i.name || '').trim(), email: String(i.email || '').trim(),
      required: !!i.required };
  });
  var slotStarts = (poll.slotStartsUtc || []).map(Number);

  var ctx = {
    dur: dur, tz: tz, horizonStartUtc: horizonStartUtc, horizonEndUtc: horizonEndUtc,
    whDays: whDays, whStart: Number(wh.startHour), whEnd: Number(wh.endHour),
    minAttendees: Number(poll.minAttendees), maxAbsences: Number(poll.maxAbsences),
    round1DeadlineUtc: round1DeadlineUtc, now: now, title: poll.title,
    organizerEmail: organizerEmail, invitees: inviteeLines, slotStarts: slotStarts
  };
  var errors = validateSetup(ctx);
  if (errors.length) return jsonErr('bad_request', 'Please fix the highlighted fields.', errors);

  var pollId = 'poll_' + Utilities.getUuid().slice(0, 8);
  var pollRow = {
    pollId: pollId, rev: 0, state: 'SETUP', title: poll.title, durationMins: dur, tz: tz,
    organizerEmail: organizerEmail, organizerName: poll.organizerName,
    horizonStartUtc: horizonStartUtc, horizonEndUtc: horizonEndUtc,
    whStartHour: Number(wh.startHour), whEndHour: Number(wh.endHour), whDays: whDays.join(','),
    visibility: poll.visibility === 'full' ? 'full' : 'neutral',
    minAttendees: Number(poll.minAttendees), maxAbsences: Number(poll.maxAbsences),
    slateVersion: 1, round1DeadlineUtc: round1DeadlineUtc, round2DeadlineUtc: '',
    pivotDelayHours: Number(poll.pivotDelayHours), pivotProposedAtUtc: '', launchApprovedAtUtc: '',
    holdSlotId: '', holdStartedAtUtc: '', holdApprovedAtUtc: '', holdForced: '',
    rescueAlternatesJson: '',
    requiredGraceUntilUtc: '', graceRound: '', holdJustification: '', calendarEventId: '',
    linkBase: String(poll.linkBase || ''),
    createdAtUtc: now
  };

  var invitees = [];
  var tokens = {};
  var addInvitee = function (id, name, email, required, organizer) {
    var token = Security.newToken();
    tokens[id] = token;
    invitees.push(inviteeRow(pollId, id, name, email, required, organizer, token));
  };
  addInvitee('inv_org', poll.organizerName, organizerEmail, true, true);
  inviteeLines.forEach(function (line, idx) {
    addInvitee('inv_' + idx, line.name, line.email, line.required, false);
  });

  var slots = slotStarts.map(function (start, idx) {
    return { pollId: pollId, slotId: 'slot_' + idx, startUtc: start,
      endUtc: start + dur * 60000, kind: 'slate1', slateVersion: 1, proposerInviteeId: '' };
  });

  Store.insertPoll(pollRow, invitees, slots);
  Store.setTokens(pollId, tokens); // raw tokens live in Script Properties, not the Sheet
  Store.appendAudit(pollId, 'created', { invitees: invitees.length, slots: slots.length });
  advancePoll(pollId, { kind: 'tick' }); // SETUP -> ROUND1, enqueues SEND_INVITE

  var warning = diversityWarning(slots, tz);
  if (warning) Store.appendAudit(pollId, 'diversity_warning', { warning: warning });

  var snapshot = Store.loadSnapshot(pollId);
  var organizer = snapshot.invitees.filter(function (i) { return i.organizer; })[0];
  organizer._token = tokens.inv_org;
  return jsonOk({
    pollId: pollId,
    dashboardToken: tokens.inv_org,
    warning: warning || null,
    state: Api.buildState(snapshot, organizer, renderBusyMap(snapshot), now)
  });
}

/** Setup-shape validation. Returns an array of specific, field-level error strings. */
function validateSetup(c) {
  var errors = [];
  var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (c.slotStarts.length < 2 || c.slotStarts.length > 8) {
    errors.push('Propose between 2 and 8 slots (got ' + c.slotStarts.length + '). 3–5 works best.');
  }
  c.slotStarts.forEach(function (s, i) {
    if (!s || isNaN(s)) errors.push('Slot ' + (i + 1) + ' is not a valid date/time.');
    else if (s < c.horizonStartUtc || s + c.dur * 60000 > c.horizonEndUtc) {
      errors.push('Slot ' + (i + 1) + ' falls outside the horizon.');
    }
  });

  var people = 1 + c.invitees.length;
  if (people < 3 || people > 10) errors.push('Total people (organizer + invitees) must be 3–10 (got ' + people + ').');

  var emails = [c.organizerEmail].concat(c.invitees.map(function (i) { return i.email; }));
  var seen = {};
  emails.forEach(function (e) {
    var key = String(e || '').toLowerCase();
    if (!emailRe.test(String(e || ''))) errors.push('Not a valid email address: ' + (e || '(blank)') + '.');
    else if (seen[key]) errors.push('Duplicate email address: ' + e + '.');
    seen[key] = 1;
  });

  if (!String(c.title || '').trim()) errors.push('Give the meeting a title.');
  c.invitees.forEach(function (inv, i) {
    if (!String(inv.name || '').trim()) errors.push('Invitee ' + (i + 1) + ' is missing a name.');
  });

  // Working hours: whole hours, 0 <= start < end <= 24; days a non-empty subset of 0–6.
  if (!isInt(c.whStart) || !isInt(c.whEnd) || c.whStart < 0 || c.whEnd > 24 || c.whStart >= c.whEnd) {
    errors.push('Working hours must be whole hours with 0 ≤ start < end ≤ 24.');
  }
  if (!c.whDays.length || c.whDays.some(function (d) { return !isInt(d) || d < 0 || d > 6; })) {
    errors.push('Select at least one working day (0=Sun … 6=Sat).');
  }

  if (isNaN(c.dur) || c.dur < 15 || c.dur > 480) errors.push('Duration must be 15–480 minutes.');
  if (isNaN(c.horizonStartUtc) || isNaN(c.horizonEndUtc) || c.horizonStartUtc >= c.horizonEndUtc) {
    errors.push('Horizon start must be before horizon end.');
  }
  if (!c.round1DeadlineUtc || isNaN(c.round1DeadlineUtc)) errors.push('Round 1 deadline is not a valid date/time.');
  else {
    if (c.round1DeadlineUtc <= c.now) errors.push('Round 1 deadline must be in the future.');
    if (c.round1DeadlineUtc > c.horizonEndUtc) errors.push('Round 1 deadline must be on or before the horizon end.');
  }
  if (isNaN(c.minAttendees) || c.minAttendees < 1 || c.minAttendees > people) {
    errors.push('Minimum attendees must be between 1 and ' + people + '.');
  }
  if (isNaN(c.maxAbsences) || c.maxAbsences < 0 || c.maxAbsences >= people) {
    errors.push('Maximum absences must be between 0 and ' + (people - 1) + '.');
  }

  var pollForCheck = {
    tz: c.tz, durationMins: c.dur, horizonStartUtc: c.horizonStartUtc, horizonEndUtc: c.horizonEndUtc,
    workingHours: { startHour: c.whStart, endHour: c.whEnd, days: c.whDays }
  };
  if (safe(function () { return Sched.universe.spansDst(pollForCheck); }, false)) {
    errors.push('This horizon spans a daylight-saving change; v1 cannot create such a poll. Shorten the horizon.');
  }
  return errors;
}

function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

/** True iff tz is a resolvable IANA zone (probe Intl; unknown zones throw RangeError). */
function validTimezone(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; }
  catch (e) { return false; }
}

function inviteeRow(pollId, id, name, email, required, organizer, token) {
  return { pollId: pollId, inviteeId: id, name: name, email: email, required: required,
    demoted: false, organizer: organizer, tokenHash: Security.hashToken(token) };
}

function diversityWarning(slots, tz) {
  if (slots.length < 2) return '';
  var days = {}, bands = {};
  slots.forEach(function (s) {
    days[Utilities.formatDate(new Date(s.startUtc), tz, 'yyyy-MM-dd')] = 1;
    var h = Number(Utilities.formatDate(new Date(s.startUtc), tz, 'HH'));
    bands[h < 12 ? 'm' : (h < 17 ? 'a' : 'e')] = 1;
  });
  if (Object.keys(days).length === 1) return 'All proposed slots are on the same day.';
  if (Object.keys(bands).length === 1) return 'All proposed slots are in the same time band.';
  return '';
}

// ---- links & exec-url capture -----------------------------------------------

// Links (invite / reminder emails) must use the public /exec URL.
// ScriptApp.getService().getUrl() returns the owner-only /dev URL when called from the
// editor and can be null under a time-driven trigger, so we cache the real /exec URL the
// first time a live web request exposes it, and every link builder reads the cache.
function captureExecUrl() {
  var live = safe(function () { return ScriptApp.getService().getUrl(); }, null);
  if (live && live.indexOf('/exec') !== -1) {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('WEBAPP_EXEC_URL') !== live) props.setProperty('WEBAPP_EXEC_URL', live);
  }
}

function webAppUrl() {
  var stored = PropertiesService.getScriptProperties().getProperty('WEBAPP_EXEC_URL');
  return stored || ScriptApp.getService().getUrl();
}

// Invitee/organizer links point at the separately hosted FRONTEND (the poll's linkBase),
// carrying only the token; the frontend resolves the poll and the right view from state.
// Falls back to the API URL if no linkBase was supplied (degraded but non-broken).
function linkFor(poll, inviteeId) {
  var token = Store.inviteeToken(poll.pollId, inviteeId);
  var base = poll.linkBase || webAppUrl();
  var sep = base.indexOf('?') === -1 ? '?' : '&';
  return base + sep + 'token=' + encodeURIComponent(token || '');
}

function attachInvitee(snapshot, inviteeRow, token) {
  var invitee = snapshot.invitees.filter(function (i) { return i.inviteeId === inviteeRow.inviteeId; })[0];
  if (invitee) invitee._token = token;
  return invitee;
}

function voteDeadlinePassed(snapshot, now) {
  var poll = snapshot.poll;
  var dl = poll.slateVersion === 2 ? poll.round2DeadlineUtc : poll.round1DeadlineUtc;
  return dl && now > dl;
}

// ---- shell-wide utilities (previously in pages.js) --------------------------

/** Live, non-excluded slots. */
function liveSlots(snapshot) {
  return snapshot.slots.filter(function (s) {
    return s.kind !== 'dropped' && s.kind !== 'rejected';
  });
}

/** Live calendar recheck for display only — map slotId -> true when now busy. */
function renderBusyMap(snapshot) {
  var map = {};
  var VOTING = { ROUND1: 1, ROUND2: 1, PIVOT_PENDING: 1, HOLD: 1 };
  if (!VOTING[snapshot.poll.state]) return map;
  liveSlots(snapshot).forEach(function (s) {
    if (!safe(function () { return Cal.isSlotFree(snapshot.poll, s); }, true)) map[s.slotId] = true;
  });
  return map;
}

function safe(fn, fallback) {
  try { var v = fn(); return (v === null || v === undefined) ? fallback : v; }
  catch (e) { return fallback; }
}
