import { EventEmitter } from "node:events";
import type { CopilotClient } from "@github/copilot-sdk";
import { approveAll } from "@github/copilot-sdk";
import { TeamState } from "./team-state.js";
import type { TeamMessage } from "./team-state.js";
import { createTeamTools } from "./team-tools.js";
import type { Agent, Task, Message, Activity, Mission, TeamStatusState } from "./types.js";

export type EventBus = EventEmitter;

const COMMUNICATION_RULES = `
## COMMUNICATION RULES
1. Use team_dm for targeted messages to specific agents.
2. When you receive a [NO REPLY NEEDED] DM, do NOT reply — just absorb the info.
3. Do not acknowledge messages with "got it" or "thanks" — only reply if you have substantive content.
4. If someone asks a question, answer concisely. Do not ask follow-up questions unless critical.
5. Focus on completing your assigned tasks. Coordinate only when blocked or done.
`.trim();

function buildLeadPrompt(agentId: string, role: string, customPrompt?: string): string {
  const base = `You are "${agentId}" — ${role}.
You are the TEAM LEAD. You receive the mission and coordinate the team.

Your responsibilities:
- Decompose the mission into tasks using team_create_task
- Spawn workers with appropriate roles and working directories using team_spawn_agent
- Assign tasks to workers and monitor progress
- Declare mission completion with team_complete_mission when the objective is fulfilled

You have access to team tools: team_dm, team_get_roster, team_create_task, team_get_tasks, team_claim_task, team_complete_task, team_spawn_agent, team_complete_mission.
Use these tools to coordinate. Do NOT just describe what you'd do — actually call the tools.`;

  const custom = customPrompt ? `\n\n## OPERATING INSTRUCTIONS\n${customPrompt}` : "";
  return `${base}${custom}\n\n${COMMUNICATION_RULES}`;
}

function buildWorkerPrompt(agentId: string, role: string): string {
  return `You are "${agentId}" — ${role}.
You are a team member. Follow the lead's direction, claim and complete tasks assigned to you.
Report results via team_complete_task and DM the lead with important findings.

You have access to team tools: team_dm, team_get_roster, team_get_tasks, team_claim_task, team_complete_task.
Use these tools to coordinate. Do NOT just describe what you'd do — actually call the tools.

${COMMUNICATION_RULES}`;
}

function toApiMessage(m: TeamMessage): Message {
  return { id: m.id, from: m.from_agent, to: m.to_agent, channel: m.channel, content: m.content, timestamp: m.timestamp };
}

export interface SpawnAgentOptions {
  id: string;
  role: string;
  model?: string;
  isLead?: boolean;
  systemPrompt?: string;
  workingDirectory?: string;
}

export interface OrchestratorOptions {
  teamId?: string;
  dbPath?: string;
  workingDirectory?: string;
  leadPrompt?: string;
  client?: CopilotClient;
}

export class Orchestrator extends EventEmitter {
  readonly teamId: string;
  private client: CopilotClient | null = null;
  private ownsClient: boolean;
  private state: TeamState;
  private started = false;
  private teamState: TeamStatusState = "active";
  private workingDirectory: string;
  private leadPrompt?: string;
  readonly createdAt: number = Date.now();

  constructor(options: OrchestratorOptions = {}) {
    super();
    this.teamId = options.teamId ?? "default";
    this.state = new TeamState(options.dbPath ?? ":memory:");
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.leadPrompt = options.leadPrompt;

    if (options.client) {
      this.client = options.client;
      this.ownsClient = false;
      this.started = true;
    } else {
      this.ownsClient = true;
    }
  }

  /** Start the orchestrator. Only creates a CopilotClient if none was injected. */
  async start(): Promise<void> {
    if (this.started) return;
    if (this.ownsClient) {
      const { CopilotClient } = await import("@github/copilot-sdk");
      this.client = new CopilotClient();
      await this.client.start();
    }
    this.started = true;
    console.log(`✅ Orchestrator [${this.teamId}] started`);
  }

  /** Stop the orchestrator. Only stops the CopilotClient if this orchestrator owns it. */
  async stop(): Promise<void> {
    if (!this.started) return;
    for (const [id] of this.state.getAllSessions()) {
      await this.despawnAgent(id);
    }
    if (this.ownsClient && this.client) {
      await this.client.stop();
    }
    this.state.close();
    this.started = false;
    this.teamState = "shutdown";
    console.log(`🛑 Orchestrator [${this.teamId}] stopped`);
  }

  /**
   * Disconnect all sessions but preserve agent rows in DB for resume.
   * Used during graceful daemon shutdown (vs stop() which fully cleans up).
   */
  async disconnect(): Promise<void> {
    if (!this.started) return;
    for (const [id, session] of this.state.getAllSessions()) {
      try {
        await session.disconnect();
        console.log(`💤 [${this.teamId}] Disconnected agent: ${id}`);
      } catch (err) {
        console.error(`Error disconnecting agent ${id}:`, err);
      }
    }
    // Clear in-memory session refs but keep DB rows
    this.state.clearSessions();
    this.state.close();
    this.started = false;
    this.teamState = "shutdown";
    console.log(`💤 Orchestrator [${this.teamId}] disconnected (state preserved)`);
  }

