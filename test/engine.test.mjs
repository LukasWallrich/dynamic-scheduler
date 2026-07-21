import { test } from "node:test";
import assert from "node:assert/strict";
import { Sched } from "./_load.mjs";
import { q3Snapshot, londonToUtc } from "./_fixture.mjs";

let rev = 0;
function vote(snap, inviteeId, slotId, answer, provenance = "explicit_slate") {
  snap.votes.push({ inviteeId, slotId, answer, provenance, rev: ++rev, atUtc: rev });
}

test("required Can't blocks a slot; ordinary Can't does not", () => {
  const snap = q3Snapshot();
  vote(snap, "maya", "s1", "cant"); // Maya required
  assert.equal(Sched.engine.slotStatus(snap, "s1", snap.poll.createdAtUtc).status, "blocked");
  const snap2 = q3Snapshot();
  vote(snap2, "priya", "s2", "cant"); // ordinary
  assert.notEqual(Sched.engine.slotStatus(snap2, "s2", snap2.poll.createdAtUtc).status, "blocked");
});

test("slot is doomed when explicit Can'ts exceed max_absences", () => {
  const snap = q3Snapshot();
  vote(snap, "priya", "s3", "cant");
  vote(snap, "jonas", "s3", "cant");
  vote(snap, "sofia", "s3", "cant"); // 3 > maxAbsences 2
  assert.equal(Sched.engine.slotStatus(snap, "s3", snap.poll.createdAtUtc).status, "doomed");
});

test("feasible needs every required attendee's recorded yes", () => {
  const snap = q3Snapshot();
  vote(snap, "alex", "s1", "works");
  vote(snap, "priya", "s1", "works");
  vote(snap, "tom", "s1", "works");
  vote(snap, "sofia", "s1", "works"); // attending 4, but Maya (required) silent
  assert.equal(Sched.engine.feasible(snap, "s1", false), false);
  vote(snap, "maya", "s1", "ifneeded");
  assert.equal(Sched.engine.feasible(snap, "s1", false), true);
});

test("at a deadline ordinary silence counts absent; required silence blocks feasibility", () => {
  const snap = q3Snapshot();
  vote(snap, "alex", "s1", "works");
  vote(snap, "maya", "s1", "works");
  vote(snap, "priya", "s1", "works");
  vote(snap, "jonas", "s1", "works"); // attending 4; Tom, Sofia silent
  assert.equal(Sched.engine.feasible(snap, "s1", false), true);
  // At the deadline Tom+Sofia silence -> 2 absent, still <= maxAbsences 2.
  assert.equal(Sched.engine.feasible(snap, "s1", true), true);
});

test("compare orders by required-Works, then Works, then fewer If-needed", () => {
  const snap = q3Snapshot();
  vote(snap, "maya", "s1", "works"); // required works on s1
  vote(snap, "maya", "s2", "ifneeded");
  vote(snap, "priya", "s2", "works");
  // s1 has more required-Works -> ranks first (compare < 0).
  assert.ok(Sched.engine.compare(snap, "s1", "s2") < 0);
});

test("pickWinner decides early when rivals are blocked", () => {
  const snap = q3Snapshot();
  // s1 feasible; s2, s3 blocked by required Maya.
  vote(snap, "alex", "s1", "works");
  vote(snap, "maya", "s1", "works");
  vote(snap, "priya", "s1", "works");
  vote(snap, "tom", "s1", "works");
  vote(snap, "maya", "s2", "cant");
  vote(snap, "maya", "s3", "cant");
  const win = Sched.engine.pickWinner(snap, snap.poll.createdAtUtc);
  assert.ok(win);
  assert.equal(win.slotId, "s1");
  assert.equal(win.justification.basis, "early_upper_bound");
});

