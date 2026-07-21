import { test } from "node:test";
import assert from "node:assert/strict";
import { Sched } from "./_load.mjs";
import { q3Snapshot, fullFreeWindows, londonToUtc } from "./_fixture.mjs";
import { World } from "./_world.mjs";

const INVITEE_MAIL = { SEND_INVITE: "invite", SEND_REMINDER: "reminder",
  SEND_ROUND2_ASK: "round2Ask", SEND_REQUIRED_GRACE: "requiredGrace" };

/** No invitee-facing string ever names another invitee or leaks required-status. */
function assertNeutral(world) {
  const snap = world.snapshot;
  world.sent.filter((e) => e.inviteeId && INVITEE_MAIL[e.type]).forEach((e) => {
    const recipient = snap.invitees.find((i) => i.inviteeId === e.inviteeId);
    const body = Sched.text.email[INVITEE_MAIL[e.type]](snap, recipient, "https://x/y", e).body;
    assert.doesNotMatch(body, /required/i, `${e.type} to ${recipient.name} leaked required-status`);
    snap.invitees.filter((i) => i.inviteeId !== e.inviteeId && !i.organizer).forEach((other) => {
      assert.ok(!body.includes(other.name), `${e.type} to ${recipient.name} leaked "${other.name}"`);
    });
  });
}

