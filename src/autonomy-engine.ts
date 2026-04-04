import { Orchestrator } from "./orchestrator.js";

const HEARTBEAT_ACTIVE_MS = 2 * 60 * 1000; // 2 minutes when work is active
const HEARTBEAT_IDLE_MS = 10 * 60 * 1000;  // 10 minutes when idle
const IDLE_AGENT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes before nudging about idle agent

/**
 * Autonomy Engine — drives the team forward via event-driven nudges
 * and a periodic heartbeat safety net.
 *
 * Listens to orchestrator events and sends contextual nudges to the lead
 * when action is needed. Stops when team is paused or completed.
 */
export class AutonomyEngine {
  private orchestrator: Orchestrator;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastActivityAt: number = Date.now();

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
  }

  /** Start listening for events and begin heartbeat */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastActivityAt = Date.now();

    this.orchestrator.on("event", this.handleEvent);
    this.scheduleHeartbeat();
    console.log(`🧠 [${this.orchestrator.teamId}] Autonomy engine started`);
  }

  /** Stop all nudges and heartbeat */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.orchestrator.off("event", this.handleEvent);
    this.clearHeartbeat();
    console.log(`🧠 [${this.orchestrator.teamId}] Autonomy engine stopped`);
  }

  private handleEvent = (event: any): void => {
    if (!this.running) return;
    const state = this.orchestrator.getTeamState();
    if (state !== "active") return;

    this.lastActivityAt = Date.now();

    switch (event.type) {
      case "task.completed":
        this.onTaskCompleted(event.taskId, event.agentId, event.result)
          .catch((err) => console.error(`⚠️ [${this.orchestrator.teamId}] Autonomy nudge failed:`, err));
        break;
      case "task.unblocked":
        this.checkAllTasksDone()
          .catch((err) => console.error(`⚠️ [${this.orchestrator.teamId}] Autonomy nudge failed:`, err));
        break;
      case "agent.status":
        if (event.status === "idle") {
          this.checkDeadlock()
            .catch((err) => console.error(`⚠️ [${this.orchestrator.teamId}] Autonomy nudge failed:`, err));
        }
        break;
      case "team.state_changed":
        if (event.state === "active") {
          this.onTeamResumed()
            .catch((err) => console.error(`⚠️ [${this.orchestrator.teamId}] Autonomy nudge failed:`, err));
        } else if (event.state === "paused") {
          this.clearHeartbeat();
        }
        break;
      case "mission.completed":
        this.stop();
        break;
    }
  };

  // ── Event-Driven Nudges ─────────────────────────────────

  private async onTaskCompleted(taskId: string, agentId: string, result: string): Promise<void> {
    const tasks = this.orchestrator.getTasks();
    const allDone = tasks.length > 0 && tasks.every((t) => t.status === "done");

    if (allDone) {
      await this.nudgeLead(
        `All tasks are now complete. Review results and declare mission complete with team_complete_mission if the objective is fulfilled.`,
      );
    } else {
      const pending = tasks.filter((t) => t.status === "pending");
      const blocked = tasks.filter((t) => t.status === "blocked");
      await this.nudgeLead(
        `Task "${taskId}" completed by ${agentId}. Result: ${result.slice(0, 200)}. ` +
        `Remaining: ${pending.length} pending, ${blocked.length} blocked. ` +
        `Assign pending tasks to idle agents or create new tasks if needed.`,
      );
    }
  }

  private async checkAllTasksDone(): Promise<void> {
    const tasks = this.orchestrator.getTasks();
    if (tasks.length > 0 && tasks.every((t) => t.status === "done")) {
      await this.nudgeLead(
        `All tasks are complete. Is the mission fulfilled? If yes, call team_complete_mission. If not, create more tasks.`,
      );
    }
  }

  private async checkDeadlock(): Promise<void> {
    const agents = this.orchestrator.getAgents();
    const tasks = this.orchestrator.getTasks();

    const allIdle = agents.every((a) => a.status === "idle");
    const hasPendingWork = tasks.some((t) => t.status === "pending" || t.status === "blocked");

    if (allIdle && hasPendingWork && tasks.length > 0) {
      const pending = tasks.filter((t) => t.status === "pending");
      const blocked = tasks.filter((t) => t.status === "blocked");
      await this.nudgeLead(
        `⚠️ Deadlock detected: all agents are idle but work remains. ` +
        `${pending.length} pending tasks, ${blocked.length} blocked tasks. ` +
        `Assign pending tasks to agents, spawn new workers, or unblock tasks.`,
      );
    }
  }

  private async onTeamResumed(): Promise<void> {
    if (!this.running) {
      this.start();
    }
    this.scheduleHeartbeat();
    await this.nudgeLead(
      `Team resumed. Review the current state of tasks and agents, then take action. ` +
      `Use team_get_tasks and team_get_roster to assess the situation.`,
    );
  }

  // ── Heartbeat ───────────────────────────────────────────

  private scheduleHeartbeat(): void {
    this.clearHeartbeat();
    if (!this.running) return;

    const interval = this.isWorkActive() ? HEARTBEAT_ACTIVE_MS : HEARTBEAT_IDLE_MS;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeat().catch((err) =>
        console.error(`⚠️ [${this.orchestrator.teamId}] Heartbeat failed:`, err),
      );
    }, interval);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async heartbeat(): Promise<void> {
    if (!this.running) return;
    const state = this.orchestrator.getTeamState();
    if (state !== "active") {
      this.clearHeartbeat();
      return;
    }

    const agents = this.orchestrator.getAgents();
    const tasks = this.orchestrator.getTasks();

    const working = agents.filter((a) => a.status === "working");
    const idle = agents.filter((a) => a.status === "idle");
    const pending = tasks.filter((t) => t.status === "pending");
    const inProgress = tasks.filter((t) => t.status === "in_progress");
    const done = tasks.filter((t) => t.status === "done");
    const blocked = tasks.filter((t) => t.status === "blocked");

    const summary =
      `📊 Status: ${agents.length} agents (${working.length} working, ${idle.length} idle), ` +
      `${tasks.length} tasks (${pending.length} pending, ${inProgress.length} in-progress, ${blocked.length} blocked, ${done.length} done).`;

    if (idle.length > 0 && pending.length > 0) {
      await this.nudgeLead(
        `${summary} Idle agents could work on pending tasks. Assign them or take action.`,
      );
    } else if (tasks.length > 0 && tasks.every((t) => t.status === "done")) {
      await this.nudgeLead(
        `${summary} All tasks are done. Is the mission complete?`,
      );
    }
    // If nothing actionable, stay quiet (don't burn tokens)

    this.scheduleHeartbeat();
  }

  private isWorkActive(): boolean {
    const agents = this.orchestrator.getAgents();
    return agents.some((a) => a.status === "working");
  }

  // ── Nudge Helper ────────────────────────────────────────

  private async nudgeLead(message: string): Promise<void> {
    const roster = this.orchestrator.getAgents();
    if (roster.length === 0) return;

    const leadId = roster[0].id;
    const state = this.orchestrator.getTeamStateDb();
    const leadSession = state.getSession(leadId);
    if (!leadSession) return;

    console.log(`🧠 [${this.orchestrator.teamId}] Nudge → ${leadId}: ${message.slice(0, 100)}...`);
    await leadSession.send({
      prompt: `[AUTONOMY ENGINE]: ${message}`,
    }).catch((err: unknown) => {
      console.error(`⚠️ [${this.orchestrator.teamId}] Failed to nudge lead:`, err);
    });
  }
}
