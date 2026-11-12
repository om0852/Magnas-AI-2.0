# ADR 0005 — Slice 1.3: the gateway, hub mode and the Magnus key

- Status: accepted (owner: "Yes, slice 1.3", 2026-11-12)

## Context
Direct sync (ADR 0002) copies every server into every tool. The owner wants one entry per tool
and one key for everything. A hub also fixes the cost found in slice 1.2: a server that uses
secrets pays one decryption (2.4 s) every time it starts.

## Decision

### 1. The gateway
A Magnus process that connects to the registered servers as an MCP client, and offers all their
tools to an AI tool as one MCP server.
- Tool names: `<server>__<tool>` (e.g. `xtraos__click`). The schema, description and result of
  each tool pass through unchanged.
- Servers start in parallel when the gateway starts. One that fails or takes over 60 s is left
  out and reported; the others work. A built-in tool `magnus__status` lists every server: its
  tool count, "starting", or its error.
- **The gateway answers fast.** AI tools give a server only seconds to start (measured on the
  owner's PC: the four real servers need 9 s together, `npx` ones 8 s each). So the gateway
  waits at most 3 s for the servers' instructions and at most 8 s (from its own start) before
  the first tool list; a server that comes up later adds its tools and the client gets a
  `tools/list_changed` notice. A call for a server that is still starting waits for it.
- The instructions of the servers that are up in time are joined (one heading per server).
- Secrets are decrypted once, for all servers, when the gateway starts.
- Only tools are proxied in this slice. Prompts and resources are not, and a server's own
  "list changed" notices are not passed on.

### 2. Two ways in
- **`magnus hub [--client <id>]` (stdio).** The tool starts Magnus like any stdio server. No
  port, no key: only the program that started it can talk to it. `--client` limits the servers
  to those assigned to that tool.
- **`magnus serve [--port N]` (HTTP).** Streamable HTTP on 127.0.0.1 only (default port 8787),
  path `/mcp`, stateless. Every request needs `Authorization: Bearer <Magnus key>`; the Host
  header must be the loopback address and any `Origin` header is refused (web pages). This is
  for tools that only speak HTTP and is the base for the phone remote in phase 3.

### 3. The Magnus key
`magnus key new` makes a key (`mgn_…`, 32 random bytes), prints it once and stores only its
SHA-256 hash in `~/.magnus/hub.json`; `magnus key new` again replaces it. Nothing can read the
key back. It is needed only for the HTTP way in; hub mode over stdio needs no key.

### 4. Hub mode in sync
`magnus mode <tool> hub|direct` sets `clients.<id>.mode` in the registry (default `direct`).
In hub mode `magnus sync` gives the tool one server, named `magnus`, that runs
`node <magnus cli> hub --client <id>`, and removes the direct entries Magnus wrote before.
Entries the user wrote themselves stay (the user then sees those tools twice, once through the
hub). The name `magnus` is reserved in the registry.

### 5. Dependency
`@modelcontextprotocol/sdk` 1.32.2 (the official MCP SDK, the version XtraOS Agent uses), for
the client, server and HTTP transport. It is the first runtime dependency of the core.

## Consequences
- One entry per tool, and adding a server to the registry needs no sync for hub-mode tools
  (only a restart of the tool).
- Each tool starts its own gateway, so each registered server runs once per tool that is open,
  as in direct mode.
- Tool names get longer; a tool with a name limit (64 characters in several clients) may refuse
  very long ones.
- A hub entry points at where Magnus is installed, as launcher entries do.

## Tests
Unit tests with in-memory servers (naming, routing, a failing server, status, instructions),
an end-to-end test that starts `magnus hub` as a process against a small real MCP server, the
HTTP checks and a real HTTP round trip, the key, and sync in hub mode.
