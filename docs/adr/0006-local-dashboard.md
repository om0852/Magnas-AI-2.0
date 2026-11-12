# ADR 0006 — Slice 1.4: the local dashboard

- Status: accepted (owner: "implement whatever the next thing is", 2026-11-12; plan row 1.4)

## Context
Everything so far is a command line. The owner wants a web app (Next.js) that later also
becomes the phone app. The first step is a dashboard on the PC: see the registry and the AI
tools, see what `sync` would change, and apply it.

## Decision
1. **`apps/web`**: Next.js 16 (App Router) and React 19, TypeScript. It imports `@magnus/core`
   and runs it in the Next.js server process on the PC; there is no separate API server. The
   core gets a small public entry (`src/index.ts`) for this.
2. **What it shows**: registry summary; the AI tools (installed, what each gets, direct or hub
   mode); MCP servers (command name, env key names, which tools, whether it uses secrets);
   skills; rules; secret names; and the sync plan grouped by tool.
3. **What it can change**: apply the sync plan (the same `sync --apply`), and switch a tool
   between direct and hub mode. Nothing else in this slice (adding servers and importing stay
   on the command line).
4. **It never sends secrets or env values to the browser**: only names and counts.
5. **Safety of a local web server that can change tool configs**:
   - It listens on 127.0.0.1 only (default port 4747).
   - `npm run dashboard` makes a random token for this run and prints a link that contains it.
     Opening the link stores the token in an HttpOnly, SameSite=Strict cookie. Without the
     cookie the pages show only how to open the dashboard, and the API refuses.
   - Every request must have a loopback Host header (DNS rebinding); every changing request
     must also come from the dashboard's own origin (another web page cannot trigger a sync).
   - The check is one pure function in the core (`checkDashboardRequest`), unit-tested.
6. The deployed phone app (phase 3) will be the same Next.js app in a second mode that talks to
   the PC through the relay; nothing of that is built here.

## Consequences
- Next.js and React are the first dependencies outside the core (`apps/web` only).
- The dashboard needs the core to be built first; `npm run dashboard` does both.
- Next.js bundles the core into the app, so the core cannot find its own `cli.js` there (found
  on the first run: the page failed). The start script resolves the real path and passes it in
  `MAGNUS_CLI`; without it sync is refused, so a wrong launcher path can never be written into
  a tool's config.
- Applying from the dashboard has the same effect as the command line, including the
  approval-free nature of `sync --apply`: the plan is on the page before the button is pressed.

## Tests
Unit tests for the guard and the dashboard state (no values leak). The pages are checked by
hand in a browser on the owner's PC and recorded in docs/03.
