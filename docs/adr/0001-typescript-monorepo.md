# ADR 0001 — One TypeScript repository with npm workspaces

- Status: accepted (owner, 2026-11-12)

## Context
Magnus has a CLI/core, a web app (Next.js, the owner's choice), a relay and later voice. The
MCP SDK and XtraOS's MCP server are TypeScript.

## Decision
One repository, npm workspaces: `packages/core` (registry, sync, gateway), later
`packages/brain`, `apps/web` (Next.js App Router, one app for the local dashboard and the
deployed phone app), `apps/relay`. TypeScript strict, ES modules, Node 22+. The core has no
runtime dependencies in phase 1 and compiles with `tsc`; tests use `node:test`.

## Consequences
One install, shared types between core and web. No build tool beyond `tsc` until the web app
needs one.
