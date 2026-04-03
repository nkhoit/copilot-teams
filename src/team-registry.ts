import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Orchestrator } from "./orchestrator.js";
import type { OrchestratorOptions } from "./orchestrator.js";
import { AutonomyEngine } from "./autonomy-engine.js";
import type { CopilotClient } from "@github/copilot-sdk";
import type { TeamInfo, TeamStatus, ServerEvent, TeamStatusState } from "./types.js";

export interface TeamConfig {
  id: string;
  mission?: string;
  workingDirectory: string;
  leadPrompt?: string;
  createdAt: number;
}

/**
 * Manages multiple teams, each backed by its own Orchestrator and SQLite DB.
 * Emits all team events with teamId for WebSocket broadcasting.
 */
export class TeamRegistry extends EventEmitter {
  private teams: Map<string, Orchestrator> = new Map();
  private engines: Map<string, AutonomyEngine> = new Map();
  private client: CopilotClient | null = null;
  private baseDir: string;

  constructor(baseDir?: string) {
    super();
    this.baseDir = baseDir ?? join(homedir(), ".copilot-teams", "teams");
    mkdirSync(this.baseDir, { recursive: true });
  }

  /** Set the shared CopilotClient (called by daemon on startup) */
  setClient(client: CopilotClient): void {
    this.client = client;
  }

  /** Create a new team */
  async createTeam(config: TeamConfig): Promise<Orchestrator> {
    if (this.teams.has(config.id)) {
      throw new Error(`Team "${config.id}" already exists`);
    }

    const teamDir = join(this.baseDir, config.id);
    mkdirSync(teamDir, { recursive: true });

    const dbPath = join(teamDir, "state.db");

    const orchestratorOpts: OrchestratorOptions = {
      teamId: config.id,
      dbPath,
      workingDirectory: config.workingDirectory,
      leadPrompt: config.leadPrompt,
      client: this.client ?? undefined,
    };

    const orchestrator = new Orchestrator(orchestratorOpts);

    // If no shared client, start the orchestrator's own client
    if (!this.client) {
      await orchestrator.start();
    }

    // Forward orchestrator events with teamId
    orchestrator.on("event", (event: any) => {
      const enriched: ServerEvent = { ...event, teamId: config.id };
      this.emit("event", enriched);
    });

    this.teams.set(config.id, orchestrator);

    // Persist team config
    this.saveTeamConfig(config);

    if (config.mission) {
      orchestrator.setMission(config.mission);
    }

    // Start autonomy engine for this team
    const engine = new AutonomyEngine(orchestrator);
    engine.start();
    this.engines.set(config.id, engine);

    const teamInfo = this.getTeamInfo(config.id)!;
    this.emit("event", { type: "team.created", team: teamInfo } satisfies ServerEvent);
    console.log(`📦 Team created: ${config.id} (dir: ${config.workingDirectory})`);

    return orchestrator;
  }

  /** Get an orchestrator by team ID */
  getTeam(id: string): Orchestrator | undefined {
    return this.teams.get(id);
  }

  /** List all team summaries */
  listTeams(): TeamInfo[] {
    const result: TeamInfo[] = [];
    for (const [id, orch] of this.teams) {
      const info = this.getTeamInfo(id);
      if (info) result.push(info);
    }
    return result;
  }

  /** Get full team status */
  getTeamStatus(id: string): TeamStatus | undefined {
    const orch = this.teams.get(id);
    if (!orch) return undefined;
    return {
      id,
      state: orch.getTeamState(),
      mission: orch.getMission(),
      workingDirectory: orch.getWorkingDirectory(),
      agents: orch.getAgents(),
      tasks: orch.getTasks(),
      createdAt: orch.createdAt,
    };
  }

  /** Get team summary info */
  getTeamInfo(id: string): TeamInfo | undefined {
    const orch = this.teams.get(id);
    if (!orch) return undefined;
    return {
      id,
      state: orch.getTeamState(),
      mission: orch.getMission(),
      workingDirectory: orch.getWorkingDirectory(),
      agentCount: orch.getAgents().length,
      createdAt: orch.createdAt,
    };
  }

  /** Delete (shutdown) a team */
  async deleteTeam(id: string): Promise<void> {
    const orch = this.teams.get(id);
    if (!orch) throw new Error(`Team "${id}" not found`);

    // Stop autonomy engine first
    const engine = this.engines.get(id);
    if (engine) {
      engine.stop();
      this.engines.delete(id);
    }

    await orch.stop();
    this.teams.delete(id);

    // Remove config (keep DB for history)
    const configPath = join(this.baseDir, id, "config.json");
    if (existsSync(configPath)) {
      rmSync(configPath);
    }

    this.emit("event", { type: "team.deleted", teamId: id } satisfies ServerEvent);
    console.log(`🗑️  Team deleted: ${id}`);
  }

