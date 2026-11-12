# Magnus AI — rules for AI coding agents

Read before changing anything. These rules apply to every AI tool working in this repository.

## What this is
Magnus AI: a hub for MCP servers, skills and rules across AI tools, with a brain and a phone
remote on top. Start with `docs/01-vision-and-plan.md`, then `docs/02-architecture.md`.

## Rules
1. **Plan first.** Work only on the current slice in `docs/01-vision-and-plan.md`. A new or
   changed command, config format or safety rule needs an ADR in `docs/adr/` before code.
2. **Honest status.** Never write "supported" or "verified" for something that was not run and
   checked. Update the Verified column in `docs/03-system-design.md` with the date when it is.
3. **Never touch the user's real config in tests.** Tests use a temporary home folder.
4. **Never overwrite what Magnus did not write**, never write without a visible plan, always
   back up first (`docs/04-coding-standards.md`, safety rules).
5. **No secrets** in code, logs, test fixtures, commits or output.
6. **Free only.** Do not add a paid service or a dependency that needs one.
7. **Security model is fixed** (`docs/05-security.md`): the user approves risky actions and
   nothing else can.
8. Follow `docs/04-coding-standards.md`. Before a commit: `npm run typecheck` and `npm test`.
9. Commit only when the owner asks.

## Commands
```
npm install        # once
npm run typecheck
npm test
node packages/core/dist/src/cli.js status
```
