import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Orchestrator } from "../orchestrator.js";
import { AutonomyEngine } from "../autonomy-engine.js";
import { MockCopilotSession } from "./mocks/copilot-sdk.js";

describe("AutonomyEngine", () => {
  let orchestrator: Orchestrator;
  let engine: AutonomyEngine;
  let leadSession: MockCopilotSession;

  beforeEach(() => {
    orchestrator = new Orchestrator({ teamId: "test-team" });
    engine = new AutonomyEngine(orchestrator);

    // Register a lead agent manually in the state DB
    leadSession = new MockCopilotSession();
    orchestrator.getTeamStateDb().registerAgent("lead", "team lead", "gpt-5", leadSession as any);
  });

  afterEach(() => {
    engine.stop();
  });

  // ── Start/Stop ────────────────────────────────────────────

  describe("lifecycle", () => {
    it("starts and stops cleanly", () => {
      engine.start();
      engine.stop();
      // No crash = pass
    });

    it("is idempotent on start", () => {
      engine.start();
      engine.start(); // no-op
      engine.stop();
    });

    it("is idempotent on stop", () => {
      engine.start();
      engine.stop();
      engine.stop(); // no-op
    });
  });

  // ── Task Completed Nudge ──────────────────────────────────

  describe("task completed nudge", () => {
    it("nudges lead when a task is completed", async () => {
      // Create tasks so we go through the "remaining work" branch
      orchestrator.getTeamStateDb().createTask("t1", "Task 1", "");
      orchestrator.getTeamStateDb().createTask("t2", "Task 2", "");
      orchestrator.getTeamStateDb().registerAgent("dev", "engineer", "gpt-5", new MockCopilotSession() as any);
      orchestrator.getTeamStateDb().claimTask("t1", "dev");
      orchestrator.getTeamStateDb().completeTask("t1", "dev", "API endpoint created");

      engine.start();

      // Emit a task.completed event
      orchestrator.emit("event", {
        type: "task.completed",
        taskId: "t1",
        agentId: "dev",
        result: "API endpoint created",
      });

      // Give event handler time to run
      await new Promise((r) => setTimeout(r, 50));

      expect(leadSession.hasMessageContaining("[AUTONOMY ENGINE]")).toBe(true);
      expect(leadSession.hasMessageContaining("t1")).toBe(true);
    });

    it("nudges about all tasks complete when they are", async () => {
      // Create and complete all tasks
      orchestrator.getTeamStateDb().createTask("t1", "Task 1", "");
      orchestrator.getTeamStateDb().registerAgent("dev", "engineer", "gpt-5", new MockCopilotSession() as any);
      orchestrator.getTeamStateDb().claimTask("t1", "dev");
      orchestrator.getTeamStateDb().completeTask("t1", "dev", "Done");

      engine.start();

      orchestrator.emit("event", {
        type: "task.completed",
        taskId: "t1",
        agentId: "dev",
        result: "Done",
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(leadSession.hasMessageContaining("All tasks")).toBe(true);
    });
  });

  // ── Deadlock Detection ────────────────────────────────────

  describe("deadlock detection", () => {
    it("detects deadlock when all agents idle + tasks pending", async () => {
      // Create a pending task
      orchestrator.getTeamStateDb().createTask("t1", "Task 1", "");

      engine.start();

      // Emit agent going idle
      orchestrator.emit("event", {
        type: "agent.status",
        agentId: "lead",
        status: "idle",
        currentTask: null,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(leadSession.hasMessageContaining("Deadlock")).toBe(true);
    });

    it("does not fire deadlock when no tasks exist", async () => {
      engine.start();

      orchestrator.emit("event", {
        type: "agent.status",
        agentId: "lead",
        status: "idle",
        currentTask: null,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(leadSession.hasMessageContaining("Deadlock")).toBe(false);
    });
  });

  // ── Team State Interactions ───────────────────────────────

  describe("team state", () => {
    it("does not nudge when team is paused", async () => {
      engine.start();
      orchestrator.pause();

      orchestrator.emit("event", {
        type: "task.completed",
        taskId: "t1",
        agentId: "dev",
        result: "Done",
      });

      await new Promise((r) => setTimeout(r, 50));

      // Should have no autonomy nudges (only pause-related messages may exist)
      expect(leadSession.hasMessageContaining("[AUTONOMY ENGINE]")).toBe(false);
    });

    it("nudges on team resume", async () => {
      engine.start();
      orchestrator.pause();
      leadSession.clearMessages();

      orchestrator.resume();
      // team.state_changed event is emitted by orchestrator.resume()

      await new Promise((r) => setTimeout(r, 50));

      expect(leadSession.hasMessageContaining("Team resumed")).toBe(true);
    });

    it("stops on mission completed", async () => {
      engine.start();

      orchestrator.emit("event", {
        type: "mission.completed",
        summary: "All done",
      });

      await new Promise((r) => setTimeout(r, 50));

      // Engine should have stopped — subsequent events should not trigger nudges
      leadSession.clearMessages();

      orchestrator.emit("event", {
        type: "task.completed",
        taskId: "t2",
        agentId: "dev",
        result: "More work",
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(leadSession.hasMessageContaining("[AUTONOMY ENGINE]")).toBe(false);
    });
  });

  // ── No Agents Edge Case ───────────────────────────────────

  describe("edge cases", () => {
    it("handles no agents gracefully", async () => {
      const emptyOrch = new Orchestrator({ teamId: "empty" });
      const emptyEngine = new AutonomyEngine(emptyOrch);
      emptyEngine.start();

      // Should not crash
      emptyOrch.emit("event", {
        type: "task.completed",
        taskId: "t1",
        agentId: "dev",
        result: "Done",
      });

      await new Promise((r) => setTimeout(r, 50));
      emptyEngine.stop();
    });
  });
});
