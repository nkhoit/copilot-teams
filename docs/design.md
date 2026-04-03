# Copilot Teams — Design Document

> **Last updated**: 2026-04-03 (v2 — daemon architecture, autonomous teams)

## Vision

Copilot Teams is an **autonomous project teams** platform for GitHub Copilot. You spin up a team, give it a mission, and walk away. The team self-organizes — the lead decomposes work, spawns workers, delegates tasks, and drives toward completion. You check in when you want, course-correct if needed, and shut it down when it's served its purpose.

Think of it as building a small startup to do a thing. The team persists as long as its purpose exists.

The primary consumer is **another agent** (not a human GUI), though human check-ins via CLI/TUI/web are supported.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     DAEMON PROCESS                       │
│                                                          │
│  ┌──────────────┐  ┌──────────────────────────────────┐ │
│  │ Team Registry │  │         Gateway API               │ │
│  │               │  │  REST: /api/teams/:id/...         │ │
│  │ create/list/  │  │  WS: event stream per team        │ │
│  │ delete teams  │  │                                   │ │
│  └──────┬───────┘  └──────────────┬────────────────────┘ │
│         │                         │                      │
│  ┌──────▼─────────────────────────▼────────────────────┐ │
│  │              Orchestrator (per team)                  │ │
│  │                                                      │ │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │ │
│  │  │   Mission    │  │  Autonomy    │  │  Copilot   │ │ │
│  │  │   System     │  │  Engine      │  │  Sessions  │ │ │
│  │  │             │  │              │  │            │ │ │
│  │  │ current obj │  │ event→nudge  │  │ lead       │ │ │
│  │  │ history     │  │ heartbeat    │  │ worker 1   │ │ │
│  │  │ completion  │  │ escalation   │  │ worker 2   │ │ │
│  │  └─────────────┘  └──────────────┘  └────────────┘ │ │
│  │                                                      │ │
│  │  ┌──────────────────────────────────────────────────┐│ │
│  │  │  TeamState (SQLite per team)                     ││ │
│  │  │  agents | messages | tasks | mission_log         ││ │
│  │  └──────────────────────────────────────────────────┘│ │
│  └──────────────────────────────────────────────────────┘ │
│                                                          │
│  ~/.copilot-teams/teams/<name>/state.db                  │
│  ~/.copilot-teams/daemon.json (PID, port)                │
└─────────────────────────────────────────────────────────┘
```

### Key Insight: `defineTool()` is the backbone

The Copilot SDK's `defineTool()` lets us inject TypeScript functions as tools into each agent session. These tool handlers run in-process and have direct access to shared state (TeamState) and all other sessions. This eliminates the need for an external MCP server, polling, or any IPC — tool execution is the coordination mechanism.

### Technology Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| AI Backend | `@github/copilot-sdk` | Session lifecycle, model access, tool execution, streaming, session persistence/resume |
| State | `better-sqlite3` (WAL mode) | Persistent, fast, zero-config, atomic operations |
| Schema validation | `zod` | Tool parameter validation (required by `defineTool`) |
| API Server | `express` + `ws` | REST endpoints + WebSocket event bus |
| Language | TypeScript (strict, ESM) | Type safety across the stack |

---

## Core Concepts

### Teams

A team is a **persistent organizational unit** — not a one-shot job runner. It has:
- **name**: unique identifier (e.g., `"api-rewrite"`, `"mobile-app"`)
- **mission**: mutable directive describing the team's current objective
- **workingDirectory**: root directory the lead can access (workers get scoped subdirectories)
- **state**: `active` | `completed` | `paused` | `shutdown`
- **agents**: the workforce (lead + workers)

Teams persist across daemon restarts. Their SQLite DB and Copilot SDK session state survive on disk.

The mission is not static — it can evolve. If the team finishes its original objective, you can update the mission and the lead will re-plan. Create a new team only for a completely new charter.

### Agents

An agent is a Copilot SDK session with team tools injected. Each agent has:
- **id**: unique identifier (e.g., `"lead"`, `"researcher"`, `"engineer"`)
- **role**: human-readable description
- **model**: which model to use (default: `claude-sonnet-4`)
- **status**: `idle` | `working`
- **currentTask**: the task ID they're working on (if any)
- **workingDirectory**: the directory this agent's file operations are scoped to
- **sessionId**: the Copilot SDK session ID (for persistence/resume)

#### The Lead

The first agent spawned is the **team lead**. The lead:
- Receives the mission and decomposes it into tasks
- Spawns workers with appropriate roles and working directories
- Delegates tasks and monitors progress
- Declares mission completion when done
- Has the broadest working directory scope (the team's root)

Workers get scoped working directories assigned by the lead.

### Communication: DMs Only

There are **no channels**. All inter-agent communication is via direct messages. Rationale:

- The lead already has full visibility via `team_get_tasks` and `team_get_roster`
- Tasks and their results ARE the broadcast mechanism
- Channels cause cascading responses (everyone replies to everything)
- DMs are targeted — the volley counter handles any remaining ping-pong

Communication patterns:
1. **User → Lead**: Mission updates, course corrections (via `/api/teams/:id/messages`)
2. **User → Agent**: Tactical override DM (via `/api/teams/:id/dm/:agentId`)
3. **Lead → Worker**: Task assignment + context (via `team_create_task` + `team_dm`)
4. **Worker → Lead**: "I'm done / I'm stuck" (via `team_complete_task` + `team_dm`)
5. **Worker → Worker**: Ad-hoc coordination (via `team_dm`)

### Activity Feed

For observability, there is a **read-only activity feed** — a projection of everything that happened (tasks created, claimed, completed, DMs sent, mission changes). It serves the same purpose as a shared channel without the noise of agents reacting to every broadcast.

### Tasks

Tasks are the unit of work. They have:
- **id**: kebab-case unique ID
- **title/description**: what needs to be done
- **status**: `pending` → `in_progress` → `done` (or `blocked` if dependencies aren't met)
- **assignee**: which agent claimed it
- **dependsOn**: array of task IDs that must complete first
- **result**: summary of what was accomplished

Tasks support dependency chains — a task with `dependsOn: ["audit"]` stays `blocked` until the `audit` task is completed, at which point it auto-transitions to `pending` and the assignee is notified.

### Mission

Each team has a **current mission** (mutable text) plus a **mission log** tracking changes over time. The mission is the team's north star — the lead plans tasks to fulfill it.

Mission lifecycle:
1. Team created with initial mission → lead decomposes into tasks
2. User updates mission → lead re-evaluates and re-plans
3. Lead declares mission complete → team transitions to `completed`
4. User can update mission again → team goes back to `active`

**Who declares completion?** The lead. It calls `team_complete_mission` when it believes the objective is fulfilled. The calling agent/user reviews the completion summary and either accepts or pushes back with a mission update.

There is no automated verification — the trust boundary is between the user and the lead.

---

## Team Tools

Tools injected into every agent session via `defineTool()`:

| Tool | Purpose | Who uses it |
|------|---------|-------------|
| `team_dm` | Direct message to a specific agent (with `expectsReply` flag) | Everyone |
| `team_get_roster` | List all team members and their status | Everyone |
| `team_create_task` | Create a task (with optional dependencies and assignee) | Lead |
| `team_get_tasks` | Query tasks (optionally filtered by status) | Everyone |
| `team_claim_task` | Claim a pending task to start working on it | Workers |
| `team_complete_task` | Mark a task as done with a result summary | Workers |
| `team_spawn_agent` | Spawn a new worker with a role and working directory | Lead |
| `team_complete_mission` | Declare the current mission fulfilled | Lead |

There is no broadcast/channel tool — all communication is via DMs. The lead spawns workers via a tool rather than requiring a REST call — this lets the lead self-organize.

---

## Autonomy Engine

The autonomy engine makes teams self-driving. It uses an **event-driven model with a heartbeat safety net**.

### Event-Driven Nudges

The orchestrator watches for state changes and sends nudges to the lead:

| Event | Nudge to Lead |
|-------|---------------|
| Team created with mission | "Here's your mission. Decompose and delegate." |
| Task completed | "Task X done. Result: Y. What's next?" |
| All tasks done | "All tasks complete. Is the mission fulfilled?" |
| Agent idle > N minutes | "Agent Z has been idle. Anything for them?" |
| All agents idle + tasks pending | "Deadlock: tasks pending but nobody's working." |
| Mission updated | "Mission changed. Re-evaluate and re-plan." |
| Team resumed after restart | "Team resumed. Review current state and take action." |

### Heartbeat

Periodic check-in to catch edge cases the event system misses:
- **Aggressive** when work is active: every ~2 minutes
- **Relaxed** when team is idle/waiting: every ~10 minutes
- **Off** when mission is completed

The heartbeat message includes task/agent status summary. If the lead replies `NOTHING_TO_DO`, the engine stays quiet until the next event or heartbeat.

### Design Note

The autonomy engine requires significant trial-and-error tuning. The nudge table and heartbeat intervals are starting points. Key unknowns:
- What prompt makes the lead think vs. just acknowledge?
- What heartbeat interval prevents stalls without burning tokens?
- What happens when the lead makes a bad plan?

Build the skeleton, ship with conservative defaults, iterate based on real runs.

---

## Working Directory Model

Each team has a root `workingDirectory`. The lead gets this broad scope. Workers get scoped to specific subdirectories by the lead.

```
Team workingDirectory: /projects/
├── api/          ← backend worker scoped here
├── web/          ← frontend worker scoped here
└── shared/       ← lead has access to everything
```

**How it works:**
- The Copilot SDK supports `workingDirectory` per session (`createSession({ workingDirectory })`)
- A single `CopilotClient` can manage sessions with different working directories
- The lead calls `team_spawn_agent({ id, role, workingDirectory })` to create workers scoped to specific directories
- No multi-directory support per session — one directory per agent

**Team creation flow:**
1. User creates team with `workingDirectory: "/projects/"` and a mission
2. Lead spawns in `/projects/`, explores the structure
3. Lead decides "I need a backend engineer in `/projects/api/` and a tester in `/projects/api/`"
4. Lead calls `team_spawn_agent` with the appropriate `workingDirectory` for each worker
5. Workers can only see files in their scoped directory

This is **sandboxing-by-delegation** — the lead decides who can access what.

---

## Interaction Model

The user (or calling agent) primarily talks to the **lead** via the messages endpoint. The lead coordinates everything internally. The user can also DM any agent directly for tactical overrides.

```
User creates team with mission → Lead decomposes → Workers execute
User checks in → reads activity feed, task status
User course-corrects → updates mission or DMs an agent
User satisfied → team sits idle or gets shut down
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
3. **Volley counter**: Tracks consecutive DMs between any pair of agents. After `MAX_VOLLEY` (default: 3) consecutive exchanges, further DMs are blocked until the agent does "real work" (completes a task, etc.).

