# Handover — Dynamic Group Scheduler

Snapshot for the next session. Written 2026-07-21.

## What this is

A lightweight Doodle/Calendly alternative for 3–10 person meetings. The organizer
proposes a few slots; the system learns only from failure, detects when a slate is
provably dead, and pivots once to a system-computed rescue slate. Full behavior spec in
**DESIGN.md** (authoritative). Module contract in **ARCHITECTURE.md**. HTTP/JSON API
contract in **API.md**.

## Architecture (disentangled, three layers)

- **`core/`** — pure JavaScript decision logic (`Sched.votes/constraints/engine/pivot/
  universe/text`). No platform APIs, all time injected. Runs identically under Node
  (tests) and Apps Script, and is ALSO loaded by the browser frontend for live
  client-side feasibility preview. This is the reusable heart.
- **`gas/`** — the Apps Script backend, now a pure **JSON HTTP API** (`gas/web.js` is the
  dispatcher; `gas/api.js` builds the read view-models; `advance/store/calendar/mail/
  cron/security/bootstrap`). Reuses `core/` for every decision. Serves no HTML.
- **`frontend/`** — a standalone **static, no-build** app (vanilla JS: `index.html`,
  `app.js`, `api.js`, `ui.js`, `views.js`, `styles.css`, `mock-api.js`). Talks to the
  backend via CORS *simple requests* only. Hostable anywhere; currently only served from
  localhost (see Open items).

`npm test` → 52 Node tests, all green (unit per core module + `test/api.test.mjs` +
`test/scenario.test.mjs` end-to-end journey replay).

## Deployment (Google Apps Script, via clasp 3.3)

- **scriptId**: `1nRWxBQH2AkuSyrp7PKRaCrIXfyJT8HagYo_bc4WL0LLbYdx19ZwSBv-8`
- **Live web app** (Anyone-access, this is the one the frontend points at):
  deployment `AKfycbwTHEhRmpl5K7nzZyRSyXqVj768QHIWMLJf0gvrMoJ8wbecbKDOD18elo3HoHc33oXK`,
  currently **@13**. `/exec` URL is that id at
  `https://script.google.com/macros/s/<id>/exec`.
- **Deployer IS the organizer** (lukas.wallrich@gmail.com); free/busy + booking run on
  their calendar; organizer email taken from `Session`, not the request.
- **Setup token** (organizer-only): stored in Script Properties `SETUP_TOKEN` — read it
  there, or run `getSetupUrl()` / `bootstrap()` in the Apps Script editor to print it.
  Never commit the raw token (this repo is public).
- **Redeploy cycle** after any `gas/` or `core/` change:
  ```
  clasp push --force
  clasp create-version "<msg>"                       # note the version number N
  clasp update-deployment --versionNumber N \
    AKfycbwTHEhRmpl5K7nzZyRSyXqVj768QHIWMLJf0gvrMoJ8wbecbKDOD18elo3HoHc33oXK
  ```
- **Serving the frontend for a test** (needs repo root so `../core/*.js` resolves):
  ```
  python3 -m http.server 8748     # from repo root
  open "http://localhost:8748/frontend/index.html?setup=<SETUP_TOKEN>&api=<EXEC_URL>"
  ```
  Invitee/organizer links use `?token=<t>` (role/state come from `getState`).

## What works (verified live)

Setup wizard pulls real calendar free/busy; `createPoll` succeeds end-to-end and sends
invites from the organizer's Gmail; JSON API round-trips; the aligned slot grid, 2–8
slots with a 3–5 nudge, 48h default deadline, bulk email paste, visible validation
errors, resubmit protection, and the new paint-over absence calendar all render and
drive correctly (against the live backend and/or `?mock=1`).

## Open items (in priority order)

