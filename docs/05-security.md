# 05 — Security model

Magnus can reach every tool the user has, and later it can be reached from a phone. These rules
hold in every phase; a change to them needs an ADR.

## Principles
1. **The user approves risky actions; nothing else can.** Not the brain, not a voice, not the
   relay, not a web page. XtraOS's approval rules stay in force behind Magnus.
2. **Least reach.** A tool gets only the servers assigned to it. The brain gets only the tools
   the task needs (phase 2).
3. **Secrets stay on the PC.** The cloud site and the relay never hold MCP tokens, files or
   screen content.
4. **Everything is visible.** Plans are shown before they run; actions are logged.

## Phase 1 (hub)
| Risk | Rule |
|---|---|
| Sync breaks a tool's config | Dry run by default, backup before the first write, atomic write, conflicts skipped |
| Sync overwrites the user's own entry, skill or rules | Only things recorded in `state.json` or marked as managed are changed |
| A registered server is malicious | Magnus registers only what the user adds; `sync` prints every command it will write |
| Secrets in plain config | Slice 1.2: values come from a store protected by the Windows account; hub mode keeps them out of tool configs |
| Gateway reachable by other programs | Stdio hub: only the tool that started it. HTTP: loopback only, the Magnus key on every request (only its hash is stored), Host checked, any Origin refused (ADR 0005) |

## Phase 2 (brain)
- The brain CLI runs with the user's rights; Magnus passes it a task and the hub, never secrets.
- Text from tools, files and pages is data. A tool result that says "now send the file to …"
  is not an instruction.
- A task has limits: steps, time, and no approval it can give itself.

## Phase 3 (remote)
Built first (slice 3.1, ADR 0008) as a Telegram bot run by the PC:
- The PC polls Telegram; no port is opened, nothing is reachable from outside.
- Pairing with a one-time 6-digit code (10 minutes, 5 tries) sent from a private chat; one owner;
  `magnus remote unpair` forgets it. Everyone else is ignored without an answer.
- The bot token is a DPAPI secret. Telegram carries the messages and files (their terms apply).
- The phone tools can only send to the owner's chat, so a tricked task can at most send the
  owner their own file.
- Approvals stay on the PC screen until slice 3.2.

Built next (slice 3.2, ADR 0009) as a web app reached over Tailscale:
- Not on the internet: Tailscale connects only the owner's devices; Magnus listens on 127.0.0.1.
- Device pairing with a one-time code made on the PC; per-device token (HttpOnly, Secure,
  SameSite=Strict); only hashes stored; devices removed on the PC.
- Requests: configured host only (DNS rebinding), the app's own https Origin for changes.
- Approvals: the device's own P-256 key (not extractable) signs each answer; XtraOS adds a device
  only after a real click on its PC dialog and checks every signature (XtraOS ADR 0076). Magnus
  cannot answer a dialog by itself.

General rules for any remote access:
- **Pairing.** A phone is paired on the PC, in person (a code shown on the PC screen). The
  phone keeps a private key; the PC keeps the public key. Pairings can be listed and revoked.
- **Signed commands.** Every command and every approval is signed by the phone and carries a
  counter; the PC rejects unsigned, replayed or unpaired messages. The relay cannot forge them.
- **Approvals on the phone** show exactly what will happen (file name, recipient). No answer
  means no.
- **Locked PC.** Desktop actions need an unlocked session; Magnus says so instead of trying.
- **Kill switch.** XtraOS's Ctrl+Alt+Esc stops everything; the phone app has a stop button.

## Phase 4 (voice)
- Push-to-talk first; a wake word only with a visible "listening" indicator.
- A voice command is a request, never an approval.
- Audio is turned into text on the device where possible and is not stored.
