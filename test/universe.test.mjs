import { test } from "node:test";
import assert from "node:assert/strict";
import { Sched } from "./_load.mjs";
import { q3Snapshot, fullFreeWindows, londonToUtc } from "./_fixture.mjs";

test("localParts reads wall clock in the event timezone", () => {
  const p = Sched.universe.localParts(londonToUtc(2026, 7, 21, 14, 0), "Europe/London");
  assert.equal(p.hour, 14);
  assert.equal(p.weekday, 2); // Tuesday
  assert.equal(p.day, 21);
});

test("tzOffset is +1h for London in July (BST)", () => {
  assert.equal(Sched.universe.tzOffset(londonToUtc(2026, 7, 21, 12, 0), "Europe/London"), 3600000);
});

test("candidateStarts stay inside working hours, horizon, and free windows", () => {
  const { poll } = q3Snapshot();
  const starts = Sched.universe.candidateStarts(poll, fullFreeWindows());
  assert.ok(starts.length > 0);
  for (const s of starts) {
    const p = Sched.universe.localParts(s, poll.tz);
    assert.ok(p.hour >= 9 && p.hour < 17);
    assert.ok(p.weekday >= 1 && p.weekday <= 5);
    assert.ok(s >= poll.horizonStartUtc && s + poll.durationMins * 60000 <= poll.horizonEndUtc);
  }
});

test("candidateStarts respects a bounded free window", () => {
  const { poll } = q3Snapshot();
  const win = [{ startUtc: londonToUtc(2026, 7, 22, 10, 0), endUtc: londonToUtc(2026, 7, 22, 12, 0) }];
  const starts = Sched.universe.candidateStarts(poll, win);
  // 10:00, 10:30, 11:00 fit a 60-min meeting before 12:00.
  assert.deepEqual(starts.map((s) => Sched.universe.localParts(s, poll.tz).hour + ":" +
    Sched.universe.localParts(s, poll.tz).minute), ["10:0", "10:30", "11:0"]);
});

test("addWorkingHours skips nights and weekends", () => {
  const { poll } = q3Snapshot();
  // Friday 24 Jul 15:00 + 4 working hours -> Monday 27 Jul 11:00 (2h Fri + 2h Mon).
  const start = londonToUtc(2026, 7, 24, 15, 0);
  const due = Sched.universe.addWorkingHours(start, 4, poll.workingHours, poll.tz);
  const p = Sched.universe.localParts(due, poll.tz);
  assert.equal(p.weekday, 1); // Monday
  assert.equal(p.day, 27);
  assert.equal(p.hour, 11);
});

test("spansDst is false within a single July horizon", () => {
  assert.equal(Sched.universe.spansDst(q3Snapshot().poll), false);
});

test("spansDst is true across the October transition", () => {
  const { poll } = q3Snapshot();
  poll.horizonStartUtc = Date.UTC(2026, 9, 20);
  poll.horizonEndUtc = Date.UTC(2026, 10, 5);
  assert.equal(Sched.universe.spansDst(poll), true);
});

test("spansDst ignores sub-second horizon ends (no false positive)", () => {
  // A Date.now()-style end carries milliseconds; tz offsets are whole minutes, so a
  // millisecond remainder must not read as a DST change within a single-season horizon.
  const poll = q3Snapshot().poll;
  poll.tz = "Europe/London";
  poll.horizonStartUtc = Date.UTC(2026, 6, 21, 0, 0, 0, 0);
  poll.horizonEndUtc = Date.UTC(2026, 7, 11, 13, 27, 26, 87);
  assert.equal(Sched.universe.spansDst(poll), false);
});
