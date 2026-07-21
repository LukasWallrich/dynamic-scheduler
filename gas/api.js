/**
 * api.js — read view-model assembly for the JSON API.
 * buildState() turns a loaded snapshot + the resolved invitee into the role-aware,
 * visibility-safe object the frontend renders (API.md `getState` data). The server is
 * the sole authority on visibility: when poll.visibility is "neutral" an invitee's view
 * carries NO other participant's name and NO required/optional status — only anonymous
 * support counts where the design allows. The organizer view adds the people-naming
 * diagnostics, coverage, budget and the state-specific block (pivot / hold / escalate).
 * getSetupContext() powers the setup pickers with the organizer's real free windows.
 */

var Api = {

  /**
   * Role-aware, visibility-safe view-model for one token-holder.
   * @param busy  map slotId -> true for slots the calendar now shows busy (display-only).
   */
  buildState: function (snapshot, invitee, busy, now) {
    var poll = snapshot.poll;
    busy = busy || {};
    var isOrg = !!invitee.organizer;
    var full = poll.visibility === 'full';
    var latest = safe(function () { return Sched.votes.latest(snapshot); }, new Map());

    var slateSlots = Sched.engine.liveSlots(snapshot).filter(function (s) {
      return s.kind !== 'bench' && s.slateVersion === poll.slateVersion;
    });
    var benchSlots = Sched.engine.liveSlots(snapshot).filter(function (s) { return s.kind === 'bench'; });

    var shape = function (s) {
      return buildSlot(snapshot, s, invitee, isOrg, full, latest, busy, now);
    };

    var data = {
      role: isOrg ? 'organizer' : 'invitee',
      poll: {
        title: poll.title,
        state: poll.state,
        tz: poll.tz,
        durationMins: poll.durationMins,
        visibility: poll.visibility,
        organizerEmail: poll.organizerEmail,
        deadlineUtc: currentDeadline(poll),
        roundLabel: poll.slateVersion === 2 ? 'Round 2' : 'Round 1',
        // Bounds for the invitee's avoid-rules UI (day toggles + painted absence dates).
        horizonStartUtc: poll.horizonStartUtc,
        horizonEndUtc: poll.horizonEndUtc,
        workingDays: (poll.workingHours && poll.workingHours.days) || [1, 2, 3, 4, 5]
      },
      you: {
        name: invitee.name,
        answersBySlotId: answersFor(latest, invitee.inviteeId, snapshot),
        // Your saved avoid-rules, so the page can seed its editor — saves REPLACE the
        // whole set, so an unseeded editor would silently wipe earlier rules.
        constraints: (snapshot.constraints || []).filter(function (c) {
          return c.inviteeId === invitee.inviteeId;
        }).map(function (c) { return { type: c.type, value: c.value }; })
      },
      slots: slateSlots.map(shape),
      bench: benchSlots.map(shape)
    };

    // Counter-proposal windows: shown only to a proposer who has marked every live slate
    // slot Can't (the same gate the writer re-checks under the lock).
    if (!isOrg && poll.state === 'ROUND1') {
      var options = safe(function () { return benchOptions(snapshot, invitee); }, []);
      if (options.length) data.benchOptions = options;
    }

    if (isOrg) data.organizer = buildOrganizer(snapshot, latest, now);

    return data;
  },

  /**
   * Setup pickers: the organizer's identity/timezone/working-hours defaults plus real
   * free windows over a default look-ahead (or a passed horizon), so the slot picker
   * only offers times the organizer is actually free.
   */
  getSetupContext: function (horizonStartUtc, horizonEndUtc) {
    var email = safe(function () { return Session.getEffectiveUser().getEmail(); }, '');
    // The organizer's own calendar timezone — not the Apps Script project tz (often UTC).
    var tz = safe(function () { return CalendarApp.getDefaultCalendar().getTimeZone(); }, '') ||
      safe(function () { return Session.getScriptTimeZone(); }, '') || 'Etc/UTC';
    // Return free windows over the FULL pickable band (all days, 06:00–22:00 — the range
    // of the day-start/end pickers) so the client can clip to any working hours/days the
    // organizer chooses without re-fetching. defaultWorkingHours is only the initial UI.
    var band = { startHour: 6, endHour: 22, days: [0, 1, 2, 3, 4, 5, 6] };
    var defaultWh = { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] };
    var now = Date.now();
    var startUtc = Number(horizonStartUtc) || now;
    var endUtc = Number(horizonEndUtc) || (now + 14 * 86400000);
    var pseudoPoll = {
      organizerEmail: email, tz: tz,
      horizonStartUtc: startUtc, horizonEndUtc: endUtc, workingHours: band
    };
    var free = safe(function () { return Cal.freeWindows(pseudoPoll); }, []);
    return {
      organizerEmail: email,
      organizerName: email ? email.split('@')[0] : '',
      tz: tz,
      defaultWorkingHours: defaultWh,
      freeWindows: free
    };
  }
};

