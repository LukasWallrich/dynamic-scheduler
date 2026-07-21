var Sched = globalThis.Sched = globalThis.Sched || {};

var MS_PER_HOUR = 3600000;
var DAY_MS = 86400000;

function isRequired(inv) { return inv.required && !inv.demoted; }
function isOptional(inv) { return !!inv.demoted; }
function countsToward(inv) { return !inv.demoted; } // required + ordinary; optional excluded

function liveSlots(snapshot) {
  return snapshot.slots.filter(function (s) {
    return s.kind !== "dropped" && s.kind !== "rejected";
  });
}

/** The slate currently presented to invitees (never the bench). */
function slateSlots(snapshot) {
  return liveSlots(snapshot).filter(function (s) {
    return s.kind !== "bench" && s.slateVersion === snapshot.poll.slateVersion;
  });
}

function slotById(snapshot, slotId) {
  return snapshot.slots.filter(function (s) { return s.slotId === slotId; })[0];
}

/** Per-slot tally of the latest recorded votes, split by invitee tier. */
function tally(snapshot, slotId) {
  var latest = Sched.votes.latest(snapshot);
  var t = {
    requiredWorks: 0, works: 0, ifneeded: 0,
    attending: 0, absent: 0,
    requiredSilent: 0, requiredCant: 0,
    silentCounting: 0
  };
  snapshot.invitees.forEach(function (inv) {
    if (!countsToward(inv)) return; // demoted/optional contribute nothing to the tally
    var v = latest.get(Sched.votes.keyOf(inv.inviteeId, slotId));
    var ans = v ? v.answer : null;
    if (ans === "works" || ans === "ifneeded") t.attending += 1;
    if (ans === "works") t.works += 1;
    if (ans === "ifneeded") t.ifneeded += 1;
    if (ans === "works" && isRequired(inv)) t.requiredWorks += 1;
    if (ans === "cant") t.absent += 1;
    if (isRequired(inv)) {
      if (!ans) t.requiredSilent += 1;
      if (ans === "cant") t.requiredCant += 1;
    }
    if (!ans) t.silentCounting += 1;
  });
  return t;
}

function requiredIds(snapshot) {
  return snapshot.invitees.filter(isRequired).map(function (i) { return i.inviteeId; });
}

/** Human-readable reasons naming people — organizer-facing only. */
function blockReasons(snapshot, slot) {
  var latest = Sched.votes.latest(snapshot);
  var reasons = [];
  var blockers = [];
  snapshot.invitees.forEach(function (inv) {
    if (!isRequired(inv)) return;
    var v = latest.get(Sched.votes.keyOf(inv.inviteeId, slot.slotId));
    if (v && v.answer === "cant") blockers.push(inv);
  });
  if (blockers.length) {
    reasons.push({
      rule: "required_cant", inviteeIds: blockers.map(function (i) { return i.inviteeId; }),
      text: blockers.map(function (i) { return i.name; }).join(", ") +
        (blockers.length > 1 ? " (required) can't make it" : " (required) can't make it")
    });
  }
  if (slot.kind === "dropped" || slot.kind === "rejected") {
    reasons.push({ rule: "excluded", inviteeIds: [], text: "Slot excluded by the organizer" });
  }
  return reasons;
}

