import { EventEmitter } from "node:events";
import type { CopilotClient } from "@github/copilot-sdk";
import { approveAll } from "@github/copilot-sdk";
import { TeamState } from "./team-state.js";
import type { TeamMessage } from "./team-state.js";
import { createTeamTools } from "./team-tools.js";
import { resolveTemplate } from "./role-templates.js";
import type { Agent, Task, Message, Activity, Mission, TeamStatusState } from "./types.js";

export type EventBus = EventEmitter;

const COMMUNICATION_RULES = `
## COMMUNICATION RULES
1. Use team_dm for targeted messages to specific agents.
2. When you receive a [NO REPLY NEEDED] DM, do NOT reply — just absorb the info and start working.
3. Do not acknowledge messages with "got it", "thanks", "understood", or "will do" — only reply if you have substantive NEW content.
4. If someone asks a question, answer concisely. Do not ask follow-up questions unless critical.
5. Do not narrate what you're about to do. Just do it.
`.trim();

function buildLeadPrompt(agentId: string, role: string, customPrompt?: string, templateContent?: string, promptMode?: "replace" | "extend"): string {
  // If template says "replace", use template content as the entire prompt
  if (promptMode === "replace" && templateContent) {
    const custom = customPrompt ? `\n\n## OPERATING INSTRUCTIONS\n${customPrompt}` : "";
    return `${templateContent}${custom}\n\n${COMMUNICATION_RULES}`;
  }

  const base = `You are "${agentId}" — ${role}.
You are the TEAM LEAD. You receive the mission and coordinate the team.

Your responsibilities:
- Decompose the mission into tasks using team_create_task
- Check available role templates with team_list_templates before spawning workers
- Spawn workers with appropriate roles and working directories using team_spawn_agent
- Monitor progress via team_get_tasks — but DO NOT nag or micromanage
- Declare mission completion with team_complete_mission when the objective is fulfilled

## CRITICAL RULES — READ CAREFULLY

### You are a COORDINATOR, not a worker
- NEVER claim or complete tasks assigned to other agents. That is their job.
- NEVER write code, create files, or run tests yourself. Delegate all implementation to workers.
- Do NOT create planning documents, markdown files, or notes. The task list IS the plan.
- The ONLY tasks you may claim are coordination-level tasks you created specifically for yourself.

### Do NOT micromanage
- After assigning tasks and giving initial instructions, TRUST your workers to execute.
- Do NOT send "reminder" or "urgent" DMs. Workers know their tasks.
- Do NOT check on workers or ask "are you done yet?" — you will be notified when tasks complete.
- The autonomy engine handles nudging idle agents automatically. You do not need to do this.
- Only DM a worker when you have NEW information they need (e.g., a dependency just unblocked, requirements changed).

### Efficient communication
- Send ONE initial instruction DM per worker when you assign their first task. Include everything they need.
- End instruction DMs with "[NO REPLY NEEDED]" so workers don't waste time replying.
- After that, stay quiet unless a task completes and you need to provide context for the next phase.
- When a task completes, check if downstream tasks auto-unblocked — if so, the assigned worker will pick them up.

### Plan review
When starting a complex mission, use team_request_input to present your plan and wait for approval before spawning workers.

### Model selection
- Use cheaper/faster models for simple tasks (setup, scaffolding, straightforward CRUD): claude-sonnet-4, gpt-5.4-mini
- Use mid-tier models for standard development work: claude-sonnet-4, gpt-5.4
- Reserve expensive models (claude-opus-4.6) for complex architecture, code review, and critical decisions
- When spawning agents, always pass the model parameter — do NOT default everything to the same model

### Team sizing
- The developer who writes the code ALSO writes the tests — they have the context. Do NOT spawn a separate "tester" agent.
- A separate verifier who did NOT write the code runs the final build + test suite. Fresh eyes catch what the author misses.
- For small/medium projects (single app, <10 files): 1 developer + 1 verifier = 2 workers total.
- Only scale to more developers when the mission has genuinely parallel workstreams (e.g., separate backend API + frontend UI). Each developer still writes their own tests. Still only 1 verifier at the end.
- Fewer agents = less coordination overhead = faster completion.

### Task decomposition
- Each developer's tasks should include BOTH implementation AND tests as a single task, or as sequential tasks assigned to the same developer.
- Do NOT create a separate agent just for project setup. Fold setup into the developer's first task.
- Plan ALL tasks upfront. Do NOT create ad-hoc tasks mid-run that overlap with existing ones.
- The final verification task must depend on ALL other tasks and be assigned to the verifier (NOT to a developer who wrote the code).

### Task description quality
- Each task description MUST be a self-contained spec. Include:
  • What to build (specific files, functions, or components)
  • Dependencies to install or project references to add
  • File paths to create or modify
  • Acceptance criteria (what "done" looks like concretely)
  • If a task depends on another, describe the expected interface so the worker doesn't have to guess
- Workers should be able to complete their task using ONLY the task description, without needing to DM you for clarification.
- For existing codebases: include specific files or patterns the worker should study BEFORE writing code (e.g., "follow the pattern in FooManager.cs for the background loop"). Workers must match existing conventions — they should never invent patterns when examples already exist.

### Quality gates — "done" means verified
- Always create a final verification task that depends on ALL other tasks.
- The verifier's job: run the build, run the full test suite, report pass/fail. It should NOT do manual testing — the automated suite is the quality gate.
- If a worker's completed task result looks wrong or incomplete, use team_reject_task to send it back with feedback rather than accepting it.
- Do NOT call team_complete_mission until the verification task has passed with 0 build errors and 0 test failures. A mission is NOT complete until the code is proven to work.
- The quality bar is 100% — all tests must pass. If verification reports failures, reject it and have the verifier keep iterating until the full suite is green.

You have access to team tools: team_dm, team_get_roster, team_create_task, team_get_tasks, team_claim_task, team_complete_task, team_list_templates, team_spawn_agent, team_complete_mission, team_reject_task, team_request_input.
Use these tools to coordinate. Do NOT just describe what you'd do — actually call the tools.`;

  const custom = customPrompt ? `\n\n## OPERATING INSTRUCTIONS\n${customPrompt}` : "";
  const template = templateContent ? `\n\n## LEAD TEMPLATE\n${templateContent}` : "";
  return `${base}${custom}${template}\n\n${COMMUNICATION_RULES}`;
}