  /**
   * Restore agent sessions from DB after a daemon restart.
   * Reads persisted agent roster, resumes each SDK session, rebinds tools/events.
   */
  async restoreAgents(client: CopilotClient): Promise<number> {
    this.client = client;
    this.ownsClient = false;
    this.started = true;
    this.teamState = "active";

    const roster = this.state.getRoster();
    let restored = 0;

    for (const agent of roster) {
      if (!agent.sessionId) {
        console.warn(`⚠️ [${this.teamId}] Agent "${agent.id}" has no session ID, skipping restore`);
        continue;
      }

      try {
        const isLead = roster.indexOf(agent) === 0;
        const tools = createTeamTools(this.state, agent.id, {
          eventBus: this,
          isLead,
          spawnAgent: isLead ? async (spawnOpts) => {
            await this.spawnAgent({
              id: spawnOpts.id,
              role: spawnOpts.role,
              model: spawnOpts.model,
              workingDirectory: spawnOpts.workingDirectory,
            });
          } : undefined,
          completeMission: isLead ? (summary) => {
            this.completeMission(summary);
          } : undefined,
        });

        const systemPrompt = isLead
          ? buildLeadPrompt(agent.id, agent.role, this.leadPrompt)
          : buildWorkerPrompt(agent.id, agent.role);

        const session = await client.resumeSession(agent.sessionId, {
          model: agent.model,
          tools,
          systemMessage: { mode: "append", content: systemPrompt },
          workingDirectory: agent.workingDirectory ?? this.workingDirectory,
          onPermissionRequest: approveAll,
        });

        this.state.setSession(agent.id, session);

        session.on("assistant.message", (event) => {
          console.log(`\n🤖 [${this.teamId}/${agent.id}]: ${event.data.content}`);
          this.emit("event", { type: "agent.thinking", agentId: agent.id, content: event.data.content });
        });

        session.on("tool.execution_start", (event) => {
          console.log(`\n🔧 [${this.teamId}/${agent.id}] tool: ${event.data.toolName}`);
        });

        restored++;
        console.log(`♻️  [${this.teamId}] Restored agent: ${agent.id} (session: ${agent.sessionId})`);
      } catch (err) {
        console.error(`⚠️ [${this.teamId}] Failed to restore agent "${agent.id}":`, err);
        // Remove stale agent from DB since session can't be resumed
        this.state.deregisterAgent(agent.id);
      }
    }

    this.state.logActivity("team.restored", null, { agentsRestored: restored, agentsTotal: roster.length });
    console.log(`♻️  Orchestrator [${this.teamId}] restored (${restored}/${roster.length} agents)`);
    return restored;
  }

  async spawnAgent(opts: SpawnAgentOptions): Promise<Agent> {
    if (!this.client) throw new Error("Orchestrator not started");

    const model = opts.model ?? "claude-opus-4.6";
    const isLead = opts.isLead ?? (this.state.getRoster().length === 0);
    const agentWorkDir = opts.workingDirectory ?? this.workingDirectory;

    const tools = createTeamTools(this.state, opts.id, {
      eventBus: this,
      isLead,
      spawnAgent: isLead ? async (spawnOpts) => {
        await this.spawnAgent({
          id: spawnOpts.id,
          role: spawnOpts.role,
          model: spawnOpts.model,
          workingDirectory: spawnOpts.workingDirectory,
        });
      } : undefined,
      completeMission: isLead ? (summary) => {
        this.completeMission(summary);
      } : undefined,
    });

    const systemPrompt = opts.systemPrompt ??
      (isLead ? buildLeadPrompt(opts.id, opts.role, this.leadPrompt) : buildWorkerPrompt(opts.id, opts.role));

    const session = await this.client.createSession({
      model,
      tools,
      systemMessage: { mode: "append", content: systemPrompt },
      workingDirectory: agentWorkDir,
      onPermissionRequest: approveAll,
    });

    this.state.registerAgent(opts.id, opts.role, model, session, agentWorkDir);

    session.on("assistant.message", (event) => {
      console.log(`\n🤖 [${this.teamId}/${opts.id}]: ${event.data.content}`);
      this.emit("event", { type: "agent.thinking", agentId: opts.id, content: event.data.content });
    });

    session.on("tool.execution_start", (event) => {
      console.log(`\n🔧 [${this.teamId}/${opts.id}] tool: ${event.data.toolName}`);
    });

    const agent: Agent = {
      id: opts.id,
      role: opts.role,
      model,
      status: "idle",
      currentTask: null,
      workingDirectory: agentWorkDir,
    };

    this.state.logActivity("agent.joined", opts.id, { role: opts.role, model, workingDirectory: agentWorkDir });
    this.emit("event", { type: "agent.joined", agent });
    console.log(`✅ [${this.teamId}] Spawned agent: ${opts.id} (${opts.role}, ${model}, dir: ${agentWorkDir})`);
    return agent;
  }

