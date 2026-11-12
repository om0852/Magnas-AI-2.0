# 03 — System design (phase 1)

## The registry: `~/.magnus`
Override the location with `MAGNUS_HOME`.

```
~/.magnus/
  magnus.json          MCP servers and settings
  skills/<name>/       one folder per skill; must contain SKILL.md
  rules/*.md           rules for every AI tool, joined in file-name order
  state.json           what Magnus wrote where (do not edit)
  secrets.json         secrets, each encrypted for your Windows account (never plain text)
  hub.json             the hash of the Magnus key (the key itself is never stored)
  remote.json          the paired phone's Telegram ids, and a pairing code while one is valid
  brain-log.jsonl      every brain run: task, brain, answer, tool calls
```

`magnus.json`:

```json
{
  "version": 1,
  "mcpServers": {
    "xtraos": {
      "command": "C:\\Users\\me\\AppData\\Local\\Programs\\XtraOS\\node\\node.exe",
      "args": ["C:\\Users\\me\\AppData\\Local\\Programs\\XtraOS\\mcp\\xtraos-mcp.mjs"],
      "env": {},
      "clients": ["codex", "vscode"]
    }
  },
  "clients": { "cursor": { "enabled": false }, "codex": { "mode": "hub" } }
}
```

- Server names: letters, digits, `_` and `-` (1–64).
- `clients` on a server: only these tools get it. Omitted = all.
- `clients.<id>.enabled = false`: `sync` leaves that tool alone.
- `clients.<id>.mode = "hub"`: the tool gets one entry, the Magnus hub (below). Default: direct.
- The server name `magnus` is reserved for the hub.

## Tools (client adapters)
"Verified" = run on a real install and checked. "config" = Magnus wrote the tool's config on the
owner's PC and the tool's own listing or file shows it; the servers were not yet seen running
in the tool after a restart. Everything else is written from the tool's
documented format and is covered only by unit tests.

| Tool | id | MCP servers | Skills | Rules | Verified |
|---|---|---|---|---|---|
| Claude Code | `claude-code` | through `claude mcp add-json / remove` (user scope); `~/.claude.json` is only read | `~/.claude/skills/` | `~/.claude/CLAUDE.md` | config: 2026-11-12 (2 servers added through `claude mcp`, in its user list; 2 skills taken over) |
| Codex CLI / app | `codex` | `~/.codex/config.toml` (`[mcp_servers.x]`) | `~/.codex/skills/` | `~/.codex/AGENTS.md` | config: 2026-11-12 (`codex mcp list` shows the 3 added servers; 2 skills copied) |
| Antigravity | `antigravity` | `~/.gemini/antigravity/mcp_config.json` | — (location not confirmed) | `~/.gemini/GEMINI.md` | config: 2026-11-12 (3 existing servers recognised as unchanged; nothing written) |
| VS Code | `vscode` | `%APPDATA%\Code\User\mcp.json` (`servers`, `type: stdio`) | — | — | config: 2026-11-12 (3 servers added to `mcp.json`) |
| Cursor | `cursor` | `~/.cursor/mcp.json` | — | — (user rules are not a file) | no |
| Windsurf | `windsurf` | `~/.codeium/windsurf/mcp_config.json` | — | `~/.codeium/windsurf/memories/global_rules.md` | no |
| Claude Desktop | `claude-desktop` | `%APPDATA%\Claude\claude_desktop_config.json` | — | — | no |
| Gemini CLI | `gemini-cli` | `~/.gemini/settings.json` | — | `~/.gemini/GEMINI.md` | no |

A tool is "installed" when its config folder (or file) exists. Tools that are not installed are
skipped.

## Sync algorithm
For each installed, enabled tool, Magnus plans three things. Planning is pure: current text in,
new text and a list of actions out. Nothing is written without `--apply`.

**MCP servers, JSON tools.** Parse the file (a file that does not parse, e.g. with comments, is
left alone and reported). For each wanted server:
- not there → **add**
- there and equal → **unchanged** (and from now on managed by Magnus)
- there, written by Magnus before → **update**
- there, different, not written by Magnus → **conflict**: skipped, unless `--force`

Servers Magnus wrote earlier that are no longer wanted → **remove**. Other entries are never
touched.

