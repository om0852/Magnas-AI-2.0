# 04 — Coding standards

## Language and tooling
- TypeScript, `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
  (`tsconfig.base.json`). ES modules. Node 22 or later.
- One repository, npm workspaces: `packages/*` (libraries, CLI), `apps/*` (web, relay).
- Dependencies are pinned to exact versions and added only with a reason written in the commit.
  The core has no runtime dependencies in phase 1.
- Web: Next.js (App Router) and React, when `apps/web` starts.

## Structure
- **Pure core, thin shell.** Decisions are pure functions (text or data in, text and actions
  out). Reading files, writing files, spawning processes and the clock live at the edges and are
  passed in.
- **Adapters are data** (`clients/defs.ts`): a new AI tool is a new entry, not new logic.
- A file does one job and stays under about 300 lines. No barrel files.
- No classes unless state must live across calls. No default exports.

## Style
- Names say what a thing is: `planJsonMcp`, not `process`. Booleans read as facts (`installed`).
- Errors: throw `MagnusError(code, message, hint)` for things the user can fix; the CLI prints
  the message and the hint, never a stack trace. Never swallow an error silently.
- Comments explain why, not what. Every exported function has a one-line doc comment.
- No `any`. `unknown` at the boundary, then validate.
- Paths: always `node:path`; never build a path with string concatenation. Windows first, but
  no hard-coded drive letters or separators.

## Safety rules for code that touches the user's files
- Never write without a plan the user could have seen (`sync` is a dry run unless `--apply`).
- Never overwrite something Magnus did not write: detect, report a conflict, skip.
- Back up a file before the first change. Write to a temporary file, then rename.
- Never print, log or commit the value of an environment variable, token or key.

## Tests
- `node:test`, next to the package in `test/`. Run: `npm test`.
- Pure planning functions get table-style unit tests. File operations are tested against a
  temporary folder used as the home directory; a test never touches the real home.
- A bug fix comes with a test that failed before the fix.
- Live checks on real tools are recorded in docs/03 (the Verified column) with the date.

## Git
- Small commits, imperative subject: `core: plan MCP changes for JSON tools`.
- A new or changed command, config format or safety rule needs an ADR in `docs/adr` first.
- `main` stays green: typecheck and tests pass before a commit.

## Definition of done
Code, tests, the doc that describes it, and an honest status (built / verified / planned).
