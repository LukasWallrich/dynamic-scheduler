import { test } from "node:test";
import assert from "node:assert/strict";
import { Sched } from "./_load.mjs";
import { q3Snapshot } from "./_fixture.mjs";

const link = "https://example.com/p/token";

function otherInviteeNames(snap, recipientId) {
  return snap.invitees
    .filter((i) => i.inviteeId !== recipientId && !i.organizer)
    .map((i) => i.name);
}

test("invite subject and body carry the specced elements", () => {
  const snap = q3Snapshot();
  const maya = snap.invitees.find((i) => i.inviteeId === "maya");
  const m = Sched.text.email.invite(snap, maya, link);
  assert.equal(m.subject, "Q3 Research Sync — please pick times");
  assert.match(m.body, /Alex is scheduling/);
  assert.match(m.body, /Europe\/London/);
  assert.match(m.body, /Sent on Alex's behalf by Dynamic Scheduler\./);
  assert.match(m.body, /propose up to 3 alternatives/); // social contract line
});

test("invitee-facing mail never names other invitees or required-status (neutral)", () => {
  const snap = q3Snapshot();
  for (const fn of ["invite", "reminder", "round2Ask", "requiredGrace"]) {
    for (const inv of snap.invitees.filter((i) => !i.organizer)) {
      const body = Sched.text.email[fn](snap, inv, link).body;
      assert.doesNotMatch(body, /required/i, `${fn} to ${inv.name} leaks required-status`);
      for (const other of otherInviteeNames(snap, inv.inviteeId)) {
        assert.ok(!body.includes(other), `${fn} to ${inv.name} leaked "${other}"`);
      }
    }
  }
});

test("veto strip label is the exact specced string", () => {
  assert.equal(Sched.text.page.vetoStripLabel(q3Snapshot()),
    "Days that never work, or dates you’re away?");
});

test("organizer-facing hold approval names who it covers and who may clash", () => {
  const snap = q3Snapshot();
  snap.poll.state = "HOLD";
  snap.poll.holdSlotId = "s1";
  snap.votes = [
    { inviteeId: "maya", slotId: "s1", answer: "works", provenance: "explicit_slate", rev: 1, atUtc: 1 },
    { inviteeId: "priya", slotId: "s1", answer: "works", provenance: "explicit_slate", rev: 1, atUtc: 1 },
    { inviteeId: "jonas", slotId: "s1", answer: "cant", provenance: "explicit_slate", rev: 1, atUtc: 1 }
  ];
  const m = Sched.text.email.holdApproval(snap, snap.invitees[0], link, { slotId: "s1" });
  assert.match(m.body, /Maya/);
  assert.match(m.body, /Jonas/); // named as a possible clash
});

test("escalate diagnosis names the failed rule and binding people", () => {
  const snap = q3Snapshot();
  snap.constraints = [{ inviteeId: "maya", type: "dow", value: 2, atUtc: 1 }];
  snap.votes = [{ inviteeId: "jonas", slotId: "s1", answer: "cant", provenance: "explicit_slate", rev: 1, atUtc: 1 }];
  const d = Sched.text.page.escalateDiagnosis(snap);
  assert.match(d, /reaches 4/);
  assert.match(d, /Maya|Jonas/);
});