Sched.engine = {
  liveSlots: liveSlots,

  /** Success rule on recorded votes. At a deadline, ordinary silence counts absent. */
  feasible: function (snapshot, slotId, atDeadline) {
    var slot = slotById(snapshot, slotId);
    if (!slot || slot.kind === "dropped" || slot.kind === "rejected") return false;
    var poll = snapshot.poll;
    var t = tally(snapshot, slotId);
    if (t.requiredCant > 0) return false;
    if (t.requiredSilent > 0) return false; // required must have a recorded yes
    var absent = atDeadline ? t.absent + t.silentCounting : t.absent;
    return t.attending >= poll.minAttendees && absent <= poll.maxAbsences;
  },

  slotStatus: function (snapshot, slotId, nowUtc) {
    var slot = slotById(snapshot, slotId);
    var poll = snapshot.poll;
    var t = tally(snapshot, slotId);
    if (!slot || slot.kind === "dropped" || slot.kind === "rejected" || t.requiredCant > 0) {
      return { status: "blocked", reasons: slot ? blockReasons(snapshot, slot) : [] };
    }
    if (this.feasible(snapshot, slotId, false)) {
      return { status: "bookable", reasons: [] };
    }
    // Optimistic upper bound: every counting silent voter says works.
    var maxAttending = t.attending + t.silentCounting;
    var minAbsent = t.absent; // silence cannot lower absent below explicit Can'ts
    var requiredReachable = t.requiredCant === 0; // silent required could still say yes
    var reachable = requiredReachable &&
      maxAttending >= poll.minAttendees && minAbsent <= poll.maxAbsences;
    if (!reachable) {
      var reasons = [];
      if (maxAttending < poll.minAttendees) {
        reasons.push({ rule: "min_attendees", inviteeIds: [],
          text: "Can't reach " + poll.minAttendees + " attendees even if everyone left says works" });
      }
      if (minAbsent > poll.maxAbsences) {
        reasons.push({ rule: "max_absences", inviteeIds: absentIds(snapshot, slotId),
          text: "Too many Can'ts (" + minAbsent + " > " + poll.maxAbsences + ")" });
      }
      return { status: "doomed", reasons: reasons };
    }
    return { status: "alive", reasons: [] };
  },

  /** Total order: required-Works, Works, fewer If-needed, listing order, earliest start. */
  compare: function (snapshot, slotIdA, slotIdB) {
    return compareProfiles(profile(snapshot, slotIdA, false), profile(snapshot, slotIdB, false));
  },

  pickWinner: function (snapshot, nowUtc) {
    var self = this;
    var live = slateSlots(snapshot);
    var deadlinePassed = roundDeadlinePassed(snapshot, nowUtc);
    // At the deadline ordinary silence counts as absent, so feasibility must be
    // re-judged under deadline semantics or max_absences can be violated.
    var feasibleSlots = live.filter(function (s) {
      return self.feasible(snapshot, s.slotId, deadlinePassed);
    });
    if (!feasibleSlots.length) return null;

    feasibleSlots.sort(function (a, b) {
      return compareProfiles(profile(snapshot, a.slotId, false), profile(snapshot, b.slotId, false));
    });
    var winner = feasibleSlots[0];
    var winnerActual = profile(snapshot, winner.slotId, false);
    var earlyDecidable = live.every(function (rival) {
      if (rival.slotId === winner.slotId) return true;
      var st = self.slotStatus(snapshot, rival.slotId, nowUtc).status;
      if (st === "blocked" || st === "doomed") return true;
      var rivalOpt = profile(snapshot, rival.slotId, true);
      return compareProfiles(winnerActual, rivalOpt) < 0; // winner strictly ahead of rival's best case
    });

    if (!earlyDecidable && !deadlinePassed) return null;

    return {
      slotId: winner.slotId,
      justification: {
        winner: winnerActual,
        basis: earlyDecidable ? "early_upper_bound" : "deadline_tiebreak",
        rivals: live.filter(function (s) { return s.slotId !== winner.slotId; })
          .map(function (s) { return { slotId: s.slotId, optimistic: profile(snapshot, s.slotId, true) }; })
      }
    };
  },

  /** Instant the pivot auto-launches (working-hours delay after the proposal). */
  pivotDueUtc: function (poll) {
    if (!poll.pivotProposedAtUtc) return null;
    return Sched.universe.addWorkingHours(
      poll.pivotProposedAtUtc, poll.pivotDelayHours, poll.workingHours, poll.tz);
  },

  advance: function (snapshot, nowUtc) {
    return advance(snapshot, nowUtc);
  }
};

