# ADR 0003 — The brain is an installed AI CLI: Codex first, Antigravity as fallback

- Status: accepted (owner, 2026-11-12: "use pre-installed CLIs … one as a fallback")

## Context
Magnus needs a model to turn a command into tool calls. The owner's rule is free only, and
Codex CLI (`codex`) and Antigravity CLI (`agy`) are installed and free for them.

## Decision
Phase 2 runs the task through `codex exec` with the Magnus hub connected. When Codex is missing
or fails (quota, sign-in, timeout), the same task goes to `agy -p`. The order is configurable.
Magnus passes the task and the hub, never secrets, and sets limits on steps and time. Other
brains (a local model, an API key) can be added behind the same interface later.

## Consequences
No model cost and no key to manage. Speed and quality depend on those CLIs; their own
permission prompts and sandboxes must be configured for headless use, which is designed and
tested in phase 2, not assumed.
