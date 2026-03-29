# Copilot Teams — Design Document

## Vision

Copilot Teams is an **agent teams** platform for GitHub Copilot. It lets multiple AI agents collaborate on software engineering tasks — communicating, decomposing work into tasks, and dynamically growing/shrinking the team. Think of it as Claude Code's [agent teams](https://code.claude.com/docs/en/agent-teams) but built on top of the GitHub Copilot SDK.

The user talks to their team like a tech lead talks to engineers: give high-level direction, the lead decomposes it, workers execute, and results flow back.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Clients                          │
│  (CLI, TUI, Web UI, IRC bridge — anything)          │
└──────────────┬──────────────────┬───────────────────┘
               │ REST             │ WebSocket
┌──────────────▼──────────────────▼───────────────────┐
│                  Gateway (Express)                   │
│  REST: agents, channels, messages, tasks, teams      │
│  WS: real-time event stream (agent.thinking,         │
│      message.channel, task.completed, etc.)          │
└──────────────┬──────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────┐
│               Orchestrator                           │
│  Wraps CopilotClient + TeamState + session lifecycle │
│  Emits ServerEvents on every state change            │
│  Manages agent spawn/despawn                         │
└───────┬───────────────┬─────────────────────────────┘
        │               │
┌───────▼──────┐ ┌──────▼─────────────────────────────┐
│  TeamState   │ │       Copilot SDK Sessions           │
│  (SQLite)    │ │  One CopilotClient, N sessions       │
│              │ │  Each session has team tools injected │
│  - agents    │ │  via defineTool()                     │
│  - messages  │ │                                       │
│  - tasks     │ │  Tools have direct references to      │
│  - volleys   │ │  TeamState + all other sessions       │
└──────────────┘ └─────────────────────────────────────┘
```

### Key Insight: `defineTool()` is the backbone

The Copilot SDK's `defineTool()` lets us inject TypeScript functions as tools into each agent session. These tool handlers run in-process and have direct access to shared state (TeamState) and all other sessions. This eliminates the need for an external MCP server, polling, or any IPC — tool execution is the coordination mechanism.

### Technology Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| AI Backend | `@github/copilot-sdk` | Session lifecycle, model access, tool execution, streaming |
| State | `better-sqlite3` (WAL mode) | Persistent, fast, zero-config, atomic operations |
| Schema validation | `zod` | Tool parameter validation (required by `defineTool`) |
| API Server | `express` + `ws` | REST endpoints + WebSocket event bus |
| Language | TypeScript (strict, ESM) | Type safety across the stack |

---

## Core Concepts

### Agents

An agent is a Copilot SDK session with team tools injected. Each agent has:
- **id**: unique identifier (e.g., `"lead"`, `"researcher"`, `"engineer"`)
- **role**: human-readable description
- **model**: which model to use (default: `claude-sonnet-4`)
- **status**: `idle` | `working`
- **currentTask**: the task ID they're working on (if any)

The first agent spawned is automatically designated the **team lead** (gets a lead-specific system prompt).

### Channels & Messages

- `#general` is the main channel. All agents see messages posted here.
- **DMs** are private between two agents (or user → agent).
- Messages are persisted in SQLite with timestamps.
- When a user sends to `#general`, all agents receive the message via `session.send()`.

### Tasks

