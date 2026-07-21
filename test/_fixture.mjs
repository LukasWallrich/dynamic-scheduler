import { londonToUtc } from "./_world.mjs";

const DAY = 86400000;

/** Reference poll used across unit and scenario tests: Q3 Research Sync. */
export function q3Snapshot() {
  const createdAtUtc = londonToUtc(2026, 7, 20, 9, 0);
  const horizonStartUtc = londonToUtc(2026, 7, 20, 0, 0);
  const horizonEndUtc = londonToUtc(2026, 8, 7, 0, 0);
  const round1DeadlineUtc = londonToUtc(2026, 7, 24, 15, 0); // Fri 24 Jul 15:00

  const poll = {
    pollId: "q3", rev: 1, state: "SETUP", title: "Q3 Research Sync",
    durationMins: 60, tz: "Europe/London",
    organizerEmail: "alex@example.com", organizerName: "Alex",
    horizonStartUtc, horizonEndUtc,
    workingHours: { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] },
    visibility: "neutral", minAttendees: 4, maxAbsences: 2,
    slateVersion: 1, round1DeadlineUtc, round2DeadlineUtc: null,
    pivotDelayHours: 4, pivotProposedAtUtc: null,
    launchApprovedAtUtc: null, rescueAlternatesJson: null,
    holdSlotId: null, holdStartedAtUtc: null, holdApprovedAtUtc: null,
    requiredGraceUntilUtc: null, graceRound: null,
    calendarEventId: null, createdAtUtc
  };

  const invitees = [
    { inviteeId: "alex", name: "Alex", email: "alex@example.com", required: true, demoted: false, organizer: true },
    { inviteeId: "maya", name: "Maya", email: "maya@example.com", required: true, demoted: false, organizer: false },
    { inviteeId: "priya", name: "Priya", email: "priya@example.com", required: false, demoted: false, organizer: false },
    { inviteeId: "jonas", name: "Jonas", email: "jonas@example.com", required: false, demoted: false, organizer: false },
    { inviteeId: "tom", name: "Tom", email: "tom@example.com", required: false, demoted: false, organizer: false },
    { inviteeId: "sofia", name: "Sofia", email: "sofia@example.com", required: false, demoted: false, organizer: false }
  ];

  const slots = [
    { slotId: "s1", startUtc: londonToUtc(2026, 7, 21, 14, 0), endUtc: londonToUtc(2026, 7, 21, 15, 0), kind: "slate1", slateVersion: 1, proposerInviteeId: "" },
    { slotId: "s2", startUtc: londonToUtc(2026, 7, 22, 10, 0), endUtc: londonToUtc(2026, 7, 22, 11, 0), kind: "slate1", slateVersion: 1, proposerInviteeId: "" },
    { slotId: "s3", startUtc: londonToUtc(2026, 7, 23, 15, 0), endUtc: londonToUtc(2026, 7, 23, 16, 0), kind: "slate1", slateVersion: 1, proposerInviteeId: "" }
  ];

  return { poll, invitees, slots, votes: [], constraints: [] };
}

/** Free windows spanning the whole horizon on weekdays 09:00-17:00 (London). */
export function fullFreeWindows() {
  const windows = [];
  for (let d = 20; d <= 31; d++) {
    const day = new Date(Date.UTC(2026, 6, d));
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    windows.push({ startUtc: londonToUtc(2026, 7, d, 9, 0), endUtc: londonToUtc(2026, 7, d, 17, 0) });
  }
  for (let d = 3; d <= 6; d++) {
    windows.push({ startUtc: londonToUtc(2026, 8, d, 9, 0), endUtc: londonToUtc(2026, 8, d, 17, 0) });
  }
  return windows;
}

export { londonToUtc, DAY };
