# Handover — Dynamic Group Scheduler

Snapshot for the next session. Updated 2026-07-21 (production-readiness session).

## What this is

A lightweight Doodle/Calendly alternative for 3–10 person meetings. Full behavior spec in
**DESIGN.md** (authoritative). Module contract in **ARCHITECTURE.md**. HTTP/JSON API
contract in **API.md**. README.md now carries a screenshot walkthrough from a real run.

## Current state: deployed and verified end-to-end

- **Public repo / hosting**: https://github.com/LukasWallrich/dynamic-scheduler (public,
  fresh history — the pre-publication local history is on the local branch
  `archive-local-history`). Frontend served by GitHub Pages from repo root:
  https://lukaswallrich.github.io/dynamic-scheduler/frontend/ . `API_BASE` in
  `frontend/api.js` is baked to the live `/exec` URL, so emailed links work anywhere.
- **Backend deployment**: scriptId `1nRWxBQH2AkuSyrp7PKRaCrIXfyJT8HagYo_bc4WL0LLbYdx19ZwSBv-8`,
  Anyone-access deployment `AKfycbwTHEhRmpl5K7nzZyRSyXqVj768QHIWMLJf0gvrMoJ8wbecbKDOD18elo3HoHc33oXK`
  currently **@17**. Redeploy cycle after any `gas/` or `core/` change:
  ```
  clasp push --force
  clasp create-version "<msg>"                       # note version N
  clasp update-deployment --versionNumber N <deploymentId>
  ```
- **Deployer IS the organizer** (lukas.wallrich@gmail.com). Setup token lives in Script
  Properties `SETUP_TOKEN` (print with `getSetupUrl()` in the editor; never commit it —
  the repo is public). Setup URL: `<pages-frontend-url>?setup=<token>`.
- **Verified live 2026-07-21** (full UI-driven E2E, screenshots in `docs/screenshots/`):
  hosted wizard → createPoll → Gmail invites to `lukas.wallrich+a@` / `+b@` → both
  invitee pages voted (incl. painted absence days) → early decision → HOLD with correct
  "Covers:" email → Approve & book → real Calendar event with all three attendees.
  Hourly cron trigger is installed and firing (reminder rows in outbox confirm).

## Bugs found & fixed this session (all deployed @17)

1. **GAS global-scope collision** (the big one): every deployed file shares ONE global
   scope; `gas/api.js` and `core/text.js` both defined `namesWithAnswer` with different
   signatures, so hold emails said "no confirmed attendees yet". Node tests missed it
   (per-module scope). Fixed by renaming/deduping (`namesByAnswer`, `pivotIsRequired`,
   `pivotBandOf`, web.js reuses `Sched.engine.liveSlots`); **`test/globals.test.mjs` now
   fails on any duplicate top-level name across core/ + gas/** — keep it green.
2. Deadline `datetime-local` input displayed UTC−offset instead of UTC+offset (2× tz
   error on screen; stored value was right). `frontend/views.js`.
3. `createPoll` stored empty `organizerName` (frontend never sends it) → emails read
   " is scheduling". Server now falls back to the email local part. `gas/web.js`.
4. `createPoll` never seeded the organizer's `proposal` Works votes, so the required
   organizer was permanently silent in ROUND1 → no early decision, and REQUIRED_GRACE
   would have waited on an organizer with no way to vote. Now seeded per DESIGN.md
   provenance rules. `gas/web.js`.
5. Absence paint calendar: dropped the broken two-tap range mode; now exactly drag-to-
   paint (pointer events, mouse+touch identical) + single tap toggles one day. Verified
   with real mouse events via CDP.

Also: full lean-copy pass across `frontend/views.js`, `core/text.js` emails, and
DESIGN.md's quoted veto-strip label (test updated to match).

## Open items

1. **Store self-heal is still a v1 shortcut.** `gas/store.js` `sheet()` repaves a tab
   when its header drifts (destroys data). Replace with a row-preserving migration
   before the store holds polls anyone cares about.
2. Test artifacts: test polls in the store sheet are terminal (CANCELLED/BOOKED); the
   E2E "Project Kickoff" calendar event is deleted after the walkthrough. Wipe the
   sheet tabs whenever a clean slate is wanted.
3. `?mock=1` demo mode exists on the hosted frontend for UI work without the backend.

## Gotchas (don't rediscover)

- **Apps Script single global scope** — see bug 1 above; `test/globals.test.mjs` guards it.
- **Apps Script CORS**: browsers can read responses only for *simple requests* — the
  frontend does POST with `Content-Type: text/plain` + JSON body. Never application/json.
- **curl can't POST to `/exec`** (302 body-drop) — drive writes from a browser context
  (see `scratchpad cdp.mjs` pattern: page fetch via CDP). GET health check works.
- **`?mock=1` intercepts fetch** — never probe the real API from a page loaded with mock
  (this burned an hour: a "cancelPoll" hit the mock and returned fake state).
- **Early decision needs a strict winner**: identical support on all slots ties → waits
  for the deadline tiebreak. In tests, differentiate votes to trigger early HOLD.
- **BOOKING → BOOKED** requires the next advance (hourly cron); the calendar event
  itself is created immediately at approve time.
- **Headless Chrome clamps to 500px min width** for "mobile" screenshots — false alarms.
- **`tzOffset` must round to whole minutes** (spansDst false positives; test exists).
- **clasp 3.x**: "Anyone" web-app access can only be set when creating a deployment in
  the UI; `update-deployment` changes the version only.

## Project memory

See `~/.claude/projects/-Users-lukaswallrich-Documents-Coding-calendly-dynamic/memory/`.