**MCP servers, Codex (TOML).** Magnus owns one block at the end of `config.toml`:

```toml
# >>> magnus (managed: edit ~/.magnus/magnus.json, then run `magnus sync`)
[mcp_servers.xtraos]
command = "…"
args = ["…"]
# <<< magnus
```

The rest of the file stays byte for byte. A `[mcp_servers.<name>]` table outside the block with
a wanted name is fine when it is identical (reported as unchanged, left where it is). A
different one is a **conflict** (two tables with one name would break the file): it is skipped,
and the user removes it by hand.

**Rules.** The files in `rules/` are joined and written into one marked block in the tool's own
rules file; text outside the block is the user's and stays:

```markdown
<!-- >>> magnus rules (managed: edit ~/.magnus/rules, then run `magnus sync`) -->
…
<!-- <<< magnus rules -->
```

**Skills.** Each skill folder is copied to the tool's skills folder with a marker file
`.magnus-managed`. A folder of the same name without the marker is the user's own: **conflict**,
never overwritten. A managed skill that left the registry is removed.

**Writing.** Before Magnus changes a file for the first time it copies it to
`<file>.magnus-backup`. Files are written to a temporary name and renamed. `state.json` records
the server and skill names Magnus manages per tool.

## Commands
| Command | Does |
|---|---|
| `magnus init` | Create `~/.magnus` with an empty registry |
| `magnus status` | Registry contents and which tools are installed |
| `magnus sync [--apply] [--force] [--client <id>]` | Show the plan; with `--apply`, do it |
| `magnus add-mcp <name> [--client <id>]… -- <command> [args…]` | Register a server |
| `magnus remove-mcp <name>` | Unregister a server (the next sync removes it from the tools) |
| `magnus import [--client <id>]… [--secrets] [--apply]` | Take the plain MCP servers and the skills the tools already have into the registry; with `--apply` they become managed by Magnus |
| `magnus secret set <NAME>` / `list` / `remove <NAME>` | Store a secret (typed hidden or piped in), list names, delete one |
| `magnus run <name>` | Start a registered server with its secrets filled in (what the tools call) |
| `magnus mode <tool> hub\|direct` | How a tool gets its servers; the next sync applies it |
| `magnus hub [--client <id>]` | The hub on stdin/stdout (what a hub-mode tool starts) |
| `magnus key new` / `status` | Make the Magnus key (shown once) / say whether one is set |
| `magnus serve [--port N]` | The hub over HTTP on 127.0.0.1, default port 8787, path `/mcp` |

Exit codes: 0 ok, 1 error, 2 the plan has conflicts.

## The hub (ADR 0005)
A Magnus process that starts the registered servers and offers all their tools as one MCP
server. Tools are named `<server>__<tool>`; `magnus__status` lists the servers.

- **Hub mode for a tool:** `magnus mode codex hub`, then `magnus sync --apply`. The tool's config
  gets one server, `magnus` (`node <magnus cli> hub --client codex`), and the direct entries
  Magnus wrote are removed. No key is needed: only the tool that started the hub can talk to it.
- **HTTP:** `magnus key new`, then `magnus serve`. `http://127.0.0.1:8787/mcp`, every request
  with `Authorization: Bearer <key>`. Loopback only; web pages and other hosts are refused.
- **Start-up:** the hub answers at once and does not wait for slow servers: instructions wait
  at most 3 s, the first tool list at most 8 s, later servers add their tools with a
  `tools/list_changed` notice. Secrets are decrypted once per hub start.
