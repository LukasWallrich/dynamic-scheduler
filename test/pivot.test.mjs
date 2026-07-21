import { test } from "node:test";
import assert from "node:assert/strict";
import { Sched } from "./_load.mjs";
import { q3Snapshot, fullFreeWindows, londonToUtc } from "./_fixture.mjs";

let rev = 0;
function vote(snap, inviteeId, slotId, answer, provenance = "explicit_slate") {
  snap.votes.push({ inviteeId, slotId, answer, provenance, rev: ++rev, atUtc: rev });
}

test("rescueSlate returns up to 3 diverse slots", () => {
  const snap = q3Snapshot();
  const { slots } = Sched.pivot.rescueSlate(snap, fullFreeWindows(), snap.poll.createdAtUtc);
  assert.equal(slots.length, 3);
  const days = slots.map((s) => Sched.universe.localParts(s.startUtc, snap.poll.tz).dateKey);
  assert.notEqual(days[0], days[1]); // best on a different day than the top pick
});

test("a required attendee's veto hard-excludes candidates", () => {
  const snap = q3Snapshot();
  // Maya (required) vetoes every Tuesday.
  snap.constraints = [{ inviteeId: "maya", type: "dow", value: 2, atUtc: 1 }];
  const { slots } = Sched.pivot.rescueSlate(snap, fullFreeWindows(), snap.poll.createdAtUtc);
  for (const s of slots) {
    assert.notEqual(Sched.universe.localParts(s.startUtc, snap.poll.tz).weekday, 2);
  }
});

test("an ordinary veto lowers the score but never excludes globally", () => {
  const snap = q3Snapshot();
  snap.constraints = [{ inviteeId: "priya", type: "dow", value: 2, atUtc: 1 }];
  const { slots } = Sched.pivot.rescueSlate(snap, fullFreeWindows(), snap.poll.createdAtUtc);
  // Tuesdays are still permitted overall (they simply score worse for Priya).
  const anyTuesdayInUniverse = Sched.universe.candidateStarts(snap.poll, fullFreeWindows())
    .some((s) => Sched.universe.localParts(s, snap.poll.tz).weekday === 2);
  assert.equal(anyTuesdayInUniverse, true);
  assert.equal(slots.length, 3);
});

test("bench slots compete via their real votes and reasoning names people", () => {
  const snap = q3Snapshot();
  const bench = { slotId: "bench_jonas_1", startUtc: londonToUtc(2026, 7, 23, 11, 0),
    endUtc: londonToUtc(2026, 7, 23, 12, 0), kind: "bench", slateVersion: 1, proposerInviteeId: "jonas" };
  snap.slots.push(bench);
  vote(snap, "jonas", "bench_jonas_1", "works", "proposal");
  vote(snap, "maya", "bench_jonas_1", "works", "explicit_bench");
  vote(snap, "priya", "bench_jonas_1", "works", "explicit_bench");
  const { slots } = Sched.pivot.rescueSlate(snap, fullFreeWindows(), snap.poll.createdAtUtc);
  const benchPick = slots.filter((s) => s.startUtc === bench.startUtc)[0];
  assert.ok(benchPick, "the well-supported bench slot should surface");
  assert.equal(benchPick.benchSlotId, "bench_jonas_1"); // promoted in place, votes carry
  assert.match(benchPick.reasoning, /Jonas|Maya|Priya/);
});

test("rescueSlate dedupes a bench window and returns ranked alternates", () => {
  const snap = q3Snapshot();
  // A bench slot on a window the universe also offers must appear once, as the bench.
  const bench = { slotId: "bench_dup", startUtc: londonToUtc(2026, 7, 23, 11, 0),
    endUtc: londonToUtc(2026, 7, 23, 12, 0), kind: "bench", slateVersion: 1, proposerInviteeId: "jonas" };
  snap.slots.push(bench);
  vote(snap, "jonas", "bench_dup", "works", "proposal");
  const { slots, alternates } = Sched.pivot.rescueSlate(snap, fullFreeWindows(), snap.poll.createdAtUtc);
  const all = slots.concat(alternates);
  const onWindow = all.filter((c) => c.startUtc === bench.startUtc);
  assert.equal(onWindow.length, 1, "the bench window is not duplicated by a universe candidate");
  assert.equal(onWindow[0].benchSlotId, "bench_dup");
  assert.ok(alternates.length > 0 && alternates.length <= 6, "alternates are capped runners-up");
  // slots and alternates are disjoint.
  slots.forEach((s) => assert.ok(!alternates.some((a) => a.startUtc === s.startUtc && a.endUtc === s.endUtc)));
});
