import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TeamState } from "../team-state.js";
import { createTeamTools } from "../team-tools.js";
import { MockCopilotSession } from "./mocks/copilot-sdk.js";

/**
 * Integration tests for team tools.
 * Uses real TeamState (SQLite in-memory) with MockCopilotSessions.
 */
describe("Team Tools", () => {
  let state: TeamState;
  let leadSession: MockCopilotSession;
  let devSession: MockCopilotSession;

  beforeEach(() => {
    state = new TeamState(":memory:");
    leadSession = new MockCopilotSession();
    devSession = new MockCopilotSession();
    state.registerAgent("lead", "team lead", "claude-sonnet-4", leadSession as any);
    state.registerAgent("dev", "engineer", "claude-sonnet-4", devSession as any);
  });

  afterEach(() => {
    state.close();
  });

  function getToolHandler(agentId: string, toolName: string, options?: { isLead?: boolean; spawnAgent?: any; completeMission?: any }) {
    const tools = createTeamTools(state, agentId, {
      isLead: options?.isLead,
      spawnAgent: options?.spawnAgent,
      completeMission: options?.completeMission,
    });
    const tool = tools.find((t: any) => t.name === toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);
    return (tool as any).handler;
  }

  function getToolNames(agentId: string, options?: { isLead?: boolean; spawnAgent?: any; completeMission?: any }): string[] {
    const tools = createTeamTools(state, agentId, {
      isLead: options?.isLead,
      spawnAgent: options?.spawnAgent,
      completeMission: options?.completeMission,
    });
    return tools.map((t: any) => t.name);
  }

  // ── Tool availability ─────────────────────────────────────

  describe("tool availability", () => {
    it("worker agents get 6 base tools", () => {
      const names = getToolNames("dev");
      expect(names).toContain("team_dm");
      expect(names).toContain("team_get_roster");
      expect(names).toContain("team_create_task");
      expect(names).toContain("team_get_tasks");
      expect(names).toContain("team_claim_task");
      expect(names).toContain("team_complete_task");
      expect(names).not.toContain("team_spawn_agent");
      expect(names).not.toContain("team_complete_mission");
    });

    it("lead agents get spawn + complete_mission tools when callbacks provided", () => {
      const spawnFn = async () => {};
      const completeFn = () => {};
      const names = getToolNames("lead", { isLead: true, spawnAgent: spawnFn, completeMission: completeFn });
      expect(names).toContain("team_spawn_agent");
      expect(names).toContain("team_complete_mission");
    });

    it("lead without callbacks does not get spawn/complete tools", () => {
      const names = getToolNames("lead", { isLead: true });
      expect(names).not.toContain("team_spawn_agent");
      expect(names).not.toContain("team_complete_mission");
    });

    it("does NOT include team_send (removed)", () => {
      const names = getToolNames("lead");
      expect(names).not.toContain("team_send");
    });
  });

  // ── team_dm ───────────────────────────────────────────────

  describe("team_dm", () => {
    it("delivers a DM to the recipient session", async () => {
      const handler = getToolHandler("lead", "team_dm");
      const result = await handler({ to: "dev", message: "hello dev", expectsReply: true });

      expect(result.sent).toBe(true);
      expect(devSession.hasMessageContaining("hello dev")).toBe(true);
      expect(devSession.hasMessageContaining("[DM from lead]")).toBe(true);
    });

    it("records the message in SQLite as a DM", async () => {
      const handler = getToolHandler("lead", "team_dm");
      await handler({ to: "dev", message: "stored message", expectsReply: true });

      const dms = state.getDMs("lead", "dev");
      expect(dms).toHaveLength(1);
      expect(dms[0].content).toBe("stored message");
    });

    it("tags NO REPLY NEEDED when expectsReply is false", async () => {
      const handler = getToolHandler("lead", "team_dm");
      await handler({ to: "dev", message: "fyi only", expectsReply: false });

      expect(devSession.hasMessageContaining("[NO REPLY NEEDED]")).toBe(true);
    });

    it("does not tag when expectsReply is true", async () => {
      const handler = getToolHandler("lead", "team_dm");
      await handler({ to: "dev", message: "question?", expectsReply: true });

      expect(devSession.hasMessageContaining("[NO REPLY NEEDED]")).toBe(false);
    });

    it("returns error for unknown recipient", async () => {
      const handler = getToolHandler("lead", "team_dm");
      const result = await handler({ to: "nobody", message: "hello", expectsReply: true });

      expect(result.error).toBeDefined();
      expect(result.error).toContain("nobody");
    });

    it("blocks after MAX_VOLLEY consecutive DMs", async () => {
      const handler = getToolHandler("lead", "team_dm");

      await handler({ to: "dev", message: "msg 1", expectsReply: true });
      await handler({ to: "dev", message: "msg 2", expectsReply: true });
      await handler({ to: "dev", message: "msg 3", expectsReply: true });

      const result = await handler({ to: "dev", message: "msg 4", expectsReply: true });
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("Volley limit");
    });
  });

  // ── team_get_roster ───────────────────────────────────────

  describe("team_get_roster", () => {
    it("returns all registered agents", async () => {
      const handler = getToolHandler("lead", "team_get_roster");
      const result = await handler({});

      expect(result).toHaveLength(2);
      expect(result.map((a: any) => a.id).sort()).toEqual(["dev", "lead"]);
    });
  });

  // ── team_create_task ──────────────────────────────────────

  describe("team_create_task", () => {
    it("creates a pending task", async () => {
      const handler = getToolHandler("lead", "team_create_task");
      const result = await handler({
        id: "task-1",
        title: "Build API",
        description: "Build the REST API",
        dependsOn: [],
      });

      expect(result.id).toBe("task-1");
      expect(result.status).toBe("pending");
    });

    it("creates a blocked task with dependencies", async () => {
      const createHandler = getToolHandler("lead", "team_create_task");
      await createHandler({ id: "dep-1", title: "Prerequisite", description: "", dependsOn: [] });
      const result = await createHandler({
        id: "task-1",
        title: "Build API",
        description: "",
        dependsOn: ["dep-1"],
      });

      expect(result.status).toBe("blocked");
    });

    it("notifies assignee via session.send()", async () => {
      const handler = getToolHandler("lead", "team_create_task");
      await handler({
        id: "task-1",
        title: "Build API",
        description: "Build the REST API",
        dependsOn: [],
        assignee: "dev",
      });

      expect(devSession.hasMessageContaining("[TASK ASSIGNED]")).toBe(true);
      expect(devSession.hasMessageContaining("Build API")).toBe(true);
    });
  });

  // ── team_get_tasks ────────────────────────────────────────

  describe("team_get_tasks", () => {
    it("returns all tasks", async () => {
      state.createTask("t1", "Task 1", "");
      state.createTask("t2", "Task 2", "");

      const handler = getToolHandler("lead", "team_get_tasks");
      const result = await handler({});
      expect(result).toHaveLength(2);
    });

    it("filters by status", async () => {
      state.createTask("t1", "Task 1", "");
      state.createTask("t2", "Task 2", "", ["t1"]);

      const handler = getToolHandler("lead", "team_get_tasks");
      const pending = await handler({ status: "pending" });
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe("t1");
    });
  });

  // ── team_claim_task ───────────────────────────────────────

  describe("team_claim_task", () => {
    it("claims a pending task", async () => {
      state.createTask("task-1", "Build API", "");
      const handler = getToolHandler("dev", "team_claim_task");
      const result = await handler({ taskId: "task-1" });

      expect(result.success).toBe(true);
      expect(state.getAgent("dev")!.status).toBe("working");
    });

    it("resets volley counter on claim", async () => {
      state.createTask("task-1", "Build API", "");

      state.incrementVolley("dev", "lead");
      state.incrementVolley("dev", "lead");
      expect(state.getVolleyCount("dev", "lead")).toBe(2);

      const handler = getToolHandler("dev", "team_claim_task");
      await handler({ taskId: "task-1" });

      expect(state.getVolleyCount("dev", "lead")).toBe(0);
    });
  });

  // ── team_complete_task ────────────────────────────────────

  describe("team_complete_task", () => {
    it("completes a task and notifies about unblocked tasks", async () => {
      state.createTask("dep-1", "Prerequisite", "");
      state.createTask("task-1", "Build API", "", ["dep-1"], "dev");
      state.claimTask("dep-1", "lead");

      const handler = getToolHandler("lead", "team_complete_task");
      const result = await handler({ taskId: "dep-1", result: "Done" });

      expect(result.completed).toBe(true);
      expect(result.unblocked).toHaveLength(1);

      expect(devSession.hasMessageContaining("[TASK UNBLOCKED]")).toBe(true);
    });

    it("resets volley counter on completion", async () => {
      state.createTask("task-1", "Build API", "");
      state.claimTask("task-1", "dev");

      state.incrementVolley("dev", "lead");
      expect(state.getVolleyCount("dev", "lead")).toBe(1);

      const handler = getToolHandler("dev", "team_complete_task");
      await handler({ taskId: "task-1", result: "All done" });

      expect(state.getVolleyCount("dev", "lead")).toBe(0);
    });
  });

  // ── team_spawn_agent (lead-only) ──────────────────────────

  describe("team_spawn_agent", () => {
    it("calls the spawn callback with the provided options", async () => {
      let spawnedWith: any = null;
      const spawnFn = async (opts: any) => { spawnedWith = opts; };

      const handler = getToolHandler("lead", "team_spawn_agent", {
        isLead: true,
        spawnAgent: spawnFn,
      });

      const result = await handler({
        id: "backend",
        role: "Backend engineer",
        workingDirectory: "/src/api",
        model: "gpt-5",
      });

      expect(result.spawned).toBe(true);
      expect(result.id).toBe("backend");
      expect(spawnedWith).toEqual({
        id: "backend",
        role: "Backend engineer",
        workingDirectory: "/src/api",
        model: "gpt-5",
      });
    });

    it("returns error when spawn fails", async () => {
      const spawnFn = async () => { throw new Error("Max agents reached"); };

      const handler = getToolHandler("lead", "team_spawn_agent", {
        isLead: true,
        spawnAgent: spawnFn,
      });

      const result = await handler({ id: "x", role: "test" });
      expect(result.error).toContain("Max agents reached");
    });
  });

  // ── team_complete_mission (lead-only) ─────────────────────

  describe("team_complete_mission", () => {
    it("calls the completion callback with summary", async () => {
      let completedSummary: string | null = null;
      const completeFn = (summary: string) => { completedSummary = summary; };

      const handler = getToolHandler("lead", "team_complete_mission", {
        isLead: true,
        completeMission: completeFn,
      });

      const result = await handler({ summary: "All tasks done, auth module refactored" });

      expect(result.completed).toBe(true);
      expect(completedSummary).toBe("All tasks done, auth module refactored");
    });
  });

  // ── team_request_input ──────────────────────────────────

  describe("team_request_input", () => {
    it("sets agent status to waiting with reason", async () => {
      const handler = getToolHandler("lead", "team_request_input");
      const result = await handler({ reason: "Please review the task plan before I spawn workers" });

      expect(result.waiting).toBe(true);
      expect(result.reason).toContain("review the task plan");

      const agent = state.getAgent("lead");
      expect(agent!.status).toBe("waiting");
      expect(agent!.waitingReason).toContain("review the task plan");
    });

    it("is available to all agents, not just lead", () => {
      const workerTools = getToolNames("dev");
      expect(workerTools).toContain("team_request_input");
    });

    it("logs activity when waiting", async () => {
      const handler = getToolHandler("lead", "team_request_input");
      await handler({ reason: "Need approval" });

      const activity = state.getActivity(10);
      const waitingActivity = activity.find((a) => a.type === "agent.waiting");
      expect(waitingActivity).toBeDefined();
    });
  });

  // ── team_reject_task (lead-only) ────────────────────────

  describe("team_reject_task", () => {
    it("rejects a completed task and moves it back to pending", async () => {
      state.createTask("task-1", "Build API", "");
      state.claimTask("task-1", "dev");
      state.completeTask("task-1", "dev", "Done but buggy");

      const handler = getToolHandler("lead", "team_reject_task", {
        isLead: true,
        spawnAgent: async () => {},
        completeMission: () => {},
      });

      const result = await handler({ taskId: "task-1", feedback: "Tests are failing, fix the edge cases" });

      expect(result.rejected).toBe(true);

      const task = state.getTasks().find((t) => t.id === "task-1");
      expect(task!.status).toBe("pending");
      expect(task!.assignee).toBe("dev");
      expect(task!.result).toBeNull();
    });

    it("returns error for non-done tasks", async () => {
      state.createTask("task-1", "Build API", "");

      const handler = getToolHandler("lead", "team_reject_task", {
        isLead: true,
        spawnAgent: async () => {},
        completeMission: () => {},
      });

      const result = await handler({ taskId: "task-1", feedback: "Bad work" });
      expect(result.error).toBeDefined();
    });

    it("is only available to the lead", () => {
      const workerTools = getToolNames("dev");
      expect(workerTools).not.toContain("team_reject_task");

      const leadTools = getToolNames("lead", {
        isLead: true,
        spawnAgent: async () => {},
        completeMission: () => {},
      });
      expect(leadTools).toContain("team_reject_task");
    });

    it("logs rejection in activity feed", async () => {
      state.createTask("task-1", "Build API", "");
      state.claimTask("task-1", "dev");
      state.completeTask("task-1", "dev", "Done");

      const handler = getToolHandler("lead", "team_reject_task", {
        isLead: true,
        spawnAgent: async () => {},
        completeMission: () => {},
      });

      await handler({ taskId: "task-1", feedback: "Needs more tests" });

      const activity = state.getActivity(10);
      const rejected = activity.find((a) => a.type === "task.rejected");
      expect(rejected).toBeDefined();
    });
  });

  // ── Lead claim/complete guards ───────────────────────────

  describe("lead task guards", () => {
    it("lead cannot claim a task assigned to another agent", async () => {
      state.createTask("t1", "Dev task", "work", [], "dev");
      const handler = getToolHandler("lead", "team_claim_task", { isLead: true });
      const result = await handler({ taskId: "t1" });
      expect(result.success).toBe(false);
      expect(result.reason).toContain("assigned to dev");
    });

    it("lead CAN claim an unassigned task", async () => {
      state.createTask("t2", "Lead task", "coord work");
      const handler = getToolHandler("lead", "team_claim_task", { isLead: true });
      const result = await handler({ taskId: "t2" });
      expect(result.success).toBe(true);
    });

    it("lead cannot complete a task claimed by another agent", async () => {
      state.createTask("t3", "Dev task", "work");
      state.claimTask("t3", "dev");
      const handler = getToolHandler("lead", "team_complete_task", { isLead: true });
      const result = await handler({ taskId: "t3", result: "done" });
      expect(result.success).toBe(false);
      expect(result.reason).toContain("claimed by dev");
    });

    it("worker can still claim/complete their own assigned tasks", async () => {
      state.createTask("t4", "Dev task", "work", [], "dev");
      const claimHandler = getToolHandler("dev", "team_claim_task");
      const claimResult = await claimHandler({ taskId: "t4" });
      expect(claimResult.success).toBe(true);

      const completeHandler = getToolHandler("dev", "team_complete_task");
      const completeResult = await completeHandler({ taskId: "t4", result: "done" });
      expect(completeResult.unblocked).toBeDefined();
    });
  });
});