- **Live (owner's PC, 2026-11-12):** all four real servers through `magnus hub`: 103 tools,
  XtraOS `status` answered through it. With three servers: initialize answered in 3.6 s with
  XtraOS's instructions; the `npx` server joined at 9.7 s with the notice.
- **Limits:** tools only (no prompts or resources). Each tool starts its own hub, so each
  server still runs once per open tool; a server that can run only once on a PC (xtradevpilot:
  one fixed port, it stops the older copy) should be assigned to one tool with `clients`.

## The dashboard (ADR 0006)
`npm run dashboard` builds and starts it on `http://127.0.0.1:4747` and prints a link with a
token for that run; open the link. `npm run dashboard:dev` is the development mode.

- Shows: registry summary, the AI tools with their direct/hub switch, MCP servers (program
  name, env key names, which tools), skills, rule lines, secret names, and the sync plan per
  tool. Env values and secrets are never sent to the browser.
- Changes: "Apply" runs the same `sync --apply`; the switch sets a tool's mode.
- Access: loopback Host only, the run's token in an HttpOnly cookie, and changes only from the
  dashboard's own origin.
- **Live (owner's PC, 2026-11-12):** the page showed the real registry (4 servers, 2 skills,
  4 tools); without the cookie, with a wrong token, another Host or another Origin the server
  answered 401/403; switching VS Code to Hub showed the 4-change plan and switching back
  returned to "In sync" (nothing was applied); the apply call with nothing to change wrote
  nothing.
- Limit: adding servers, importing and secrets are still command-line only.

## The brain (ADR 0007)
`magnus ask "<task>"` (and "Ask Magnus" on the dashboard) gives the task, wrapped in fixed rules,
to Codex CLI; if Codex is not installed or fails before calling any tool, to Antigravity CLI.

- Codex gets only the Magnus hub limited to `brain.servers` (default `xtraos`), its tools
  pre-approved, a read-only sandbox, no user config. Antigravity uses its own configured
  servers; the prompt names the allowed ones (a soft limit).
- No second brain after one may have acted (no action twice). Time limit `brain.timeoutSec`
  (default 300). Every run is logged to `~/.magnus/brain-log.jsonl`.
- Settings in `magnus.json`: `"brain": { "order": ["codex", "antigravity"], "servers": ["xtraos"], "timeoutSec": 300 }`.
- **Live (owner's PC, 2026-11-12):** "Open https://www.youtube.com in Firefox" — Codex, 45 s,
  2 tool calls, a Firefox window titled YouTube appeared. "Open Notepad, type Hello from
  Magnus, read it back, tell me the title" — Codex, 61 s, 11 tool calls; the answer matched the
  real window ("*Hello from Magnus. - Notepad"). Antigravity brain: listed the open windows,
  65 s. Measured while deciding: with all 103 hub tools Codex listed none, so the brain gets a
  chosen set of servers. Dashboard "Ask Magnus": "how many windows are open, which is in
  front" answered by Codex in 49 s (2 tool calls); a request from another web page got 403.

## The phone remote (ADR 0008)
1. In Telegram, ask @BotFather for a new bot (free); it gives a token.
2. `magnus secret set TELEGRAM_BOT_TOKEN` (stored encrypted).
3. `magnus remote run` (keeps running), then in another terminal `magnus remote pair`; send the
   printed `/pair 123456` to the bot from your phone.
4. Send any task to the bot: "find my resume and send it to me".

- The PC polls Telegram; nothing on the PC is reachable from the internet.
- Only the paired Telegram user, in their private chat, is obeyed; others get no answer.
  Messages sent while Magnus was not running are skipped.
- A phone task runs `magnus ask` with the brain's servers plus `phone`: `phone__send_file`
  and `phone__send_message` reach only the owner's chat (no recipient argument; max 50 MB).
- XtraOS approvals still appear on the PC screen only (slice 3.2 moves them to the phone).
- Files in `~/.magnus`: `remote.json` (owner's Telegram ids, pairing code while valid).

## Secrets
Write `${secret:NAME}` in a server's `env` value or `args`. The value lives only in
`secrets.json`, encrypted with Windows DPAPI for the current user. A server that uses a secret
is written to the tools as a launcher (`node <magnus cli> run <name>`), so no tool config holds
the value. `sync` stops when a referenced secret is not set. Details: ADR 0004.

## Known limits
- `env` values without `${secret:…}` are written to the tools' configs as they are.
- Starting a server that uses secrets takes about 2.4 s longer (one PowerShell start for the
  decryption, measured on the owner's PC); the gateway in slice 1.3 will decrypt once.
- Only plain command servers are handled; URL servers and entries with extra settings stay
  where they are.
- Rules are not imported.
- JSON files are rewritten with 2-space indentation; comments are not supported (file skipped).
- A tool must be restarted to load changed MCP servers.