test("pickWinner waits when a rival could still optimistically win", () => {
  const snap = q3Snapshot();
  vote(snap, "alex", "s1", "works");
  vote(snap, "maya", "s1", "works");
  vote(snap, "priya", "s1", "works");
  vote(snap, "tom", "s1", "works"); // s1 feasible; s2 wide open, everyone silent
  const win = Sched.engine.pickWinner(snap, snap.poll.createdAtUtc);
  assert.equal(win, null); // s2 optimistic (all works) outranks s1 -> not decidable yet
});

test("advance SETUP -> ROUND1 invites every non-organizer, idempotently", () => {
  const snap = q3Snapshot();
  const res = Sched.engine.advance(snap, snap.poll.createdAtUtc);
  assert.equal(res.state, "ROUND1");
  const invites = res.effects.filter((e) => e.type === "SEND_INVITE");
  assert.equal(invites.length, 5); // 6 invitees minus organizer
  assert.ok(invites.every((e) => e.idempotencyKey.startsWith("q3:INVITE:")));
});

test("advance performs no transition and no new effects when nothing is due", () => {
  const snap = q3Snapshot();
  snap.poll.state = "ROUND1";
  const now = snap.poll.createdAtUtc + 1000; // before the reminder midpoint
  const a = Sched.engine.advance(snap, now);
  assert.equal(a.state, "ROUND1");
  assert.equal(a.effects.length, 0);
  assert.equal(Object.keys(a.pollPatch).length, 0);
  assert.equal(a.slotPatches.length, 0);
});

test("pickWinner after the deadline judges feasibility with deadline semantics", () => {
  const snap = q3Snapshot();
  snap.poll.state = "ROUND1";
  snap.poll.maxAbsences = 1;
  vote(snap, "alex", "s1", "works");
  vote(snap, "maya", "s1", "works");
  vote(snap, "priya", "s1", "works");
  vote(snap, "jonas", "s1", "works"); // attending 4; Tom + Sofia silent
  assert.equal(Sched.engine.feasible(snap, "s1", false), true); // open round: 0 absences
  const afterDeadline = snap.poll.round1DeadlineUtc + 1;
  // At the deadline Tom + Sofia silence = 2 absent > maxAbsences 1 -> must not book.
  assert.equal(Sched.engine.feasible(snap, "s1", true), false);
  assert.equal(Sched.engine.pickWinner(snap, afterDeadline), null);
});

test("no oscillation: a deadline pivot with an alive-but-infeasible slate-1 slot stays put", () => {
  const snap = q3Snapshot();
  snap.poll.state = "PIVOT_PENDING";
  snap.poll.pivotProposedAtUtc = snap.poll.round1DeadlineUtc;
  vote(snap, "alex", "s1", "works"); // s1 optimistically alive (Maya could still say yes)
  const now = snap.poll.round1DeadlineUtc + 3600000; // deadline passed
  assert.equal(Sched.engine.slotStatus(snap, "s1", now).status, "alive");
  for (let i = 0; i < 5; i++) {
    const res = Sched.engine.advance(snap, now);
    assert.equal(res.state, "PIVOT_PENDING"); // never bounces back to the round
    snap.poll.state = res.state;
  }
});

test("demoted invitees never count toward min_attendees or the comparator", () => {
  const snap = q3Snapshot();
  snap.invitees.find((i) => i.inviteeId === "tom").demoted = true;
  vote(snap, "alex", "s1", "works");
  vote(snap, "maya", "s1", "works");
  vote(snap, "priya", "s1", "works");
  vote(snap, "tom", "s1", "works"); // demoted -> must not be the 4th attendee
  assert.equal(Sched.engine.feasible(snap, "s1", false), false);

  // Comparator: s1 (earlier in listing) has only a demoted Works; s2 a real Works.
  // Ignoring the demoted vote, s2 outranks s1 despite the listing order.
  const snap2 = q3Snapshot();
  snap2.invitees.find((i) => i.inviteeId === "tom").demoted = true;
  vote(snap2, "tom", "s1", "works");   // demoted -> ignored
  vote(snap2, "priya", "s2", "works"); // real ordinary Works
  assert.ok(Sched.engine.compare(snap2, "s1", "s2") > 0);
});

