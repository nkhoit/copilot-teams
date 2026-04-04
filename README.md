# copilot-teams

Autonomous AI agent teams for GitHub Copilot. Spawn a team of specialized agents — developers, QA engineers, code reviewers — that collaborate on real software projects. A lead agent decomposes your mission into tasks, spawns workers, and coordinates the pipeline while an autonomy engine keeps everything moving.

In practice: you describe what you want built, the lead creates a plan, spawns the right agents, and the team builds it end-to-end — writing code, running tests, reviewing for security issues, and writing docs. A URL shortener with 33 passing tests and 100% statement coverage was built in ~7 minutes with zero human intervention beyond approving the plan.

Built on the [GitHub Copilot SDK](https://github.com/github/copilot-sdk).

## Prerequisites

- **Node.js** 18+
- **GitHub CLI** with **Copilot extension** installed, authenticated, and on your PATH
  - Install: `gh extension install github/gh-copilot`
  - Verify: `gh copilot --version`
- A GitHub account with **Copilot access** (any plan with agent mode)

## Install

```bash
git clone https://github.com/nkhoit/copilot-teams.git
cd copilot-teams
npm install
npm run build
```

## Quick Start

### 1. Start the daemon

```bash
npm run cpt -- daemon start
# or: npx tsx src/cli.ts daemon start
```

The daemon runs on `http://localhost:3742` by default (override with `--port`).

### 2. Create a team with a mission

```bash
npm run cpt -- team create my-team \
  --mission "Build a REST API for a todo app with Express, SQLite, and vitest tests" \
  --dir /path/to/project
```

### 3. Add the lead agent

```bash
npm run cpt -- agent add my-team --id lead --role "Tech Lead" --model claude-opus-4.6
```

The first agent added becomes the **team lead**. The mission is delivered automatically — the lead will decompose it into tasks, spawn workers (developers, QA, reviewers), and coordinate the team without further prompting.

### 4. Monitor progress

```bash
npm run cpt -- team status my-team    # Agents, tasks, team state
npm run cpt -- tasks my-team          # Task board
npm run cpt -- activity my-team       # Full activity feed
```

### 5. Interact (optional)

```bash
npm run cpt -- send my-team "message"              # Message the lead
npm run cpt -- dm my-team <agentId> "message"       # DM a specific agent
```

### 6. Stop

```bash
npm run cpt -- team delete my-team    # Delete a specific team
npm run cpt -- daemon stop            # Stop the daemon
```

## How It Works

1. **You describe a mission** → the lead agent receives it
2. **Lead creates a plan** → optionally pauses for your approval via `team_request_input`
3. **Lead spawns workers** → each with a specific role, model, and working directory
4. **Lead creates tasks** with dependency chains → tasks auto-unblock as dependencies complete
5. **Workers claim and execute tasks** → writing code, running tests, doing reviews
6. **Workers communicate via DMs** → reporting blockers, sharing findings
7. **Autonomy engine nudges** → detects idle agents, deadlocks, completed pipelines
8. **Lead declares mission complete** → all agent sessions are disconnected to save tokens

### Agent Roles & Models

The lead chooses which agents to spawn and which model each uses. Common patterns:

| Role | Recommended Model | Why |
|------|------------------|-----|
| Tech Lead | `claude-opus-4.6` | Best at planning, decomposition, coordination |
| Backend Developer | `claude-sonnet-4` | Fast, capable coder for implementation tasks |
| QA Engineer | `gpt-5.4` | Strong at finding edge cases, writing thorough tests |
| Code Reviewer | `claude-opus-4.6` | Best at security analysis, type safety, best practices |

Default model is `claude-opus-4.6`. Override per-agent with `--model` when adding agents, or let the lead choose when spawning workers.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Daemon (Node.js process, port 3742)                    │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │   Gateway    │  │ TeamRegistry │  │ AutonomyEngine│  │
│  │ REST + WS API│  │  per-team    │  │  per-team     │  │
│  └──────┬───────┘  │ orchestrator │  │ event nudges  │  │
│         │          └──────┬───────┘  │ + heartbeat   │  │
│         │                 │          └───────┬───────┘  │
│         │          ┌──────┴───────┐          │          │
│         └─────────►│ Orchestrator │◄─────────┘          │
│                    │              │                      │
│                    │ ┌──────────┐ │                      │
│                    │ │TeamState │ │  SQLite per team     │
│                    │ │ (SQLite) │ │  ~/.copilot-teams/   │
│                    │ └──────────┘ │    teams/<id>/       │
│                    │              │      state.db        │
│                    │ Sessions:    │      config.json     │
│                    │  lead ──────►│──► Copilot SDK       │
│                    │  worker-1 ──►│──► Copilot SDK       │
│                    │  worker-2 ──►│──► Copilot SDK       │
│                    └──────────────┘                      │
└─────────────────────────────────────────────────────────┘
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| **CLI** | `src/cli.ts` | `cpt` command — thin REST client for the daemon |
| **Gateway** | `src/gateway.ts` | Express REST API + WebSocket for real-time events |
| **Daemon** | `src/daemon.ts` | Process lifecycle, PID file, graceful shutdown |
| **TeamRegistry** | `src/team-registry.ts` | Multi-team CRUD, event forwarding, persistence |
| **Orchestrator** | `src/orchestrator.ts` | Per-team agent management, messaging, missions |
| **TeamState** | `src/team-state.ts` | SQLite persistence — agents, tasks, messages, activity, tool calls |
| **TeamTools** | `src/team-tools.ts` | Tools injected into each agent via `defineTool()` |
| **AutonomyEngine** | `src/autonomy-engine.ts` | Event-driven nudges + heartbeat to keep teams moving |
| **RoleTemplates** | `src/role-templates.ts` | Reusable agent role templates (`.md` files) |

### Agent Tools

Each agent gets team coordination tools injected into their Copilot session:

| Tool | Available To | Description |
|------|-------------|-------------|
| `team_dm` | All | Direct message another agent |
| `team_get_roster` | All | See who's on the team |
| `team_get_tasks` | All | View the task board |
| `team_create_task` | All | Create a new task with dependencies |
| `team_claim_task` | All | Claim a pending task (lead cannot claim tasks assigned to others) |
| `team_complete_task` | All | Mark a task done with results (lead cannot complete others' tasks) |
| `team_request_input` | All | Signal waiting for user input — sets status to "waiting" |
| `team_spawn_agent` | Lead only | Spawn a new worker with role, model, and template |
| `team_complete_mission` | Lead only | Declare mission complete, disconnect all agents |
| `team_reject_task` | Lead only | Reject a completed task with feedback, send back for rework |
| `team_list_templates` | Lead only | Discover available role templates |

### Autonomy Engine

Each team has an autonomy engine that monitors events and nudges the lead when action is needed:

- **Task completed** → "Agent X finished task Y. 3 pending, 1 blocked remaining."
- **All tasks done** → "All tasks complete. Is the mission fulfilled?"
- **Deadlock detected** → "All agents are idle but work remains. Assign tasks."
- **Team resumed** → "Team resumed. Review tasks and take action."
- **Heartbeat** → Periodic check (2min active, 10min idle) for stuck teams.

### Role Templates

Create reusable agent archetypes as `.md` files. The lead can discover and apply them when spawning workers.

**Project-specific templates** (checked first):
```
<project>/.copilot-teams/roles/
├── backend-dev.md
├── qa-engineer.md
└── code-reviewer.md
```

**Global templates** (fallback):
```
~/.copilot-teams/roles/
├── backend-dev.md
└── qa-engineer.md
```

Template content becomes the agent's system prompt. Use `team_list_templates` to discover available templates, and pass `template: "backend-dev"` when spawning.

### Session Persistence

Teams survive daemon restarts:

- **Team config** persisted to `~/.copilot-teams/teams/<id>/config.json`
- **Team state** (agents, tasks, messages, activity) in `~/.copilot-teams/teams/<id>/state.db`
- **Copilot sessions** persisted to disk by the SDK — resumed via `client.resumeSession()`
- On restart, the daemon auto-detects persisted teams and restores them with full conversation history

### Observability

Every tool call made by every agent (including Copilot's built-in file edits, shell commands, etc.) is logged to the `tool_calls` table in SQLite. Query via the REST API:

```bash
# All tool calls for a team
curl http://localhost:3742/api/teams/my-team/tool-calls

# Filtered by agent
curl http://localhost:3742/api/teams/my-team/tool-calls?agent=backend-dev&limit=50
```

## CLI Reference

```
cpt daemon start [--port 3742]     Start the daemon
cpt daemon stop                    Stop the daemon
cpt daemon status                  Show daemon info

cpt team create <id> [--mission "..."] [--dir /path]
cpt team list                      List all teams
cpt team status <id>               Full team status (agents, tasks, state)
cpt team pause <id>                Pause a team
cpt team resume <id>               Resume a paused team
cpt team delete <id>               Delete a team

cpt mission get <team>             Get current mission
cpt mission set <team> "text"      Set/update mission

cpt agent list <team>              List agents on a team
cpt agent add <team> --id <id> --role "..." [--dir /path] [--model ...]
cpt agent remove <team> <agentId>  Remove an agent

cpt send <team> "message"          Send message to the lead
cpt dm <team> <agentId> "message"  DM a specific agent

cpt activity <team> [--limit N]    Activity feed
cpt tasks <team> [--status ...]    List tasks (filter: pending, in_progress, done, blocked)
```

## REST API

All endpoints are under `http://localhost:3742/api`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/daemon/status` | Daemon info, uptime, team list |
| POST | `/teams` | Create a team `{ id, mission?, workingDirectory? }` |
| GET | `/teams` | List all teams |
| GET | `/teams/:id` | Full team status |
| DELETE | `/teams/:id` | Delete a team |
| POST | `/teams/:id/pause` | Pause a team |
| POST | `/teams/:id/resume` | Resume a team |
| POST | `/teams/:id/agents` | Add agent `{ id, role, model?, workingDirectory?, template? }` |
| DELETE | `/teams/:id/agents/:agentId` | Remove an agent |
| POST | `/teams/:id/messages` | Send message to lead `{ content }` |
| POST | `/teams/:id/dm/:agentId` | DM an agent `{ content }` |
| GET | `/teams/:id/tasks` | List tasks (optional `?status=pending`) |
| POST | `/teams/:id/tasks` | Create task `{ id, title, description?, dependsOn? }` |
| GET | `/teams/:id/mission` | Get mission |
| PUT | `/teams/:id/mission` | Set mission `{ text }` |
| GET | `/teams/:id/activity` | Activity feed (optional `?limit=50`) |
| GET | `/teams/:id/tool-calls` | Tool call log (optional `?agent=<id>&limit=100`) |

### WebSocket

Connect to `ws://localhost:3742/ws` for real-time events. Filter by team with `?team=<id>`.

Events: `agent.joined`, `agent.left`, `agent.thinking`, `agent.waiting`, `task.created`, `task.claimed`, `task.completed`, `task.rejected`, `message.dm`, `mission.updated`, `mission.completed`, `team.created`, `team.deleted`, `team.state_changed`.

## Development

```bash
npm test              # Run all tests (123 tests)
npm run test:watch    # Watch mode
npm run dev           # Start daemon in dev mode (tsx, no build needed)
npm run build         # Compile TypeScript to dist/
```

### Project Structure

```
src/
├── index.ts              # Entry point — starts the gateway
├── cli.ts                # cpt CLI tool
├── gateway.ts            # Express REST + WebSocket server
├── daemon.ts             # Daemon lifecycle (PID file, shutdown)
├── team-registry.ts      # Multi-team management
├── orchestrator.ts       # Per-team agent coordination
├── team-state.ts         # SQLite persistence layer
├── team-tools.ts         # Agent tools (defineTool bindings)
├── autonomy-engine.ts    # Event-driven nudges + heartbeat
├── role-templates.ts     # Template resolver (project + global)
├── types.ts              # Shared TypeScript interfaces
└── test/
    ├── mocks/
    │   └── copilot-sdk.ts        # MockCopilotSession + MockCopilotClient
    ├── team-state.test.ts        # 43 tests — SQLite layer
    ├── team-tools.test.ts        # 34 tests — tool bindings + guards
    ├── team-registry.test.ts     # 26 tests — multi-team + crash recovery
    ├── autonomy-engine.test.ts   # 11 tests — nudges + heartbeat
    └── role-templates.test.ts    #  9 tests — template resolution

skills/
└── copilot-teams.md      # Skill file for agent import
```

## Data Storage

All persistent data lives under `~/.copilot-teams/`:

```
~/.copilot-teams/
├── daemon.json                  # PID file (port, pid, started time)
├── roles/                       # Global role templates
│   └── *.md
└── teams/
    ├── <team-id>/
    │   ├── config.json          # Team config (mission, workingDirectory)
    │   └── state.db             # SQLite (agents, tasks, messages, activity, tool_calls)
    └── ...
```

## License

MIT
