# ADR 0019 — Windows Defender through its own tools; screenshots when a window is unreadable

- Status: accepted (owner, 2026-11-13: "perform security check for virus on windows using windows
  defender … why it is working half way only … if possible provide him screenshot … orchestrators and
  sub agents only if necessary").

## Context
"Run a virus check with Windows Defender" stopped half way: the brain opened the Windows Security app
and XtraOS answered `BLOCKED_BY_POLICY: observe in "Windows Security": app rule for
applicationframehost.exe`. That block is right: no agent should click through security settings.

## Decision
- `magnus__defender` (hub, Windows, when XtraOS is behind the hub) with three fixed operations:
  `status` (Get-MpComputerStatus: protection on/off, definitions age, last scans, recent threats),
  `update` (`MpCmdRun -SignatureUpdate`), `quick_scan` (`MpCmdRun -Scan -ScanType 1`, then the
  status). No free-form command, no option that changes a setting, no full scan (hours long).
- The brain is told to use it for antivirus work and never to try the Windows Security app.
- When `observe` shows few or no elements (custom-drawn apps, games, canvas, video), the brain uses
  `xtraos__screenshot` or `xtraos__ocr` instead of giving up.
- Antigravity reading its own tool descriptions ("File …/mcp/…") is hidden from the phone's steps.
- No orchestrator / sub-agents: the failures came from a safety block and missing tools, not from a
  task being too big for one brain. Revisit when a task needs parallel work.

## Consequences
- Checked live: `status` read the real Defender state on the owner's PC; a real quick scan ran
  through the tool.
