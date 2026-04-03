import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Daemon } from "./daemon.js";
import { TeamRegistry } from "./team-registry.js";
import type { ServerEvent, ClientCommand } from "./types.js";

const DEFAULT_PORT = 3742;

export function createGateway(daemon: Daemon) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  const registry = daemon.getRegistry();

  // Track WebSocket clients and their team subscriptions
  const clients = new Map<WebSocket, string | null>(); // null = all teams

  function broadcast(event: ServerEvent) {
    const data = JSON.stringify(event);
    const teamId = "teamId" in event ? (event as any).teamId : null;

    for (const [ws, filter] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      // Send if client subscribes to all teams (null) or this specific team
      if (filter === null || filter === teamId) {
        ws.send(data);
      }
    }
  }

  // Pipe registry events to WebSocket clients
  registry.on("event", (event: ServerEvent) => {
    broadcast(event);
  });

  // ── WebSocket handling ──────────────────────────────────────

  wss.on("connection", (ws, req) => {
    // Parse ?team=<id> from query string
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const teamFilter = url.searchParams.get("team");
    clients.set(ws, teamFilter);
    console.log(`🔌 WebSocket connected (team=${teamFilter ?? "all"}, ${clients.size} total)`);

    ws.on("message", async (raw) => {
      try {
        const cmd: ClientCommand = JSON.parse(raw.toString());
        const orch = registry.getTeam(cmd.teamId);
        if (!orch) {
          ws.send(JSON.stringify({ type: "error", message: `Team "${cmd.teamId}" not found` }));
          return;
        }

        switch (cmd.type) {
          case "message":
            await orch.sendMessage(cmd.content);
            break;
          case "dm":
            await orch.sendDM(cmd.to, cmd.content);
            break;
          case "mission.update":
            orch.setMission(cmd.text);
            break;
          case "task.create":
            orch.createTask(cmd.id, cmd.title, cmd.description, cmd.dependsOn, cmd.assignee);
            break;
          default:
            ws.send(JSON.stringify({ type: "error", message: `Unknown command: ${(cmd as any).type}` }));
        }
      } catch (err: any) {
        ws.send(JSON.stringify({ type: "error", message: err.message }));
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`🔌 WebSocket disconnected (${clients.size} total)`);
    });
  });

  // ── REST: Health & Daemon ──────────────────────────────────

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/daemon/status", (_req, res) => {
    res.json(daemon.getStatus());
  });

  // ── REST: Teams CRUD ──────────────────────────────────────

  app.get("/api/teams", (_req, res) => {
    res.json(registry.listTeams());
  });

  app.post("/api/teams", async (req, res) => {
    try {
      const { id, mission, workingDirectory, leadPrompt } = req.body;
      if (!id) return res.status(400).json({ error: "id is required" });

      await registry.createTeam({
        id,
        mission,
        workingDirectory: workingDirectory ?? process.cwd(),
        leadPrompt,
        createdAt: Date.now(),
      });

      res.status(201).json(registry.getTeamStatus(id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/teams/:teamId", (req, res) => {
    const status = registry.getTeamStatus(req.params.teamId);
    if (!status) return res.status(404).json({ error: "Team not found" });
    res.json(status);
  });

  app.delete("/api/teams/:teamId", async (req, res) => {
    try {
      await registry.deleteTeam(req.params.teamId);
      res.status(204).send();
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  app.post("/api/teams/:teamId/pause", (req, res) => {
    try {
      registry.pauseTeam(req.params.teamId);
      res.json({ state: "paused" });
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  app.post("/api/teams/:teamId/resume", (req, res) => {
    try {
      registry.resumeTeam(req.params.teamId);
      res.json({ state: "active" });
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  // ── Middleware: resolve team orchestrator ───────────────────

  function resolveTeam(req: express.Request, res: express.Response, next: express.NextFunction) {
    const teamId = req.params.teamId as string;
    const orch = registry.getTeam(teamId);
    if (!orch) return res.status(404).json({ error: `Team "${teamId}" not found` });
    (req as any).orchestrator = orch;
    next();
  }

  // ── REST: Per-Team Agents ──────────────────────────────────

  app.get("/api/teams/:teamId/agents", resolveTeam, (req, res) => {
    res.json((req as any).orchestrator.getAgents());
  });

  app.get("/api/teams/:teamId/agents/:agentId", resolveTeam, (req, res) => {
    const agent = (req as any).orchestrator.getAgent(req.params.agentId);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json(agent);
  });

  app.post("/api/teams/:teamId/agents", resolveTeam, async (req, res) => {
    try {
      const orch = (req as any).orchestrator;
      const { id, role, model, systemPrompt, workingDirectory } = req.body;
      if (!id || !role) return res.status(400).json({ error: "id and role are required" });
      const agent = await orch.spawnAgent({
        id,
        role,
        model,
        isLead: orch.getAgents().length === 0,
        systemPrompt,
        workingDirectory,
      });
      res.status(201).json(agent);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/teams/:teamId/agents/:agentId", resolveTeam, async (req, res) => {
    try {
      await (req as any).orchestrator.despawnAgent(req.params.agentId);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── REST: Per-Team Messages ────────────────────────────────

  app.get("/api/teams/:teamId/messages", resolveTeam, (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    res.json((req as any).orchestrator.getMessages(limit));
  });

  app.post("/api/teams/:teamId/messages", resolveTeam, async (req, res) => {
    try {
      const { content } = req.body;
      if (!content) return res.status(400).json({ error: "content is required" });
      const msg = await (req as any).orchestrator.sendMessage(content);
      res.status(201).json(msg);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/teams/:teamId/dm/:agentId", resolveTeam, async (req, res) => {
    try {
      const { content } = req.body;
      if (!content) return res.status(400).json({ error: "content is required" });
      const msg = await (req as any).orchestrator.sendDM(req.params.agentId, content);
      res.status(201).json(msg);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── REST: Per-Team Tasks ───────────────────────────────────

  app.get("/api/teams/:teamId/tasks", resolveTeam, (req, res) => {
    const status = req.query.status as string | undefined;
    res.json((req as any).orchestrator.getTasks(status));
  });

  app.post("/api/teams/:teamId/tasks", resolveTeam, (req, res) => {
    try {
      const { id, title, description, dependsOn, assignee } = req.body;
      if (!id || !title) return res.status(400).json({ error: "id and title are required" });
      const task = (req as any).orchestrator.createTask(id, title, description, dependsOn, assignee);
      res.status(201).json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── REST: Per-Team Mission ─────────────────────────────────

  app.get("/api/teams/:teamId/mission", resolveTeam, (_req, res) => {
    const mission = (_req as any).orchestrator.getMission();
    if (!mission) return res.status(404).json({ error: "No mission set" });
    res.json(mission);
  });

  app.put("/api/teams/:teamId/mission", resolveTeam, (req, res) => {
    try {
      const { text } = req.body;
      if (!text) return res.status(400).json({ error: "text is required" });
      (req as any).orchestrator.setMission(text);
      res.json((req as any).orchestrator.getMission());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── REST: Per-Team Activity ────────────────────────────────

  app.get("/api/teams/:teamId/activity", resolveTeam, (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    res.json((req as any).orchestrator.getActivity(limit));
  });

  return { app, server, wss };
}

export async function startGateway(port: number = DEFAULT_PORT): Promise<void> {
  const daemon = new Daemon({ port });

  // Check if another daemon is running
  if (Daemon.isRunning()) {
    const existing = Daemon.readDaemonConfig();
    console.error(`❌ Another daemon is already running (PID ${existing?.pid}, port ${existing?.port})`);
    process.exit(1);
  }

  daemon.writePidFile();

  const { server } = createGateway(daemon);

  server.listen(port, () => {
    console.log(`\n🌐 Daemon running on http://localhost:${port}`);
    console.log(`   WebSocket: ws://localhost:${port}/ws`);
    console.log(`   REST API:  http://localhost:${port}/api\n`);
    console.log("Endpoints:");
    console.log("  GET    /api/health");
    console.log("  GET    /api/daemon/status");
    console.log("  POST   /api/teams               { id, mission?, workingDirectory? }");
    console.log("  GET    /api/teams");
    console.log("  GET    /api/teams/:id");
    console.log("  DELETE /api/teams/:id");
    console.log("  POST   /api/teams/:id/pause");
    console.log("  POST   /api/teams/:id/resume");
    console.log("  POST   /api/teams/:id/agents     { id, role, model?, workingDirectory? }");
    console.log("  DELETE /api/teams/:id/agents/:agentId");
    console.log("  POST   /api/teams/:id/messages   { content }");
    console.log("  POST   /api/teams/:id/dm/:agentId { content }");
    console.log("  GET    /api/teams/:id/tasks");
    console.log("  POST   /api/teams/:id/tasks      { id, title, description?, dependsOn? }");
    console.log("  GET    /api/teams/:id/mission");
    console.log("  PUT    /api/teams/:id/mission     { text }");
    console.log("  GET    /api/teams/:id/activity");
    console.log("");
  });

  const shutdown = async () => {
    await daemon.shutdown();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
