# ADR 0015 — Conversations with memory, in a ChatGPT-style app

- Status: accepted (owner, 2026-11-13: "make the web app design completely like ChatGPT … jump to
  any conversation … the AI should remember what we have done in this conversation … create new
  conversation, continue that conversation"; "Both, phone first"). Files and images: later.

## Context
Each brain run is a fresh `codex exec --ephemeral` or `agy -p`: it remembers nothing, so the owner
had to explain everything again in every task.

## Decision
1. **Store:** one file per chat, `~/.magnus/chats/<id>.json` (`c_` + 16 hex), with title, times and
   messages (role, text, time; for Magnus's replies also brain, ok and the tools used). Written to a
   temp file and renamed (retried briefly on Windows). Texts are scrubbed of secrets and cut
   (8,000 characters) before they are stored. Up to 400 messages per chat are kept. Delete moves the
   file to `chats/deleted/` so it can be undone.
2. **Memory:** the brain's task is the chat so far inside `<history>…</history>`, marked as data,
   not instructions, followed by the new message. The last 12 messages go in full (the owner's up to
   1,500 characters, Magnus's up to 800); before them, up to 30 of the owner's earlier requests as
   short lines. A total budget of 16,000 characters drops the oldest lines first; the new message is
   never dropped. A message's own `<history>` / `<turn>` tags are neutralised. The same for every
   brain, so a chat continues even when Codex falls back to Antigravity.
   Rejected: the CLIs' own sessions (`codex exec resume`, `agy -c`): brain-specific, and they break
   the fallback.
3. **One send per chat at a time,** across the relay process and the dashboard (a lock file; a lock
   older than 30 minutes is taken over). One task at a time overall stays as before.
4. **Calls:** `ask` takes `chat: "new" | <chat id>` (absent: a one-off task, as before) and returns
   `chatId` and `title`; `chats.list`, `chats.get`, `chats.rename`, `chats.delete`. The dashboard has
   the same under `/api/chats`. The task list (ADR 0013) shows the owner's message as the title.
5. **UI:** phone app and dashboard look like ChatGPT: a list of chats (new chat, rename, delete),
   message bubbles, a composer with the mic and Send/Stop, live steps under the reply being written.

## Consequences
- Memory is a bounded replay, not understanding: very old details can fall out of the prompt.
- Chats stay on the PC; the relay only carries them end-to-end encrypted.
- Reviewed by Codex and Antigravity before building: both preferred this replay to native sessions;
  their points on fencing the history, a total budget, per-chat locking and undoable delete were
  taken.
