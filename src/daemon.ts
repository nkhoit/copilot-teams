import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { TeamRegistry } from "./team-registry.js";
import type { DaemonStatus } from "./types.js";

const CONFIG_DIR = join(homedir(), ".copilot-teams");
const DAEMON_JSON = join(CONFIG_DIR, "daemon.json");

export interface DaemonConfig {
  pid: number;
  port: number;
  started: string;
}

/**
 * Manages the daemon lifecycle: PID file, startup, shutdown.
 * The daemon is the top-level process that owns the CopilotClient and TeamRegistry.
 */
export class Daemon {
  private registry: TeamRegistry;
  private port: number;
  private startedAt: Date;

  constructor(options: { port?: number; baseDir?: string } = {}) {
    this.port = options.port ?? 3742;
    this.startedAt = new Date();

    const teamsDir = options.baseDir ?? join(CONFIG_DIR, "teams");
    this.registry = new TeamRegistry(teamsDir);
  }

  /** Write PID file so CLI can discover the daemon */
  writePidFile(): void {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const config: DaemonConfig = {
      pid: process.pid,
      port: this.port,
      started: this.startedAt.toISOString(),
    };
    writeFileSync(DAEMON_JSON, JSON.stringify(config, null, 2));
  }

  /** Remove PID file on shutdown */
  removePidFile(): void {
    if (existsSync(DAEMON_JSON)) {
      rmSync(DAEMON_JSON);
    }
  }

  /** Get daemon status for the API */
  getStatus(): DaemonStatus {
    return {
      pid: process.pid,
      port: this.port,
      uptime: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      started: this.startedAt.toISOString(),
      teams: this.registry.listTeams(),
    };
  }

  /** Get the TeamRegistry */
  getRegistry(): TeamRegistry {
    return this.registry;
  }

  /** Get port */
  getPort(): number {
    return this.port;
  }

  /** Graceful shutdown */
  async shutdown(): Promise<void> {
    console.log("\n🛑 Daemon shutting down...");
    await this.registry.stopAll();
    this.removePidFile();
    console.log("🛑 Daemon stopped");
  }

  /** Read daemon config from PID file (used by CLI) */
  static readDaemonConfig(): DaemonConfig | null {
    if (!existsSync(DAEMON_JSON)) return null;
    try {
      return JSON.parse(readFileSync(DAEMON_JSON, "utf-8"));
    } catch {
      return null;
    }
  }

  /** Check if a daemon is running */
  static isRunning(): boolean {
    const config = Daemon.readDaemonConfig();
    if (!config) return false;
    try {
      process.kill(config.pid, 0);
      return true;
    } catch {
      // Process doesn't exist — stale PID file
      rmSync(DAEMON_JSON, { force: true });
      return false;
    }
  }
}