The prompt rules should handle most cases — the volley counter is a hard safety net for when they don't.

---

## Prompt Customization

Each agent's system prompt is built from multiple layers. Some are handled automatically by the Copilot CLI, others are managed by copilot-teams.

### Prompt Stack

```
Layer 1: CLI foundation (identity, safety, tool instructions)          ← Copilot CLI (automatic)
Layer 2: ~/.copilot/instructions.md (user's global preferences)        ← Copilot CLI (automatic)
Layer 3: .github/copilot-instructions.md (repo-specific instructions)  ← Copilot CLI (automatic)
Layer 4: Built-in team prompt (team mechanics, tools, task system)     ← copilot-teams (automatic)
Layer 5: lead.md / worker operating instructions (user-defined style)  ← copilot-teams (user-provided)
```

**Layers 1–3** are inherited for free. The Copilot CLI subprocess loads global and repo-level instructions for every session based on the agent's `workingDirectory`. This means agents will follow the same coding conventions, style preferences, and project-specific instructions that a normal Copilot session would.

**Layer 4** is the built-in team prompt managed by copilot-teams. It teaches agents about the team tools (`team_dm`, `team_create_task`, etc.), their role (lead vs. worker), and communication rules (anti-ping-pong).

**Layer 5** is the user's customization point — operating instructions that control *how* the lead (or workers) should behave.