function absentIds(snapshot, slotId) {
  var latest = Sched.votes.latest(snapshot);
  return snapshot.invitees.filter(function (inv) {
    if (!countsToward(inv)) return false;
    var v = latest.get(Sched.votes.keyOf(inv.inviteeId, slotId));
    return v && v.answer === "cant";
  }).map(function (i) { return i.inviteeId; });
}

/** Comparable vote profile of a slot; optimistic assumes counting-silent -> works. */
function profile(snapshot, slotId, optimistic) {
  var latest = Sched.votes.latest(snapshot);
  var slot = slotById(snapshot, slotId);
  var p = { requiredWorks: 0, works: 0, ifneeded: 0, index: slotIndex(snapshot, slotId),
    start: slot ? slot.startUtc : Infinity };
  snapshot.invitees.forEach(function (inv) {
    if (!countsToward(inv)) return; // demoted/optional never enter the comparator profile
    var v = latest.get(Sched.votes.keyOf(inv.inviteeId, slotId));
    var ans = v ? v.answer : null;
    if (!ans && optimistic) ans = "works";
    if (ans === "works") { p.works += 1; if (isRequired(inv)) p.requiredWorks += 1; }
    if (ans === "ifneeded") p.ifneeded += 1;
  });
  return p;
}

function compareProfiles(a, b) {
  if (a.requiredWorks !== b.requiredWorks) return b.requiredWorks - a.requiredWorks;
  if (a.works !== b.works) return b.works - a.works;
  if (a.ifneeded !== b.ifneeded) return a.ifneeded - b.ifneeded;
  if (a.index !== b.index) return a.index - b.index;
  return a.start - b.start;
}

function slotIndex(snapshot, slotId) {
  for (var i = 0; i < snapshot.slots.length; i++) {
    if (snapshot.slots[i].slotId === slotId) return i;
  }
  return 999;
}

function roundDeadline(snapshot) {
  var poll = snapshot.poll;
  return poll.slateVersion === 2 ? poll.round2DeadlineUtc : poll.round1DeadlineUtc;
}

function roundDeadlinePassed(snapshot, nowUtc) {
  var dl = roundDeadline(snapshot);
  return dl != null && nowUtc >= dl;
}

/**
 * Required people who lack a recorded vote on at least one live slate slot of the
 * current version — either such slot could be the winner, so grace must still fire.
 */
function silentRequired(snapshot) {
  var latest = Sched.votes.latest(snapshot);
  var live = slateSlots(snapshot);
  return snapshot.invitees.filter(function (inv) {
    if (!isRequired(inv)) return false;
    return live.some(function (s) {
      return !latest.get(Sched.votes.keyOf(inv.inviteeId, s.slotId));
    });
  });
}

/** Invitees with no recorded vote on any live slot. */
function nonResponders(snapshot) {
  var latest = Sched.votes.latest(snapshot);
  var live = slateSlots(snapshot);
  return snapshot.invitees.filter(function (inv) {
    return live.every(function (s) {
      return !latest.get(Sched.votes.keyOf(inv.inviteeId, s.slotId));
    });
  });
}

function allDoomedOrBlocked(snapshot, nowUtc) {
  var live = slateSlots(snapshot);
  if (!live.length) return true;
  return live.every(function (s) {
    var st = Sched.engine.slotStatus(snapshot, s.slotId, nowUtc).status;
    return st === "doomed" || st === "blocked";
  });
}

function effect(type, key, payload) {
  var e = { type: type, idempotencyKey: key };
  if (payload) Object.keys(payload).forEach(function (k) { e[k] = payload[k]; });
  return e;
}

function inviteEffects(snapshot, type, tag) {
  return snapshot.invitees.filter(function (inv) { return !inv.organizer; }).map(function (inv) {
    return effect(type, snapshot.poll.pollId + ":" + tag + ":" + inv.inviteeId,
      { inviteeId: inv.inviteeId });
  });
}

