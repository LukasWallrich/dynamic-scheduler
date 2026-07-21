import { test } from "node:test";
import assert from "node:assert/strict";
import { Sched } from "./_load.mjs";
import { q3Snapshot } from "./_fixture.mjs";

const tz = "Europe/London";

test("dow veto excludes the matching weekday", () => {
  const snap = q3Snapshot();
  const tuesday = snap.slots[0]; // Tue 21 Jul
  assert.equal(Sched.constraints.vetoesSlot({ type: "dow", value: 2 }, tuesday, tz), true);
  assert.equal(Sched.constraints.vetoesSlot({ type: "dow", value: 3 }, tuesday, tz), false);
});

test("band veto uses invitee-local band boundaries", () => {
  const snap = q3Snapshot();
  const afternoon = snap.slots[0]; // 14:00
  const morning = snap.slots[1]; // 10:00
  assert.equal(Sched.constraints.vetoesSlot({ type: "band", value: "afternoon" }, afternoon, tz), true);
  assert.equal(Sched.constraints.vetoesSlot({ type: "band", value: "morning" }, afternoon, tz), false);
  assert.equal(Sched.constraints.vetoesSlot({ type: "band", value: "morning" }, morning, tz), true);
});

test("week veto matches slots inside the Monday-anchored week", () => {
  const snap = q3Snapshot();
  const thu = snap.slots[2]; // Thu 23 Jul, week of Mon 20 Jul
  assert.equal(Sched.constraints.vetoesSlot({ type: "week", value: "2026-07-20" }, thu, tz), true);
  assert.equal(Sched.constraints.vetoesSlot({ type: "week", value: "2026-07-27" }, thu, tz), false);
});

test("predictedAnswer is 'cant' from a veto, null when explicit vote exists", () => {
  const snap = q3Snapshot();
  snap.constraints = [{ inviteeId: "jonas", type: "dow", value: 2, atUtc: 1 }];
  assert.equal(Sched.constraints.predictedAnswer(snap, "jonas", snap.slots[0]), "cant");
  snap.votes = [{ inviteeId: "jonas", slotId: "s1", answer: "works", provenance: "explicit_slate", rev: 1, atUtc: 2 }];
  assert.equal(Sched.constraints.predictedAnswer(snap, "jonas", snap.slots[0]), null);
});

test("contradiction surfaces an explicit yes against the person's own veto", () => {
  const snap = q3Snapshot();
  snap.constraints = [{ inviteeId: "jonas", type: "dow", value: 2, atUtc: 1 }];
  snap.votes = [{ inviteeId: "jonas", slotId: "s1", answer: "works", provenance: "explicit_slate", rev: 1, atUtc: 2 }];
  const c = Sched.constraints.contradiction(snap, "jonas", snap.slots[0]);
  assert.ok(c);
  assert.equal(c.answer, "works");
  assert.equal(c.veto.type, "dow");
  // An explicit Can't is no contradiction.
  snap.votes[0].answer = "cant";
  assert.equal(Sched.constraints.contradiction(snap, "jonas", snap.slots[0]), null);
});
