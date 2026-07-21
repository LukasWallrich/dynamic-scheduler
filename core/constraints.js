var Sched = globalThis.Sched = globalThis.Sched || {};

function bandOf(hour) {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

/** A "YYYY-MM-DD" date as the UTC instant of its local midnight. */
function dateToUtc(dateStr) {
  var parts = String(dateStr).split("-");
  return Date.UTC(+parts[0], +parts[1] - 1, +parts[2]);
}
var mondayOfWeek = dateToUtc;

Sched.constraints = {
  /** True if a single veto excludes a slot, interpreted in the given timezone. */
  vetoesSlot: function (constraint, slot, tz) {
    var p = Sched.universe.localParts(slot.startUtc, tz);
    if (constraint.type === "dow") return p.weekday === Number(constraint.value);
    if (constraint.type === "band") return bandOf(p.hour) === constraint.value;
    var slotDay = Date.UTC(p.year, p.month - 1, p.day);
    if (constraint.type === "week") {
      var monday = dateToUtc(constraint.value);
      return slotDay >= monday && slotDay < monday + 7 * 86400000;
    }
    // "range": an absence period painted over the calendar. value = "YYYY-MM-DD/YYYY-MM-DD"
    // (inclusive of both endpoints), interpreted by the slot's date in the invitee's tz.
    if (constraint.type === "range") {
      var ends = String(constraint.value).split("/");
      return slotDay >= dateToUtc(ends[0]) && slotDay <= dateToUtc(ends[1]);
    }
    return false;
  },

  /** Constraints a given invitee has declared. */
  forInvitee: function (snapshot, inviteeId) {
    return (snapshot.constraints || []).filter(function (c) {
      return c.inviteeId === inviteeId;
    });
  },

  /** "cant" if the invitee has no explicit vote but a veto hits the slot, else null. */
  predictedAnswer: function (snapshot, inviteeId, slot) {
    var explicit = Sched.votes.latest(snapshot).get(Sched.votes.keyOf(inviteeId, slot.slotId));
    if (explicit) return null;
    var tz = snapshot.poll.tz;
    var hit = this.forInvitee(snapshot, inviteeId).some(function (c) {
      return Sched.constraints.vetoesSlot(c, slot, tz);
    });
    return hit ? "cant" : null;
  },

  /** Surfaced-correction case: an explicit yes that contradicts the person's own veto. */
  contradiction: function (snapshot, inviteeId, slot) {
    var explicit = Sched.votes.latest(snapshot).get(Sched.votes.keyOf(inviteeId, slot.slotId));
    if (!explicit || explicit.answer === "cant") return null;
    var tz = snapshot.poll.tz;
    var veto = this.forInvitee(snapshot, inviteeId).filter(function (c) {
      return Sched.constraints.vetoesSlot(c, slot, tz);
    })[0];
    if (!veto) return null;
    return { inviteeId: inviteeId, slotId: slot.slotId, answer: explicit.answer, veto: veto };
  }
};

if (typeof module !== "undefined") module.exports = Sched;