// ---- per-slot shaping --------------------------------------------------------

function buildSlot(snapshot, slot, invitee, isOrg, full, latest, busy, now) {
  var yv = latest.get ? latest.get(Sched.votes.keyOf(invitee.inviteeId, slot.slotId)) : null;
  var out = {
    slotId: slot.slotId,
    startUtc: slot.startUtc,
    endUtc: slot.endUtc,
    kind: slot.kind,
    yourVote: yv ? yv.answer : null,
    busy: !!busy[slot.slotId]
  };

  // Support counts are anonymous {works, ifneeded, cant}. Neutral visibility exposes them
  // only on the bench (where the design shows anonymous interest); full visibility and the
  // organizer see them on every slot. Counts never carry names or required-status.
  if (isOrg || full || slot.kind === 'bench') {
    out.support = safe(function () { return Sched.votes.counts(snapshot, slot.slotId); },
      { works: 0, ifneeded: 0, cant: 0 });
  }

  // status/reasons name people, so they are organizer-only.
  if (isOrg) {
    var st = safe(function () { return Sched.engine.slotStatus(snapshot, slot.slotId, now); },
      { status: 'unknown', reasons: [] });
    out.status = st.status;
    out.reasons = (st.reasons || []).map(function (r) { return reasonWithNames(snapshot, r); });
  }
  return out;
}

/** The invitee's own recorded answers across every live slot they can see. */
function answersFor(latest, inviteeId, snapshot) {
  var out = {};
  Sched.engine.liveSlots(snapshot).forEach(function (s) {
    var v = latest.get ? latest.get(Sched.votes.keyOf(inviteeId, s.slotId)) : null;
    if (v) out[s.slotId] = v.answer;
  });
  return out;
}

// ---- organizer-only assembly -------------------------------------------------

function buildOrganizer(snapshot, latest, now) {
  var poll = snapshot.poll;
  var live = Sched.engine.liveSlots(snapshot);

  var diagnostics = [];
  live.forEach(function (s) {
    var st = safe(function () { return Sched.engine.slotStatus(snapshot, s.slotId, now); },
      { reasons: [] });
    (st.reasons || []).forEach(function (r) {
      diagnostics.push({
        slotId: s.slotId, rule: r.rule,
        people: namesForIds(snapshot, r.inviteeIds || []),
        text: r.text
      });
    });
  });

  // Everyone, not just required people — the dashboard labels this "Who has responded".
  var coverage = snapshot.invitees.filter(function (i) { return !i.demoted; }).map(function (i) {
    var responded = snapshot.slots.some(function (s) {
      return latest.get && latest.get(Sched.votes.keyOf(i.inviteeId, s.slotId));
    });
    return { name: i.name, responded: responded };
  });

  var out = {
    coverage: coverage,
    emailBudget: {
      used: safe(function () { return Mail.used(); }, 0),
      total: safe(function () { return Mail.DAILY_BUDGET; }, 0),
      squeezed: safe(function () { return Mail.squeezedToday(); }, false)
    },
    diagnostics: diagnostics
  };

  if (poll.state === 'PIVOT_PENDING') out.pivot = buildPivot(snapshot, now);
  else if (poll.state === 'HOLD') out.hold = buildHold(snapshot, latest);
  else if (poll.state === 'ESCALATE') out.escalate = buildEscalate(snapshot);
  else if (poll.state === 'REQUIRED_GRACE') {
    appendSilentRequired(snapshot, latest, diagnostics);
    // Actionable grace block: the dashboard renders extend / demote controls from this
    // (the grace email promises those options, so the page must actually offer them).
    out.grace = {
      untilUtc: poll.requiredGraceUntilUtc || null,
      silent: silentRequiredInvitees(snapshot, latest).map(function (i) {
        return { inviteeId: i.inviteeId, name: i.name };
      })
    };
  } else if (poll.state === 'BOOKING_FAILED') {
    out.bookingFailed = true; // dashboard shows the retry control
  }

  return out;
}

/** Required, non-demoted invitees still missing a vote on a live current-slate slot. */
function silentRequiredInvitees(snapshot, latest) {
  var live = Sched.engine.liveSlots(snapshot).filter(function (s) {
    return s.kind !== 'bench' && s.slateVersion === snapshot.poll.slateVersion;
  });
  return snapshot.invitees.filter(function (inv) {
    if (!(inv.required && !inv.demoted)) return false;
    return live.some(function (s) {
      return !(latest.get && latest.get(Sched.votes.keyOf(inv.inviteeId, s.slotId)));
    });
  });
}