### Lead Prompt Customization

The lead's operating style is customizable via a markdown file. This file is appended to the system prompt (it does not replace any existing layers).

**Resolution order** (first match wins):

```
1. Explicit flag:    --lead-prompt-file ./my-lead.md
2. Convention file:  <workingDirectory>/.copilot-teams/lead.md
3. Global default:   ~/.copilot-teams/lead.md
4. None:             Built-in default only
```

**Example lead.md:**

```markdown
## Planning Style
- Break work into small, independently testable tasks
- Never have more than 2 tasks in progress simultaneously
- Always create a verification task as the final step

## Worker Management
- Prefer spawning specialists over generalists
- Give each worker a focused scope — one module, one service
- Check in with idle workers before spawning new ones

## Communication
- When reporting progress, include concrete metrics (files changed, tests passing)
- Escalate to the user if blocked for more than 2 task cycles
```

**CLI usage:**

```bash
# Explicit file
cpt team create api-rewrite \
  --mission "Rewrite API to Hono" \
  --dir /projects/app \
  --lead-prompt-file ./lead-instructions.md

# Convention-based (auto-detects /projects/app/.copilot-teams/lead.md)
cpt team create api-rewrite \
  --mission "Rewrite API to Hono" \
  --dir /projects/app
```

**API:**

