# Skill: copilot-teams

You can orchestrate autonomous AI agent teams using the `copilot-teams` daemon. Teams consist of a lead agent who coordinates workers, decomposes missions into tasks, and drives work to completion.

## Prerequisites

The copilot-teams daemon must be running. Start it with:

```bash
cd <copilot-teams-repo>
npm run cpt -- daemon start
```

Default port: `3742`. Override with `--port`.

## Core Workflow

### 1. Create a team

```bash
npm run cpt -- team create <team-id> --mission "Your mission here" --dir /path/to/project
```

Or via REST:

```bash
curl -X POST http://localhost:3742/api/teams \
  -H "Content-Type: application/json" \
  -d '{"id": "my-team", "mission": "Build a REST API", "workingDirectory": "/path/to/project"}'
```

### 2. Add the lead agent

The first agent becomes the team lead. They receive the mission and coordinate everything.

```bash
npm run cpt -- agent add <team-id> --id lead --role "senior engineer and team coordinator"
```

Optional flags: `--model <model>` (default: claude-sonnet-4), `--dir <path>` (scope agent to a subdirectory).

### 3. Send instructions to the lead

```bash
npm run cpt -- send <team-id> "Get started. Spawn workers as needed."
```

The lead will autonomously:
- Decompose the mission into tasks
- Spawn worker agents with `team_spawn_agent`
- Assign tasks and monitor progress
- Declare mission complete with `team_complete_mission`

### 4. Monitor progress

```bash
npm run cpt -- team status <team-id>   # State, agents, tasks
npm run cpt -- tasks <team-id>         # Task board
npm run cpt -- activity <team-id>      # Full event log
```

### 5. Intervene if needed

```bash
npm run cpt -- send <team-id> "Change direction — focus on the API first"
npm run cpt -- dm <team-id> <agent-id> "Drop what you're doing, fix the auth bug"
npm run cpt -- team pause <team-id>    # Pause the team
npm run cpt -- team resume <team-id>   # Resume
```

### 6. Cleanup

```bash
npm run cpt -- team delete <team-id>
npm run cpt -- daemon stop
```

## REST API Reference

Base URL: `http://localhost:3742/api`

### Daemon

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/health` | — | Health check |
| GET | `/daemon/status` | — | PID, uptime, team list |

### Teams

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/teams` | `{ id, mission?, workingDirectory? }` | Create team |
| GET | `/teams` | — | List all teams |
| GET | `/teams/:id` | — | Full team status (agents, tasks, mission) |
| DELETE | `/teams/:id` | — | Delete team |
| POST | `/teams/:id/pause` | — | Pause team |
| POST | `/teams/:id/resume` | — | Resume team |

### Agents

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/teams/:id/agents` | `{ id, role, model?, workingDirectory? }` | Add agent |
| DELETE | `/teams/:id/agents/:agentId` | — | Remove agent |

### Messaging

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/teams/:id/messages` | `{ content }` | Message the lead |
| POST | `/teams/:id/dm/:agentId` | `{ content }` | DM a specific agent |

### Tasks

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/teams/:id/tasks` | — | List tasks (`?status=pending`) |
| POST | `/teams/:id/tasks` | `{ id, title, description?, dependsOn? }` | Create task |

### Mission

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/teams/:id/mission` | — | Get current mission |
| PUT | `/teams/:id/mission` | `{ text }` | Set/update mission |

### Activity

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/teams/:id/activity` | — | Activity feed (`?limit=50`) |

### WebSocket

Connect to `ws://localhost:3742/ws` (filter with `?team=<id>`).

Events: `agent.joined`, `agent.left`, `agent.thinking`, `task.created`, `task.claimed`, `task.completed`, `message.dm`, `mission.updated`, `mission.completed`, `team.created`, `team.deleted`, `team.state_changed`.

## Programmatic Usage (Node.js)

If you need to interact with copilot-teams from code rather than CLI:

```typescript
const BASE = "http://localhost:3742/api";

// Create a team
await fetch(`${BASE}/teams`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    id: "my-team",
    mission: "Implement user authentication",
    workingDirectory: "/path/to/repo",
  }),
});

// Add lead agent
await fetch(`${BASE}/teams/my-team/agents`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id: "lead", role: "senior engineer" }),
});

// Send instructions
await fetch(`${BASE}/teams/my-team/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: "Get started on the mission." }),
});

// Poll status
const status = await fetch(`${BASE}/teams/my-team`).then((r) => r.json());
console.log(status.state);   // "active" | "completed" | "paused"
console.log(status.tasks);   // [{ id, title, status, assignee, result }]
console.log(status.agents);  // [{ id, role, model, status }]

// Listen to real-time events
const ws = new WebSocket("ws://localhost:3742/ws?team=my-team");
ws.onmessage = (e) => {
  const event = JSON.parse(e.data);
  // event.type: "task.completed", "agent.thinking", "mission.completed", etc.
};
```

## Key Concepts

- **Team**: A group of agents working on a mission. Each team has its own SQLite database, task board, and activity log.
- **Lead**: The first agent added to a team. Has exclusive access to `team_spawn_agent` and `team_complete_mission`.
- **Workers**: Agents spawned by the lead. Can claim tasks, complete tasks, and DM other agents.
- **Mission**: The high-level objective. Set on team creation or updated later.
- **Tasks**: Units of work created by agents. Have status (`pending` → `in_progress` → `done`), assignees, dependencies, and results.
- **Activity Feed**: Append-only log of everything that happens on the team.
- **Autonomy Engine**: Background process that nudges the lead when action is needed (deadlock, all tasks done, idle agents).
- **Session Persistence**: Teams survive daemon restarts. Agent sessions are resumed with full conversation history.

## Data Storage

All state lives under `~/.copilot-teams/`:

```
~/.copilot-teams/
├── daemon.json              # PID file
└── teams/
    └── <team-id>/
        ├── config.json      # Team config
        └── state.db         # SQLite database
```