function noop(snapshot) {
  return { state: snapshot.poll.state, pollPatch: {}, slotPatches: [], effects: [] };
}

function transition(snapshot, state, pollPatch, effects, slotPatches) {
  return {
    state: state,
    pollPatch: pollPatch || {},
    slotPatches: slotPatches || [],
    effects: effects || []
  };
}

function advance(snapshot, nowUtc) {
  var poll = snapshot.poll;
  switch (poll.state) {
    case "SETUP": return advanceSetup(snapshot, nowUtc);
    case "ROUND1": return advanceRound(snapshot, nowUtc);
    case "ROUND2": return advanceRound(snapshot, nowUtc);
    case "PIVOT_PENDING": return advancePivotPending(snapshot, nowUtc);
    case "REQUIRED_GRACE": return advanceGrace(snapshot, nowUtc);
    case "HOLD": return advanceHold(snapshot, nowUtc);
    case "BOOKING": return advanceBooking(snapshot, nowUtc);
    case "BOOKING_FAILED":
      return transition(snapshot, "BOOKING_FAILED", {},
        [effect("SEND_BOOKING_FAILED", poll.pollId + ":BOOKING_FAILED", {})]);
    case "ESCALATE":
      return transition(snapshot, "ESCALATE", {},
        [effect("SEND_ESCALATE", poll.pollId + ":ESCALATE:v" + poll.slateVersion, {})]);
    default: return noop(snapshot);
  }
}

function advanceSetup(snapshot, nowUtc) {
  return transition(snapshot, "ROUND1", {}, inviteEffects(snapshot, "SEND_INVITE", "INVITE"));
}

function advanceRound(snapshot, nowUtc) {
  var poll = snapshot.poll;
  var isRound2 = poll.slateVersion === 2;

  var win = Sched.engine.pickWinner(snapshot, nowUtc);
  if (win) {
    return transition(snapshot, "HOLD",
      { holdSlotId: win.slotId, holdStartedAtUtc: nowUtc,
        holdJustification: JSON.stringify(win.justification) },
      [effect("SEND_HOLD_APPROVAL", poll.pollId + ":HOLD:" + win.slotId + ":" + nowUtc,
        { slotId: win.slotId })]);
  }

  if (allDoomedOrBlocked(snapshot, nowUtc)) {
    if (isRound2) {
      return transition(snapshot, "ESCALATE", {},
        [effect("SEND_ESCALATE", poll.pollId + ":ESCALATE:v" + poll.slateVersion, {})]);
    }
    return transition(snapshot, "PIVOT_PENDING",
      { pivotProposedAtUtc: nowUtc },
      [effect("SEND_PIVOT_PROPOSAL", poll.pollId + ":PIVOT_PROPOSAL:v" + poll.slateVersion, {})]);
  }

  if (roundDeadlinePassed(snapshot, nowUtc)) {
    var silent = silentRequired(snapshot);
    if (silent.length) {
      return transition(snapshot, "REQUIRED_GRACE",
        { graceRound: poll.slateVersion, requiredGraceUntilUtc: nowUtc + 24 * MS_PER_HOUR },
        silent.filter(function (inv) { return !inv.organizer; }).map(function (inv) {
          return effect("SEND_REQUIRED_GRACE",
            poll.pollId + ":REQUIRED_GRACE:v" + poll.slateVersion + ":" + inv.inviteeId,
            { inviteeId: inv.inviteeId });
        }));
    }
    var deadlineWin = Sched.engine.pickWinner(snapshot, nowUtc);
    if (deadlineWin) {
      return transition(snapshot, "HOLD",
        { holdSlotId: deadlineWin.slotId, holdStartedAtUtc: nowUtc,
          holdJustification: JSON.stringify(deadlineWin.justification) },
        [effect("SEND_HOLD_APPROVAL", poll.pollId + ":HOLD:" + deadlineWin.slotId + ":" + nowUtc,
          { slotId: deadlineWin.slotId })]);
    }
    if (isRound2) {
      return transition(snapshot, "ESCALATE", {},
        [effect("SEND_ESCALATE", poll.pollId + ":ESCALATE:v" + poll.slateVersion, {})]);
    }
    return transition(snapshot, "PIVOT_PENDING",
      { pivotProposedAtUtc: nowUtc },
      [effect("SEND_PIVOT_PROPOSAL", poll.pollId + ":PIVOT_PROPOSAL:v" + poll.slateVersion, {})]);
  }

  return reminderPass(snapshot, nowUtc);
}

