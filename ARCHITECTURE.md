# Architecture

Two layers. `core/` is pure JavaScript — no Apps Script APIs, no `Date.now()`, no I/O —
and runs identically under Node (tests) and Apps Script (production). `gas/` is the thin
Apps Script shell: storage, HTTP, calendar, mail, locking, cron. The shell never decides
anything; it loads a snapshot, calls the core, persists what the core returns, and
executes the side effects the core requested.

## Shared module pattern

Every `core/` file attaches to one global namespace and stays require-able in Node:

```js
var Sched = globalThis.Sched = globalThis.Sched || {};
Sched.engine = { /* ... */ };
if (typeof module !== "undefined") module.exports = Sched;
```

Core files may read other `Sched.*` members but never call platform globals. All time
enters the core as an argument (`nowUtc`, epoch ms).

## Snapshot (the one data shape)

Everything the core needs about a poll, loaded fresh under lock on every entry:

```js
{
  poll: { pollId, rev, state, title, durationMins, tz, organizerEmail, organizerName,
          horizonStartUtc, horizonEndUtc, workingHours: {startHour, endHour, days:[1..5]},
          visibility,               // "neutral" | "full"
          minAttendees, maxAbsences,
          slateVersion,             // 1 | 2
          round1DeadlineUtc, round2DeadlineUtc,
          pivotDelayHours,          // default 4 (working hours)
          pivotProposedAtUtc,       // set on entering PIVOT_PENDING
          launchApprovedAtUtc,      // organizer clicked vote-and-launch (immediate ROUND2)
          holdSlotId, holdStartedAtUtc,
          holdApprovedAtUtc,        // organizer approved the hold (immediate BOOKING)
          holdForced,               // escalate "book least-bad": skip the feasibility
                                    // gate in HOLD (calendar recheck still applies)
          rescueAlternatesJson,     // ranked runners-up beyond slate 2, for Can't-swaps
          requiredGraceUntilUtc, calendarEventId, createdAtUtc },
  invitees: [ { inviteeId, name, email, required, demoted, organizer } ],
  slots:    [ { slotId, startUtc, endUtc, kind,   // "slate1" | "bench" | "slate2"
                slateVersion, proposerInviteeId } ],
  votes:    [ { inviteeId, slotId, answer,        // "works" | "ifneeded" | "cant"
                provenance,  // "explicit_slate" | "explicit_bench" | "proposal" | "prefill"
                rev, atUtc } ],                   // latest rev per (inviteeId, slotId) wins
  constraints: [ { inviteeId, type,               // "dow" | "range" | "week"
                   value, atUtc } ]  // dow: 0-6 (invitee-local day of week);
                                    // range: "YYYY-MM-DD/YYYY-MM-DD" painted absence
                                    // period (both ends inclusive); week (legacy):
                                    // "YYYY-MM-DD" of a Monday. Time-of-day bands were
                                    // dropped from the invitee avoid-rules UI.
}
```

Poll states: `SETUP, ROUND1, PIVOT_PENDING, ROUND2, REQUIRED_GRACE, HOLD, BOOKING,
BOOKED, BOOKING_FAILED, ESCALATE, CANCELLED`. (`REQUIRED_GRACE` carries the round it
suspends in `poll.graceRound`.)

## Core contract (exact names)

`Sched.votes` — `latest(snapshot)` → Map keyed `inviteeId|slotId`; `counts(snapshot,
slotId)`.

`Sched.constraints` — `vetoesSlot(constraint, slot, tz)`; `predictedAnswer(snapshot,
inviteeId, slot)` (`"cant"` | null; explicit vote beats veto);
`contradiction(snapshot, inviteeId, slot)` for the surfaced-correction rule. Bands are
invitee-local: morning < 12:00 ≤ afternoon < 17:00 ≤ evening.

`Sched.engine` —
- `slotStatus(snapshot, slotId, nowUtc)` → `{ status: "bookable"|"alive"|"doomed"|
  "blocked", reasons: [{ rule, inviteeIds, text }] }` (reasons name people — shown to
  the organizer only).
- `feasible(snapshot, slotId, atDeadline)` — success rule on recorded votes; at a
  deadline ordinary silence counts absent, required silence blocks.
- `compare(snapshot, slotIdA, slotIdB)` — total order: required-Works, Works,
  fewer If-needed, organizer preference (slot listing order), earliest start.
- `pickWinner(snapshot, nowUtc)` → `{ slotId, justification } | null` — feasible and
  either every rival's optimistic upper-bound rank is strictly below the winner's
  actual rank, or the round deadline has passed (tie-break by `compare`).
- `advance(snapshot, nowUtc)` → `{ state, pollPatch, slotPatches, effects, voteRecords }`
  — the single transition function. Pure; at most one legal transition per call.
  `voteRecords` (optional) are votes the transition itself creates — e.g. the
  organizer's Works prefills when the pivot auto-launches — persisted by the shell
  exactly like action votes. Effects are
  `{ type, idempotencyKey, ...payload }` with types: `SEND_INVITE, SEND_REMINDER,
  SEND_REQUIRED_GRACE, SEND_ROUND2_ASK, SEND_PIVOT_PROPOSAL, SEND_HOLD_APPROVAL,
  SEND_REQUIRED_STUCK, SEND_ESCALATE, SEND_BOOKING_FAILED, RECHECK_CALENDAR,
  CREATE_EVENT`.

