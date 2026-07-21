var Sched = globalThis.Sched = globalThis.Sched || {};

function key(inviteeId, slotId) { return inviteeId + "|" + slotId; }

function newer(a, b) {
  if (a.rev !== b.rev) return a.rev > b.rev;
  return (a.atUtc || 0) >= (b.atUtc || 0);
}

Sched.votes = {
  keyOf: key,

  /** Latest recorded vote per (inviteeId, slotId), keyed "inviteeId|slotId". */
  latest: function (snapshot) {
    var map = new Map();
    (snapshot.votes || []).forEach(function (v) {
      var k = key(v.inviteeId, v.slotId);
      var cur = map.get(k);
      if (!cur || newer(v, cur)) map.set(k, v);
    });
    return map;
  },

  /** {works, ifneeded, cant} over the latest votes on a slot. */
  counts: function (snapshot, slotId) {
    var out = { works: 0, ifneeded: 0, cant: 0 };
    this.latest(snapshot).forEach(function (v) {
      if (v.slotId === slotId && out.hasOwnProperty(v.answer)) out[v.answer] += 1;
    });
    return out;
  }
};

if (typeof module !== "undefined") module.exports = Sched;