Tasks are the unit of work. They have:
- **id**: kebab-case unique ID
- **title/description**: what needs to be done
- **status**: `pending` → `in_progress` → `done` (or `blocked` if dependencies aren't met)
- **assignee**: which agent claimed it
- **dependsOn**: array of task IDs that must complete first
- **result**: summary of what was accomplished

Tasks support dependency chains — a task with `dependsOn: ["audit"]` stays `blocked` until the `audit` task is completed, at which point it auto-transitions to `pending` and the assignee is notified.

### Team Tools (7 tools injected into every agent)

| Tool | Purpose |
|------|---------|
| `team_send` | Post to #general (broadcasts to all agents) |
| `team_dm` | Direct message to a specific agent |
| `team_get_roster` | List all team members and their status |
| `team_create_task` | Create a task (with optional dependencies) |
| `team_get_tasks` | Query tasks (optionally filtered by status) |
| `team_claim_task` | Claim a pending task to work on |
| `team_complete_task` | Mark a task as done with a result summary |

---

## Interaction Model (Model C — Hybrid)

The user primarily talks to the team through `#general`, where the **lead** picks up messages and coordinates. But the user can also **DM any agent directly** for tactical overrides.

```
User writes to #general → Lead decomposes into tasks → Workers execute
User DMs engineer directly → Engineer acts on it, Lead gets notified
```

Hierarchy (enforced via system prompts, not infrastructure):
```
User > Lead > Peer Agents
```

---

## Anti-Ping-Pong System

Without guardrails, agents will chat endlessly ("Got it!" "Thanks!" "No problem!" ...). We prevent this with:

1. **System prompt rules**: Agents are instructed not to acknowledge messages, not to reply to FYI messages, and to only respond with substantive content.
2. **`expectsReply` flag**: The `team_dm` tool has a boolean parameter. When `false`, the message is tagged `[NO REPLY NEEDED]` and agents know not to respond.
3. **Volley counter**: Tracks consecutive DMs between any pair of agents. After `MAX_VOLLEY` (default: 3) consecutive exchanges, further DMs are blocked until the agent does "real work" (completes a task, posts to #general, etc.).

In practice, the prompt rules alone work well — the volley counter is a safety net.

---

## API Reference

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/status` | Full team snapshot (agents, tasks, channels) |
| GET | `/api/agents` | List all agents |
| GET | `/api/agents/:id` | Get a specific agent |
| POST | `/api/agents` | Spawn a new agent `{ id, role, model? }` |
| DELETE | `/api/agents/:id` | Despawn an agent |
| GET | `/api/channels/:ch/messages` | Get channel messages |
| POST | `/api/channels/:ch/messages` | Send message to channel `{ content }` |
| POST | `/api/dm/:agentId` | DM an agent `{ content }` |
| GET | `/api/tasks` | List tasks (optional `?status=` filter) |
| POST | `/api/tasks` | Create a task `{ id, title, description?, dependsOn?, assignee? }` |

### WebSocket Events (`ws://host:port/ws`)

**Server → Client events:**

```typescript
type ServerEvent =
  | { type: "agent.joined"; agent: Agent }
  | { type: "agent.left"; agentId: string }
  | { type: "agent.status"; agentId: string; status: string; currentTask: string | null }
  | { type: "message.channel"; message: Message }
  | { type: "message.dm"; message: Message }
  | { type: "task.created"; task: Task }
  | { type: "task.claimed"; taskId: string; agentId: string }
  | { type: "task.completed"; taskId: string; agentId: string; result: string }
  | { type: "task.unblocked"; task: Task }
  | { type: "agent.thinking"; agentId: string; content: string }
  | { type: "error"; message: string }
```

**Client → Server commands:**

```typescript
type ClientCommand =
  | { type: "message"; channel: string; content: string }
  | { type: "dm"; to: string; content: string }
  | { type: "task.create"; id: string; title: string; description?: string; dependsOn?: string[]; assignee?: string }
```

---

## Current State (M1-M3 Complete)

### What's Built

| File | Purpose |
|------|---------|
| `src/team-state.ts` | SQLite-backed state (agents, messages, tasks, volley counter) |
| `src/team-tools.ts` | 7 `defineTool()` tools injected into every agent session |
| `src/orchestrator.ts` | Wraps CopilotClient + TeamState + session lifecycle + events |
| `src/gateway.ts` | Express REST API + WebSocket event bus |
| `src/types.ts` | Shared TypeScript interfaces for API shapes |
| `src/index.ts` | Entry point — starts the gateway on port 3742 |
| `src/test-harness.ts` | M1 test (two agents chatting) |

### What's Been Tested

- **M1**: Two agents (Alice, Bob) exchange messages via #general and DMs ✅
- **M2**: Three agents (lead, researcher, engineer) coordinate a security review with task dependencies. Lead decomposes work, researcher completes audit, tasks auto-unblock, engineer claims and starts fixes ✅
- **M3**: Gateway boots, agents spawn/despawn via REST, user messages flow through #general, agents respond, tasks CRUD works, DMs work, WebSocket events pipe to clients ✅

### What Agents Actually Do

During M2 testing, agents:
- Used `team_create_task` to decompose "security review" into 3 dependent tasks
- Used `team_claim_task` and `team_complete_task` to manage their work
- Used `team_dm` with `expectsReply: false` for FYI notifications
- Actually ran security analysis tools (grep, view files) and created findings databases
- Started editing source files to fix discovered issues (!)
- Respected anti-ping-pong rules ("No response needed")

---

## Remaining Milestones

### M4: Dynamic Spawn/Despawn

Agents can propose adding or removing team members through a quorum vote:

- `team_propose` tool: "I need a database expert for this migration"
- `team_vote` tool: other agents vote yes/no
- Majority vote → Orchestrator spawns/despawns the agent
- System prompt describes available roles/specializations

This is what makes the team truly dynamic — it grows and shrinks based on the task.

### M5: First Client

Build a real frontend that connects to the gateway. Options:

1. **CLI client** — `copilot-teams chat` opens a terminal chat interface
2. **TUI** (Ink/React) — richer terminal UI with panels for agents, tasks, chat
3. **Web UI** — React + assistant-ui library for streaming/markdown/typing indicators
4. **IRC bridge** — map agents to IRC nicks, channels to IRC channels

The gateway is client-agnostic — any of these can be built independently.

---

## Open Design Questions

### Multi-Team / Daemon Model

The current gateway runs one team. The north-star architecture is:

- **Single daemon** running in the background (`copilot-teams daemon start`)
- **Multiple named workspaces** (teams) managed via the API
- Each team has its own Orchestrator, agents, and SQLite DB
- Teams can scope to one or more directories
- State persists to `~/.copilot-teams/teams/<name>/state.db`
- API prefix: `/api/teams/:teamId/...`

This hasn't been built yet — the current implementation is single-team.

### Working Directory Isolation

During M2 testing, the engineer agent started editing the project's own source files while "fixing security issues." Test runs should probably use `--add-dir` or a working directory override to sandbox agent file access.

### Shared vs. Independent CopilotClient

Currently, each Orchestrator creates its own CopilotClient (one Copilot CLI subprocess). For multi-team, we could share one CopilotClient across teams since `createSession()` is independent. This needs testing.

### Task Scoping

Agents are thorough — they'll spend 10+ minutes on a task if not constrained. The test harness timed out because the engineer was doing excellent but exhaustive work. Tasks may need time budgets or scope limits.

### Channel Broadcast Scaling

`team_send` pushes to ALL other agents via `session.send()`. With many agents, this could cause cascading responses. May need selective delivery (e.g., only agents subscribed to a channel).

---

## Running the Project

```bash
# Install dependencies
npm install

# Start the gateway (port 3742)
npm run gateway
# or: npx tsx src/index.ts

# Run the M1 test harness
npm test

# Type-check
npx tsc --noEmit
```

### Prerequisites

- Node.js 20+
- GitHub Copilot CLI installed and authenticated (`copilot auth login`)
- `@github/copilot-sdk` (installed via npm)

### Quick Test via curl

```bash
# Health check
curl http://localhost:3742/api/health

# Spawn agents
curl -X POST http://localhost:3742/api/agents \
  -H "Content-Type: application/json" \
  -d '{"id":"lead","role":"team lead"}'

curl -X POST http://localhost:3742/api/agents \
  -H "Content-Type: application/json" \
  -d '{"id":"dev","role":"software engineer"}'

# Send a message to #general
curl -X POST http://localhost:3742/api/channels/general/messages \
  -H "Content-Type: application/json" \
  -d '{"content":"Hello team, what can you help me with?"}'

# Check responses
curl http://localhost:3742/api/channels/general/messages

# Check team status
curl http://localhost:3742/api/status
```

### WebSocket (Node.js)

```javascript
import WebSocket from "ws";
const ws = new WebSocket("ws://localhost:3742/ws");
ws.on("message", (data) => {
  const event = JSON.parse(data.toString());
  console.log(event.type, event);
});
```
