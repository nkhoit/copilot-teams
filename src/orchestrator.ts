import { EventEmitter } from "node:events";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { TeamState } from "./team-state.js";
import type { TeamMessage } from "./team-state.js";
import { createTeamTools } from "./team-tools.js";
import type { Agent, Task, Message, ServerEvent } from "./types.js";

function toApiMessage(m: TeamMessage): Message {
  return { id: m.id, from: m.from_agent, to: m.to_agent, channel: m.channel, content: m.content, timestamp: m.timestamp };
}

export type EventBus = EventEmitter;

const COMMUNICATION_RULES = `
## COMMUNICATION RULES
1. Use team_send for announcements; team_dm for targeted questions.
2. When you receive a [NO REPLY NEEDED] DM, do NOT reply — just absorb the info.
3. Do not acknowledge messages with "got it" or "thanks" — only reply if you have substantive content.
4. If someone asks a question, answer concisely. Do not ask follow-up questions unless critical.
5. Focus on completing your assigned tasks. Coordinate only when blocked or done.
`.trim();

function buildSystemPrompt(agentId: string, role: string, isLead: boolean): string {
  const base = `You are "${agentId}" — ${role} on a software development team.
You have access to team coordination tools (team_send, team_dm, team_get_roster, team_create_task, team_get_tasks, team_claim_task, team_complete_task).
Use these tools to communicate and coordinate. Do NOT just describe what you'd do — actually call the tools.`;

  const leadExtra = isLead
    ? `\nYou are the TEAM LEAD. You receive user requests and coordinate the team.
When the user sends a message to #general, decompose it into tasks and delegate to teammates.
You can create tasks with dependencies, assign them, and track progress.`
    : `\nYou are a team member. Follow the lead's direction, claim and complete tasks assigned to you.
Report results via team_complete_task and notify the team of important findings.`;

  return `${base}\n${leadExtra}\n\n${COMMUNICATION_RULES}`;
}

export interface SpawnAgentOptions {
  id: string;
  role: string;
  model?: string;
  isLead?: boolean;
  systemPrompt?: string;
}

export class Orchestrator extends EventEmitter {
  private client: CopilotClient | null = null;
  private state: TeamState;
  private started = false;

  constructor(dbPath: string = ":memory:") {
    super();
    this.state = new TeamState(dbPath);
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
    // Disconnect all sessions
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
    const tools = createTeamTools(this.state, opts.id, this);
    const systemPrompt = opts.systemPrompt ?? buildSystemPrompt(opts.id, opts.role, opts.isLead ?? false);

    const session = await this.client.createSession({
      model,
      tools,
      systemMessage: { mode: "append", content: systemPrompt },
      onPermissionRequest: approveAll,
    });

    this.state.registerAgent(opts.id, opts.role, model, session);

    // Wire up streaming events for the gateway
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
    };

    this.emit("event", { type: "agent.joined", agent } satisfies ServerEvent);
    console.log(`✅ Spawned agent: ${opts.id} (${opts.role}, ${model})`);
    return agent;
  }

  async despawnAgent(id: string): Promise<void> {
    const session = this.state.getSession(id);
    if (session) {
      await session.disconnect();
    }
    this.state.deregisterAgent(id);
    this.emit("event", { type: "agent.left", agentId: id } satisfies ServerEvent);
    console.log(`👋 Despawned agent: ${id}`);
  }

  /** Send a user message to #general — the lead picks it up */
  async sendToChannel(channel: string, content: string, from: string = "user"): Promise<Message> {
    const msg = this.state.addMessage(from, content, channel, null);
    const apiMsg = toApiMessage(msg);
    this.emit("event", { type: "message.channel", message: apiMsg } satisfies ServerEvent);
    console.log(`\n💬 [${channel}] ${from}: ${content}`);

    // Push to all agents in the channel
    for (const [id, session] of this.state.getAllSessions()) {
      await session.send({
        prompt: `[${channel} — ${from}]: ${content}`,
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

  // ── Queries ─────────────────────────────────────────────────

  getAgents(): Agent[] {
    return this.state.getRoster().map((a) => ({
      id: a.id,
      role: a.role,
      model: a.model,
      status: a.status,
      currentTask: a.currentTask,
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

  getMessages(channel?: string, limit: number = 50): Message[] {
    const ch = channel ?? "#general";
    return this.state.getChannelMessages(ch, limit).map(toApiMessage);
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

  isStarted(): boolean {
    return this.started;
  }
}