`Sched.pivot` — `rescueSlate(snapshot, freeWindows, nowUtc)` →
`{ slots: [...], alternates: [...] }`, each entry
`{ startUtc, endUtc, benchSlotId, reasoning }` (`benchSlotId` set when the candidate
IS an existing bench slot — the shell promotes it in place so its votes carry;
universe candidates that duplicate a bench slot's window are deduped in the bench's
favor). `slots` is the proposed slate (≤3, diversity applied after scoring),
`alternates` the ranked runners-up used when an organizer Can't at launch drops a
slot. Hard gates (organizer free, required feasibility, quorum reachable) then
explicit Works > If-needed > predicted-Can't penalty; earliest start breaks ties;
reasoning names people. `freeWindows` = `[{startUtc, endUtc}]` from the shell.

`Sched.universe` — `candidateStarts(poll, freeWindows)` → all aligned starts of
`durationMins` inside working hours and horizon; `spansDst(poll)` for the setup refusal.

`Sched.text` — every user-facing string: email subjects/bodies and page fragments,
`text.email.invite(snapshot, invitee, link)` etc. Neutral tool voice ("sent on
<organizer>'s behalf"), consequence-not-algorithm, no names/required-status in
invitee-facing output while visibility is neutral.

## Storage (Google Sheet, one tab per table)

`polls` (one row per poll, `rev` bumped on every commit — stale writes rejected),
`invitees` (+ `tokenHash`), `slots`, `votes` (append-only), `constraints`, `outbox`
(`key, pollId, type, payloadJson, status, attempts, atUtc` — `key` is the idempotency
guard, checked before every send/create), `audit` (append-only event log).

## Shell responsibilities (`gas/`)

- `advancePoll(pollId, action)` — the only writer. ScriptLock (10 s; on timeout return
  retryable "busy"), reload snapshot, apply the action (vote/constraint/bench/organizer
  decision/tick) as new rows, run `Sched.engine.advance` until it reports no
  transition, commit with rev check. When a transition lands in `PIVOT_PENDING` and no
  slate-2 slots exist yet, the shell — still inside the lock — fetches free windows,
  calls `Sched.pivot.rescueSlate`, promotes chosen bench slots in place (patch `kind`/
  `slateVersion`, keeping the slotId so carried votes follow) and appends the rest as
  new slate-2 slots, storing the ranked runners-up on the poll row so an organizer
  Can't at launch can pull the next candidate. Outbox rows are claimed atomically
  (pending → executing) inside the lock before it is released; CREATE_EVENT re-enters
  the lock to re-verify state and feasibility immediately before creating, and a
  crashed `executing` CREATE_EVENT is reconciled on the next tick by searching the
  calendar for the event before re-creating. Server-side validation lives here too:
  setup shape (2–3 slots, sane rule numbers, valid emails, deadline inside horizon),
  bench proposals only in ROUND1 from an all-Can't proposer and only from the offered
  candidate set, organizer decisions only in the state that shows them and only for
  the slot they target.
- `doGet` — routes by token: invitee page, organizer dashboard / pivot / hold /
  escalate pages, setup form, closed page. `Cache-Control: no-store`; GETs are strictly
  read-only — they render from the snapshot (including display-only calendar rechecks
  and deadline-aware rendering) and never call `advancePoll`; transitions happen on
  POSTs and cron ticks only.
- `doPost` — nonce-checked mutations; deadlines re-evaluated server-side at receipt.
- Tokens: 128-bit random; the Sheet stores only SHA-256 hashes. Raw tokens (needed to
  rebuild links for reminder emails) live in Script Properties, keyed per poll — never
  in the Sheet. Possession = identity. Nonces are per-render, multi-valid, consumed on
  use. Idempotency keys for effects that can legitimately fire again (e.g. HOLD
  approval after a cancelled hold) include the arming timestamp.
- Calendar: free/busy per the blocking policy (Busy blocks; declined/free/
  working-location don't; all-day only if Busy). Live recheck at render, vote, HOLD,
  approval, booking.
- Mail: GmailApp, daily budget counter in Script Properties; lowest-priority mail
  suppressed first and the squeeze surfaced to the organizer.
- Cron: one hourly trigger for all polls — deadlines, reminders, pivot auto-launch,
  auto-book, grace expiry.

## Verification

`npm test` runs `node --test test/` — unit tests per core module plus
`test/scenario.test.mjs`, which replays the full reference journey (6 people, slate 1
dies, bench, pivot, organizer votes at launch, round 2, HOLD, booked) against the pure
core with a scripted clock, asserting states, effects, and email cadence caps at each
beat. The GAS shell stays thin enough that what the tests can't reach is adapter glue.
