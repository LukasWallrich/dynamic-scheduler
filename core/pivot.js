var Sched = globalThis.Sched = globalThis.Sched || {};

var W_WORKS = 3;
var W_IFNEEDED = 1;
var PENALTY_PREDICTED_CANT = 4;

function isRequired(inv) { return inv.required && !inv.demoted; }
function bandOf(hour) { return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"; }

/** Score a candidate slot and collect people-naming reasoning fragments. */
function scoreCandidate(snapshot, slot) {
  var poll = snapshot.poll;
  var latest = Sched.votes.latest(snapshot);
  var score = 0;
  var reasons = [];
  var reachable = 0; // people who could attend (not predicted/known Can't)

  snapshot.invitees.forEach(function (inv) {
    if (inv.demoted) return; // demoted people never count toward quorum or scoring
    var v = latest.get(Sched.votes.keyOf(inv.inviteeId, slot.slotId));
    var ans = v ? v.answer : null;
    var predicted = ans ? null : Sched.constraints.predictedAnswer(snapshot, inv.inviteeId, slot);
    if (ans === "works") {
      score += W_WORKS; reachable += 1;
      reasons.push(inv.name + " works");
    } else if (ans === "ifneeded") {
      score += W_IFNEEDED; reachable += 1;
      reasons.push(inv.name + " if needed");
    } else if (ans === "cant") {
      reasons.push(inv.name + " can't");
    } else if (predicted === "cant") {
      score -= PENALTY_PREDICTED_CANT;
      var veto = Sched.constraints.forInvitee(snapshot, inv.inviteeId).filter(function (c) {
        return Sched.constraints.vetoesSlot(c, slot, poll.tz);
      })[0];
      reasons.push(inv.name + " likely can't (" + vetoLabel(veto) + ")");
      // predicted Can't does not by itself remove reachability for ordinary people,
      // but counts against the score; required predicted-Can't is gated out earlier.
      reachable += 0;
    } else {
      reachable += 1; // unasked/unknown: never treated as opposed
    }
  });

  return { score: score, reasons: reasons, reachable: reachable };
}

function vetoLabel(veto) {
  if (!veto) return "veto";
  if (veto.type === "dow") return "no that weekday";
  if (veto.type === "band") return "no " + veto.value + "s";
  if (veto.type === "week") return "week of " + veto.value;
  return "veto";
}

/** Hard gate: a required attendee's veto or recorded Can't excludes the candidate. */
function requiredGatePasses(snapshot, slot) {
  var latest = Sched.votes.latest(snapshot);
  return snapshot.invitees.every(function (inv) {
    if (!isRequired(inv)) return true;
    var v = latest.get(Sched.votes.keyOf(inv.inviteeId, slot.slotId));
    if (v && v.answer === "cant") return false;
    if (!v && Sched.constraints.predictedAnswer(snapshot, inv.inviteeId, slot) === "cant") return false;
    return true;
  });
}

Sched.pivot = {
  /**
   * { slots, alternates } — hard gates, then scoring, then diversity outside scoring.
   * `slots` is the proposed slate (<=3); `alternates` the ranked runners-up (cap ~6)
   * the shell keeps for a Can't-at-launch swap. `benchSlotId` is set when a candidate
   * IS an existing bench slot; a universe candidate on the same window is deduped away
   * in the bench's favor so the bench's carried votes follow the promotion.
   */
  rescueSlate: function (snapshot, freeWindows, nowUtc) {
    var poll = snapshot.poll;
    var candidates = [];
    var benchWindows = {};
    snapshot.slots.filter(function (s) { return s.kind === "bench"; }).forEach(function (s) {
      benchWindows[s.startUtc + ":" + s.endUtc] = true;
      candidates.push({ startUtc: s.startUtc, endUtc: s.endUtc, kind: "bench", slotId: s.slotId });
    });
    Sched.universe.candidateStarts(poll, freeWindows).forEach(function (start) {
      var end = start + poll.durationMins * 60000;
      if (benchWindows[start + ":" + end]) return; // dedupe: the bench slot owns this window
      candidates.push({ startUtc: start, endUtc: end, kind: "new" });
    });

    var scored = candidates
      .filter(function (c) { return requiredGatePasses(snapshot, c); })
      .filter(function (c) { return quorumReachable(snapshot, c); })
      .map(function (c) {
        var s = scoreCandidate(snapshot, c);
        return { startUtc: c.startUtc, endUtc: c.endUtc,
          benchSlotId: c.kind === "bench" ? c.slotId : null,
          score: s.score, reasons: s.reasons };
      });

    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.startUtc - b.startUtc;
    });

    var slots = pickDiverse(scored, poll);
    var chosen = {};
    slots.forEach(function (c) { chosen[c.startUtc + ":" + c.endUtc] = true; });
    var alternates = scored.filter(function (c) {
      return !chosen[c.startUtc + ":" + c.endUtc];
    }).slice(0, 6);

    return { slots: slots.map(shape), alternates: alternates.map(shape) };
  }
};

function shape(c) {
  return { startUtc: c.startUtc, endUtc: c.endUtc,
    benchSlotId: c.benchSlotId || null, reasoning: buildReasoning(c) };
}

function quorumReachable(snapshot, slot) {
  var poll = snapshot.poll;
  var s = scoreCandidate(snapshot, slot);
  return s.reachable >= poll.minAttendees;
}

function buildReasoning(candidate) {
  return candidate.reasons.join("; ");
}

/** Best, then best on a different day, then best in a different band; fall back unrestricted. */
function pickDiverse(scored, poll) {
  if (!scored.length) return [];
  var picked = [scored[0]];
  var dayKey = function (c) { return Sched.universe.localParts(c.startUtc, poll.tz).dateKey; };
  var bandKey = function (c) {
    return bandOf(Sched.universe.localParts(c.startUtc, poll.tz).hour);
  };

  var differentDay = scored.slice(1).filter(function (c) {
    return dayKey(c) !== dayKey(picked[0]);
  })[0];
  if (differentDay) picked.push(differentDay);

  var usedBands = picked.map(bandKey);
  var differentBand = scored.filter(function (c) {
    return picked.indexOf(c) < 0 && usedBands.indexOf(bandKey(c)) < 0;
  })[0];
  if (differentBand) picked.push(differentBand);

  for (var i = 0; i < scored.length && picked.length < 3; i++) {
    if (picked.indexOf(scored[i]) < 0) picked.push(scored[i]);
  }
  return picked.slice(0, 3);
}

if (typeof module !== "undefined") module.exports = Sched;
