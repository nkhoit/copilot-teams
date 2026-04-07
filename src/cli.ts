#!/usr/bin/env node

/**
 * cpt — thin REST client for the copilot-teams daemon.
 *
 * Usage:
 *   cpt daemon start [--port 3742]
 *   cpt daemon stop
 *   cpt daemon status
 *   cpt daemon install
 *   cpt daemon uninstall
 *   cpt daemon logs [--follow]
 *
 *   cpt team create <id> [--mission "..."] [--dir /path]
 *   cpt team list
 *   cpt team status <id>
 *   cpt team pause <id>
 *   cpt team resume <id>
 *   cpt team delete <id>
 *
 *   cpt mission get <team>
 *   cpt mission set <team> "text"
 *
 *   cpt agent list <team>
 *   cpt agent add <team> --id <id> --role "role" [--dir /path] [--model gpt-5]
 *   cpt agent remove <team> <agentId>
 *
 *   cpt send <team> "message"
 *   cpt dm <team> <agentId> "message"
 *
 *   cpt activity <team> [--limit 50]
 *   cpt tasks <team> [--status pending]
 */

import { Daemon } from "./daemon.js";

const BASE_URL_ENV = process.env.CPT_DAEMON_URL;

function getDaemonUrl(): string {
  if (BASE_URL_ENV) return BASE_URL_ENV;
  const config = Daemon.readDaemonConfig();
  if (!config) {
    console.error("❌ Daemon is not running. Start it with: cpt daemon start");
    process.exit(1);
  }
  return `http://localhost:${config.port}`;
}

