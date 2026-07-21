import { test } from "node:test";
import assert from "node:assert/strict";
import { Sched } from "./_load.mjs";
import { q3Snapshot } from "./_fixture.mjs";

test("latest keeps the highest-rev vote per (invitee, slot)", () => {
  const snap = q3Snapshot();
  snap.votes = [
    { inviteeId: "priya", slotId: "s1", answer: "cant", provenance: "explicit_slate", rev: 2, atUtc: 20 },
    { inviteeId: "priya", slotId: "s1", answer: "works", provenance: "explicit_slate", rev: 5, atUtc: 50 }
  ];
  const latest = Sched.votes.latest(snap);
  assert.equal(latest.get("priya|s1").answer, "works");
});

test("counts tallies latest votes by answer", () => {
  const snap = q3Snapshot();
  snap.votes = [
    { inviteeId: "priya", slotId: "s1", answer: "works", provenance: "explicit_slate", rev: 1, atUtc: 1 },
    { inviteeId: "jonas", slotId: "s1", answer: "cant", provenance: "explicit_slate", rev: 1, atUtc: 1 },
    { inviteeId: "maya", slotId: "s1", answer: "ifneeded", provenance: "explicit_slate", rev: 1, atUtc: 1 }
  ];
  assert.deepEqual(Sched.votes.counts(snap, "s1"), { works: 1, ifneeded: 1, cant: 1 });
});

test("proposal and prefill provenance count as recorded votes", () => {
  const snap = q3Snapshot();
  snap.votes = [
    { inviteeId: "jonas", slotId: "s1", answer: "works", provenance: "proposal", rev: 1, atUtc: 1 },
    { inviteeId: "alex", slotId: "s1", answer: "works", provenance: "prefill", rev: 1, atUtc: 1 }
  ];
  assert.equal(Sched.votes.counts(snap, "s1").works, 2);
});
