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

    it("registers agent with workingDirectory", () => {
      const session = new MockCopilotSession();
      state.registerAgent("dev", "engineer", "gpt-5", session as any, "/src/backend");

      const agent = state.getAgent("dev");
      expect(agent).toBeDefined();
      expect(agent!.workingDirectory).toBe("/src/backend");
    });

    it("defaults workingDirectory to null", () => {
      const session = new MockCopilotSession();
      state.registerAgent("dev", "engineer", "gpt-5", session as any);

      const agent = state.getAgent("dev");
      expect(agent!.workingDirectory).toBeNull();
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

    it("roster includes workingDirectory", () => {
      const session = new MockCopilotSession();
      state.registerAgent("dev", "engineer", "gpt-5", session as any, "/src");

      const roster = state.getRoster();
      expect(roster[0].workingDirectory).toBe("/src");
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

    it("setSession replaces an existing session", () => {
      const s1 = new MockCopilotSession();
      const s2 = new MockCopilotSession();
      state.registerAgent("dev", "engineer", "gpt-5", s1 as any);
      state.setSession("dev", s2 as any);

      expect(state.getSession("dev")).toBe(s2);
    });
  });

  // ── Messages ──────────────────────────────────────────────

  describe("messages", () => {
    it("adds DMs (to_agent set, channel null)", () => {
      const msg = state.addMessage("lead", "hey dev", null, "dev");
      expect(msg.to_agent).toBe("dev");
      expect(msg.channel).toBeNull();
      expect(msg.from_agent).toBe("lead");
    });

    it("returns auto-incremented message IDs", () => {
      const m1 = state.addMessage("lead", "first", null, "dev");
      const m2 = state.addMessage("lead", "second", null, "dev");
      expect(m2.id).toBeGreaterThan(m1.id);
    });

    it("getDMs returns messages between two agents", () => {
      state.addMessage("lead", "hey dev", null, "dev");
      state.addMessage("dev", "hey lead", null, "lead");
      state.addMessage("lead", "follow up", null, "dev");

      const dms = state.getDMs("lead", "dev");
      expect(dms).toHaveLength(3);
    });

    it("getDMs excludes unrelated messages", () => {
      const s = new MockCopilotSession();
      state.registerAgent("other", "other", "gpt-5", s as any);

      state.addMessage("lead", "to dev", null, "dev");
      state.addMessage("lead", "to other", null, "other");
      state.addMessage("other", "to lead", null, "lead");

      const dms = state.getDMs("lead", "dev");
      expect(dms).toHaveLength(1);
    });

    it("getAllMessages returns all messages", () => {
      state.addMessage("lead", "msg1", null, "dev");
      state.addMessage("dev", "msg2", null, "lead");
      state.addMessage("lead", "msg3", "#general", null);

      const all = state.getAllMessages();
      expect(all).toHaveLength(3);
    });

    it("getAllMessages respects limit", () => {
      for (let i = 0; i < 10; i++) {
        state.addMessage("lead", `msg ${i}`, null, "dev");
      }
      const msgs = state.getAllMessages(3);
      expect(msgs).toHaveLength(3);
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

    it("resetAgentTasks resets in_progress tasks for a specific agent", () => {
      state.createTask("t1", "Task 1", "");
      state.createTask("t2", "Task 2", "");
      state.claimTask("t1", "dev1");
      state.claimTask("t2", "dev2");

      state.resetAgentTasks("dev1");

      const tasks = state.getTasks();
      const t1 = tasks.find((t) => t.id === "t1")!;
      const t2 = tasks.find((t) => t.id === "t2")!;
      expect(t1.status).toBe("pending");
      expect(t2.status).toBe("in_progress");
    });

    it("rejectTask re-blocks dependent tasks", () => {
      state.createTask("t1", "Task 1", "");
      state.createTask("t2", "Task 2", "", ["t1"]);
      state.claimTask("t1", "dev");
      state.completeTask("t1", "dev", "done");

      // t2 should now be pending (unblocked)
      let t2 = state.getTasks().find((t) => t.id === "t2")!;
      expect(t2.status).toBe("pending");

      // Reject t1 — t2 should go back to blocked
      state.rejectTask("t1", "needs rework");
      t2 = state.getTasks().find((t) => t.id === "t2")!;
      expect(t2.status).toBe("blocked");
    });
  });

  // ── Mission ───────────────────────────────────────────────

  describe("mission", () => {
    it("returns null when no mission set", () => {
      expect(state.getMission()).toBeNull();
    });

    it("sets and retrieves the current mission", () => {
      state.setMission("Build an auth system");
      const mission = state.getMission();
      expect(mission).toBeDefined();
      expect(mission!.text).toBe("Build an auth system");
    });

    it("updates mission and preserves history", () => {
      state.setMission("Build auth v1");
      state.setMission("Build auth v2 with OAuth");

      const current = state.getMission();
      expect(current!.text).toBe("Build auth v2 with OAuth");

      const history = state.getMissionHistory();
      expect(history).toHaveLength(2);
    });

    it("mission history is ordered by updated_at", () => {
      state.setMission("First");
      state.setMission("Second");
      state.setMission("Third");

      const history = state.getMissionHistory();
      expect(history).toHaveLength(3);
      expect(history[0].text).toBe("First");
      expect(history[2].text).toBe("Third");
    });
  });

  // ── Activity Log ──────────────────────────────────────────

  describe("activity", () => {
    it("logs and retrieves activity", () => {
      state.logActivity("test.event", "lead", { key: "value" });

      const activity = state.getActivity();
      expect(activity).toHaveLength(1);
      expect(activity[0].type).toBe("test.event");
      expect(activity[0].agent_id).toBe("lead");
      expect(JSON.parse(activity[0].data)).toEqual({ key: "value" });
    });

    it("auto-logs on DM creation", () => {
      state.addMessage("lead", "hello", null, "dev");

      const activity = state.getActivity();
      const dmActivity = activity.filter((a) => a.type === "dm.sent");
      expect(dmActivity).toHaveLength(1);
    });

    it("auto-logs on task creation", () => {
      state.createTask("t1", "Build API", "");

      const activity = state.getActivity();
      const taskActivity = activity.filter((a) => a.type === "task.created");
      expect(taskActivity).toHaveLength(1);
    });

    it("auto-logs on task claim", () => {
      state.createTask("t1", "Build API", "");
      const session = new MockCopilotSession();
      state.registerAgent("dev", "engineer", "gpt-5", session as any);
      state.claimTask("t1", "dev");

      const activity = state.getActivity();
      const claimActivity = activity.filter((a) => a.type === "task.claimed");
      expect(claimActivity).toHaveLength(1);
    });

    it("auto-logs on task completion", () => {
      state.createTask("t1", "Build API", "");
      const session = new MockCopilotSession();
      state.registerAgent("dev", "engineer", "gpt-5", session as any);
      state.claimTask("t1", "dev");
      state.completeTask("t1", "dev", "Done");

      const activity = state.getActivity();
      const completedActivity = activity.filter((a) => a.type === "task.completed");
      expect(completedActivity).toHaveLength(1);
    });

    it("respects limit", () => {
      for (let i = 0; i < 10; i++) {
        state.logActivity("test", null, { i });
      }
      const activity = state.getActivity(3);
      expect(activity).toHaveLength(3);
    });

    it("allows null agent_id", () => {
      state.logActivity("system.event", null, {});
      const activity = state.getActivity();
      expect(activity[0].agent_id).toBeNull();
    });
  });
});
