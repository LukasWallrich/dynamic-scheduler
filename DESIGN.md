# Dynamic Group Scheduler — Design

A lightweight Doodle/Calendly alternative for group meetings (3–10 people). Instead of a
large up-front grid, the organizer proposes a few slots (2–8, 3–5 recommended); the system detects early when the
proposal set is provably dead and pivots once, computing a rescue slate from constraints
collected along the way. Backend: Google Apps Script (sheet-backed storage, one global
time-driven trigger, MailApp, CalendarApp).

**Guiding principle:** propose narrowly, learn only from failure, and stop asking as soon
as the decision is determined.

## Core concepts

- **Candidate universe** — all free windows of the meeting's duration in the organizer's
  Google Calendar within a declared horizon (e.g. "next 3 weeks"), inside the organizer's
  working hours. Only these *poll-level* bounds reduce the universe globally. Person-level
  vetoes never shrink it (see Constraints below). Free/busy is a live fact, not a setup
  snapshot: slots are rechecked against the calendar at page render, at vote submission,
  and before HOLD, approval, and booking. A slot that has become busy is marked Blocked
  and doom status is recomputed. Default blocking policy: events the organizer shows as
  Busy block; declined, free-marked, and working-location events do not; all-day events
  block only if marked Busy.
- **Slate** — an immutable, versioned set of proposed slots (2–8; 3–5 recommended, and
  the setup UI strongly nudges that range — "propose narrowly" is still the intent, but
  the hard cap was raised from 3 on organizer request). Slate 1: organizer-picked.
  Slate 2 (rescue): system-computed. Hard cap at two slates; after that, escalate to the
  organizer.
- **Constraint pool** — vetoes collected from *all* invitees: days-of-week, specific
  dates/weeks, time bands. Stored **per person** and applied per person: a required
  attendee's veto hard-excludes a candidate; an ordinary attendee's veto counts as a
  predicted "Can't" for that person in scoring. (Subtracting all vetoes globally would be
  wrong — one optional attendee's "no mornings" must not delete mornings that satisfy the
  success rule without them.)
