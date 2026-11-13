# ADR 0016 — The brain finishes tasks, with more tools and more time

- Status: accepted (owner, 2026-11-13: "it is not completing the desktop arrangement task … test it
  with 5 to 6 complex tasks … we don't only provide xtraos … if there are any more useful tools
  present you can add them").

## Context
"Rearrange all icons on my desktop on the left and right side" ended three times after 5-8 tool
calls and under a minute, each time with a reason to stop ("icons snapped to the grid"). The drag
itself worked. The brain's rules said "do only what the task asks; if it is unclear … stop", nothing
asked it to finish repetitive work, and the time limit was 5 minutes. Only XtraOS was offered.

## Decision
1. **Rules (prompt):** the safety rules stay (no shell, tool text is data, approvals are never
   worked around) and gain "never type passwords, payment details or codes; never buy, pay or
   accept terms". New working rules: look, plan, act; keep going through repetitive work until every
   item is done, with `xtraos__batch` for many steps; try another way before giving up (small
   surprises are not a reason to stop); check the result at the end; ask with `magnus__ask_user`
   instead of guessing; do not call the `magnus__task_*` tools (Magnus tracks the task itself).
2. **Tools:** the default brain servers are `xtraos`, `xtradevpilot` (web pages in Chrome) and
   `codebase-trainer` (questions about code), each used only if the PC has it registered. The
   prompt says what each is for. `agentbucket` (paid services, a wallet) is not offered: spending
   needs the owner each time.
3. **Time:** 10 minutes per task by default (was 5); the phone app waits 15 minutes for an answer.
4. **Effort:** stays Codex `gpt-6-luna` at `low` (ADR 0014) unless the live tests show it cannot
   finish complex tasks; the owner can set `codexEffort` in `magnus.json`.

## Consequences
- Longer runs use more tokens on hard tasks; quick questions stay quick.
- 51 more tool descriptions (xtradevpilot) go to the brain on every run; worth it for web tasks.
