# 02 — Architecture

## Components

```mermaid
flowchart LR
  subgraph Phone
    PWA[Magnus app<br/>text + mic]
  end
  subgraph Cloud["Cloud (free tier)"]
    WEB[Next.js site]
    RELAY[Relay<br/>messages only]
  end
  subgraph PC["Your PC"]
    DASH[Dashboard<br/>Next.js, local]
    CORE[Magnus core<br/>registry · sync · gateway]
    BRAIN[Brain<br/>Codex CLI → Antigravity CLI]
    REG[(~/.magnus<br/>magnus.json · skills · rules)]
    subgraph Tools["AI tools"]
      CC[Claude Code]
      CX[Codex]
      AG[Antigravity]
      VS[VS Code]
    end
    subgraph Hands
      XO[XtraOS Agent]
      MCPS[Other MCP servers / CLIs]
    end
  end
  PWA --> WEB
  PWA <--> RELAY
  RELAY <-->|outgoing connection from the PC| CORE
  DASH --> CORE
  CORE --- REG
  CORE -->|sync: MCPs, skills, rules| Tools
  Tools -->|hub mode: one entry, one key| CORE
  CORE --> BRAIN
  BRAIN --> CORE
  CORE --> XO
  CORE --> MCPS
```

| Component | Package | Phase | Role |
|---|---|---|---|
| Core | `packages/core` | 1 | Registry, client adapters, sync, later the gateway |
| Dashboard / phone app | `apps/web` | 1.4, 3 | One Next.js app: local dashboard and deployed phone app |
| Brain | `packages/brain` | 2 | Runs an installed AI CLI headless with the hub connected |
| Relay | `apps/relay` | 3 | Forwards signed messages between phone and PC; stores nothing |
| Voice | `packages/voice` | 4 | Speech to text (browser on the phone, local model on the PC) |

## Two ways a tool gets its MCP servers

```mermaid
flowchart TB
  subgraph Direct["direct (slice 1.1)"]
    R1[(registry)] -->|magnus sync writes every server| T1[tool config]
    T1 --> S1[server A]
    T1 --> S2[server B]
  end
  subgraph Hub["hub (slice 1.3)"]
    R2[(registry)] -->|magnus sync writes ONE entry + key| T2[tool config]
    T2 --> G[Magnus gateway]
    G --> S3[server A]
    G --> S4[server B]
  end
```

Direct needs nothing running and works today. Hub adds one key, one place to switch servers on
and off, a log of calls, and keeps other secrets out of the tools' config files (ADR 0002).

## Flow: `magnus sync`

```mermaid
sequenceDiagram
  actor U as User
  participant C as magnus CLI
  participant R as Registry (~/.magnus)
  participant A as Client adapter
  participant F as Tool config files
  U->>C: magnus sync
  C->>R: load magnus.json, skills/, rules/
  C->>A: for each installed tool: plan
  A->>F: read current config
  A-->>C: actions (add / update / remove / unchanged / conflict)
  C-->>U: the plan (nothing written)
  U->>C: magnus sync --apply
  C->>F: backup once, then write
  C->>R: record what Magnus manages (state.json)
  C-->>U: what changed, what was skipped and why
```

## Flow: a command from the phone (phase 3)

```mermaid
sequenceDiagram
  actor U as User (phone)
  participant P as Phone app
  participant Y as Relay
  participant M as Magnus core (PC)
  participant B as Brain (Codex CLI)
  participant X as XtraOS
  U->>P: "share my resume on WhatsApp"
  P->>Y: command, signed by the paired phone
  Y->>M: forward
  M->>M: verify signature and pairing
  M->>B: plan with the hub's tools
  B->>X: files.find "resume"
  B->>X: whatsapp.send (file)
  X-->>M: approval needed (sending a file)
  M->>Y: approval request
  Y->>P: "Send Resume.pdf to +91…?"
  U->>P: Allow
  P->>Y: approval, signed
  Y->>M: forward
  M->>X: approved by the user
  X-->>B: sent
  B-->>M: done
  M->>Y: result
  Y->>P: "Sent."
```

The approval is the user's, given on a paired device and signed; the brain cannot produce it.
This flow needs an XtraOS change (remote approvals) with its own ADR in that project.

## Flow: brain fallback (phase 2)

```mermaid
flowchart LR
  T[task] --> C1{Codex CLI<br/>available?}
  C1 -->|yes| R1[run codex exec]
  R1 -->|ok| D[result]
  R1 -->|fails: quota, auth, timeout| C2
  C1 -->|no| C2{Antigravity CLI<br/>available?}
  C2 -->|yes| R2[run agy -p]
  R2 --> D
  C2 -->|no| E[error: no brain configured]
```

## Boundaries
- **Core has no UI and no model.** It reads and writes files and (later) speaks MCP.
- **Adapters are data.** A tool is described by where its config lives and its format; the
  planning code is shared and pure (text in, text and actions out).
- **The relay is dumb.** It cannot read or forge commands (they are signed end to end).
- **Secrets stay on the PC**, under the user's Windows account.