test("a required person who answered only some slots still triggers grace", () => {
  const snap = q3Snapshot();
  snap.poll.state = "ROUND1";
  vote(snap, "alex", "s1", "works");
  vote(snap, "alex", "s2", "works");
  vote(snap, "alex", "s3", "works");
  vote(snap, "maya", "s1", "works"); // Maya (required) silent on s2 and s3
  const afterDeadline = snap.poll.round1DeadlineUtc + 1;
  const res = Sched.engine.advance(snap, afterDeadline);
  assert.equal(res.state, "REQUIRED_GRACE");
  const grace = res.effects.filter((e) => e.type === "SEND_REQUIRED_GRACE");
  assert.deepEqual(grace.map((e) => e.inviteeId), ["maya"]);
  assert.ok(grace[0].idempotencyKey.includes(":v1:")); // grace key carries the slate version
});

function pivotReady() {
  const snap = q3Snapshot();
  snap.poll.state = "PIVOT_PENDING";
  snap.poll.pivotProposedAtUtc = snap.poll.round1DeadlineUtc;
  vote(snap, "maya", "s1", "cant");
  vote(snap, "maya", "s2", "cant");
  vote(snap, "maya", "s3", "cant"); // slate 1 all blocked -> no bounce back to the round
  snap.slots.push({ slotId: "r0", startUtc: londonToUtc(2026, 7, 29, 10, 0),
    endUtc: londonToUtc(2026, 7, 29, 11, 0), kind: "slate2", slateVersion: 2, proposerInviteeId: "" });
  snap.slots.push({ slotId: "r1", startUtc: londonToUtc(2026, 7, 30, 14, 0),
    endUtc: londonToUtc(2026, 7, 30, 15, 0), kind: "slate2", slateVersion: 2, proposerInviteeId: "" });
  return snap;
}

test("pivot auto-launch records the organizer's Works prefills; manual launch does not", () => {
  const snap = pivotReady();
  const now = londonToUtc(2026, 7, 28, 12, 0); // past the 4-working-hour auto-launch delay
  const res = Sched.engine.advance(snap, now);
  assert.equal(res.state, "ROUND2");
  assert.equal(res.voteRecords.length, 2); // one prefill per slate-2 slot
  res.voteRecords.forEach((vr) => {
    assert.equal(vr.inviteeId, "alex");
    assert.equal(vr.answer, "works");
    assert.equal(vr.provenance, "prefill");
  });

  // Manual launch: the shell recorded the organizer's votes and set launchApprovedAtUtc,
  // so the transition itself creates none.
  const snap2 = pivotReady();
  vote(snap2, "alex", "r0", "works", "prefill");
  vote(snap2, "alex", "r1", "works", "prefill");
  const early = londonToUtc(2026, 7, 25, 9, 0); // before the auto-launch is due
  snap2.poll.launchApprovedAtUtc = early;
  const res2 = Sched.engine.advance(snap2, early);
  assert.equal(res2.state, "ROUND2");
  assert.ok(!res2.voteRecords || res2.voteRecords.length === 0);
});

test("holdApprovedAtUtc books immediately, ahead of the 24h auto-book timer", () => {
  const snap = q3Snapshot();
  snap.poll.state = "HOLD";
  snap.poll.holdSlotId = "s1";
  snap.poll.holdStartedAtUtc = snap.poll.createdAtUtc;
  vote(snap, "alex", "s1", "works");
  vote(snap, "maya", "s1", "works");
  vote(snap, "priya", "s1", "works");
  vote(snap, "jonas", "s1", "works"); // s1 feasible
  const soon = snap.poll.createdAtUtc + 3600000; // 1h in, well inside the 24h window
  assert.equal(Sched.engine.advance(snap, soon).state, "HOLD"); // no auto-book yet
  snap.poll.holdApprovedAtUtc = soon;
  assert.equal(Sched.engine.advance(snap, soon).state, "BOOKING");
});

