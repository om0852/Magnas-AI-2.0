# ADR 0012 — Live steps, a Stop button, and voice typing

- Status: accepted (owner, 2026-11-12: "show that you are thinking, you are observing, you find
  this or that, and you are doing this. So I can stop the process"; "give the voice option … for
  both desktop and phone").

## Context
A task from the phone or the dashboard showed nothing for 15-70 s and then the answer. The owner
could neither see that it was going right nor stop it. Typing on the phone is slow.

## Decision
1. **Steps as they happen.** The brains report their work as JSON lines: `codex exec --json`
   (`item.started` / `item.completed` for MCP tool calls, agent messages, reasoning) and
   `agy --output-format stream-json` (`step_update` for tools and text, `result`). Pure parsers
   turn them into steps: thinking, using a tool (with short arguments), tool done (first line of
   its result), tool failed, says. Antigravity's stream also gives its tool calls, so the
   "no second brain once it may have acted" rule now knows them (ADR 0007).
2. **Stop.** A stop signal ends the CLI process at once. A stopped task is reported as stopped
   and is never handed to the other brain.
3. **Where it shows:**
   - `magnus ask` prints each step; Ctrl+C stops.
   - Dashboard and `/m`: `/api/ask` answers with newline-delimited JSON (steps, then the result);
     `DELETE /api/ask` stops; closing the page stops too.
   - Phone over the relay: the PC sends each step as an extra encrypted message for the same call
     (ADR 0010); `ask.stop` stops. One task at a time.
4. **Voice typing.** A mic button next to the Ask box and the "type into a window" box, on the
   dashboard, `/m` and the relay phone app. It uses the browser's speech recognition
   (`SpeechRecognition`, Chrome, Edge and Safari; not Firefox), language = the browser's, with
   live partial text; it only fills the text box, the owner still presses Run.

## Consequences
- In Chrome, the browser sends the microphone audio to Google's speech service to get text. Free,
  but not on-device; the owner can always type instead.
- Steps show tool names, short arguments and the first line of results (e.g. a window title) on
  the owner's own devices; they are not logged beyond the existing brain log.

## Tests
Parsers on real lines captured from both CLIs; Stop without fallback; the relay delivering steps
before the answer and stopping a running task; Codex/agy arguments. Live: `magnus ask` showed
each step from the real Codex CLI. Voice needs the owner's microphone: not yet checked.
