/**
 * cron.js — the single hourly time-driven trigger.
 * tick() scans active polls and calls advancePoll with a tick action so the engine
 * processes deadlines, reminders, pivot auto-launch, grace expiry, and auto-book in
 * batch. Never creates per-poll triggers (20-trigger cap).
 */

function tick() {
  reconcileOutbox(); // resolve any CREATE_EVENT that crashed mid-send before advancing
  Store.activePollIds().forEach(function (pollId) {
    try {
      applyCalendarRechecks(pollId); // record newly-busy slots as the organizer's Can't
      advancePoll(pollId, { kind: 'tick' });
    } catch (e) {
      Store.appendAudit(pollId, 'tick_error', { error: String(e) });
    }
  });
}

/** Idempotent installer for the one hourly trigger. */
function installTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'tick';
  });
  if (!exists) {
    ScriptApp.newTrigger('tick').timeBased().everyHours(1).create();
  }
  return exists ? 'already installed' : 'installed';
}
