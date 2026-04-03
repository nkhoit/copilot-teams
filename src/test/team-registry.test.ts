import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TeamRegistry } from "../team-registry.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("TeamRegistry", () => {
  let registry: TeamRegistry;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cpt-test-"));
    registry = new TeamRegistry(tempDir);
  });

  afterEach(async () => {
    await registry.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Team CRUD ─────────────────────────────────────────────

  describe("team CRUD", () => {
    it("creates a team", async () => {
      const orch = await registry.createTeam({
        id: "alpha",
        workingDirectory: "/tmp/alpha",
        createdAt: Date.now(),
      });

      expect(orch).toBeDefined();
      expect(orch.teamId).toBe("alpha");
      expect(registry.hasTeam("alpha")).toBe(true);
      expect(registry.size).toBe(1);
    });

    it("rejects duplicate team IDs", async () => {
      await registry.createTeam({
        id: "alpha",
        workingDirectory: "/tmp/alpha",
        createdAt: Date.now(),
      });

      await expect(
        registry.createTeam({
          id: "alpha",
          workingDirectory: "/tmp/alpha2",
          createdAt: Date.now(),
        }),
      ).rejects.toThrow("already exists");
    });

    it("lists all teams", async () => {
      await registry.createTeam({ id: "alpha", workingDirectory: "/tmp/a", createdAt: Date.now() });
      await registry.createTeam({ id: "beta", workingDirectory: "/tmp/b", createdAt: Date.now() });

      const teams = registry.listTeams();
      expect(teams).toHaveLength(2);
      expect(teams.map((t) => t.id).sort()).toEqual(["alpha", "beta"]);
    });

    it("gets team info", async () => {
      await registry.createTeam({
        id: "alpha",
        workingDirectory: "/tmp/alpha",
        mission: "Build something",
        createdAt: Date.now(),
      });

      const info = registry.getTeamInfo("alpha");
      expect(info).toBeDefined();
      expect(info!.id).toBe("alpha");
      expect(info!.state).toBe("active");
      expect(info!.agentCount).toBe(0);
      expect(info!.mission).toBeDefined();
      expect(info!.mission!.text).toBe("Build something");
    });

    it("gets full team status", async () => {
      await registry.createTeam({
        id: "alpha",
        workingDirectory: "/tmp/alpha",
        createdAt: Date.now(),
      });

      const status = registry.getTeamStatus("alpha");
      expect(status).toBeDefined();
      expect(status!.id).toBe("alpha");
      expect(status!.agents).toEqual([]);
      expect(status!.tasks).toEqual([]);
    });

    it("returns undefined for unknown team", () => {
      expect(registry.getTeam("nope")).toBeUndefined();
      expect(registry.getTeamInfo("nope")).toBeUndefined();
      expect(registry.getTeamStatus("nope")).toBeUndefined();
    });

    it("deletes a team", async () => {
      await registry.createTeam({ id: "alpha", workingDirectory: "/tmp/a", createdAt: Date.now() });
      await registry.deleteTeam("alpha");

      expect(registry.hasTeam("alpha")).toBe(false);
      expect(registry.size).toBe(0);
    });

    it("throws when deleting unknown team", async () => {
      await expect(registry.deleteTeam("nope")).rejects.toThrow("not found");
    });
  });

  // ── Team Lifecycle ────────────────────────────────────────

  describe("lifecycle", () => {
    it("pauses and resumes a team", async () => {
      await registry.createTeam({ id: "alpha", workingDirectory: "/tmp/a", createdAt: Date.now() });

      registry.pauseTeam("alpha");
      expect(registry.getTeamInfo("alpha")!.state).toBe("paused");

      registry.resumeTeam("alpha");
      expect(registry.getTeamInfo("alpha")!.state).toBe("active");
    });

    it("throws when pausing unknown team", () => {
      expect(() => registry.pauseTeam("nope")).toThrow("not found");
    });

    it("throws when resuming unknown team", () => {
      expect(() => registry.resumeTeam("nope")).toThrow("not found");
    });
  });

  // ── Events ────────────────────────────────────────────────

  describe("events", () => {
    it("emits team.created event", async () => {
      const events: any[] = [];
      registry.on("event", (e) => events.push(e));

      await registry.createTeam({
        id: "alpha",
        workingDirectory: "/tmp/a",
        createdAt: Date.now(),
      });

      const created = events.find((e) => e.type === "team.created");
      expect(created).toBeDefined();
      expect(created.team.id).toBe("alpha");
    });

    it("emits team.deleted event", async () => {
      await registry.createTeam({ id: "alpha", workingDirectory: "/tmp/a", createdAt: Date.now() });

      const events: any[] = [];
      registry.on("event", (e) => events.push(e));

      await registry.deleteTeam("alpha");

      const deleted = events.find((e) => e.type === "team.deleted");
      expect(deleted).toBeDefined();
      expect(deleted.teamId).toBe("alpha");
    });

    it("emits team.state_changed on pause/resume", async () => {
      await registry.createTeam({ id: "alpha", workingDirectory: "/tmp/a", createdAt: Date.now() });

      const events: any[] = [];
      registry.on("event", (e) => events.push(e));

      registry.pauseTeam("alpha");
      registry.resumeTeam("alpha");

      const stateChanges = events.filter((e) => e.type === "team.state_changed");
      expect(stateChanges).toHaveLength(2);
      expect(stateChanges[0].state).toBe("paused");
      expect(stateChanges[1].state).toBe("active");
    });

    it("forwards orchestrator events with teamId", async () => {
      const orch = await registry.createTeam({
        id: "alpha",
        workingDirectory: "/tmp/a",
        createdAt: Date.now(),
      });

      const events: any[] = [];
      registry.on("event", (e) => events.push(e));

      // Simulate an orchestrator event
      orch.emit("event", { type: "agent.joined", agent: { id: "lead", role: "lead", model: "gpt-5", status: "idle", currentTask: null, workingDirectory: null } });

      const forwarded = events.find((e) => e.type === "agent.joined");
      expect(forwarded).toBeDefined();
      expect(forwarded.teamId).toBe("alpha");
    });
  });

  // ── Persistence ───────────────────────────────────────────

  describe("persistence", () => {
    it("persists team config to disk", async () => {
      await registry.createTeam({
        id: "alpha",
        workingDirectory: "/tmp/alpha",
        mission: "Test mission",
        createdAt: 1234567890,
      });

      const configs = registry.loadPersistedTeams();
      expect(configs).toHaveLength(1);
      expect(configs[0].id).toBe("alpha");
      expect(configs[0].workingDirectory).toBe("/tmp/alpha");
    });

    it("loads configs from a fresh registry", async () => {
      await registry.createTeam({
        id: "alpha",
        workingDirectory: "/tmp/alpha",
        createdAt: Date.now(),
      });
      await registry.createTeam({
        id: "beta",
        workingDirectory: "/tmp/beta",
        createdAt: Date.now(),
      });

      // Create a new registry pointing to the same dir
      const registry2 = new TeamRegistry(tempDir);
      const configs = registry2.loadPersistedTeams();
      expect(configs).toHaveLength(2);
      expect(configs.map((c) => c.id).sort()).toEqual(["alpha", "beta"]);
    });
  });

  // ── Multi-Team Isolation ──────────────────────────────────

  describe("isolation", () => {
    it("teams have independent state", async () => {
      const orchA = await registry.createTeam({ id: "alpha", workingDirectory: "/tmp/a", createdAt: Date.now() });
      const orchB = await registry.createTeam({ id: "beta", workingDirectory: "/tmp/b", createdAt: Date.now() });

      // Create task on alpha only
      orchA.createTask("t1", "Alpha task", "");

      expect(orchA.getTasks()).toHaveLength(1);
      expect(orchB.getTasks()).toHaveLength(0);
    });

    it("each team has its own working directory", async () => {
      await registry.createTeam({ id: "alpha", workingDirectory: "/project/frontend", createdAt: Date.now() });
      await registry.createTeam({ id: "beta", workingDirectory: "/project/backend", createdAt: Date.now() });

      expect(registry.getTeam("alpha")!.getWorkingDirectory()).toBe("/project/frontend");
      expect(registry.getTeam("beta")!.getWorkingDirectory()).toBe("/project/backend");
    });
  });
});
