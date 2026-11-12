# ADR 0004 — Slice 1.2: import, Claude Code MCP servers, secrets

- Status: accepted (owner: "Yes, slice 1.2", 2026-11-12)

## Context
Slice 1.1 can write the registry into the tools, but the registry starts empty, Claude Code
gets no MCP servers, and an `env` value with a token is copied into every tool's config.
The dry run on the owner's PC also reported an identical, hand-written Codex table as a
conflict.

## Decision

### 1. `magnus import [--client <id>]… [--secrets] [--apply]`
Reads what the installed tools already have and proposes it for the registry. Dry run unless
`--apply`.
- **MCP servers** from every tool (JSON files, Codex's `config.toml`, Claude Code's
  `~/.claude.json`, read only). Only plain stdio servers are taken: an entry with settings
  Magnus does not carry (a URL, timeouts, a tool's own built-in server) stays where it is and
  is reported.
- **Skills**: folders in a tool's skills folder that Magnus did not write are copied to the
  registry.
- A name that is already in the registry, or that two tools define differently, is not
  overwritten: the first one wins and the other is reported.
- **Take-over.** With `--apply`, the entries that were imported are recorded as managed by
  Magnus in the tools that hold an identical copy (state for servers, the marker file for
  skills), so the next `sync` shows them as unchanged instead of as conflicts.
- Rules are not imported: a tool's rules file is the user's text and cannot be split safely.

### 2. An identical Codex table is not a conflict
When the user's own `[mcp_servers.<name>]` table equals what Magnus would write, `sync` reports
it as unchanged and leaves it where it is. A different one stays a conflict.

### 3. Claude Code MCP servers go through its own command
Claude Code rewrites `~/.claude.json` while it runs, so Magnus never writes that file. It reads
the user-scope `mcpServers` from it to plan, and applies with `claude mcp add-json <name> <json>
-s user` and `claude mcp remove <name> -s user`. When the `claude` command is not found the
servers are skipped and reported.

### 4. Secrets
- A value in a server's `env` or `args` may contain `${secret:NAME}`.
- `magnus secret set <NAME>` stores a value (typed without echo, or piped in); `magnus secret
  list` shows names only; `magnus secret remove <NAME>` deletes one. Values are never printed.
- The store is `~/.magnus/secrets.json`. Each value is encrypted with Windows DPAPI for the
  current user (through PowerShell, the value passed on stdin, never on a command line). The
  file is useless on another account or PC. Other platforms: not supported yet (clear error).
- **A server that uses a secret is written to the tools as a launcher**, not with the value:
  `node <magnus cli> run <name>`. `magnus run` resolves the secrets and starts the real server
  with its input and output passed through. So the secret is in no tool's config file.
- `sync` stops with a clear error when a referenced secret is not set.
- `import --secrets` stores every imported `env` value as a secret named `<SERVER>_<KEY>` and
  puts the reference in the registry; without it, values are imported as they are and the
  servers that have `env` values are listed.

## Consequences
- A launcher entry points at where Magnus is installed; after moving Magnus, `magnus sync
  --apply` rewrites the entries.
- Starting a server that uses secrets costs one PowerShell start for the decryption: 2.4 s
  measured on the owner's PC (2026-11-12). The gateway (slice 1.3) will decrypt once instead.
- DPAPI protects against other users and copied files, not against a program already running
  as the user; that is the same level as the tools' own config files, and better than plain
  text in several of them.

## Tests
Unit tests with a temporary home, a fake `claude` runner and a fake protector; DPAPI itself gets
one round-trip test that runs only on Windows. Live checks are recorded in docs/03.
