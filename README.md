# Magnus AI

One hub for your MCP servers, skills and rules across every AI tool, with a brain and a phone
remote on top.

**Status: phases 1 and 2 built** (registry, sync, import, secrets, the hub, the dashboard and
the brain: `magnus ask`).
Unit-tested; sync applied on the owner's PC to Claude Code, Codex and VS Code; the hub ran live
with four real servers; the dashboard was checked in a browser. See docs/03 for what is verified. The brain, phone remote and voice are planned, not built. See
[the plan](docs/01-vision-and-plan.md).

## What works today
```
magnus init                                  # create ~/.magnus
magnus import                                # what your tools already have (writes nothing)
magnus import --apply                        # take it into the registry
magnus add-mcp xtraos -- node C:\path\xtraos-mcp.mjs
# put skills in ~/.magnus/skills/<name>/SKILL.md and rules in ~/.magnus/rules/*.md
magnus status                                # which AI tools are installed
magnus sync                                  # show what would change (writes nothing)
magnus sync --apply                          # write it, with backups
magnus secret set API_KEY                    # then use ${secret:API_KEY} in a server's env
magnus mode codex hub                        # Codex gets ONE entry: the Magnus hub
magnus key new && magnus serve               # the hub over HTTP on this PC, with the Magnus key
magnus ask "Open YouTube in Firefox"         # Codex CLI does it with XtraOS (Antigravity CLI as fallback)
```
`sync` puts the same MCP servers, skills and rules into each installed tool, never overwrites
anything you wrote yourself, and reports conflicts instead.

## Dashboard
```
npm run dashboard        # builds, starts on 127.0.0.1:4747, prints the link to open
```

## Develop
```
npm install
npm test
```

## Docs
- [01 Vision and plan](docs/01-vision-and-plan.md)
- [02 Architecture and flows](docs/02-architecture.md)
- [03 System design](docs/03-system-design.md)
- [04 Coding standards](docs/04-coding-standards.md)
- [05 Security model](docs/05-security.md)
- [Decisions (ADRs)](docs/adr)
- [Rules for AI agents](AGENTS.md)
