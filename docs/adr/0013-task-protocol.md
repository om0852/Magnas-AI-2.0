# ADR 0013 — One task protocol for every AI tool: report back, ask the user, finish

- Status: accepted (owner, 2026-11-12: "if something task is given … by Magnus then you should
  respond back … saying task is complete … compatible with all other AI tools … better and secure";
  "yes implement it" for steps 1 and 2 of the plan).

## Context
Magnus starts tasks (the brain, ADR 0007) and the owner also runs AI tools by hand (Claude Code,
Codex, Antigravity…). The owner wants one place, the phone, that shows every task, says when one
is done, and shows when a tool is waiting for an answer.

## Decision
1. **A task log**: `~/.magnus/tasks/events.jsonl`, append-only events (created, step, status,
   question, answer, done, failed, stopped). A task's state is the fold of its events. Kept small
   (at 1 MB the file is renamed to events.1.jsonl, replacing the older one: a rename, so no
   event written at the same moment is lost).
2. **Three ways a tool reports**, so every tool fits:
   - **Magnus tools over MCP** (any MCP client): the hub offers `magnus__task_start`,
     `magnus__task_update`, `magnus__task_done` and `magnus__ask_user` (waits up to 10 minutes for
     the owner's answer from the phone).
   - **Lifecycle hooks** (automatic): `magnus sync` installs Claude Code hooks (prompt submitted,
     Notification, Stop) that run `magnus event claude-code`. Codex's `notify` setting is left alone:
     the owner's config already uses it.
   - **Live stream** when Magnus starts the tool (ADR 0012): brain tasks are logged as tasks too.
3. **Security:**
   - Each task has a random token (only its hash is stored). Updating or finishing a task needs it:
     one tool cannot change another tool's task. Hook tasks are keyed by the tool's own session id
     and written only by the local `magnus event` command.
   - What a tool reports is data. It is shown to the owner, never run; texts are length-limited.
   - **Secret scrubbing** before anything is stored or leaves the PC: keys, tokens, passwords in
     URLs and private keys are masked (`[hidden]`).
   - Nothing new listens on the network: tools report through the existing local MCP connection or
     a local command; the phone reads tasks through the encrypted relay (ADR 0010) or the dashboard.
   - An answer to `ask_user` comes only from the owner's paired phone or the PC dashboard, and it is
     handed back to the asking tool as data.
4. **Where it shows:** a Tasks tab on the phone (relay and `/m`) and a Tasks card on the dashboard:
   each task's tool, status (working, needs you, done, failed), last steps, result, and a box to
   answer a question (with the mic).

## Consequences
- A tool only reports through the Magnus tools if its instructions say so; the brain's prompt does
  (with the task id and token). For tasks the owner starts by hand, hooks are the reliable path,
  and today only Claude Code has them installed.
- Phone notifications when the app is closed are the next step (plan step 3).

## Tests
Unit: the event fold, tokens, scrubbing, the hook intake, the MCP tools (including ask_user and an
answer), sync adding and removing only Magnus's hooks. Live: a Claude Code session's prompt and
finish appear as a task.
