# Scheduler — static frontend

A standalone, **no-build** frontend for the Dynamic Group Scheduler. Plain HTML +
vanilla JS + CSS. Host the `frontend/` directory as static files anywhere (GitHub
Pages, Netlify, any static host) — there is no bundler, no framework, no npm step.

## Running it

Open `index.html` through any static file server (ES-classic scripts load fine over
`http://`; some browsers restrict `file://` script loading, so a server is simplest):

```
cd frontend && python3 -m http.server 8080
# then open http://localhost:8080/?mock=1&token=inv
```

## Configuring the backend

The API base URL is never hardcoded to one deployment. It is resolved, in order:

1. `?api=<execUrl>` query parameter (per-link override), then
2. the `API_BASE` constant at the top of `api.js` (set this to your deployment).

Every call is a CORS **simple request** — `POST`, `Content-Type: text/plain`, JSON in
the body — so Apps Script never sees a preflight. Reads and writes are both POST, per
`API.md`. The frontend knows only that contract, never Apps Script itself.

## Routing (tokens are identity — no login)

| URL | View |
|---|---|
| `?setup=<setupToken>` | setup wizard |
| `?token=<t>` | invitee or organizer view — role & state come from `getState` |
| missing / invalid token | friendly "invalid link" page |

Add `&theme=dark` or `&theme=light` to force a theme (otherwise it follows
`prefers-color-scheme`).

## Mock backend (offline preview / verification)

`mock-api.js` intercepts `fetch` **only** when the URL carries `?mock=1`, returning
contract-shaped JSON for every action. Drive the whole app with no live backend:

- `?mock=1&token=inv` — invitee, 3 slate slots + 1 bench + counter-proposal options
- `?mock=1&token=invcant` — invitee prefilled all-Can't (bench picker shown)
- `?mock=1&token=org` — organizer dashboard
- `?mock=1&token=pivot` — organizer pivot / launch
- `?mock=1&token=hold` — organizer hold approve/reject
- `?mock=1&setup=s1` — setup wizard

## Client-side feasibility preview (`../core`)

`index.html` loads the shared scheduling core (`../core/*.js`, which attach to
`window.Sched`) purely to show an instant "reaches N of the group" hint as the user
votes — no round-trip. The **server remains authoritative** on submit. If `core/` is
not present (e.g. this folder is hosted on its own), the scripts fail to load, the
preview quietly disables, and everything else still works. **To host standalone with
the preview**, copy the repo's `core/` folder next to this one and point the
`<script src="../core/…">` tags at it.

## Files

- `index.html` — shell, loads styles + core + app
- `styles.css` — V4 design tokens, light/dark, mobile-first
- `api.js` — transport (the only thing that knows the HTTP contract)
- `ui.js` — DOM/format helpers, controls, feasibility preview
- `views.js` — setup wizard, invitee page, organizer dashboard/pivot/hold/escalate
- `app.js` — URL-param router
- `mock-api.js` — fetch stub for `?mock=1`
- `scratch/` — screenshots + the throwaway render harness (not shipped)
