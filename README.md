# copilot-teams

Autonomous AI agent teams for GitHub Copilot. Multiple agents collaborate on software engineering tasks — coordinated by a lead, communicating via direct messages, sharing work through a task system, and driven forward by an autonomy engine.

Built on the [GitHub Copilot SDK](https://github.com/github/copilot-sdk).

## Prerequisites

- **Node.js** 18+
- **GitHub Copilot CLI** (`gh copilot`) installed, authenticated, and on your PATH
  - Install: `gh extension install github/gh-copilot`
  - Verify: `gh copilot --version`
- A GitHub account with **Copilot access**

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

### 2. Create a team

```bash
npm run cpt -- team create my-team --mission "Build a REST API for a todo app" --dir /path/to/project
```

### 3. Add the lead agent

```bash
npm run cpt -- agent add my-team --id lead --role "senior engineer and team coordinator"
```

The first agent added becomes the **team lead** — they receive the mission, decompose it into tasks, spawn workers, and coordinate the team.

### 4. Send a message

```bash
npm run cpt -- send my-team "Get started on the mission. Spawn workers as needed."
```

### 5. Monitor progress

```bash
npm run cpt -- team status my-team    # Team state, agents, tasks
npm run cpt -- tasks my-team          # Task list
npm run cpt -- activity my-team       # Full activity feed
```

### 6. Stop

```bash
npm run cpt -- team delete my-team    # Delete a specific team
npm run cpt -- daemon stop            # Stop the daemon
```

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
| **TeamState** | `src/team-state.ts` | SQLite persistence — agents, tasks, messages, activity |
| **TeamTools** | `src/team-tools.ts` | Tools injected into each agent via `defineTool()` |
| **AutonomyEngine** | `src/autonomy-engine.ts` | Event-driven nudges + heartbeat to keep teams moving |

### How Agents Coordinate

Each agent gets team coordination tools injected into their Copilot session:

| Tool | Available To | Description |
|------|-------------|-------------|
| `team_dm` | All | Direct message another agent |
| `team_get_roster` | All | See who's on the team |
| `team_get_tasks` | All | View the task board |
| `team_create_task` | All | Create a new task |
| `team_claim_task` | All | Claim a task for yourself |
| `team_complete_task` | All | Mark a task done with results |
| `team_spawn_agent` | Lead only | Spawn a new worker agent |
| `team_complete_mission` | Lead only | Declare the mission complete |

### Autonomy Engine

Each team has an autonomy engine that monitors events and nudges the lead when action is needed:

- **Task completed** → "Agent X finished task Y. 3 pending, 1 blocked remaining."
- **All tasks done** → "All tasks complete. Is the mission fulfilled?"
- **Deadlock detected** → "All agents are idle but work remains. Assign tasks."
- **Team resumed** → "Team resumed. Review tasks and take action."
- **Heartbeat** → Periodic check (2min active, 10min idle) for stuck teams.

### Session Persistence

Teams survive daemon restarts:

- **Team config** persisted to `~/.copilot-teams/teams/<id>/config.json`
- **Team state** (agents, tasks, messages, activity) in `~/.copilot-teams/teams/<id>/state.db`
- **Copilot sessions** persisted to disk by the SDK — resumed via `client.resumeSession()`
- On restart, the daemon auto-detects persisted teams and restores them with full conversation history

## CLI Reference

```
cpt daemon start [--port 3742]     Start the daemon
cpt daemon stop                    Stop the daemon
cpt daemon status                  Show daemon info

cpt team create <id> [--mission "..."] [--dir /path]
cpt team list                      List all teams
cpt team status <id>               Full team status
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
cpt tasks <team> [--status ...]    List tasks
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
| POST | `/teams/:id/agents` | Add agent `{ id, role, model?, workingDirectory? }` |
| DELETE | `/teams/:id/agents/:agentId` | Remove an agent |
| POST | `/teams/:id/messages` | Send message to lead `{ content }` |
| POST | `/teams/:id/dm/:agentId` | DM an agent `{ content }` |
| GET | `/teams/:id/tasks` | List tasks (optional `?status=pending`) |
| POST | `/teams/:id/tasks` | Create task `{ id, title, description?, dependsOn? }` |
| GET | `/teams/:id/mission` | Get mission |
| PUT | `/teams/:id/mission` | Set mission `{ text }` |
| GET | `/teams/:id/activity` | Activity feed (optional `?limit=50`) |

### WebSocket

Connect to `ws://localhost:3742/ws` for real-time events. Filter by team with `?team=<id>`.

Events: `agent.joined`, `agent.left`, `agent.thinking`, `task.created`, `task.claimed`, `task.completed`, `message.dm`, `mission.updated`, `mission.completed`, `team.created`, `team.deleted`, `team.state_changed`.

## Development

```bash
npm test              # Run all tests (103 tests)
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
├── types.ts              # Shared TypeScript interfaces
└── test/
    ├── mocks/
    │   └── copilot-sdk.ts    # MockCopilotSession + MockCopilotClient
    ├── team-state.test.ts    # 43 tests — SQLite layer
    ├── team-tools.test.ts    # 23 tests — tool bindings
    ├── team-registry.test.ts # 26 tests — multi-team + crash recovery
    └── autonomy-engine.test.ts # 11 tests — nudges + heartbeat
```

## Data Storage

All persistent data lives under `~/.copilot-teams/`:

```
~/.copilot-teams/
├── daemon.json                  # PID file (port, pid, started time)
└── teams/
    ├── <team-id>/
    │   ├── config.json          # Team config (mission, workingDirectory)
    │   └── state.db             # SQLite (agents, tasks, messages, activity)
    └── ...
```

## License

MIT