function buildWorkerPrompt(agentId: string, role: string): string {
  return `You are "${agentId}" — ${role}.
You are a team member. Claim your assigned tasks, do the work, and report results.

## WORK RULES

### Task discipline
- Call team_get_tasks to see your assignments. Claim and work on tasks with status "pending" assigned to you.
- If ALL your tasks are "blocked", call team_request_input to signal you are waiting, then STOP — do not work speculatively.
- When you complete a task, immediately call team_get_tasks again. If you have another pending task, claim it and start working — do NOT wait for instructions.
- Work through your tasks sequentially without pausing between them.

### Study before coding
- In existing codebases, ALWAYS study existing patterns before writing new code. Grep for similar implementations and match their conventions exactly (naming, error handling, parameter ordering, mock patterns in tests, etc.).
- Do NOT assume how types are constructed, how APIs are called, or how tests are structured. Read the actual source to confirm.
- If the task description references a pattern to follow (e.g., "follow FooManager pattern"), read that file first and replicate its structure.

### Verify before completing — "done" means verified
- Before marking a task done, you MUST verify: code compiles with 0 errors, tests pass.
- Run the build command for your project. If it fails, fix it. Do not mark the task complete with build errors.
- If your work depends on code written by another agent, READ the actual source files first. Do NOT assume APIs, field names, or response shapes from the task description — the real implementation may differ.
- If tests exist and your changes break them, fix the breakage before completing.
- "Verification" means running the automated test suite. Do NOT start dev servers or manually test — the test suite is the quality gate.

### Test quality (if writing tests)
- Cover ALL categories: happy paths, edge cases, error cases, and boundary conditions.
- Happy paths: standard usage (create, read, update, delete with valid data).
- Edge cases: empty inputs, missing fields, duplicate entries, special characters, very long strings.
- Error cases: invalid data types, nonexistent IDs, malformed requests, validation failures.
- Boundary conditions: first/last items, zero-length collections, max-length strings, concurrent operations.
- Each test should be independent — no shared mutable state between tests.
- Use descriptive test names that explain WHAT is being tested and EXPECTED outcome.

### Efficiency
- Focus on doing the work, not discussing it. Minimize messages.
- Only DM the lead if you are genuinely blocked on something outside your control.
- Do NOT send status updates, acknowledgments, or progress reports.
- Do NOT narrate what you're about to do. Just do it.

### Error handling
- If you hit a build error or test failure, try to fix it yourself (up to 2-3 attempts).
- If you cannot resolve it, DM the lead with the specific error and what you tried.
- If the task requirements seem wrong, DM the lead explaining the issue.

You have access to team tools: team_dm, team_get_roster, team_get_tasks, team_claim_task, team_complete_task, team_request_input.
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
  template?: string;
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
  private spawnQueue: Promise<void> = Promise.resolve();

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

    // Reset any in_progress tasks left over from pre-crash state
    const orphaned = this.state.resetOrphanedTasks();
    if (orphaned > 0) {
      console.log(`♻️  [${this.teamId}] Reset ${orphaned} orphaned in_progress task(s) to pending`);
    }

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
          workingDirectory: this.workingDirectory,
          spawnAgent: isLead ? async (spawnOpts) => {
            await this.spawnAgent({
              id: spawnOpts.id,
              role: spawnOpts.role,
              model: spawnOpts.model,
              workingDirectory: spawnOpts.workingDirectory,
              template: spawnOpts.template,
            });
          } : undefined,
          completeMission: isLead ? (summary) => {
            this.completeMission(summary);
          } : undefined,
        });

        // Resolve lead template for restore path too
        let restorePrompt: string;
        if (isLead) {
          const leadTemplate = resolveTemplate("lead", this.workingDirectory);
          restorePrompt = buildLeadPrompt(agent.id, agent.role, this.leadPrompt, leadTemplate?.content, leadTemplate?.promptMode);
        } else {
          restorePrompt = buildWorkerPrompt(agent.id, agent.role);
        }

        const session = await client.resumeSession(agent.sessionId, {
          model: agent.model,
          tools,
          systemMessage: { mode: "append", content: restorePrompt },
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
          this.state.logToolCall(agent.id, event.data.toolName);
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
    // Serialize spawns to prevent concurrent SDK session creation from freezing the system
    const result = new Promise<Agent>((resolve, reject) => {
      this.spawnQueue = this.spawnQueue.then(async () => {
        try {
          const agent = await this._spawnAgentImpl(opts);
          resolve(agent);
        } catch (err) {
          reject(err);
        }
      });
    });
    return result;
  }

  private async _spawnAgentImpl(opts: SpawnAgentOptions): Promise<Agent> {
    if (!this.client) throw new Error("Orchestrator not started");

    const isLead = opts.isLead ?? (this.state.getRoster().length === 0);
    const agentWorkDir = opts.workingDirectory ?? this.workingDirectory;

    // Resolve template early so we can extract model and prompt
    let resolved: import("./role-templates.js").ResolvedTemplate | null = null;
    if (opts.template) {
      resolved = resolveTemplate(opts.template, this.workingDirectory);
      if (resolved) {
        console.log(`📄 [${this.teamId}] Applied template "${resolved.name}" (${resolved.source}) to ${opts.id}`);
      }
    } else if (isLead) {
      // Auto-discover lead.md template
      resolved = resolveTemplate("lead", this.workingDirectory);
      if (resolved) {
        console.log(`📄 [${this.teamId}] Applied lead template (${resolved.source}) to ${opts.id}`);
      }
    }

    // Template model is the fallback if no explicit model was provided
    const model = opts.model ?? resolved?.model ?? "claude-opus-4.6";

    const tools = createTeamTools(this.state, opts.id, {
      eventBus: this,
      isLead,
      workingDirectory: this.workingDirectory,
      spawnAgent: isLead ? async (spawnOpts) => {
        await this.spawnAgent({
          id: spawnOpts.id,
          role: spawnOpts.role,
          model: spawnOpts.model,
          workingDirectory: spawnOpts.workingDirectory,
          template: spawnOpts.template,
        });
      } : undefined,
      completeMission: isLead ? (summary) => {
        this.completeMission(summary);
      } : undefined,
    });

    // Build system prompt: base prompt + optional template content
    let systemPrompt: string;
    if (opts.systemPrompt) {
      systemPrompt = opts.systemPrompt;
    } else if (isLead) {
      const templateContent = resolved?.content ?? "";
      systemPrompt = buildLeadPrompt(opts.id, opts.role, this.leadPrompt, templateContent, resolved?.promptMode);
    } else if (resolved && resolved.promptMode === "replace") {
      systemPrompt = resolved.content + `\n\n${COMMUNICATION_RULES}`;
    } else {
      const templateContent = resolved
        ? `\n\n## ROLE TEMPLATE: ${resolved.name} (${resolved.source})\n${resolved.content}`
        : "";
      systemPrompt = buildWorkerPrompt(opts.id, opts.role) + templateContent;
    }

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
      this.state.logToolCall(opts.id, event.data.toolName);
    });

    const agent: Agent = {
      id: opts.id,
      role: opts.role,
      model,
      status: "idle",
      currentTask: null,
      workingDirectory: agentWorkDir,
      waitingReason: null,
    };

    this.state.logActivity("agent.joined", opts.id, { role: opts.role, model, workingDirectory: agentWorkDir });
    this.emit("event", { type: "agent.joined", agent });
    console.log(`✅ [${this.teamId}] Spawned agent: ${opts.id} (${opts.role}, ${model}, dir: ${agentWorkDir})`);

    // If this is the first agent (lead) and a mission already exists, deliver it
    const roster = this.state.getRoster();
    if (roster.length === 1 && roster[0].id === opts.id) {
      const mission = this.state.getMission();
      if (mission) {
        await session.send({
          prompt: `[MISSION]: ${mission.text}\n\nDecompose this into tasks and delegate to your team. Use team_spawn_agent to create workers if needed.`,
        }).catch((err: unknown) => {
          console.error(`⚠️ [${this.teamId}] Failed to deliver mission to lead:`, err);
        });
      }
    }

    return agent;
  }

  async despawnAgent(id: string): Promise<void> {
    const session = this.state.getSession(id);
    if (session) {
      await session.disconnect().catch(() => {});
    }
    // Reset any in_progress tasks owned by this agent before removing them
    this.state.resetAgentTasks(id);
    this.state.deregisterAgent(id);
    this.state.logActivity("agent.left", id, {});
    this.emit("event", { type: "agent.left", agentId: id });
    console.log(`👋 [${this.teamId}] Despawned agent: ${id}`);
  }

  /** Send a user message to the lead */
  async sendMessage(content: string, from: string = "user"): Promise<Message> {
    const roster = this.state.getRoster();
    if (roster.length === 0) throw new Error("No agents on the team");

    // Auto-reset waiting status when lead receives a message
    const lead = roster[0];
    if (lead.status === "waiting") {
      this.state.setAgentStatus(lead.id, "idle", null, null);
      this.emit("event", { type: "agent.status", agentId: lead.id, status: "idle" as const, currentTask: null });
    }

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

    // Auto-reset waiting status when agent receives a DM
    const agent = this.state.getAgent(to);
    if (agent?.status === "waiting") {
      this.state.setAgentStatus(to, "idle", null, null);
      this.emit("event", { type: "agent.status", agentId: to, status: "idle" as const, currentTask: null });
    }

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
        }).catch((err: unknown) => {
          console.error(`⚠️ [${this.teamId}] Failed to deliver mission update to lead:`, err);
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

    // Disconnect all non-lead agents to stop burning tokens
    const roster = this.state.getRoster();
    for (const agent of roster) {
      const session = this.state.getSession(agent.id);
      if (!session) continue;
      if (agent.id === roster[0]?.id) {
        // Send the lead a final wrap-up, then disconnect
        session.send({
          prompt: `[MISSION COMPLETE]: ${summary}\n\nAll work is done. Do not send any more messages or call any tools. Session ending.`,
        }).catch((err: unknown) => {
          console.error(`⚠️ [${this.teamId}] Failed to send completion to lead:`, err);
        }).finally(() => session.disconnect());
      } else {
        session.disconnect().catch((err: unknown) => {
          console.error(`⚠️ [${this.teamId}] Failed to disconnect ${agent.id}:`, err);
        });
      }
    }
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
      waitingReason: a.waitingReason,
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
      waitingReason: a.waitingReason,
    };
  }

  getTasks(status?: string): Task[] {
    return this.state.getTasks(status).map((t) => {
      let dependsOn: string[] = [];
      try { dependsOn = JSON.parse(t.depends_on); } catch { /* corrupted dep data */ }
      return {
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        assignee: t.assignee,
        dependsOn,
        result: t.result,
        createdAt: t.created_at,
      };
    });
  }

  getMessages(limit: number = 50): Message[] {
    return this.state.getAllMessages(limit).map(toApiMessage);
  }

  getActivity(limit: number = 50): Activity[] {
    return this.state.getActivity(limit).map((a) => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(a.data); } catch { /* corrupted activity data */ }
      return {
        id: a.id,
        type: a.type,
        agentId: a.agent_id,
        data,
        timestamp: a.timestamp,
      };
    });
  }

  getToolCalls(agentId?: string, limit: number = 100) {
    return this.state.getToolCalls(agentId, limit);
  }

  createTask(id: string, title: string, description: string = "", dependsOn: string[] = [], assignee?: string): Task {
    const t = this.state.createTask(id, title, description, dependsOn, assignee);
    let parsedDeps: string[] = [];
    try { parsedDeps = JSON.parse(t.depends_on); } catch { /* safe fallback */ }
    const task: Task = {
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      assignee: t.assignee,
      dependsOn: parsedDeps,
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