- **Candidate bench** — specific slots counter-proposed by blocked invitees, chosen from
  the organizer's free windows minus the proposer's own vetoes and any required-attendee
  hard exclusions known so far (so proposals are feasible for the organizer and consistent
  with required people's stated constraints). Bench slots are scored by later visitors and
  carry those votes into the rescue slate.
- **Success rule** — declared at setup as an explicit predicate (all clauses AND-ed;
  unused clauses default to trivially true):

  ```
  feasible(slot) =
        every required attendee has a recorded Works or If-needed on the slot
    AND attending(slot) ≥ min_attendees
    AND absent(slot)    ≤ max_absences
  ```

  Definitions: the invitee set is fixed at setup; the organizer is a member of it and is
  always required. `attending` = explicit Works + If-needed votes. During an open round,
  `absent` counts only explicit Can't votes; at a round deadline, ordinary invitees'
  silence also counts as absent (required attendees' silence blocks instead — it never
  converts to absent). `min_attendees` and `max_absences` are distinct on purpose: with a
  loosely committed invitee list, min_attendees is the absolute floor for the meeting to
  be worth holding, while max_absences bounds how many engaged people may be excluded.

## Response vocabulary

Per slot, three states: **Works / If needed / Can't**. "If needed" means inconvenient but
possible; it satisfies feasibility but ranks below Works in the comparator. No numeric
ranking, no "first choice" mark in v1.

**Vote provenance** is stored with every answer: `explicit_slate_vote`,
`explicit_bench_vote`, `proposal`, or `prefill`. All recorded answers count toward
feasibility and booking — a person's own counter-proposal counts as Works on that slot,
and constraint-derived prefills count as entered. Prefilled answers are shown
pre-selected and stay revisable until the round deadline, but no confirmation tap is
required and the UI does not nudge people to reconsider; provenance is kept for audit.

## Slot lifecycle (recomputed on every state change)

For each slot, using explicit votes only:

- **Bookable** — already satisfies the success rule.
- **Alive** — could satisfy it if every non-responder voted Works (optimistic upper
  bound ≥ rule).
- **Doomed** — cannot satisfy it even under the optimistic bound.
- **Blocked** — a required attendee voted Can't, or the organizer's calendar now shows
  the slot busy.

Silence is never yes and never no — it only caps the optimistic upper bound. Because the
invitee set and denominators are fixed, doom is monotone within a round (a vote revision
triggers a full recompute, which may resurrect a slot only while the poll hasn't pivoted).
The poll pivots when **all** slots are doomed or blocked — which can happen after a
handful of responses.

## Winner selection (HOLD entry)

Deterministic total order on feasible slots: more required-attendee Works → more Works →
fewer If-needed → organizer's stated preference order → earliest start time. A slot
enters HOLD only when (a) it is feasible on explicit votes and every other slot's
*optimistic upper-bound* position in this order is strictly below the winner's *actual*
position, or (b) the round deadline has passed and it wins the tie-break among feasible
slots. Store the comparison that justified the choice for auditability.

## State machine

```
SETUP → ROUND 1 → (winner) ──────────────────────→ HOLD → BOOKING → BOOKED
              └→ (all doomed ∨ deadline) → PIVOT_PENDING → ROUND 2 → HOLD → …
                                                       └→ (fail) → ESCALATE
Additional exits: HOLD → (vote revision breaking feasibility/rejection/calendar
conflict) → recompute (back to
round, PIVOT_PENDING, or ESCALATE); BOOKING → BOOKING_FAILED → organizer alert;
any state → CANCELLED (organizer).
```

1. **SETUP** (organizer, ~1 min): duration, invitees (+ required flags — organizer-
   private by default: invitee-facing pages never label anyone required or ordinary,
   so nobody reads their own or others' weighting off the poll), success rule,
   horizon, 2–8 slots (3–5 recommended), per-poll visibility toggle (neutral status [default] vs. full
   Doodle-style transparency), response deadline. Warn if the proposed slots lack
   diversity (all same day / same time band). Plain-language preview of the social
   contract ("If none of these can reach N people, we'll propose up to 3 alternatives;
   decision by Tue 3pm."). Organizer profile (reused across polls): working hours,
   timezone, pivot auto-launch delay (default 4 working hours).

2. **ROUND 1**: invitees get personal tokenized links (no login). One page: three buttons
   per slot, plus a **collapsed** veto strip ("Days that never work, or dates you’re
   away?") that any invitee may open — zero cost to ignore on the
   happy path. For someone who marks
   all slots Can't, the veto strip auto-expands and the page adds the counter-proposal
   picker: "Here's when the organizer is still free — pick 3 that could work for you."
   Picks join the bench. Every later visitor also scores whatever bench slots exist at
   visit time (same three buttons; anonymous support counts shown where visibility
   allows). Bench votes are explicit votes and carry forward. Because early visitors
   never saw late bench slots, raw support counts are **display only** — pivot scoring
   uses per-person vote records and treats unasked people as unknown, never as opposed.

3. **PIVOT_PENDING** (entered when all slots doomed/blocked, or deadline without a
   feasible slot): the system scores the candidate universe per person — hard gates
   first (organizer free, required-attendee feasibility, quorum reachability), then
   explicit Works, explicit If-needed, predicted Can't from vetoes, organizer preference.
   Diversity is applied *outside* the scoring: pick the best slot, then the best
   remaining slot on a different day, then the best in a different time band (fall back
   to next-best unrestricted if the universe is too small). Bench slots compete via
   their explicit votes. The organizer gets an email listing **every proposed slot**
   with its per-slot reasoning — including which people block or veto what (organizer
   diagnostics name people; only invitee-facing views stay neutral) — so the decision
   can be made from the email alone; it links to a page (not a direct-action link)
   where the organizer votes and launches in one step. The launch page shows the
   organizer's own Works / If-needed / Can't controls on each proposed slot,
   prefilled to Works (the slots are drawn from their free windows) — so the default
   is still one click, but the organizer votes *first*, before invitees are asked,
   and can downgrade or veto a slot (a Can't drops it and pulls the next candidate).
   Only if the auto-launch delay expires does the cron launch with the Works prefills
   recorded on the organizer's behalf (revisable, like any prefill). Either way the
   organizer, as a required attendee, has a recorded vote on every slate-2 slot —
   without one, no rescue slot could ever be feasible. If the organizer doesn't react within their configured delay
   (default 4 working hours, evaluated against their working-hours calendar), the cron
   launches it automatically. The grace window also absorbs misclick corrections: a vote
   revision during PIVOT_PENDING triggers recompute and can cancel the pivot.

4. **ROUND 2**: same page mechanics; veto collection and bench are closed (final round).
   Anyone whose explicit votes already cover every slate-2 slot is not contacted — their
   votes stand. Contact only people with ≥1 unscored slot. A promoted slot counts as
   Works for its proposer (shown as a marked, revisable prefill — no confirmation
   required). Required attendees must have a recorded vote on the eventual winner.

5. **HOLD**: winner selected per the comparator. HOLD is **organizer-only**: the
   organizer gets an approve/reject email showing the winner and who it covers,
   including who has said Can't and so *may report a clash* (link to a confirmation
   page — never a state-changing GET). No reaction → auto-book after 24 h via the cron.
   Invitees are deliberately **not** told about a provisional time — announcing one
   invites relitigation and risks opening another cycle; they next hear via the
   calendar invite. Their pages still accept vote revisions until booking; if a
   revision breaks feasibility, HOLD is cancelled and the poll recomputes (possibly
   straight into PIVOT_PENDING or ESCALATE). Organizer rejection excludes the slot and
   recomputes.

6. **BOOKING → BOOKED**: final live calendar recheck, then create the event; `BOOKED`
   means a `calendarEventId` is stored. Creation failure → `BOOKING_FAILED` + organizer
   alert, state not falsely advanced. The calendar invite goes to **all invitees**
   (single contract, no exceptions), with the event description noting that poll
   responses were advisory; explicit Can't voters simply decline, and anyone with a
   conflict reports the clash to the organizer directly. Stale links show "already
   scheduled" plus the organizer's email address for out-of-band contact (no in-app
   note box; the poll does not reopen).

7. **ESCALATE** (rescue slate infeasible, or empty universe at pivot): no automatic
   Round 3. Diagnosis names the failed *rule* and the binding people ("no slot reaches
   4 with Maya in it; Maya's no-Tuesdays veto and Jonas's Can'ts are binding"), and
   offers explicit levers: relax the rule, extend the horizon, book the least-bad slot
   (shown with who makes it and who may report a clash), or cancel.

## Stragglers & email policy

All mail is sent from the organizer's own Gmail via GmailApp — invitations with the
personal link come from a real human sender, not a noreply address, which helps response
rates. The mail is nonetheless written as what it is — a scheduling tool acting on the
organizer's behalf — not as simulated personal notes; no faux-chatty prose in the
organizer's voice. Deadline per round + act-early-when-decidable. Cadence per invitee
per poll, hard-capped: invite → one reminder to non-responders (midway to deadline) →
required-grace reminder (required silents only, see ladder below) → round-2 ask (only
those with unscored slots) → calendar invite. No pivot FYI emails — the
persistent page carries status. Reminder targeting is simple (all incomplete responders);
no "can their answer change the outcome" solver in v1. A daily email budget counter
(consumer Gmail ≈ 100/day) suppresses lowest-priority mail first and surfaces the
squeeze to the organizer.

Silence semantics by role: required person's silence blocks final booking; ordinary
invitee is scheduled without them at the deadline; optional attendees never block and
never count toward max_absences.

**Required-person escalation ladder** (cron-driven): responses are attributable because
each vote arrives via the invitee's personal token, so the system always knows which
required people are still silent. If any are silent at the round deadline, the round
enters a 24 h **required-grace** state: ordinary invitees' silence is resolved normally,
but the round doesn't close; each silent required person gets one personal reminder
("the meeting can't be scheduled without you — 24 h left"). If still silent when the
grace expires, the organizer is informed with the silent names and explicit options:
extend another 24 h, demote the person to ordinary (the poll then resolves without
them), chase them out-of-band, or cancel. The poll never stalls silently — every path
out of required-silence is an explicit organizer choice with a default nudge.

## Concurrency & execution model (Apps Script)

- **Single transition function**: every entry point (vote submission, vote revision,
  organizer action, cron tick) calls `advancePoll(pollId)` under
  `LockService.getScriptLock()` (≈10 s timeout; on failure return a retryable "busy"
  response to the client). Inside the lock: reload canonical state, reject stale writes
  via a per-poll monotonic revision number, recompute derived status, perform at most
  one legal transition, append intended side effects to an **outbox** (e.g.
  `SEND_REMINDER`, `CREATE_EVENT`) with idempotency keys, commit, release, then execute
  the outbox. Never infer from poll state whether a side effect already happened —
  check the key.
- **One global time-driven trigger** (hourly): scans active polls and processes
  deadlines, reminders, pivot auto-launches, and auto-books in batch. Never create
  per-poll triggers (20-trigger cap). Deadlines are additionally evaluated
  opportunistically on every web request, server-side, by receipt time — the cron is a
  backup clock, and a page loaded before the deadline cannot submit after it.
- **Storage**: a spreadsheet is the canonical store, normalized and append-friendly —
  tables for polls, invitees, slots, votes (with provenance + revision), constraints,
  outbox/audit. Script Properties hold only deployment config and small indexes
  (9 KB/value, 500 KB total limits rule them out as the main store).

## Security model (tokenized links)

The web app executes as the deployer (so invitees need no Google login), which means
every request runs with the organizer's authority — authorization is therefore strictly
server-side per token. High-entropy random tokens; only hashes stored. GET renders
pages; every mutation is a POST with a per-session nonce. No state-changing links in
emails (mail scanners follow GETs) — email buttons land on confirmation pages.
`Cache-Control: no-store`, no third-party assets, referrer suppressed. Possession of a
link = acting as that invitee; tokens are rotatable/revocable by the organizer.

## Timezones

Store IANA timezone IDs plus exact UTC instants. Slots display event-local and
viewer-local times. Day and time-band vetoes are interpreted in the *invitee's*
timezone with fixed band boundaries (morning ends 12:00, afternoon 12:00–17:00, evening
after 17:00, invitee-local). v1 refuses to create polls whose horizon spans a DST
transition in the event timezone (lifted once tested).

## Interaction principles

- **One persistent personal page per invitee** that always renders their current task:
  slate 1 → saved → bench slots → slate 2 → final details. Revisable until booking
  (carried bench votes are revisable until the round-2 deadline).
- **Visibility** is a per-poll organizer toggle; neutral is the default ("all slots
  still in contention", anonymous counts). Full transparency shows names + answers and
  is flagged to invitees before they respond.
- **Explain consequence, not algorithm**: invitees see "if none work, we'll ask for a
  bit more". Organizer diagnostics are fully specific: they name the rule that failed
  *and* the people whose votes or vetoes block a slot — the organizer needs to know who
  the block is to act. Invitee-facing views stay neutral (anonymous counts) unless
  transparency mode is on.
- If an exact vote contradicts a coarse veto, the exact vote wins for that slot; the
  contradiction is surfaced for correction.

## Deliberate v1 exclusions

First-choice marks; combined/custom success-rule syntax beyond the three-clause
predicate; automated "can this answer change the outcome" reminder targeting; live
Calendar push-sync (polling rechecks suffice); DST-spanning polls; invitee calendar
integration. The two-slate cap and the bench are **in** — the bench (feasible
counter-proposals + early scoring, with provenance rules) is the product's distinctive
mechanic, retained against reviewer advice with its consent and exposure-bias fixes
applied.

## Failure modes designed for

Near-identical proposed slots (diversity warning); vetoes-only respondents (blocked
invitees must pick 3 feasible alternatives); counter-proposals the organizer can't make
(impossible by construction); strategic all-Can't (make If-needed socially safe);
popular slot missing a required person (hard gate); non-responders keeping slots alive
forever (upper bound + deadline); endless rounds (two-slate cap); misclick-triggered
pivot (PIVOT_PENDING grace); organizer calendar changes mid-poll (live rechecks);
double-booking and duplicate email (locks + idempotent outbox); late responses after
booking (closed page + organizer contact); provisional announcements reopening debate
(HOLD is organizer-only); rescue slots as false precision (still confirmed by people);
trigger/email quota exhaustion (global cron + email budget).
