# ADR 0008 — Phase 3, slice 3.1: the phone remote through a Telegram bot on the PC

- Status: accepted (owner: "continue to phase 3 now", 2026-11-12)

## Context
The owner wants to say from the phone "Hey Magnus, share my resume" and have the PC do it.
Constraints: free only; Claude does not create accounts or deploy services for the owner; the
security model (docs/05) says only paired devices may command the PC and secrets stay on it.

A cloud relay plus a phone web app (the plan's first idea) needs hosting and an account, and a
new pairing and signing protocol. A Telegram bot needs neither: the owner makes a bot once with
@BotFather (free, their own account), and the PC **polls** Telegram for messages, so nothing on
the PC is reachable from the internet. Telegram can also deliver files, which covers "send me my
resume" without driving WhatsApp.

## Decision
1. **`magnus remote`** commands:
   - `magnus secret set TELEGRAM_BOT_TOKEN` — the bot's token, stored encrypted (ADR 0004).
   - `magnus remote pair` — prints a 6-digit code, valid 10 minutes, 5 tries.
   - `magnus remote run` — long-polls Telegram until stopped (Ctrl+C).
   - `magnus remote status` / `magnus remote unpair`.
2. **Pairing.** The owner sends `/pair <code>` to the bot while `remote run` is running. The
   sender's Telegram user id and chat id become the owner (`~/.magnus/remote.json`). Only a
   private chat can pair. One owner at a time; `unpair` forgets it.
3. **Only the owner.** Messages from anyone else are ignored and not answered (no hint that a
   bot is there). Group chats are ignored.
4. **A message is a task.** Plain text from the owner runs `magnus ask` (ADR 0007): the bot
   answers "Working on it…", then the brain's report. One task at a time; a second message while
   one runs gets "still working". `/status` and `/help` answer at once. Messages older than the
   bot's start are skipped (no stale commands after the PC was off).
5. **Phone tools for the brain.** A built-in MCP server `phone` (`magnus phone-mcp`, served by
   the hub when the brain's servers include `phone`) with two tools:
   - `send_file(path, caption?)` — sends a file to the owner's chat (max 50 MB, Telegram's limit;
     a folder or a missing file is refused).
   - `send_message(text)`.
   They can reach **only** the paired owner's chat; there is no recipient argument. For a task
   from the phone the brain's servers are `brain.servers` plus `phone`.
6. **Approvals stay on the PC.** XtraOS still shows its approval dialog on the PC screen; from
   the phone the owner cannot answer it, so such a step ends as "not approved within 60 s" and
   the brain reports it. Answering approvals on the phone needs a change in XtraOS (its own ADR)
   and is slice 3.2.
7. **Sending a file to yourself needs no approval.** The only recipient is the owner, so a task
   that was tricked by a web page can at most send the owner their own file.

## Consequences
- Messages and any file sent pass through Telegram's servers (Telegram's privacy terms apply).
  The bot token is a secret: whoever has it can read what the bot receives (not command the PC:
  only the owner's user id can).
- The PC must be on, unlocked for desktop tasks, and running `magnus remote run`.
- The Antigravity fallback brain has no `phone` tools (it uses its own servers, ADR 0007).
- Later slices: 3.2 approvals on the phone (XtraOS change); 3.3 the web app on the phone through
  a relay, if still wanted.

## Tests
A fake Telegram API (no network): pairing (right code, wrong code, expiry, tries, group chat),
owner-only handling, one task at a time, stale messages skipped, the phone tools' checks and that
they only ever address the owner's chat. Live: needs the owner's bot token.
