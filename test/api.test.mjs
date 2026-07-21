/**
 * api.test.mjs — the JSON dispatcher + view-model, exercised in-Node.
 *
 * Loads the pure core plus the real gas/api.js and gas/web.js dispatcher over mocked
 * platform globals: an in-memory Store, Cal/Mail/Session/Utilities/ContentService stubs,
 * and a compact advancePoll that mirrors the writer loop (append action rows, then run the
 * REAL Sched.engine.advance until it reports no transition). Every call goes through the
 * actual doPost, so the dispatch, authorization, visibility rules and view-model are the
 * production code paths.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Sched } from "./_load.mjs";

const gasDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gas");

// ---- in-memory Store --------------------------------------------------------

const db = { polls: {} };
let voteRev = 1;

function numOrNull(v) { return (v === "" || v === null || v === undefined) ? null : Number(v); }

function buildSnapshot(p) {
  const r = p.pollRow;
  const poll = {
    pollId: r.pollId, rev: Number(r.rev), state: r.state, title: r.title,
    durationMins: Number(r.durationMins), tz: r.tz,
    organizerEmail: r.organizerEmail, organizerName: r.organizerName,
    horizonStartUtc: Number(r.horizonStartUtc), horizonEndUtc: Number(r.horizonEndUtc),
    workingHours: { startHour: Number(r.whStartHour), endHour: Number(r.whEndHour),
      days: String(r.whDays).split(",").filter(Boolean).map(Number) },
    visibility: r.visibility, minAttendees: Number(r.minAttendees), maxAbsences: Number(r.maxAbsences),
    slateVersion: Number(r.slateVersion),
    round1DeadlineUtc: numOrNull(r.round1DeadlineUtc), round2DeadlineUtc: numOrNull(r.round2DeadlineUtc),
    pivotDelayHours: Number(r.pivotDelayHours), pivotProposedAtUtc: numOrNull(r.pivotProposedAtUtc),
    launchApprovedAtUtc: numOrNull(r.launchApprovedAtUtc),
    holdSlotId: r.holdSlotId || null, holdStartedAtUtc: numOrNull(r.holdStartedAtUtc),
    holdApprovedAtUtc: numOrNull(r.holdApprovedAtUtc),
    holdForced: r.holdForced === true || r.holdForced === "TRUE",
    rescueAlternatesJson: r.rescueAlternatesJson || "",
    requiredGraceUntilUtc: numOrNull(r.requiredGraceUntilUtc), graceRound: numOrNull(r.graceRound),
    holdJustification: r.holdJustification || "",
    calendarEventId: r.calendarEventId || null, createdAtUtc: numOrNull(r.createdAtUtc)
  };
  return {
    poll,
    invitees: p.invitees.map((i) => ({
      inviteeId: i.inviteeId, name: i.name, email: i.email,
      required: i.required === true || i.required === "TRUE",
      demoted: i.demoted === true || i.demoted === "TRUE",
      organizer: i.organizer === true || i.organizer === "TRUE"
    })),
    slots: p.slots.map((s) => ({
      slotId: s.slotId, startUtc: Number(s.startUtc), endUtc: Number(s.endUtc),
      kind: s.kind, slateVersion: Number(s.slateVersion), proposerInviteeId: s.proposerInviteeId || null
    })),
    votes: p.votes.map((v) => ({
      inviteeId: v.inviteeId, slotId: v.slotId, answer: v.answer, provenance: v.provenance,
      rev: Number(v.rev), atUtc: Number(v.atUtc)
    })),
    constraints: p.constraints.map((c) => ({
      inviteeId: c.inviteeId, type: c.type, value: c.value, atUtc: Number(c.atUtc)
    }))
  };
}

const Store = {
  insertPoll(pollRow, invitees, slots) {
    db.polls[pollRow.pollId] = {
      pollRow: { ...pollRow }, invitees: invitees.map((i) => ({ ...i })),
      slots: slots.map((s) => ({ ...s })), votes: [], constraints: [], tokens: {}
    };
  },
  setTokens(pollId, map) { db.polls[pollId].tokens = { ...map }; },
  inviteeToken(pollId, id) { return db.polls[pollId].tokens[id] || null; },
  appendAudit() {},
  loadSnapshot(pollId) { return db.polls[pollId] ? buildSnapshot(db.polls[pollId]) : null; },
  findInviteeByTokenAny(token) {
    const hash = globalThis.Security.hashToken(token);
    for (const pid in db.polls) {
      const row = db.polls[pid].invitees.find((i) => i.tokenHash === hash);
      if (row) return { ...row, pollId: pid };
    }
    return null;
  },
  findInviteeByToken(pollId, token) {
    const hash = globalThis.Security.hashToken(token);
    const row = db.polls[pollId].invitees.find((i) => i.tokenHash === hash);
    return row ? { ...row, pollId } : null;
  },
  appendVotes(pollId, inviteeId, votes) {
    votes.forEach((v) => db.polls[pollId].votes.push({
      inviteeId, slotId: v.slotId, answer: v.answer, provenance: v.provenance,
      rev: v.rev || (++voteRev), atUtc: Date.now()
    }));
  },
  appendConstraints(pollId, inviteeId, cs) {
    cs.forEach((c) => db.polls[pollId].constraints.push({ inviteeId, type: c.type, value: c.value, atUtc: Date.now() }));
  },
  appendSlots(pollId, slots) { slots.forEach((s) => db.polls[pollId].slots.push({ ...s })); },
  applySlotPatches(pollId, patches) {
    (patches || []).forEach((p) => {
      const row = db.polls[pollId].slots.find((s) => s.slotId === p.slotId);
      if (row) Object.keys(p).forEach((k) => { if (k !== "slotId") row[k] = p[k]; });
    });
  },
  updatePoll(pollId, patch, _expectedRev) {
    const p = db.polls[pollId];
    Object.keys(patch).forEach((k) => { p.pollRow[k] = patch[k]; });
    p.pollRow.rev = Number(p.pollRow.rev) + 1;
  },
  demoteInvitee(pollId, inviteeId) {
    const row = db.polls[pollId].invitees.find((i) => i.inviteeId === inviteeId);
    if (row) { row.required = false; row.demoted = true; }
  },
  rotateToken(pollId, inviteeId) {
    const row = db.polls[pollId].invitees.find((i) => i.inviteeId === inviteeId);
    if (!row) return null;
    const t = globalThis.Security.newToken();
    row.tokenHash = globalThis.Security.hashToken(t);
    db.polls[pollId].tokens[inviteeId] = t;
    return t;
  }
};

// ---- compact writer loop (mirrors gas/advance.js over the in-memory Store) ---

function applyActionStub(pollId, action) {
  if (!action || action.kind === "tick") return;
  const snap = Store.loadSnapshot(pollId);
  switch (action.kind) {
    case "votes": Store.appendVotes(pollId, action.inviteeId, action.votes); break;
    case "constraints": Store.appendConstraints(pollId, action.inviteeId, action.constraints); break;
    case "bench": {
      const bench = action.slots.map((s, idx) => ({
        slotId: "bench_" + action.inviteeId + "_" + Date.now() + "_" + idx,
        startUtc: s.startUtc, endUtc: s.endUtc, kind: "bench",
        slateVersion: snap.poll.slateVersion, proposerInviteeId: action.inviteeId
      }));
      Store.appendSlots(pollId, bench);
      Store.appendVotes(pollId, action.inviteeId, bench.map((s) => ({ slotId: s.slotId, answer: "works", provenance: "proposal" })));
      break;
    }
    case "calendarBusy":
      Store.appendVotes(pollId, action.inviteeId, [{ slotId: action.slotId, answer: "cant", provenance: "prefill" }]);
      break;
    case "organizerLaunch":
      Store.appendVotes(pollId, action.inviteeId, action.votes);
      Store.updatePoll(pollId, { launchApprovedAtUtc: Date.now() }, snap.poll.rev);
      break;
    case "organizerReject":
      Store.appendVotes(pollId, action.inviteeId, [{ slotId: action.slotId, answer: "cant", provenance: "explicit_slate" }]);
      break;
    case "organizerApprove":
      if (snap.poll.state === "HOLD") Store.updatePoll(pollId, { holdApprovedAtUtc: Date.now() }, snap.poll.rev);
      break;
    case "demoteRequired": Store.demoteInvitee(pollId, action.inviteeId); break;
    case "extendGrace": Store.updatePoll(pollId, { requiredGraceUntilUtc: Date.now() + 24 * 3600000 }, snap.poll.rev); break;
    case "retryBooking":
      Store.updatePoll(pollId, { state: "BOOKING", holdStartedAtUtc: Date.now(), holdApprovedAtUtc: Date.now() }, snap.poll.rev);
      break;
    case "cancel": Store.updatePoll(pollId, { state: "CANCELLED" }, snap.poll.rev); break;
  }
}

function runAdvance(pollId, now) {
  for (let i = 0; i < 40; i++) {
    const snap = Store.loadSnapshot(pollId);
    const res = Sched.engine.advance(snap, now);
    const pollPatch = res.pollPatch || {};
    const slotPatches = res.slotPatches || [];
    const voteRecords = res.voteRecords || [];
    const stateChanged = res.state && res.state !== snap.poll.state;
    const patched = stateChanged || Object.keys(pollPatch).length > 0 || slotPatches.length > 0;
    if (patched) {
      const patch = { ...pollPatch };
      if (stateChanged) patch.state = res.state;
      Store.updatePoll(pollId, patch, snap.poll.rev);
      Store.applySlotPatches(pollId, slotPatches);
    }
    voteRecords.forEach((vr) => Store.appendVotes(pollId, vr.inviteeId,
      [{ slotId: vr.slotId, answer: vr.answer, provenance: vr.provenance || "prefill" }]));
    (res.effects || []).forEach((e) => {
      if (e.type === "CREATE_EVENT") {
        Store.updatePoll(pollId, { calendarEventId: "evt_" + e.slotId }, Store.loadSnapshot(pollId).poll.rev);
      }
    });
    if (!patched) break;
  }
}

// ---- platform globals -------------------------------------------------------

const props = {};
globalThis.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); },
    deleteProperty: (k) => { delete props[k]; }
  })
};
globalThis.ScriptApp = { getService: () => ({ getUrl: () => "https://script.google.com/macros/s/x/exec" }) };
globalThis.Session = {
  getEffectiveUser: () => ({ getEmail: () => "alex@example.com" }),
  getScriptTimeZone: () => "Europe/London"
};
globalThis.Cal = { freeWindows: () => [], isSlotFree: () => true };
globalThis.Mail = { used: () => 0, DAILY_BUDGET: 100, squeezedToday: () => false };
globalThis.ContentService = {
  createTextOutput: (s) => ({ _t: s, setMimeType() { return this; }, getContent() { return this._t; } }),
  MimeType: { JSON: "JSON" }
};

function formatDateStub(date, tz, fmt) {
  const p = Sched.universe.localParts(date.getTime(), tz);
  const pad = (n) => String(n).padStart(2, "0");
  if (fmt === "yyyy-MM-dd") return p.year + "-" + pad(p.month) + "-" + pad(p.day);
  if (fmt === "HH") return pad(p.hour);
  return date.toISOString();
}
globalThis.Utilities = {
  getUuid: () => crypto.randomUUID(),
  computeDigest: (_alg, str) => Array.from(crypto.createHash("sha256").update(str, "utf8").digest())
    .map((b) => (b > 127 ? b - 256 : b)),
  DigestAlgorithm: { SHA_256: "SHA_256" },
  Charset: { UTF_8: "UTF_8" },
  formatDate: (date, tz, fmt) => formatDateStub(date, tz, fmt)
};

globalThis.Store = Store;
globalThis.advancePoll = function (pollId, action) {
  applyActionStub(pollId, action);
  runAdvance(pollId, Date.now());
  return { ok: true };
};
globalThis.applyCalendarRechecks = function () {}; // no-op: Cal stub is always free

// ---- load the real gas dispatcher over the stubs ---------------------------

function loadGas(name) {
  vm.runInThisContext(fs.readFileSync(path.join(gasDir, name), "utf8"), { filename: "gas/" + name });
}
loadGas("security.js");
loadGas("api.js");
loadGas("web.js");

function callApi(body) {
  const res = globalThis.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(res.getContent());
}

// ---- a valid poll (Etc/UTC keeps it DST-proof and date-agnostic) ------------

const DAY = 86400000;
function makePoll(overrides) {
  const now = Date.now();
  return Object.assign({
    title: "Q3 Sync", durationMins: 60, tz: "Etc/UTC",
    organizerName: "Alex",
    horizonStartUtc: now, horizonEndUtc: now + 20 * DAY,
    workingHours: { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] },
    minAttendees: 3, maxAbsences: 2, pivotDelayHours: 4,
    round1DeadlineUtc: now + 3 * DAY, visibility: "neutral",
    invitees: [
      { name: "Maya", email: "maya@example.com", required: true },
      { name: "Priya", email: "priya@example.com", required: false },
      { name: "Jonas", email: "jonas@example.com", required: false }
    ],
    slotStartsUtc: [now + 2 * DAY, now + 3 * DAY, now + 4 * DAY]
  }, overrides || {});
}

function createPoll(overrides) {
  const setupToken = globalThis.Security.setupToken();
  const res = callApi({ action: "createPoll", setupToken, poll: makePoll(overrides) });
  assert.equal(res.ok, true, "createPoll should succeed: " + JSON.stringify(res.error || {}));
  return res.data; // { pollId, dashboardToken, state, ... }
}

// ---- tests ------------------------------------------------------------------

test("createPoll -> getState round-trips", () => {
  const created = createPoll();
  assert.ok(created.pollId);
  assert.ok(created.dashboardToken);
  assert.equal(created.state.role, "organizer");
  assert.equal(created.state.poll.state, "ROUND1");

  const mayaToken = Store.inviteeToken(created.pollId, "inv_0");
  const res = callApi({ action: "getState", token: mayaToken });
  assert.equal(res.ok, true);
  assert.equal(res.data.role, "invitee");
  assert.equal(res.data.poll.title, "Q3 Sync");
  assert.equal(res.data.slots.length, 3);
  assert.equal(res.data.you.name, "Maya");
});

test("neutral invitee getState leaks no other name and no required-status", () => {
  const created = createPoll();
  const mayaToken = Store.inviteeToken(created.pollId, "inv_0");
  const res = callApi({ action: "getState", token: mayaToken });
  const json = JSON.stringify(res.data);

  ["Priya", "Jonas", "Alex"].forEach((name) => {
    assert.ok(!json.includes(name), `neutral invitee view leaked "${name}"`);
  });
  assert.doesNotMatch(json, /required/i, "neutral invitee view leaked required-status");
  // The invitee still sees their own identity.
  assert.ok(json.includes("Maya"));
  // No organizer-only fields reach an invitee.
  assert.equal(res.data.organizer, undefined);
  res.data.slots.forEach((s) => {
    assert.equal(s.status, undefined);
    assert.equal(s.reasons, undefined);
    assert.equal(s.support, undefined); // neutral: no support on the slate
  });
});

test("submitVotes returns fresh state reflecting the vote", () => {
  const created = createPoll();
  const mayaToken = Store.inviteeToken(created.pollId, "inv_0");
  const slotId = created.state.slots[0].slotId;

  const res = callApi({ action: "submitVotes", token: mayaToken, votes: { [slotId]: "works" } });
  assert.equal(res.ok, true);
  assert.equal(res.data.you.answersBySlotId[slotId], "works");
  const row = res.data.slots.find((s) => s.slotId === slotId);
  assert.equal(row.yourVote, "works");
});

test("organizer getState names people in diagnostics", () => {
  const created = createPoll();
  const mayaToken = Store.inviteeToken(created.pollId, "inv_0");
  const dash = created.dashboardToken;
  const slotId = created.state.slots[0].slotId;

  // Maya is required; her Can't blocks the slot, which the organizer diagnostics name.
  callApi({ action: "submitVotes", token: mayaToken, votes: { [slotId]: "cant" } });

  const res = callApi({ action: "getState", token: dash });
  assert.equal(res.ok, true);
  assert.equal(res.data.role, "organizer");
  const named = res.data.organizer.diagnostics.some((d) =>
    (d.people || []).some((p) => p.name === "Maya"));
  assert.ok(named, "organizer diagnostics should name Maya");
  // Coverage lists required people by name too (organizer-only).
  assert.ok(res.data.organizer.coverage.some((c) => c.name === "Maya"));
});

test("unauthorized token is rejected", () => {
  const res = callApi({ action: "getState", token: "not-a-real-token" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "unauthorized");
});

test("full-visibility invitee sees anonymous support counts on the slate", () => {
  const created = createPoll({ visibility: "full" });
  const mayaToken = Store.inviteeToken(created.pollId, "inv_0");
  const res = callApi({ action: "getState", token: mayaToken });
  assert.equal(res.ok, true);
  res.data.slots.forEach((s) => {
    assert.ok(s.support, "full visibility exposes support counts");
    assert.equal(typeof s.support.works, "number");
  });
  // Counts are still anonymous — no names, no required-status.
  assert.doesNotMatch(JSON.stringify(res.data), /required/i);
});
