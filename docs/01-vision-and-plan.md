# 01 — Vision and plan

## What Magnus AI is
One place on your PC that holds everything your AI tools share, plus a brain and a phone remote
on top of it:

1. **Hub** — your MCP servers, skills and rules live once in the Magnus registry. One command
   (`magnus sync`) puts them into every AI tool (Claude Code, Codex, Antigravity, VS Code,
   Cursor, …). A new IDE is set up with the same command.
2. **Brain** — a command in plain language ("share my resume") is planned by an AI CLI that is
   already installed (Codex CLI first, Antigravity CLI as fallback) and carried out with the
   hub's tools.
3. **Hands** — the tools themselves: XtraOS Agent for the Windows desktop, and any other MCP
   server or CLI you register.
4. **Remote** — a web app (Next.js) that is the dashboard on the PC and an installable app on
   the phone: type or say "Hey Magnus, …" from anywhere.

## Who it is for
A developer who uses several AI tools and is tired of configuring each one, and who wants to
drive their own PC by voice or from their phone, safely.

## Constraints (from the owner)
- **Free only.** No paid service is required. The brain uses CLIs the user already has; speech
  uses the browser's recogniser or a local model; hosting stays inside free tiers.
- **Safe by default.** Magnus never approves a risky action for the user. XtraOS's approval
  rules stay in force; Magnus only forwards the question (docs/05).
- **Honest status.** Nothing is called "supported" until it was run and checked (docs/03 has a
  verified column).

## Phases

| Phase | Result | Done when |
|---|---|---|
| **1 Hub** | Registry + `magnus sync` for MCP servers, skills and rules; then a local gateway with one Magnus key; then the dashboard | A fresh IDE gets all MCPs, skills and rules from one command; tests pass; verified live on the owner's PC |
| **2 Brain** (built) | A command box (CLI and dashboard): text in, plan, tool calls, result | "open YouTube" and a 3-step task run end to end through Codex CLI with Antigravity fallback |
| **3 Remote** | Phone app, relay, device pairing, approvals on the phone, Telegram bot | "share my resume" typed on the phone sends the file; a denied approval sends nothing |
| **4 Voice** | Mic on the phone, then push-to-talk and "Hey Magnus" on the PC | The same task works by voice; a voice can never approve a risky action |

### Phase 1 in slices
| Slice | Content | Status |
|---|---|---|
| 1.1 | Registry, client adapters, `magnus init / status / sync / add-mcp / remove-mcp`; MCP servers, skills and rules written into each tool with backups and conflict detection | built, unit-tested |
| 1.2 | `magnus import` (take over what a tool already has), Claude Code MCP through `claude mcp`, secrets (`magnus secret`, encrypted store, `magnus run` launcher) — ADR 0004 | built, unit-tested; dry runs on the owner's PC; no real apply yet |
| 1.3 | Gateway: `magnus hub` (stdio) and `magnus serve` (HTTP, Magnus key); `magnus mode <tool> hub` gives a tool one entry — ADR 0005 | built, unit-tested; live on the owner's PC: 103 tools from 4 real servers through the hub; no tool switched to hub mode yet |
| 1.4 | Dashboard (Next.js 16): registry, tools, servers, skills, rules, the sync plan; apply; direct/hub switch — ADR 0006 | built; guard and state unit-tested; checked in a browser on the owner's PC (dark and light, desktop and phone width) |

### Phase 3 in slices
| Slice | Content | Status |
|---|---|---|
| 3.1 | (Kept, off unless a bot token is set; the owner's Telegram cannot make bots.) Phone remote through the owner's own Telegram bot: the PC polls Telegram (nothing exposed), pairing with a one-time code, owner only, one task at a time; phone tools for the brain (`send_file`, `send_message`, owner's chat only) — ADR 0008 | built, unit-tested; hub and phone server checked as real processes; live run needs the owner's bot token |
| 3.2 | The remote web app on the phone over Tailscale: device pairing, Approvals (XtraOS dialogs answered with a signed answer, XtraOS ADR 0076), Windows (read, tap, type), Ask — ADR 0009 | built, unit-tested; live on the owner's PC with the browser pane as the phone; not yet on a real phone (needs Tailscale) |
| 3.3 | Phone access with no VPN: the owner's own WebSocket relay, end-to-end encrypted (ECDH P-256 + AES-GCM, keys set up through a QR code); phone app served by the relay; `magnus relay setup/pair/run` — ADR 0010, docs/06 | built, unit- and end-to-end tested; live on this PC with a local relay and the browser pane as the phone; relay not yet deployed (owner's Oracle VM) |
| 3.4 | Start the relay connection and XtraOS at sign-in (`magnus autostart`) — ADR 0011 | built, unit-tested; on for the owner, checked by starting it as sign-in does |
| 3.5 | Live steps of a task and a Stop button (dashboard, `/m`, phone over the relay, CLI); voice typing on desktop and phone — ADR 0012 | built, tested; steps checked live with the real Codex CLI; voice not yet tried with a microphone |
| 3.6 | Notifications for new approvals and for apps waiting on the user | next |

## Not goals
- Magnus is not a new model and trains nothing.
- Magnus does not replace XtraOS's safety layer and does not bypass any tool's own permissions.
- No cloud copy of the user's secrets, files or screen.