```json
POST /api/teams
{
  "name": "api-rewrite",
  "mission": "Rewrite API to Hono",
  "workingDirectory": "/projects/app",
  "leadPrompt": "contents of the lead.md file as a string"
}
```

The CLI reads the file and passes contents as a string. The API only deals with text.

### Convention File Location

The convention file at `<workingDirectory>/.copilot-teams/lead.md` mirrors the `.github/copilot-instructions.md` pattern — it lives with the project, gets version-controlled, and different repos can have different lead styles without any flags.

The global default at `~/.copilot-teams/lead.md` is for personal preferences that should apply across all teams (e.g., "always be concise", "prefer TypeScript").

### Mid-Mission Style Changes

The lead's system prompt cannot be changed after session creation (SDK limitation). To adjust the lead's behavior during a mission, fold operating instructions into a **mission update**:

```bash
cpt mission set api-rewrite "Continue the API rewrite, but prioritize test coverage. Don't proceed to new endpoints until existing ones have full test coverage."
```

The lead re-reads the mission on every autonomy engine nudge, so updated instructions take effect naturally.

---

## API Reference

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| **Daemon** | | |
| GET | `/api/health` | Health check |
| **Teams** | | |
| POST | `/api/teams` | Create a team `{ name, mission, workingDirectory, agents? }` |
| GET | `/api/teams` | List all teams |
| GET | `/api/teams/:id` | Team status (agents, tasks, mission, state) |
| DELETE | `/api/teams/:id` | Shut down a team |
| POST | `/api/teams/:id/pause` | Pause a team (keep state, stop autonomy) |
| POST | `/api/teams/:id/resume` | Resume a paused team |
| **Mission** | | |
| GET | `/api/teams/:id/mission` | Current mission + history |
| PUT | `/api/teams/:id/mission` | Update mission `{ text }` |
| **Agents** | | |
| GET | `/api/teams/:id/agents` | List agents |
| POST | `/api/teams/:id/agents` | Add agent `{ id, role, model?, workingDirectory? }` |
| DELETE | `/api/teams/:id/agents/:agentId` | Remove agent |
| **Communication** | | |
| POST | `/api/teams/:id/messages` | Send message to the lead `{ content }` |
| POST | `/api/teams/:id/dm/:agentId` | DM a specific agent `{ content }` |
| **Observability** | | |
| GET | `/api/teams/:id/activity` | Activity feed (read-only log of everything) |
| GET | `/api/teams/:id/tasks` | List tasks `(?status=)` |

