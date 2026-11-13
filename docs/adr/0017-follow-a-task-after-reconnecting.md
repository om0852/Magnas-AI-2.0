# ADR 0017 — Follow a task after the connection drops

- Status: accepted (owner, 2026-11-13: "suddenly between working it shows connection lost and when
  it gets connected again it doesn't show any progress … even if I reconnect later it should work").

## Context
The relay drops a connection that misses its 30-second ping; a short network blip on the PC did that
at 05:54 (close code 1006). The PC reconnected in 3 s and the task kept running, but the phone's
encrypted session was gone, its pending call was rejected ("connection lost"), and nothing told the
phone what happened next. Reloading the page or coming back later showed nothing either.

## Decision
- The PC keeps the running task (and the last finished one): its text, its chat, its steps (up to
  300) and its answer.
- Two calls: `ask.current` (is a task running; its text, chat and step count) and `ask.follow`
  (sends the steps so far as progress, then the live ones, then the answer; for a finished task, the
  answer at once). Several phones may follow; the original caller keeps getting steps while it is
  connected. Everything stays end-to-end encrypted.
- The phone: when a reply is cut off by a lost connection, the reply bubble stays, says Magnus keeps
  working, waits for the connection (up to 15 minutes) and follows. Opening the app, or a chat,
  while a task runs shows it live again.
- The task itself never depended on the phone being connected; it keeps running and its answer is
  saved in the chat (ADR 0015).

## Consequences
- A PC restart (or relay connection restart) forgets the running task; the chat still has what was
  saved.
- Tested end to end through a real relay: a phone session dies mid-task, a new one sees it running,
  catches the missed step, then the live step and the answer; coming back later still gets the answer.

## Amendment (2026-11-13): fewer drops
Two more drops (06:16:59, 06:20:15) came in the middle of a heavy desktop task. The relay now cuts a
connection only after 3 missed 30-second pings (~90 s) and counts any message as a sign of life; the
PC sends its own `ping` every 20 s and reconnects when the relay has not answered for 75 s; the relay
connection logs when it was frozen for more than 5 s, so the next drop has a cause in the log.