  async despawnAgent(id: string): Promise<void> {
    const session = this.state.getSession(id);
    if (session) {
      await session.disconnect();
    }
    this.state.deregisterAgent(id);
    this.state.logActivity("agent.left", id, {});
    this.emit("event", { type: "agent.left", agentId: id });
    console.log(`👋 [${this.teamId}] Despawned agent: ${id}`);
  }

  /** Send a user message to the lead */
  async sendMessage(content: string, from: string = "user"): Promise<Message> {
    const roster = this.state.getRoster();
    if (roster.length === 0) throw new Error("No agents on the team");

    const msg = this.state.addMessage(from, content, null, roster[0].id);
    const apiMsg = toApiMessage(msg);
    this.emit("event", { type: "message.dm", message: apiMsg });

    const leadSession = this.state.getSession(roster[0].id);
    if (leadSession) {
      await leadSession.send({
        prompt: `[Message from ${from}]: ${content}`,
      });
    }

    return apiMsg;
  }

  /** Send a DM from the user to a specific agent */
  async sendDM(to: string, content: string, from: string = "user"): Promise<Message> {
    const session = this.state.getSession(to);
    if (!session) throw new Error(`Agent "${to}" not found`);

    const msg = this.state.addMessage(from, content, null, to);
    const apiMsg = toApiMessage(msg);
    this.emit("event", { type: "message.dm", message: apiMsg });

    await session.send({
      prompt: `[DM from ${from}]: ${content}`,
    });

    return apiMsg;
  }

  // ── Mission ─────────────────────────────────────────────────

  setMission(text: string): void {
    this.state.setMission(text);
    this.teamState = "active";
    this.emit("event", { type: "mission.updated", text });

    const roster = this.state.getRoster();
    if (roster.length > 0) {
      const leadSession = this.state.getSession(roster[0].id);
      if (leadSession) {
        leadSession.send({
          prompt: `[MISSION UPDATED]: ${text}\n\nDecompose this into tasks and delegate to your team. Use team_spawn_agent to create workers if needed.`,
        });
      }
    }
  }

  getMission(): Mission | null {
    const current = this.state.getMission();
    if (!current) return null;
    const history = this.state.getMissionHistory().map((m) => ({
      text: m.text,
      updatedAt: m.updated_at,
    }));
    return { text: current.text, updatedAt: current.updated_at, history };
  }

  completeMission(summary: string): void {
    this.teamState = "completed";
    this.state.logActivity("mission.completed", null, { summary });
    this.emit("event", { type: "mission.completed", summary });
  }

  // ── Lifecycle ───────────────────────────────────────────────

  pause(): void {
    if (this.teamState !== "active") return;
    this.teamState = "paused";
    this.state.logActivity("team.paused", null, {});
    this.emit("event", { type: "team.state_changed", state: "paused" });
  }

  resume(): void {
    if (this.teamState !== "paused") return;
    this.teamState = "active";
    this.state.logActivity("team.resumed", null, {});
    this.emit("event", { type: "team.state_changed", state: "active" });
  }

  // ── Queries ─────────────────────────────────────────────────

  getAgents(): Agent[] {
    return this.state.getRoster().map((a) => ({
      id: a.id,
      role: a.role,
      model: a.model,
      status: a.status,
      currentTask: a.currentTask,
      workingDirectory: a.workingDirectory,
    }));
  }

  getAgent(id: string): Agent | undefined {
    const a = this.state.getAgent(id);
    if (!a) return undefined;
    return {
      id: a.id,
      role: a.role,
      model: a.model,
      status: a.status,
      currentTask: a.currentTask,
      workingDirectory: a.workingDirectory,
    };
  }

  getTasks(status?: string): Task[] {
    return this.state.getTasks(status).map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      assignee: t.assignee,
      dependsOn: JSON.parse(t.depends_on),
      result: t.result,
      createdAt: t.created_at,
    }));
  }

  getMessages(limit: number = 50): Message[] {
    return this.state.getAllMessages(limit).map(toApiMessage);
  }

  getActivity(limit: number = 50): Activity[] {
    return this.state.getActivity(limit).map((a) => ({
      id: a.id,
      type: a.type,
      agentId: a.agent_id,
      data: JSON.parse(a.data),
      timestamp: a.timestamp,
    }));
  }

  createTask(id: string, title: string, description: string = "", dependsOn: string[] = [], assignee?: string): Task {
    const t = this.state.createTask(id, title, description, dependsOn, assignee);
    const task: Task = {
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      assignee: t.assignee,
      dependsOn: JSON.parse(t.depends_on),
      result: t.result,
      createdAt: t.created_at,
    };
    this.emit("event", { type: "task.created", task });
    return task;
  }

  getTeamState(): TeamStatusState {
    return this.teamState;
  }

  isStarted(): boolean {
    return this.started;
  }

  getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  getTeamStateDb(): TeamState {
    return this.state;
  }
}
