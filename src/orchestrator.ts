import { EventEmitter } from "node:events";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { TeamState } from "./team-state.js";
import type { TeamMessage } from "./team-state.js";
import { createTeamTools } from "./team-tools.js";
import type { Agent, Task, Message, Activity, Mission, ServerEvent, TeamStatusState } from "./types.js";

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

export class Orchestrator extends EventEmitter {
  private client: CopilotClient | null = null;
  private state: TeamState;
  private started = false;
  private teamState: TeamStatusState = "active";
  private workingDirectory: string;
  private leadPrompt?: string;

  constructor(options: {
    dbPath?: string;
    workingDirectory?: string;
    leadPrompt?: string;
  } = {}) {
    super();
    this.state = new TeamState(options.dbPath ?? ":memory:");
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.leadPrompt = options.leadPrompt;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.client = new CopilotClient();
    await this.client.start();
    this.started = true;
    console.log("✅ Orchestrator started (CopilotClient ready)");
  }

  async stop(): Promise<void> {
    if (!this.started || !this.client) return;
    for (const [id] of this.state.getAllSessions()) {
      await this.despawnAgent(id);
    }
    await this.client.stop();
    this.state.close();
    this.started = false;
    console.log("🛑 Orchestrator stopped");
  }

  async spawnAgent(opts: SpawnAgentOptions): Promise<Agent> {
    if (!this.client) throw new Error("Orchestrator not started");

    const model = opts.model ?? "claude-sonnet-4";
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
      console.log(`\n🤖 [${opts.id}]: ${event.data.content}`);
      this.emit("event", {
        type: "agent.thinking",
        agentId: opts.id,
        content: event.data.content,
      } satisfies ServerEvent);
    });

    session.on("tool.execution_start", (event) => {
      console.log(`\n🔧 [${opts.id}] tool: ${event.data.toolName}`);
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
    this.emit("event", { type: "agent.joined", agent } satisfies ServerEvent);
    console.log(`✅ Spawned agent: ${opts.id} (${opts.role}, ${model}, dir: ${agentWorkDir})`);
    return agent;
  }

  async despawnAgent(id: string): Promise<void> {
    const session = this.state.getSession(id);
    if (session) {
      await session.disconnect();
    }
    this.state.deregisterAgent(id);
    this.state.logActivity("agent.left", id, {});
    this.emit("event", { type: "agent.left", agentId: id } satisfies ServerEvent);
    console.log(`👋 Despawned agent: ${id}`);
  }

  /** Send a user message to the lead */
  async sendMessage(content: string, from: string = "user"): Promise<Message> {
    const roster = this.state.getRoster();
    if (roster.length === 0) throw new Error("No agents on the team");

    const msg = this.state.addMessage(from, content, null, roster[0].id);
    const apiMsg = toApiMessage(msg);
    this.emit("event", { type: "message.dm", message: apiMsg } satisfies ServerEvent);
    console.log(`\n📨 [user → ${roster[0].id}]: ${content}`);

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
    this.emit("event", { type: "message.dm", message: apiMsg } satisfies ServerEvent);
    console.log(`\n📨 [DM] ${from} → ${to}: ${content}`);

    await session.send({
      prompt: `[DM from ${from}]: ${content}`,
    });

    return apiMsg;
  }

  // ── Mission ─────────────────────────────────────────────────

  setMission(text: string): void {
    this.state.setMission(text);
    this.teamState = "active";
    this.emit("event", { type: "mission.updated", text } satisfies ServerEvent);
    console.log(`\n🎯 Mission updated: ${text}`);

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
    this.emit("event", { type: "mission.completed", summary } satisfies ServerEvent);
    console.log(`\n🎯 Mission completed: ${summary}`);
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
    this.emit("event", { type: "task.created", task } satisfies ServerEvent);
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