function reminderPass(snapshot, nowUtc) {
  var poll = snapshot.poll;
  var dl = roundDeadline(snapshot);
  if (dl == null) return noop(snapshot);
  var roundStart = poll.slateVersion === 2
    ? (poll.pivotProposedAtUtc || poll.createdAtUtc)
    : poll.createdAtUtc;
  // Guard: a missing/invalid roundStart would make the midpoint ~half of a huge epoch
  // (a 1998 timestamp), firing reminders on the first tick. Never remind without a
  // trustworthy round start.
  if (typeof roundStart !== "number" || !isFinite(roundStart) || roundStart <= 0) {
    return noop(snapshot);
  }
  var midpoint = roundStart + (dl - roundStart) / 2;
  if (nowUtc < midpoint) return noop(snapshot);
  var tag = poll.slateVersion === 2 ? "REMINDER2" : "REMINDER1";
  var effects = nonResponders(snapshot)
    .filter(function (inv) { return !inv.organizer; })
    .map(function (inv) {
      return effect("SEND_REMINDER", poll.pollId + ":" + tag + ":" + inv.inviteeId,
        { inviteeId: inv.inviteeId });
    });
  return { state: poll.state, pollPatch: {}, slotPatches: [], effects: effects };
}

function advancePivotPending(snapshot, nowUtc) {
  var poll = snapshot.poll;

  // Misclick / revision grace. Return to the round only when (a) a slate slot is now
  // feasible on recorded votes (a winner can be picked), or (b) not every slot is
  // doomed/blocked AND the round deadline has not passed (the correction window).
  // Otherwise stay put — a still-alive-but-infeasible slot after the deadline must not
  // bounce back to a round that would only re-pivot (the ROUND1<->PIVOT oscillation).
  var slate1Feasible = slateSlots(snapshot).some(function (s) {
    return Sched.engine.feasible(snapshot, s.slotId, false);
  });
  var deadlinePassed = roundDeadlinePassed(snapshot, nowUtc);
  if (slate1Feasible || (!allDoomedOrBlocked(snapshot, nowUtc) && !deadlinePassed)) {
    return transition(snapshot, "ROUND1", { pivotProposedAtUtc: null }, []);
  }

  var slate2 = liveSlots(snapshot).filter(function (s) { return s.slateVersion === 2; });
  var latest = Sched.votes.latest(snapshot);
  var organizer = snapshot.invitees.filter(function (i) { return i.organizer; })[0];
  var due = Sched.engine.pivotDueUtc(poll);
  var autoLaunch = due != null && nowUtc >= due;
  // Manual launch: the shell records the organizer's votes, then sets launchApprovedAtUtc.
  var launch = poll.launchApprovedAtUtc != null || autoLaunch;

  if (slate2.length > 0 && launch) {
    var roundLen = (poll.round1DeadlineUtc || poll.createdAtUtc) - poll.createdAtUtc;
    if (!roundLen || roundLen < 0) roundLen = 2 * DAY_MS;
    // Contact only invitees with an unscored slate-2 slot (poll.slateVersion is still 1 here).
    var effects = snapshot.invitees
      .filter(function (inv) { return !inv.organizer; })
      .filter(function (inv) {
        return slate2.some(function (s) {
          return !latest.get(Sched.votes.keyOf(inv.inviteeId, s.slotId));
        });
      })
      .map(function (inv) {
        return effect("SEND_ROUND2_ASK", poll.pollId + ":ROUND2_ASK:" + inv.inviteeId,
          { inviteeId: inv.inviteeId });
      });
    var res = transition(snapshot, "ROUND2",
      { slateVersion: 2, round2DeadlineUtc: nowUtc + roundLen }, effects);
    // Auto-launch: record the organizer's Works prefills on every slate-2 slot they
    // haven't voted on, else required silence blocks every rescue slot forever.
    if (autoLaunch && poll.launchApprovedAtUtc == null && organizer) {
      res.voteRecords = slate2
        .filter(function (s) {
          return !latest.get(Sched.votes.keyOf(organizer.inviteeId, s.slotId));
        })
        .map(function (s) {
          return { inviteeId: organizer.inviteeId, slotId: s.slotId,
            answer: "works", provenance: "prefill" };
        });
    }
    return res;
  }

  return noop(snapshot);
}