test("reference journey: slate 1 dies, bench, pivot, round 2, HOLD, BOOKED", () => {
  const snap = q3Snapshot();
  const free = fullFreeWindows();
  const world = new World(snap, snap.poll.createdAtUtc);

  // --- SETUP -> ROUND1 -----------------------------------------------------
  let fresh = world.run();
  assert.equal(world.state, "ROUND1");
  assert.equal(fresh.filter((e) => e.type === "SEND_INVITE").length, 5); // all but organizer
  assert.ok(!fresh.some((e) => e.inviteeId === "alex"));

  // --- ROUND1 votes --------------------------------------------------------
  world.setNow(londonToUtc(2026, 7, 20, 10, 0));
  world.addVotes("priya", [
    { slotId: "s1", answer: "works" }, { slotId: "s2", answer: "works" },
    { slotId: "s3", answer: "cant" }]);
  world.run();
  assert.equal(world.state, "ROUND1");

  // Jonas: all Can't, vetoes (no Tuesdays, week of 28 Jul), 3 bench proposals.
  world.setNow(londonToUtc(2026, 7, 20, 11, 0));
  world.addVotes("jonas", [
    { slotId: "s1", answer: "cant" }, { slotId: "s2", answer: "cant" },
    { slotId: "s3", answer: "cant" }]);
  world.addConstraints("jonas", [
    { type: "dow", value: 2 }, { type: "week", value: "2026-07-27" }]);
  const bench = world.addBench("jonas", [
    { startUtc: londonToUtc(2026, 7, 23, 11, 0), endUtc: londonToUtc(2026, 7, 23, 12, 0) },
    { startUtc: londonToUtc(2026, 7, 24, 14, 0), endUtc: londonToUtc(2026, 7, 24, 15, 0) },
    { startUtc: londonToUtc(2026, 8, 3, 10, 0), endUtc: londonToUtc(2026, 8, 3, 11, 0) }]);
  world.run();
  assert.equal(world.state, "ROUND1"); // bench slots never keep the dead slate alive

  // Maya (required): can't on s1/s2, if-needed on s3, and scores the bench.
  world.setNow(londonToUtc(2026, 7, 20, 14, 0));
  world.addVotes("maya", [
    { slotId: "s1", answer: "cant" }, { slotId: "s2", answer: "cant" },
    { slotId: "s3", answer: "ifneeded" }]);
  world.addVotes("maya", [
    { slotId: bench[0].slotId, answer: "works", provenance: "explicit_bench" },
    { slotId: bench[1].slotId, answer: "works", provenance: "explicit_bench" },
    { slotId: bench[2].slotId, answer: "ifneeded", provenance: "explicit_bench" }]);
  world.run();
  assert.equal(world.state, "ROUND1"); // s1/s2 blocked, s3 still optimistically alive
  assert.equal(world.slotStatus("s1"), "blocked");
  assert.equal(world.slotStatus("s3"), "alive");

  // --- slate 1 becomes provably dead -> PIVOT ------------------------------
  // Sofia declines s3, pushing absences past max_absences: s3 is now doomed.
  world.setNow(londonToUtc(2026, 7, 20, 15, 0));
  world.addVotes("sofia", [{ slotId: "s3", answer: "cant" }]);
  fresh = world.run();
  assert.equal(world.state, "PIVOT_PENDING");
  assert.equal(world.slotStatus("s3"), "doomed");
  assert.equal(fresh.filter((e) => e.type === "SEND_PIVOT_PROPOSAL").length, 1);
  assert.ok(!fresh.some((e) => e.inviteeId)); // pivot proposal is organizer-only, no invitees

  // --- shell computes + installs the rescue slate --------------------------
  const rescue = Sched.pivot.rescueSlate(snap, free, world.now);
  assert.equal(rescue.slots.length, 3);
  assert.ok(rescue.slots.some((p) => /Jonas|Maya/.test(p.reasoning)), "reasoning names people");
  const slate2 = world.installRescueSlate(rescue.slots);
  // Jonas's proposal and Maya's bench scores carried onto the promoted slots.
  const carried = Sched.votes.latest(snap).get(Sched.votes.keyOf("jonas", slate2[0].slotId));
  assert.ok(carried && carried.provenance === "proposal");

  // --- organizer votes at launch (Works prefills) -> ROUND2 ----------------
  // The shell records the organizer's votes, then sets launchApprovedAtUtc.
  world.setNow(londonToUtc(2026, 7, 20, 16, 0));
  world.addVotes("alex", slate2.map((s) => ({ slotId: s.slotId, answer: "works", provenance: "prefill" })));
  snap.poll.launchApprovedAtUtc = world.now;
  fresh = world.run();
  assert.equal(world.state, "ROUND2");
  assert.equal(snap.poll.slateVersion, 2);
  const asked = fresh.filter((e) => e.type === "SEND_ROUND2_ASK").map((e) => e.inviteeId).sort();
  assert.deepEqual(asked, ["priya", "sofia", "tom"]); // Maya & Jonas already scored via carry; Alex is organizer

  // --- ROUND2 votes: support concentrates on slate2_0 ----------------------
  world.setNow(londonToUtc(2026, 7, 21, 10, 0));
  ["priya", "tom", "sofia"].forEach((id) => {
    world.addVotes(id, [
      { slotId: slate2[0].slotId, answer: "works" },
      { slotId: slate2[1].slotId, answer: "cant" },
      { slotId: slate2[2].slotId, answer: "cant" }]);
  });
  fresh = world.run();

  // --- winner decided early -> HOLD (organizer-only) -----------------------
  assert.equal(world.state, "HOLD");
  assert.equal(snap.poll.holdSlotId, slate2[0].slotId);
  assert.equal(world.slotStatus(slate2[0].slotId), "bookable");
  assert.equal(fresh.filter((e) => e.type === "SEND_HOLD_APPROVAL").length, 1);
  assert.ok(!fresh.some((e) => e.inviteeId), "no invitee is notified at HOLD");
  const just = JSON.parse(snap.poll.holdJustification);
  assert.equal(just.basis, "early_upper_bound");

  // --- organizer approves -> BOOKING -> CREATE_EVENT -> BOOKED -------------
  snap.poll.holdApprovedAtUtc = world.now; // organizer approval books immediately
  fresh = world.run();
  assert.equal(world.state, "BOOKED");
  assert.equal(world.created.length, 1);
  assert.equal(world.created[0].slotId, slate2[0].slotId);
  assert.equal(world.created[0].idempotencyKey,
    "q3:CREATE_EVENT:" + slate2[0].slotId + ":" + snap.poll.holdStartedAtUtc);
  assert.ok(snap.poll.calendarEventId);

  // --- idempotency: re-advancing yields no new effects ---------------------
  const again = world.run();
  assert.equal(again.length, 0);

  // --- email cadence caps + neutrality ------------------------------------
  for (const id of ["priya", "jonas", "tom", "sofia", "maya"]) {
    const mine = world.sent.filter((e) => e.inviteeId === id);
    const byType = {};
    mine.forEach((e) => { byType[e.type] = (byType[e.type] || 0) + 1; });
    Object.values(byType).forEach((n) => assert.ok(n <= 1, `${id} got a duplicated mail`));
    assert.ok(mine.length <= 4, `${id} exceeded the ladder cap`);
  }
  assert.equal(world.mailCountFor("priya"), 2); // invite + round2 ask
  assert.equal(world.mailCountFor("maya"), 1);  // invite only (never re-asked)
  assert.equal(world.mailCountFor("jonas"), 1);
  assert.equal(world.mailCountFor("alex"), 0);  // organizer never gets invitee mail
  assertNeutral(world);
});
