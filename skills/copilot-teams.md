# Skill: copilot-teams

You can orchestrate autonomous AI agent teams using the `copilot-teams` daemon. Teams consist of a lead agent who coordinates workers, decomposes missions into tasks, and drives work to completion.

## Prerequisites

The copilot-teams daemon must be running. Start it with:

```bash
cpt daemon start
```

Default port: `3742`. Override with `--port`.

## Core Workflow

### 1. Create a team

```bash
cpt team create <team-id> --mission "Your mission here" --dir /path/to/project
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
cpt agent add <team-id> --id lead --role "senior engineer and team coordinator"
```

Optional flags: `--model <model>` (default: claude-opus-4.6), `--dir <path>` (scope agent to a subdirectory).

### 3. The lead begins automatically

The lead automatically receives the mission and begins working. No further prompting is needed — the lead will decompose the mission, spawn workers, and coordinate autonomously.

### 4. Monitor progress

```bash
cpt team status <team-id>   # State, agents, tasks
cpt tasks <team-id>         # Task board
cpt activity <team-id>      # Full event log
```

### 5. Intervene if needed

```bash
cpt send <team-id> "Change direction — focus on the API first"
cpt dm <team-id> <agent-id> "Drop what you're doing, fix the auth bug"
cpt team pause <team-id>    # Pause the team
cpt team resume <team-id>   # Resume
```

### 6. Cleanup

```bash
cpt team delete <team-id>
cpt daemon stop
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
| GET | `/teams/:id/tool-calls` | — | Tool call log (`?agent=<agentId>&limit=100`) |

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

// (Optional) Send additional instructions to the lead
await fetch(`${BASE}/teams/my-team/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: "Focus on the login flow first." }),
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