function advanceGrace(snapshot, nowUtc) {
  var poll = snapshot.poll;
  var silent = silentRequired(snapshot);

  if (!silent.length) {
    var resumed = poll.graceRound === 2 ? "ROUND2" : "ROUND1";
    return transition(snapshot, resumed, { requiredGraceUntilUtc: null, graceRound: null }, []);
  }

  if (nowUtc >= poll.requiredGraceUntilUtc) {
    return transition(snapshot, "REQUIRED_GRACE", {},
      [effect("SEND_REQUIRED_STUCK", poll.pollId + ":REQUIRED_STUCK:" + poll.requiredGraceUntilUtc, {})]);
  }

  return noop(snapshot);
}

function advanceHold(snapshot, nowUtc) {
  var poll = snapshot.poll;
  var slotId = poll.holdSlotId;

  // holdForced (escalate "book least-bad") deliberately books a slot the success rule
  // rejects, so it skips this feasibility gate. The calendar recheck before CREATE_EVENT
  // still applies, and a required-organizer Can't recorded via calendarBusy still blocks
  // there. When the hold is instead ABANDONED (a revision or rejection broke it), drop
  // the slot, recompute the round, and clear holdForced so no later hold inherits it.
  if (!poll.holdForced && !Sched.engine.feasible(snapshot, slotId, false)) {
    var resumed = poll.slateVersion === 2 ? "ROUND2" : "ROUND1";
    var patches = organizerRejected(snapshot, slotId)
      ? [{ slotId: slotId, kind: "rejected" }] : [];
    return transition(snapshot, resumed,
      { holdSlotId: null, holdStartedAtUtc: null, holdJustification: null, holdForced: null },
      [], patches);
  }

  // Organizer approval books immediately; the 24h timer is the no-reaction fallback.
  if (poll.holdApprovedAtUtc != null) {
    return transition(snapshot, "BOOKING", {}, []);
  }
  if (nowUtc >= poll.holdStartedAtUtc + 24 * MS_PER_HOUR) {
    return transition(snapshot, "BOOKING", {}, []);
  }

  return noop(snapshot);
}

function organizerRejected(snapshot, slotId) {
  var organizer = snapshot.invitees.filter(function (i) { return i.organizer; })[0];
  if (!organizer) return false;
  var v = Sched.votes.latest(snapshot).get(Sched.votes.keyOf(organizer.inviteeId, slotId));
  return !!(v && v.answer === "cant");
}

function advanceBooking(snapshot, nowUtc) {
  var poll = snapshot.poll;
  if (poll.calendarEventId) {
    return transition(snapshot, "BOOKED", {}, []);
  }
  return transition(snapshot, "BOOKING", {},
    [effect("CREATE_EVENT",
      poll.pollId + ":CREATE_EVENT:" + poll.holdSlotId + ":" + poll.holdStartedAtUtc,
      { slotId: poll.holdSlotId })]);
}

if (typeof module !== "undefined") module.exports = Sched;
