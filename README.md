# Dynamic Group Scheduler

A lightweight Doodle/Calendly alternative for 3–10 person meetings, running entirely as a
Google Apps Script web app on the organizer's own account. The organizer proposes 2–3
slots; the system learns only from failure, detects when a slate is provably dead, and
pivots once to a system-computed rescue slate. Invitees respond via personal tokenized
links with no login.

**The deployer is the organizer.** The web app executes as the deploying account, so
free/busy checks and the final calendar booking both run on that account's default
calendar, and the organizer's email is taken from the session at setup (any value typed
into the form is ignored). Deploy one instance per organizer.

## Architecture

- `core/` — pure JavaScript decision logic (`Sched.*`), no platform APIs, unit-tested under Node.
- `gas/` — the Apps Script shell: storage, HTTP, calendar, mail, locking, cron. It loads a
  snapshot, calls the core, persists what the core returns, and executes the side effects
  the core requested. See `ARCHITECTURE.md` for the module contract.

## Deploy

1. `clasp login`
2. `clasp create --type webapp --title "Group Scheduler"` (or `clasp clone <id>` for an existing project)
3. `clasp push` — pushes `core/`, `gas/`, and `appsscript.json` (per `.claspignore`).
4. In the Apps Script editor: **Deploy → New deployment → Web app**, execute as *me*, access
   *Anyone*. Authorize the requested scopes (Sheets, Calendar, Gmail, triggers).
5. Run `installTrigger` once from the editor to create the single hourly cron.
6. Open the setup URL: `<web-app-url>?setup=<SETUP_TOKEN>`. The token is minted on first use
   and stored in Script Properties (`SETUP_TOKEN`) — read it there, or call `Security.setupToken()`
   from the editor.

## Where data lives

- A Google Sheet named `DynamicScheduler-Store` (auto-created on first use; its id is kept in
  Script Properties under `SPREADSHEET_ID`) holds every table: `polls`, `invitees`, `slots`,
  `votes`, `constraints`, `outbox`, `audit`.
- Script Properties also hold the setup token, the daily email-budget counter, and the
  per-poll raw invitee tokens (`tokens:<pollId>`). The Sheet stores only token **hashes**;
  the raw tokens (needed to rebuild reminder links) never touch the Sheet and are deleted
  once a poll reaches a terminal state.
- All mail is sent from the deploying organizer's own Gmail.

## Run the core tests

`npm test` (runs `node --test test/` against the pure core).