### WebSocket Events

Connect to `ws://host:port/ws?team=<teamId>` for a specific team, or `ws://host:port/ws` for all teams.

**Server → Client events:**

```typescript
type ServerEvent =
  | { type: "agent.joined"; teamId: string; agent: Agent }
  | { type: "agent.left"; teamId: string; agentId: string }
  | { type: "agent.status"; teamId: string; agentId: string; status: string; currentTask: string | null }
  | { type: "message.dm"; teamId: string; message: Message }
  | { type: "task.created"; teamId: string; task: Task }
  | { type: "task.claimed"; teamId: string; taskId: string; agentId: string }
  | { type: "task.completed"; teamId: string; taskId: string; agentId: string; result: string }
  | { type: "task.unblocked"; teamId: string; task: Task }
  | { type: "mission.updated"; teamId: string; text: string }
  | { type: "mission.completed"; teamId: string; summary: string }
  | { type: "agent.thinking"; teamId: string; agentId: string; content: string }
  | { type: "team.state"; teamId: string; state: TeamStateEnum }
  | { type: "error"; message: string }
```

**Client → Server commands:**

```typescript
type ClientCommand =
  | { type: "message"; teamId: string; content: string }
  | { type: "dm"; teamId: string; to: string; content: string }
  | { type: "mission.update"; teamId: string; text: string }
```

---

## CLI (`cpt`)

`cpt` (copilot-teams) is a thin CLI client that talks to the daemon's REST API. It's the primary interface for both humans and agents.

### Commands

```bash
# Daemon management
cpt daemon start              # Start the daemon (or auto-starts on first use)
cpt daemon stop               # Gracefully shut down
cpt daemon status             # Show PID, port, uptime, running teams

# Team lifecycle
cpt team create <name> --mission "..." --dir /path/to/project
cpt team list                 # List all teams and their state
cpt team status <name>        # Agents, tasks, mission, current state
cpt team pause <name>         # Pause autonomy (sessions stay alive)
cpt team resume <name>        # Resume autonomy
cpt team delete <name>        # Shut down and clean up

# Mission
cpt mission get <team>        # Current mission + history
cpt mission set <team> "..."  # Update the mission

# Agents
cpt agent list <team>         # List agents and their status
cpt agent add <team> --id dev --role "engineer" [--dir /path] [--model gpt-5]
cpt agent remove <team> <agentId>

# Communication
cpt send <team> "message"     # Send a message to the lead
cpt dm <team> <agentId> "msg" # DM a specific agent

# Observability
cpt activity <team>           # Recent activity feed
cpt activity <team> --follow  # Stream activity in real-time (WebSocket)
cpt tasks <team>              # List tasks
cpt tasks <team> --status in_progress  # Filter by status
```

### Design Principles

- **Thin client**: Zero logic — every command is a REST call or WebSocket connection to the daemon. No state, no config beyond daemon address.
- **Agent-friendly**: Output is structured (JSON by default, human-readable with `--pretty`). An outer agent can parse `cpt team status api-rewrite` as easily as a human can read it.
- **Auto-start**: If the daemon isn't running, `cpt team create` starts it automatically. No manual `daemon start` required.
- **Pipe-friendly**: `cpt tasks api-rewrite --status pending | jq '.[] | .id'` works.

### Output Modes

```bash
cpt team status api-rewrite              # JSON (default, agent-friendly)
cpt team status api-rewrite --pretty     # Formatted for humans
cpt activity api-rewrite --follow        # Streaming (real-time via WebSocket)
```

