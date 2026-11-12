# ADR 0002 — Sync writes servers directly first; the one-key gateway comes second

- Status: accepted (owner, 2026-11-12)

## Context
The owner wants one command to give every AI tool the same MCP servers, skills and rules, and
one key for all of them. Two designs: write every server into every tool's config (direct), or
write one Magnus entry that points at a gateway which fans out to the servers (hub).

## Decision
1. Slice 1.1 ships **direct**: `magnus sync` writes the registry's servers, skills and rules
   into each tool. Nothing has to be running, and it already removes the per-tool setup work.
2. Slice 1.3 adds **hub**: a local gateway (loopback, one Magnus key) that proxies the
   registered servers; `sync` then writes a single entry per tool. Each tool can be set to
   `direct` or `hub`.
3. Skills and rules are always files written by `sync`; they do not go through the gateway.
4. Ownership is explicit: a managed block (TOML, Markdown), a marker file (skills) and
   `state.json` (JSON entries). Anything else belongs to the user and is never changed; a clash
   is reported as a conflict.

## Consequences
Direct mode copies `env` values into tool configs (as the tools do today); secrets move to a
protected store in slice 1.2 and out of tool configs entirely in hub mode.
