# HTTP/JSON API contract

The seam between frontend and backend. The frontend is a standalone static app; it knows
only this contract, never Apps Script. Any backend that implements these endpoints (Apps
Script today, a Node/serverless service later) can serve the same frontend. `core/` is
shared by both sides: the backend uses it for authority, the frontend for instant
client-side feasibility preview.

## Transport

- Single endpoint, action-dispatched: every call is `POST` with a JSON body
  `{ action, ...payload }` and a JSON response. POST-only (even for reads) deliberately —
  it keeps requests as CORS "simple requests" (`Content-Type: text/plain`, JSON in the
  body) and sidesteps Apps Script's GET-redirect behavior. The backend parses the text
  body as JSON.
- Identity is a token in the body, never the URL path: `token` (invitee/organizer) or
  `setupToken` (poll creation). Possession = identity; the server authorizes per token.
- Responses: `{ ok: true, data }` or `{ ok: false, error: { code, message, fields? } }`.
  `code` ∈ `bad_request | unauthorized | wrong_state | rejected | busy | not_found |
  server_error`. `busy` means the lock was held — client retries. `error.fields`, when
  present, is an **array of human-readable messages** to display as a list (e.g. setup
  validation) — the frontend must render them all, not treat it as a field→message map.
- The server is the sole authority on **visibility**: invitee responses never include
  other people's names or required/optional status while visibility is `neutral`. The
  frontend renders whatever it is given and cannot leak what it never receives.

## Reads

### `getState` — the one read an invitee/organizer page needs
Request: `{ action: "getState", token }`
Response `data`:
```
{
  role: "invitee" | "organizer",
  poll: { title, state, tz, durationMins, visibility,
          deadlineUtc, roundLabel },          // no participant data here
  you:  { name, answersBySlotId: { <slotId>: "works"|"ifneeded"|"cant" } },
  slots: [ { slotId, startUtc, endUtc, kind,   // "slate1"|"slate2"|"bench"
             yourVote, busy,                    // busy = live calendar recheck
             support?: { works, ifneeded, cant },   // present per visibility rule
             status?, reasons? } ],            // status/reasons: organizer only (names people)
  bench: [ ... same shape ... ],
  benchOptions?: [ { startUtc, endUtc } ],     // present only when you may counter-propose
  organizer?: {                                // organizer role only
     coverage: [ { name, responded } ],
     emailBudget: { used, total, squeezed },
     diagnostics: [ { slotId, rule, people, text } ],
     pivot?: { proposed: [ { slotId, startUtc, endUtc, reasoning } ], dueUtc },
     hold?:  { slotId, confirmed: [name], mayClash: [name], autoBookUtc },
     escalate?: { diagnosis, levers: [ { id, label } ] } }
}
```

### `getSetupContext` — powers the setup pickers
Request: `{ action: "getSetupContext", setupToken }`
Response `data`: `{ organizerEmail, organizerName, tz, defaultWorkingHours,
freeWindows: [ { startUtc, endUtc } ] }` — free windows across a default look-ahead so the
slot picker shows real availability. (The frontend can re-request with `{ horizonStartUtc,
horizonEndUtc }` once the organizer sets a horizon.)

## Writes (all take `token`, or `setupToken` for createPoll)

| action | payload | effect |
|---|---|---|
| `createPoll` | `{ setupToken, poll }` (see below) | validates, creates, sends invites → `{ pollId, dashboardToken }` |
| `submitVotes` | `{ token, votes: {<slotId>: answer}, constraints? }` | records votes (+ optional vetoes) |
| `saveConstraints` | `{ token, constraints }` | dow/week/range vetoes; REPLACES the invitee's whole set ([] clears) |
| `proposeBench` | `{ token, slots: [{startUtc,endUtc}] }` | counter-proposals (validated server-side against the offered set) |
| `organizerLaunch` | `{ token, votes: {<slotId>: answer} }` | records organizer votes on the rescue slate, launches round 2 |
| `organizerApprove` | `{ token, slotId? }` | approve hold (or book least-bad from escalate) |
| `organizerReject` | `{ token, slotId }` | reject the held slot, recompute |
| `extendGrace` | `{ token }` | +24h required-grace |
| `demoteRequired` | `{ token, targetInviteeId }` | demote a silent required person |
| `retryBooking` | `{ token }` | re-arm a failed booking |
| `cancelPoll` | `{ token }` | cancel |
| `rotateToken` | `{ token, targetInviteeId }` | revoke/reissue a link |

Every write re-evaluates deadlines server-side by receipt time and runs the single locked
`advancePoll`; the response is a fresh `getState` `data` so the frontend re-renders from
authoritative state in one round-trip.

### `poll` object for `createPoll`
```
{ title, durationMins, tz,
  horizonStartUtc, horizonEndUtc,
  workingHours: { startHour, endHour, days: [1..5] },
  minAttendees, maxAbsences, pivotDelayHours,
  round1DeadlineUtc, visibility,
  invitees: [ { name, email, required } ],       // organizer added server-side
  slotStartsUtc: [ <utc>, ... ],                 // 2-8; picked, not typed; each must be
                                                 // in the server-recomputed candidate set
  linkBase }                                     // where the frontend is hosted; the
                                                 // backend appends ?token=<t> (or &token=)
                                                 // to build every invitee/organizer link
                                                 // it emails. The frontend supplies its own
                                                 // location; a hosted build with a baked-in
                                                 // API base sends just origin+path.
```
Server validates shape, DST span, diversity, calendar-freeness, and returns field-level
errors under `error.fields` on failure.

## Notes for a non-Apps-Script backend

The contract assumes only: per-token authorization, a lock around state transitions, a
free/busy source, an email sender, and a periodic tick. `core/` supplies every scheduling
decision. An alternate backend re-implements storage + those four capabilities and reuses
`core/` unchanged.