### Implementation

The CLI is a standalone binary/script that:
1. Reads `~/.copilot-teams/daemon.json` for PID/port
2. Makes HTTP requests to `http://localhost:<port>/api/...`
3. For `--follow` commands, opens a WebSocket to `ws://localhost:<port>/ws?team=<id>`
4. Prints response JSON (or formatted output with `--pretty`)

Built with a lightweight arg parser (e.g., `commander` or `yargs`). Packaged as an npm bin so `npm install -g copilot-teams` gives you the `cpt` command.

---

## Daemon Lifecycle

### Process Management

The daemon is a single Node.js process managing all teams. State file at `~/.copilot-teams/daemon.json`:

```json
{ "pid": 12345, "port": 3742, "startedAt": "2026-04-03T..." }
```

**Start**: Lazy start on first API call, or explicit `copilot-teams daemon start`. Spawns a detached process, writes PID file, boots gateway.

**Stop**: `copilot-teams daemon stop` or `DELETE /api/daemon`. Gracefully disconnects all sessions (state preserved on disk), saves team configs, exits.

**Status**: `copilot-teams daemon status` — shows running teams, port, uptime.

### Crash Recovery

On restart after a crash:

1. Read team configs from `~/.copilot-teams/teams/*/` (which teams exist, their agents, session IDs)
2. Start a new `CopilotClient`
3. Call `client.resumeSession(sessionId, config)` for each agent — the SDK restores full conversation history from disk
4. Re-inject team tools into each session
5. Nudge the lead: "Team resumed after restart. Review current state and take action."

**What survives a crash:**
- ✅ SQLite state (messages, tasks, mission) — on disk
- ✅ Agent conversation history — persisted by Copilot CLI, restored via `resumeSession()`
- ❌ In-flight tool executions — lost, but tasks stay `in_progress` and the lead can re-assign

The key SDK capabilities that enable this:
- `session.disconnect()` releases memory but **preserves state on disk**
- `client.resumeSession(sessionId, config)` resumes with full history
- `client.listSessions()` discovers existing sessions
- `client.deleteSession(id)` permanently removes session data

### Shared CopilotClient

One `CopilotClient` serves all teams. `createSession()` is independent per session, and each session can have its own `workingDirectory`. No need for one CLI subprocess per team.

---

## Team States

```
active      → team is working (autonomy engine running, agents busy)
completed   → lead declared mission done (team idle, sessions alive)
paused      → user manually paused (sessions alive, autonomy engine stopped)
shutdown    → team torn down (sessions disconnected, only DB remains on disk)
```

Transitions:
```
create          → active
complete_mission → completed
update_mission  → active (from completed or paused)
pause           → paused
resume          → active
delete          → shutdown
```

---

## Current State (M1-M3 Complete)

### What's Built

| File | Purpose |
|------|---------|
| `src/team-state.ts` | SQLite-backed state (agents, messages, tasks, volley counter) |
| `src/team-tools.ts` | 7 `defineTool()` tools injected into every agent session |
| `src/orchestrator.ts` | Wraps CopilotClient + TeamState + session lifecycle + events |
| `src/gateway.ts` | Express REST API + WebSocket event bus (single-team) |
| `src/types.ts` | Shared TypeScript interfaces for API shapes |
| `src/index.ts` | Entry point — starts the gateway on port 3742 |
| `src/test-harness.ts` | M1 test (two agents chatting) |

### What's Been Tested

- **M1 — Agent communication**: Two agents (Alice, Bob) exchange messages via DMs and a shared channel. Validates that `defineTool()` handlers can inject messages into other sessions via `session.send()`. ✅
- **M2 — Task coordination**: Three agents (lead, researcher, engineer) coordinate a security review with task dependencies. Lead decomposes work into dependent tasks, researcher completes an audit, tasks auto-unblock, engineer claims and starts implementing fixes. Validates the task lifecycle, dependency resolution, and anti-ping-pong system. ✅
- **M3 — Gateway API**: Express server with REST endpoints and WebSocket event bus. Agents spawn/despawn via REST, user messages flow to agents, tasks CRUD works, real-time events stream to WebSocket clients. ✅