  /** Pause a team */
  pauseTeam(id: string): void {
    const orch = this.teams.get(id);
    if (!orch) throw new Error(`Team "${id}" not found`);

    const engine = this.engines.get(id);
    if (engine) engine.stop();

    orch.pause();
  }

  /** Resume a paused team */
  resumeTeam(id: string): void {
    const orch = this.teams.get(id);
    if (!orch) throw new Error(`Team "${id}" not found`);
    orch.resume();

    const engine = this.engines.get(id);
    if (engine) engine.start();
  }

  /** Stop all teams (called on daemon shutdown) — preserves state for resume */
  async stopAll(): Promise<void> {
    for (const [id] of this.teams) {
      try {
        await this.disconnectTeam(id);
      } catch (err) {
        console.error(`Error disconnecting team ${id}:`, err);
      }
    }
  }

  /**
   * Disconnect a team (graceful shutdown) — preserves config + DB for resume.
   * Unlike deleteTeam, this keeps config.json on disk so the team can be restored.
   */
  async disconnectTeam(id: string): Promise<void> {
    const engine = this.engines.get(id);
    if (engine) {
      engine.stop();
      this.engines.delete(id);
    }

    const orch = this.teams.get(id);
    if (orch) {
      await orch.disconnect();
      this.teams.delete(id);
    }
    console.log(`💤 Team disconnected: ${id} (state preserved)`);
  }

  /**
   * Restore all persisted teams after daemon restart.
   * Reads config.json files from disk, creates Orchestrators, resumes SDK sessions.
   */
  async restoreTeams(): Promise<number> {
    const configs = this.loadPersistedTeams();
    if (configs.length === 0) return 0;

    console.log(`♻️  Found ${configs.length} team(s) to restore...`);
    let restored = 0;

    for (const config of configs) {
      try {
        if (this.teams.has(config.id)) {
          console.warn(`⚠️ Team "${config.id}" already active, skipping restore`);
          continue;
        }

        const teamDir = join(this.baseDir, config.id);
        const dbPath = join(teamDir, "state.db");

        // Create orchestrator pointing at existing DB
        const orchestrator = new Orchestrator({
          teamId: config.id,
          dbPath,
          workingDirectory: config.workingDirectory,
          leadPrompt: config.leadPrompt,
          client: this.client ?? undefined,
        });

        // Restore agent sessions from DB
        if (this.client) {
          const agentsRestored = await orchestrator.restoreAgents(this.client);
          console.log(`♻️  Team "${config.id}": ${agentsRestored} agent(s) restored`);
        }

        // Forward orchestrator events with teamId
        orchestrator.on("event", (event: any) => {
          const enriched: ServerEvent = { ...event, teamId: config.id };
          this.emit("event", enriched);
        });

        this.teams.set(config.id, orchestrator);

        // Start autonomy engine
        const engine = new AutonomyEngine(orchestrator);
        engine.start();
        this.engines.set(config.id, engine);

        restored++;
        console.log(`♻️  Team restored: ${config.id}`);
      } catch (err) {
        console.error(`⚠️ Failed to restore team "${config.id}":`, err);
      }
    }

    console.log(`♻️  Restore complete: ${restored}/${configs.length} team(s)`);
    return restored;
  }

  /** Check if a team exists */
  hasTeam(id: string): boolean {
    return this.teams.has(id);
  }

  /** Get the number of active teams */
  get size(): number {
    return this.teams.size;
  }

  // ── Persistence ──────────────────────────────────────────────

  private saveTeamConfig(config: TeamConfig): void {
    const teamDir = join(this.baseDir, config.id);
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(
      join(teamDir, "config.json"),
      JSON.stringify(config, null, 2),
    );
  }

  /** Load persisted team configs (for crash recovery) */
  loadPersistedTeams(): TeamConfig[] {
    const configs: TeamConfig[] = [];
    if (!existsSync(this.baseDir)) return configs;

    for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const configPath = join(this.baseDir, entry.name, "config.json");
      if (existsSync(configPath)) {
        try {
          const raw = readFileSync(configPath, "utf-8");
          configs.push(JSON.parse(raw));
        } catch (err) {
          console.error(`Failed to load config for team ${entry.name}:`, err);
        }
      }
    }
    return configs;
  }
}
