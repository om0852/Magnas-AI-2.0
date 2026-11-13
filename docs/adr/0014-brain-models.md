# ADR 0014 — The brain uses cheap, quick models by default

- Status: accepted (owner, 2026-11-13: "if you are using codex or antigravity use their model in
  low … so then don't consume much tokens and take time").

## Context
Magnus runs Codex with `--ignore-user-config` (ADR 0007), so the owner's own Codex model and
effort were skipped and Codex used its larger defaults. Antigravity got no model choice.

## Decision
- `brain` in `magnus.json` gains `codexModel`, `codexEffort` (low|medium|high|xhigh|max) and
  `agyModel`. Names are checked (letters, digits, `.`, `_`, `-`) since they go on a command line.
- Defaults: Codex `gpt-6-luna` ("fast and affordable model for easier tasks") at `low` effort,
  passed as `-m` and `-c model_reasoning_effort="low"`. Antigravity: its own default, because
  `gemini-3.8-flash-low` hung on a one-word prompt in a live check (2026-11-13) while the default
  answered in 71 s. The owner can set `agyModel` to try again.
- Removing the brain's temp folder is best effort: a file still held by an app the task opened
  no longer turns a finished task into a failure.

## Consequences
- Checked live: Codex answered with 2,642 tokens in 42 s (mostly start-up).
- Harder tasks may need `"codexEffort": "medium"` in `magnus.json`.

## Amendment (2026-11-13, owner: "use high model and in medium mode")
Low effort gave up on complex tasks (the desktop icons). Checked live which models this ChatGPT
account may use in Codex: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol` and `gpt-5.6-sol` are refused
("not supported when using Codex with a ChatGPT account"); `gpt-6-luna` works. New defaults: Codex
`gpt-6-luna` at **medium** effort; Antigravity `gemini-3.8-flash-high` (answered in 53 s; the low
variant had hung). Both stay changeable in `magnus.json`.
