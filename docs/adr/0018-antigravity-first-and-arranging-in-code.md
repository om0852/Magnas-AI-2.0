# ADR 0018 — Antigravity first (through ACP), repetitive desktop work in code, chat as the home page

- Status: accepted (owner, 2026-11-13: "use antigravity cli then if codex is not working properly …
  it is with other more complex tasks"; "use gemini-flash-3.8 in medium for antigravity"; "update the
  dashboard ui like chatgpt … just like we did it for mobile phones").

## Context
Codex on the owner's ChatGPT plan only offers `gpt-6-luna` (stronger models are refused). Even at
medium effort it stopped long tasks early: "rearrange the desktop icons" ended after 1-3 drags,
with no error. Antigravity ran with its own MCP list (which also holds `agentbucket` and Stitch)
and could not see the Magnus hub's tools (desktop tools, `magnus__ask_user`).

## Decision
1. **Antigravity first, through ACP.** Magnus starts `agy acp` (Agent Client Protocol) and gives
   the session one MCP server: the Magnus hub (`magnus hub --quick --servers …`). Its own configured
   servers are not used. Model `gemini-3.8-flash-medium` (owner's choice), `gemini-3.8-flash-high`
   if that is not offered. Permission requests: allowed for hub tools, refused otherwise (it has no
   shell or file access from Magnus). Stop sends `session/cancel`. A note tells it to call every
   tool on server "magnus" with the full name (it once split `xtraos__status`). Codex is second.
2. **`magnus hub --quick`:** answers a new client within ~2 s (Antigravity starts servers lazily and
   waits briefly); servers that come up later add their tools then.
3. **Repetitive desktop work in code:** `magnus__arrange_desktop_icons {layout: left-right | left |
   right}` reads every icon and the desktop grid from XtraOS `observe`, plans neat edge columns,
   moves the icons in rounds (a taken spot waits; a cycle parks one icon in the empty middle),
   re-reads after each round, restores the windows and reports "Arranged N of M". Every move is an
   XtraOS `drag`, so XtraOS's policy and log still apply. The brain is told to use it.
4. **Dashboard:** `/` is the ChatGPT-style chat (as on the phone); the old dashboard is
   "Tools & settings" at `/manage`, linked from the chat sidebar; `/chat` redirects to `/`.

## Consequences
- Checked live: Antigravity through ACP got the hub's tools (not its own list), set the model, and
  answered a hub call in 39 s (the very first run, with cold `npx` servers, took 6½ minutes).
- The arranger is tested on a simulated snapping desktop (43 icons, all placed, 22 left / 21 right);
  not yet on the owner's real desktop.

## Amendment (2026-11-13): zones, not spots
First real run: all 45 icons arranged, but the tool was called 5 times and icons were moved again
and again. Cause: each icon got an exact spot, numbered from where the icons were at the start; an
icon that snapped one cell off counted as wrong, and each call renumbered the spots. Now the goal is
a zone: every icon anywhere in the left columns or the right columns, split evenly. Icons already in
their zone are never moved; only middle icons and a fuller side's extras move, to the nearest free
cell. A second call moves nothing and says the task is done. The grid step is the smallest gap that
the other gaps are multiples of, halved when it is about two icons wide (sparse columns).
