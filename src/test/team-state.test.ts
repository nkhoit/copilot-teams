import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TeamState } from "../team-state.js";
import { MockCopilotSession } from "./mocks/copilot-sdk.js";

describe("TeamState", () => {
  let state: TeamState;

  beforeEach(() => {
    state = new TeamState(":memory:");
  });

  afterEach(() => {
    state.close();
  });

  // ── Agent Management ──────────────────────────────────────

  describe("agents", () => {
    it("registers and retrieves an agent", () => {
      const session = new MockCopilotSession();
      state.registerAgent("lead", "team lead", "claude-sonnet-4", session as any);

      const agent = state.getAgent("lead");
      expect(agent).toBeDefined();
      expect(agent!.id).toBe("lead");
      expect(agent!.role).toBe("team lead");
      expect(agent!.model).toBe("claude-sonnet-4");
      expect(agent!.status).toBe("idle");
    });

    it("returns undefined for unknown agent", () => {
      expect(state.getAgent("nonexistent")).toBeUndefined();
    });

    it("returns the full roster", () => {
      const s1 = new MockCopilotSession();
      const s2 = new MockCopilotSession();
      state.registerAgent("lead", "team lead", "gpt-5", s1 as any);
      state.registerAgent("dev", "engineer", "claude-sonnet-4", s2 as any);

      const roster = state.getRoster();
      expect(roster).toHaveLength(2);
      expect(roster.map((a) => a.id).sort()).toEqual(["dev", "lead"]);
    });

    it("deregisters an agent", () => {
      const session = new MockCopilotSession();
      state.registerAgent("lead", "team lead", "gpt-5", session as any);
      state.deregisterAgent("lead");

      expect(state.getAgent("lead")).toBeUndefined();
      expect(state.getSession("lead")).toBeUndefined();
    });

    it("tracks sessions separately from DB", () => {
      const session = new MockCopilotSession();
      state.registerAgent("lead", "team lead", "gpt-5", session as any);

      expect(state.getSession("lead")).toBe(session);
      expect(state.getAllSessions().size).toBe(1);
    });

    it("updates agent status", () => {
      const session = new MockCopilotSession();
      state.registerAgent("dev", "engineer", "gpt-5", session as any);

      state.setAgentStatus("dev", "working", "task-1");
      const agent = state.getAgent("dev");
      expect(agent!.status).toBe("working");
    });
  });

  // ── Messages ──────────────────────────────────────────────

  describe("messages", () => {
    it("adds and retrieves channel messages", () => {
      state.addMessage("lead", "hello team", "#general", null);
      state.addMessage("dev", "hi lead", "#general", null);

      const messages = state.getChannelMessages("#general");
      expect(messages).toHaveLength(2);
      const agents = messages.map((m) => m.from_agent).sort();
      expect(agents).toEqual(["dev", "lead"]);
    });

    it("adds DMs (to_agent set, channel null)", () => {
      const msg = state.addMessage("lead", "hey dev", null, "dev");
      expect(msg.to_agent).toBe("dev");
      expect(msg.channel).toBeNull();
      expect(msg.from_agent).toBe("lead");
    });

    it("respects limit on channel messages", () => {
      for (let i = 0; i < 10; i++) {
        state.addMessage("lead", `message ${i}`, "#general", null);
      }
      const messages = state.getChannelMessages("#general", 3);
      expect(messages).toHaveLength(3);
    });

    it("returns auto-incremented message IDs", () => {
      const m1 = state.addMessage("lead", "first", "#general", null);
      const m2 = state.addMessage("lead", "second", "#general", null);
      expect(m2.id).toBeGreaterThan(m1.id);
    });
  });

  // ── Volley Counter ────────────────────────────────────────

  describe("volley counter", () => {
    it("starts at zero", () => {
      expect(state.getVolleyCount("alice", "bob")).toBe(0);
    });

    it("increments and tracks correctly", () => {
      expect(state.incrementVolley("alice", "bob")).toBe(1);
      expect(state.incrementVolley("alice", "bob")).toBe(2);
      expect(state.getVolleyCount("alice", "bob")).toBe(2);
    });

    it("is symmetric (alice→bob same as bob→alice)", () => {
      state.incrementVolley("alice", "bob");
      expect(state.getVolleyCount("bob", "alice")).toBe(1);
    });

    it("resets for a specific agent", () => {
      state.incrementVolley("alice", "bob");
      state.incrementVolley("alice", "charlie");
      state.resetVolley("alice");

      expect(state.getVolleyCount("alice", "bob")).toBe(0);
      expect(state.getVolleyCount("alice", "charlie")).toBe(0);
    });

    it("reset doesn't affect unrelated pairs", () => {
      state.incrementVolley("alice", "bob");
      state.incrementVolley("charlie", "dave");
      state.resetVolley("alice");

      expect(state.getVolleyCount("charlie", "dave")).toBe(1);
    });
  });

  // ── Tasks ─────────────────────────────────────────────────

  describe("tasks", () => {
    it("creates a pending task", () => {
      const task = state.createTask("task-1", "Build API", "Build the REST API");
      expect(task.id).toBe("task-1");
      expect(task.status).toBe("pending");
      expect(task.assignee).toBeNull();
    });

    it("creates a blocked task when dependencies exist", () => {
      state.createTask("dep-1", "Prerequisite", "");
      const task = state.createTask("task-1", "Build API", "", ["dep-1"]);
      expect(task.status).toBe("blocked");
    });

    it("claims a pending task", () => {
      state.createTask("task-1", "Build API", "");
      const session = new MockCopilotSession();
      state.registerAgent("dev", "engineer", "gpt-5", session as any);

      const result = state.claimTask("task-1", "dev");
      expect(result.success).toBe(true);

      const agent = state.getAgent("dev");
      expect(agent!.status).toBe("working");
    });

    it("rejects claiming a blocked task", () => {
      state.createTask("dep-1", "Prerequisite", "");
      state.createTask("task-1", "Build API", "", ["dep-1"]);

      const result = state.claimTask("task-1", "dev");
      expect(result.success).toBe(false);
      expect(result.reason).toContain("blocked");
    });

    it("rejects claiming an already claimed task", () => {
      state.createTask("task-1", "Build API", "");
      const s1 = new MockCopilotSession();
      const s2 = new MockCopilotSession();
      state.registerAgent("dev1", "engineer", "gpt-5", s1 as any);
      state.registerAgent("dev2", "engineer", "gpt-5", s2 as any);

      state.claimTask("task-1", "dev1");
      const result = state.claimTask("task-1", "dev2");
      expect(result.success).toBe(false);
      expect(result.reason).toContain("dev1");
    });

    it("rejects claiming a nonexistent task", () => {
      const result = state.claimTask("nope", "dev");
      expect(result.success).toBe(false);
      expect(result.reason).toContain("not found");
    });

    it("completes a task and unblocks dependents", () => {
      state.createTask("dep-1", "Prerequisite", "");
      state.createTask("task-1", "Build API", "", ["dep-1"], "dev");

      const session = new MockCopilotSession();
      state.registerAgent("lead", "lead", "gpt-5", session as any);
      state.claimTask("dep-1", "lead");

      const outcome = state.completeTask("dep-1", "lead", "Done");
      expect(outcome.completed).toBe(true);
      expect(outcome.unblocked).toHaveLength(1);
      expect(outcome.unblocked[0].id).toBe("task-1");
      expect(outcome.unblocked[0].status).toBe("pending");
    });

    it("completes a task and sets agent to idle", () => {
      state.createTask("task-1", "Build API", "");
      const session = new MockCopilotSession();
      state.registerAgent("dev", "engineer", "gpt-5", session as any);
      state.claimTask("task-1", "dev");

      state.completeTask("task-1", "dev", "All done");
      const agent = state.getAgent("dev");
      expect(agent!.status).toBe("idle");
    });

    it("does not unblock when not all deps are done", () => {
      state.createTask("dep-1", "First", "");
      state.createTask("dep-2", "Second", "");
      state.createTask("task-1", "Build API", "", ["dep-1", "dep-2"]);

      const session = new MockCopilotSession();
      state.registerAgent("lead", "lead", "gpt-5", session as any);
      state.claimTask("dep-1", "lead");

      const outcome = state.completeTask("dep-1", "lead", "Done");
      expect(outcome.unblocked).toHaveLength(0);

      const task = state.getTasks().find((t) => t.id === "task-1");
      expect(task!.status).toBe("blocked");
    });

    it("filters tasks by status", () => {
      state.createTask("t1", "Task 1", "");
      state.createTask("t2", "Task 2", "");
      state.createTask("t3", "Task 3", "", ["t1"]);

      expect(state.getTasks("pending")).toHaveLength(2);
      expect(state.getTasks("blocked")).toHaveLength(1);
      expect(state.getTasks("done")).toHaveLength(0);
    });

    it("gets unblocked (pending + unassigned) tasks", () => {
      state.createTask("t1", "Task 1", "");
      state.createTask("t2", "Task 2", "", [], "dev");
      state.createTask("t3", "Task 3", "", ["t1"]);

      const unblocked = state.getUnblockedTasks();
      expect(unblocked).toHaveLength(1);
      expect(unblocked[0].id).toBe("t1");
    });
  });
});