test("a re-armed hold produces a fresh approval effect key", () => {
  function heldKey(now) {
    const snap = q3Snapshot();
    snap.poll.state = "ROUND1";
    vote(snap, "alex", "s1", "works");
    vote(snap, "maya", "s1", "works");
    vote(snap, "priya", "s1", "works");
    vote(snap, "tom", "s1", "works"); // s1 feasible
    vote(snap, "maya", "s2", "cant");
    vote(snap, "maya", "s3", "cant"); // rivals blocked -> early decidable
    const res = Sched.engine.advance(snap, now);
    assert.equal(res.state, "HOLD");
    return res.effects.filter((e) => e.type === "SEND_HOLD_APPROVAL")[0].idempotencyKey;
  }
  const base = q3Snapshot().poll.createdAtUtc;
  const k1 = heldKey(base);
  const k2 = heldKey(base + 5 * 3600000);
  assert.ok(k1.startsWith("q3:HOLD:s1:"));
  assert.notEqual(k1, k2); // holdStartedAtUtc differs -> outbox can re-queue after a cancel
});

test("escalate holdForced books an infeasible slot; without it the hold recomputes", () => {
  function held(forced) {
    const snap = q3Snapshot();
    snap.poll.state = "HOLD";
    snap.poll.holdSlotId = "s1";
    snap.poll.holdStartedAtUtc = snap.poll.createdAtUtc;
    snap.poll.holdApprovedAtUtc = snap.poll.createdAtUtc; // organizer's least-bad choice
    vote(snap, "maya", "s1", "cant"); // required Maya blocks -> s1 infeasible
    snap.poll.holdForced = forced;
    return Sched.engine.advance(snap, snap.poll.createdAtUtc);
  }
  // Forced: skip the feasibility gate, book the explicitly chosen least-bad slot.
  assert.equal(held(true).state, "BOOKING");
  // Unforced: the infeasible slot bounces back to the round and holdForced is cleared.
  const recompute = held(false);
  assert.equal(recompute.state, "ROUND1");
  assert.equal(recompute.pollPatch.holdForced, null);
});

test("a re-armed booking after failure produces a fresh CREATE_EVENT key", () => {
  function createKey(holdStartedAtUtc) {
    const snap = q3Snapshot();
    snap.poll.state = "BOOKING";
    snap.poll.holdSlotId = "s1";
    snap.poll.holdStartedAtUtc = holdStartedAtUtc; // retryBooking refreshes this
    const res = Sched.engine.advance(snap, holdStartedAtUtc);
    assert.equal(res.state, "BOOKING");
    return res.effects.filter((e) => e.type === "CREATE_EVENT")[0].idempotencyKey;
  }
  const base = q3Snapshot().poll.createdAtUtc;
  const k1 = createKey(base);
  const k2 = createKey(base + 3600000); // BOOKING_FAILED -> retry re-armed the hold
  assert.ok(k1.startsWith("q3:CREATE_EVENT:s1:"));
  assert.notEqual(k1, k2); // fresh holdStartedAtUtc -> the old failed row no longer suppresses
});

test("advance ROUND1 pivots when all slate-1 slots are doomed or blocked", () => {
  const snap = q3Snapshot();
  snap.poll.state = "ROUND1";
  vote(snap, "maya", "s1", "cant");
  vote(snap, "maya", "s2", "cant");
  vote(snap, "priya", "s3", "cant");
  vote(snap, "jonas", "s3", "cant");
  vote(snap, "sofia", "s3", "cant");
  const res = Sched.engine.advance(snap, snap.poll.createdAtUtc);
  assert.equal(res.state, "PIVOT_PENDING");
  assert.ok(res.effects.some((e) => e.type === "SEND_PIVOT_PROPOSAL"));
  assert.equal(res.pollPatch.pivotProposedAtUtc, snap.poll.createdAtUtc);
});