### Remaining Work

The current codebase implements a single-team gateway with channel-based communication. To fully implement the design described in this document:

1. **DMs-only communication** — replace channel broadcast (`team_send` / `#general`) with DM-only communication
2. **Multi-team support** — Team Registry, per-team orchestrators, `/api/teams/:id/` routing
3. **Mission system** — mission field on teams, `team_complete_mission` tool, mission update API
4. **Autonomy engine** — event-driven nudges + heartbeat timer
5. **`team_spawn_agent` tool** — lead can spawn workers with scoped working directories
6. **Daemon lifecycle** — PID file, lazy start, crash recovery via `resumeSession()`
7. **Activity feed** — read-only projection of all events for observability
8. **CLI (`cpt`)** — thin client over REST/WebSocket

---

## Running the Project

```bash
# Install dependencies
npm install

# Start the gateway (port 3742)
npm run gateway

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

# Create a team (future API — not yet implemented)
curl -X POST http://localhost:3742/api/teams \
  -H "Content-Type: application/json" \
  -d '{
    "name": "api-rewrite",
    "mission": "Rewrite the REST API from Express to Hono",
    "workingDirectory": "/projects/my-app"
  }'

# Check team status
curl http://localhost:3742/api/teams/api-rewrite

# Send the team a message
curl -X POST http://localhost:3742/api/teams/api-rewrite/messages \
  -H "Content-Type: application/json" \
  -d '{"content":"Focus on the auth endpoints first"}'

# Check activity
curl http://localhost:3742/api/teams/api-rewrite/activity

# Check tasks
curl http://localhost:3742/api/teams/api-rewrite/tasks
```

---

## Future: Role Templates

> **Status**: Not yet designed or implemented. Captured here for future exploration.

When spinning up teams frequently, the same types of workers appear repeatedly — QA testers, backend engineers, security researchers. Currently the lead describes each worker's focus in the spawn call. Role templates would let users define reusable agent archetypes so that knowledge is codified once and applied consistently.

### Concept

A role template is a markdown file that defines a worker's persistent operating instructions — what they care about, how they work, and what standards they follow. Templates live in a known directory:

```
~/.copilot-teams/roles/          ← global templates (personal library)
<workingDir>/.copilot-teams/roles/  ← project-specific templates
```

**Example** (`~/.copilot-teams/roles/qa-tester.md`):

```markdown
# QA Tester

## Focus Areas
- Test coverage for all public APIs
- Edge cases: empty inputs, max limits, concurrent access
- Regression tests for any changed behavior

## Working Style
- Always run the existing test suite before writing new tests
- Prefer integration tests over unit tests for API endpoints
- Report findings with reproducible steps, not just "it's broken"

## Standards
- Tests must be deterministic — no flaky tests
- Use the project's existing test framework, don't introduce new ones
```

### How It Would Work

When the lead spawns a worker, the `role` field doubles as a template lookup:

```
team_spawn_agent({ id: "tester", role: "qa-tester" })
→ looks up qa-tester.md → injects as system prompt layer 5
```

Resolution order (first match wins):
1. Project-level: `<workingDirectory>/.copilot-teams/roles/<role>.md`
2. Global: `~/.copilot-teams/roles/<role>.md`
3. None found: generic worker prompt only (lead's spawn-time description is the only context)

The lead could also pass `additionalInstructions` to extend a template for a specific task without redefining the whole role.

### Why This Matters Later

- **Consistency**: The QA tester behaves the same way across every team, every project
- **Institutional knowledge**: Best practices get encoded once, not re-prompted every time
- **Role discovery**: The lead could list available templates and make informed staffing decisions
- **Shareability**: Role templates can be version-controlled and shared across a team/org