function buildPivot(snapshot, now) {
  var poll = snapshot.poll;
  var slate2 = Sched.engine.liveSlots(snapshot).filter(function (s) { return s.slateVersion === 2; });
  return {
    proposed: slate2.map(function (s) {
      var st = safe(function () { return Sched.engine.slotStatus(snapshot, s.slotId, now); },
        { reasons: [] });
      return {
        slotId: s.slotId, startUtc: s.startUtc, endUtc: s.endUtc,
        reasoning: (st.reasons || []).map(function (r) { return r.text; }).join('; ')
      };
    }),
    dueUtc: safe(function () { return Sched.engine.pivotDueUtc(poll); }, null)
  };
}

function buildHold(snapshot, latest) {
  var poll = snapshot.poll;
  return {
    slotId: poll.holdSlotId,
    confirmed: namesByAnswer(snapshot, latest, poll.holdSlotId, 'works')
      .concat(namesByAnswer(snapshot, latest, poll.holdSlotId, 'ifneeded')),
    mayClash: namesByAnswer(snapshot, latest, poll.holdSlotId, 'cant'),
    autoBookUtc: poll.holdStartedAtUtc ? poll.holdStartedAtUtc + 24 * 3600000 : null
  };
}

function buildEscalate(snapshot) {
  var poll = snapshot.poll;
  var latest = Sched.votes.latest(snapshot);
  // Typed levers the frontend can actually execute: book a specific slot despite the
  // failed rule (organizerApprove + slotId, holdForced path), or cancel.
  var levers = Sched.engine.liveSlots(snapshot)
    .filter(function (s) { return s.kind !== 'bench' && s.slateVersion === poll.slateVersion; })
    .map(function (s) {
      var covers = namesByAnswer(snapshot, latest, s.slotId, 'works')
        .concat(namesByAnswer(snapshot, latest, s.slotId, 'ifneeded'));
      var clash = namesByAnswer(snapshot, latest, s.slotId, 'cant');
      return {
        id: 'book:' + s.slotId, slotId: s.slotId,
        label: 'Book ' + safe(function () { return Sched.text.when(s.startUtc, poll.tz); }, '') + ' anyway',
        detail: 'Covers: ' + (covers.length ? covers.join(', ') : 'nobody yet') +
          (clash.length ? ' · said Can’t: ' + clash.join(', ') : '')
      };
    });
  levers.push({ id: 'cancel', slotId: null, label: 'Cancel the poll', detail: '' });
  return {
    diagnosis: safe(function () { return Sched.text.page.escalateDiagnosis(snapshot); },
      'No rescue slot reached the success rule.'),
    levers: levers
  };
}

/** Required people missing a vote on a live current-slate slot — the demote candidates. */
function appendSilentRequired(snapshot, latest, diagnostics) {
  var live = Sched.engine.liveSlots(snapshot).filter(function (s) {
    return s.kind !== 'bench' && s.slateVersion === snapshot.poll.slateVersion;
  });
  snapshot.invitees.forEach(function (inv) {
    if (!(inv.required && !inv.demoted)) return;
    var silent = live.some(function (s) {
      return !(latest.get && latest.get(Sched.votes.keyOf(inv.inviteeId, s.slotId)));
    });
    if (!silent) return;
    diagnostics.push({
      slotId: null, rule: 'required_silent',
      people: [{ inviteeId: inv.inviteeId, name: inv.name }],
      text: inv.name + ' (required) has not responded yet.'
    });
  });
}

// ---- naming helpers (organizer-only paths) -----------------------------------

function reasonWithNames(snapshot, reason) {
  return {
    rule: reason.rule,
    people: namesForIds(snapshot, reason.inviteeIds || []),
    text: reason.text
  };
}

function namesForIds(snapshot, ids) {
  return ids.map(function (id) {
    var inv = snapshot.invitees.filter(function (i) { return i.inviteeId === id; })[0];
    return { inviteeId: id, name: inv ? inv.name : id };
  });
}

function namesByAnswer(snapshot, latest, slotId, answer) {
  return snapshot.invitees.filter(function (inv) {
    var v = latest.get ? latest.get(Sched.votes.keyOf(inv.inviteeId, slotId)) : null;
    return v && v.answer === answer;
  }).map(function (i) { return i.name; });
}

function currentDeadline(poll) {
  return poll.slateVersion === 2 ? poll.round2DeadlineUtc : poll.round1DeadlineUtc;
}