async function request(method: string, path: string, body?: any): Promise<any> {
  const url = `${getDaemonUrl()}${path}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (res.status === 204) return null;

  const data = await res.json();
  if (!res.ok) {
    console.error(`❌ ${data.error ?? "Request failed"}`);
    process.exit(1);
  }
  return data;
}

function print(data: any): void {
  console.log(JSON.stringify(data, null, 2));
}

function usage(): never {
  console.log(`Usage: cpt <command> [options]

Commands:
  daemon start [--port N]              Start the daemon
  daemon stop                          Stop the daemon
  daemon status                        Daemon status
  daemon install                       Install as auto-start service
  daemon uninstall                     Uninstall the auto-start service
  daemon logs [--follow]               Show daemon log files

  team create <id> [--mission "..."] [--dir /path]
  team list                            List all teams
  team status <id>                     Team details
  team pause <id>                      Pause a team
  team resume <id>                     Resume a team
  team delete <id>                     Delete a team

  mission get <team>                   Get current mission
  mission set <team> "text"            Set/update mission

  agent list <team>                    List agents
  agent add <team> --id <id> --role "..." [--dir /path] [--model ...]
  agent remove <team> <agentId>        Remove an agent

  send <team> "message"                Send message to lead
  dm <team> <agentId> "message"        DM a specific agent

  activity <team> [--limit N]          Activity feed
  tasks <team> [--status ...]          List tasks`);
  process.exit(1);
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const [cmd, sub, ...rest] = args;

  switch (cmd) {
    // ── Daemon ─────────────────────────────────────────────
    case "daemon": {
      switch (sub) {
        case "start": {
          if (Daemon.isRunning()) {
            const config = Daemon.readDaemonConfig();
            console.log(`Daemon already running (PID ${config?.pid}, port ${config?.port})`);
            return;
          }
          const port = parseInt(parseFlag(args, "--port") ?? "3742", 10);
          // Dynamic import to start the gateway
          const { startGateway } = await import("./gateway.js");
          await startGateway(port);
          break;
        }
        case "stop": {
          const config = Daemon.readDaemonConfig();
          if (!config) {
            console.log("Daemon is not running.");
            return;
          }
          try {
            process.kill(config.pid, "SIGTERM");
            console.log(`Sent SIGTERM to daemon (PID ${config.pid})`);
          } catch {
            console.log("Daemon process not found. Cleaning up PID file.");
            new Daemon().removePidFile();
          }
          break;
        }
        case "status": {
          const data = await request("GET", "/api/daemon/status");
          print(data);
          break;
        }
        case "install": {
          const { install } = await import("./service.js");
          install();
          break;
        }
        case "uninstall": {
          const { uninstall } = await import("./service.js");
          uninstall();
          break;
        }
        case "logs": {
          const { getLogPaths } = await import("./service.js");
          const { existsSync, readFileSync } = await import("node:fs");
          const logs = getLogPaths();
          const follow = args.includes("--follow") || args.includes("-f");

          if (!existsSync(logs.stdout) && !existsSync(logs.stderr)) {
            console.error("❌ No log files found. Is the daemon installed?");
            console.error(`   Expected: ${logs.stdout}`);
            process.exit(1);
          }

          if (follow) {
            // tail -f both log files — replaces the process
            const files: string[] = [];
            if (existsSync(logs.stdout)) files.push(logs.stdout);
            if (existsSync(logs.stderr)) files.push(logs.stderr);
            const { spawn } = await import("node:child_process");
            const child = spawn("tail", ["-f", ...files], { stdio: "inherit" });
            child.on("exit", (code) => process.exit(code ?? 0));
          } else {
            if (existsSync(logs.stdout)) {
              console.log("── stdout ──────────────────────────────────");
              console.log(readFileSync(logs.stdout, "utf-8"));
            }
            if (existsSync(logs.stderr)) {
              console.log("── stderr ──────────────────────────────────");
              console.log(readFileSync(logs.stderr, "utf-8"));
            }
          }
          break;
        }
        default:
          usage();
      }
      break;
    }

    // ── Team ───────────────────────────────────────────────
    case "team": {
      switch (sub) {
        case "create": {
          const id = rest[0];
          if (!id) usage();
          const mission = parseFlag(args, "--mission");
          const dir = parseFlag(args, "--dir");
          const data = await request("POST", "/api/teams", {
            id,
            mission,
            workingDirectory: dir,
          });
          print(data);
          break;
        }
        case "list": {
          const data = await request("GET", "/api/teams");
          print(data);
          break;
        }
        case "status": {
          const id = rest[0];
          if (!id) usage();
          const data = await request("GET", `/api/teams/${id}`);
          print(data);
          break;
        }
        case "pause": {
          const id = rest[0];
          if (!id) usage();
          const data = await request("POST", `/api/teams/${id}/pause`);
          print(data);
          break;
        }
        case "resume": {
          const id = rest[0];
          if (!id) usage();
          const data = await request("POST", `/api/teams/${id}/resume`);
          print(data);
          break;
        }
        case "delete": {
          const id = rest[0];
          if (!id) usage();
          await request("DELETE", `/api/teams/${id}`);
          console.log(`Team "${id}" deleted.`);
          break;
        }
        default:
          usage();
      }
      break;
    }

    // ── Mission ────────────────────────────────────────────
    case "mission": {
      switch (sub) {
        case "get": {
          const team = rest[0];
          if (!team) usage();
          const data = await request("GET", `/api/teams/${team}/mission`);
          print(data);
          break;
        }
        case "set": {
          const team = rest[0];
          const text = rest[1];
          if (!team || !text) usage();
          const data = await request("PUT", `/api/teams/${team}/mission`, { text });
          print(data);
          break;
        }
        default:
          usage();
      }
      break;
    }

    // ── Agent ──────────────────────────────────────────────
    case "agent": {
      switch (sub) {
        case "list": {
          const team = rest[0];
          if (!team) usage();
          const data = await request("GET", `/api/teams/${team}/agents`);
          print(data);
          break;
        }
        case "add": {
          const team = rest[0];
          if (!team) usage();
          const id = parseFlag(args, "--id");
          const role = parseFlag(args, "--role");
          const dir = parseFlag(args, "--dir");
          const model = parseFlag(args, "--model");
          if (!id || !role) {
            console.error("❌ --id and --role are required");
            process.exit(1);
          }
          const data = await request("POST", `/api/teams/${team}/agents`, {
            id,
            role,
            workingDirectory: dir,
            model,
          });
          print(data);
          break;
        }
        case "remove": {
          const team = rest[0];
          const agentId = rest[1];
          if (!team || !agentId) usage();
          await request("DELETE", `/api/teams/${team}/agents/${agentId}`);
          console.log(`Agent "${agentId}" removed from team "${team}".`);
          break;
        }
        default:
          usage();
      }
      break;
    }

    // ── Send / DM ──────────────────────────────────────────
    case "send": {
      const team = sub;
      const message = rest[0];
      if (!team || !message) usage();
      const data = await request("POST", `/api/teams/${team}/messages`, { content: message });
      print(data);
      break;
    }

    case "dm": {
      const team = sub;
      const agentId = rest[0];
      const message = rest[1];
      if (!team || !agentId || !message) usage();
      const data = await request("POST", `/api/teams/${team}/dm/${agentId}`, { content: message });
      print(data);
      break;
    }

    // ── Activity / Tasks ───────────────────────────────────
    case "activity": {
      const team = sub;
      if (!team) usage();
      const limit = parseFlag(args, "--limit") ?? "50";
      const data = await request("GET", `/api/teams/${team}/activity?limit=${limit}`);
      print(data);
      break;
    }

    case "tasks": {
      const team = sub;
      if (!team) usage();
      const status = parseFlag(args, "--status");
      const query = status ? `?status=${status}` : "";
      const data = await request("GET", `/api/teams/${team}/tasks${query}`);
      print(data);
      break;
    }

    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