1. **Drop the tap-start/tap-end range mode in the absence paint calendar.** It's broken
   on desktop (relies on touch, not mouse) and is redundant with tapping two individual
   days. Keep exactly two interactions: **drag-to-paint a span** (must work with MOUSE
   drag on desktop AND touch drag on mobile) and **single click/tap toggles one day**.
   Remove the two-tap range fallback and its ghost-event guards. Code: `frontend/
   views.js` `absenceCalendar()` / the paint handlers. Verify desktop mouse-drag paints a
   contiguous span in a real browser (not just headless).
2. **Host the frontend for real (GitHub Pages / Netlify).** It's currently only on
   `localhost:8748` (this machine), so emailed invite links only work here. After
   hosting: set `API_BASE` in `frontend/api.js` to the `/exec` URL so links don't need
   `?api=`; the backend already builds invite links from the per-poll `linkBase` the
   frontend sends (`App.api.linkBase()`), so links will point at the hosted app
   automatically. Note `frontend/` loads `../core/*.js` — host the repo (or copy `core/`
   alongside `frontend/`); see `frontend/README.md`.
3. **Full end-to-end smoke test through the real UI.** Not yet done UI-driven: create a
   poll in the wizard → open two invitee links → vote both to Works → organizer approves
   HOLD → confirm a real Calendar event is created. (createPoll is verified; the
   vote→HOLD→book tail has only been exercised in `test/scenario.test.mjs`, not live.)
   Test invites currently go to `lukas.wallrich+t1@` / `+t2@`.
4. **Store self-heal is a v1 shortcut.** `gas/store.js` `sheet()` repaves a tab when its
   header drifts from the schema (destroys data). Fine while data is disposable; before
   real use, replace with a row-preserving migration.

## Gotchas learned this session (don't rediscover these)

- **Apps Script CORS**: a cross-origin browser can read responses ONLY for *simple
  requests* — GET, or `POST` with `Content-Type: text/plain` and JSON in the body.
  `application/json` triggers a preflight Apps Script can't answer. The frontend already
  does text/plain POST. (Verified empirically.)
- **curl can't POST to `/exec`**: it mangles Apps Script's POST→302 redirect (drops the
  body), always 404s. Debug write actions in a browser, not curl. GET health check works.
- **Headless Chrome clamps to 500px min width** (old headless): "mobile" screenshots look
  clipped/overflowing when they're actually fine — a false alarm. To truly test 390px,
  wrap with `body{max-width:390px}` or measure `document.body.scrollWidth`.
- **Adding a column to a `store.js` TABLES array** silently corrupts an existing sheet
  (writes by code order, reads by stored header). The self-heal now catches it, but be
  aware when changing schema.
- **`tzOffset` must round to whole minutes** — comparing a second-precision local time to
  a millisecond-precision instant (a `Date.now()` horizon end) left a sub-second
  remainder that made `spansDst` falsely reject valid single-season polls. Fixed; test in
  `test/universe.test.mjs`.
- **clasp 3.x**: web-app "Who has access = Anyone" can only be set when *creating* a
  deployment in the UI, not by editing one. `update-deployment` changes the version only.
  The current live deployment is already Anyone-access.

## Design decisions made this session (all reflected in DESIGN.md)

Chose the V4 "storyboard" journey direction (artifact
`https://claude.ai/code/artifact/fa7f6c61-309c-4a15-b103-d6ecdd2ec996`); emails in neutral
tool voice; no provisional-time notices (HOLD is organizer-only); prefills count without
confirm; required flags organizer-private; organizer diagnostics name blockers (invitee
views stay anonymous); organizer votes first at pivot launch; slate size raised from ≤3 to
2–8 (3–5 recommended); invitee avoid-rules are working-day toggles + a paint-over absence
calendar (date-range constraints), no time-of-day bands.

## Project memory

See `~/.claude/projects/-Users-lukaswallrich-Documents-Coding-calendly-dynamic/memory/`
(`scheduler-mockup-direction`, `scheduler-v1-build`) for cross-session context.
