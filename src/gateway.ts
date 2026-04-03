import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Orchestrator } from "./orchestrator.js";
import type { ServerEvent, ClientCommand } from "./types.js";

const DEFAULT_PORT = 3742;

export function createGateway(orchestrator: Orchestrator) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();

  function broadcast(event: ServerEvent) {
    const data = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  orchestrator.on("event", (event: ServerEvent) => {
    broadcast(event);
  });

  // ── WebSocket handling ──────────────────────────────────────

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`🔌 WebSocket client connected (${clients.size} total)`);

    ws.on("message", async (raw) => {
      try {
        const cmd: ClientCommand = JSON.parse(raw.toString());
        switch (cmd.type) {
          case "message":
            await orchestrator.sendMessage(cmd.content);
            break;
          case "dm":
            await orchestrator.sendDM(cmd.to, cmd.content);
            break;
          case "mission.update":
            orchestrator.setMission(cmd.text);
            break;
          case "task.create":
            orchestrator.createTask(cmd.id, cmd.title, cmd.description, cmd.dependsOn, cmd.assignee);
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
      console.log(`🔌 WebSocket client disconnected (${clients.size} total)`);
    });
  });

  // ── REST: Health ────────────────────────────────────────────

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", started: orchestrator.isStarted() });
  });

  // ── REST: Team Status ───────────────────────────────────────

  app.get("/api/status", (_req, res) => {
    res.json({
      state: orchestrator.getTeamState(),
      mission: orchestrator.getMission(),
      agents: orchestrator.getAgents(),
      tasks: orchestrator.getTasks(),
    });
  });

  // ── REST: Agents ────────────────────────────────────────────

  app.get("/api/agents", (_req, res) => {
    res.json(orchestrator.getAgents());
  });

  app.get("/api/agents/:id", (req, res) => {
    const agent = orchestrator.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json(agent);
  });

  app.post("/api/agents", async (req, res) => {
    try {
      const { id, role, model, systemPrompt, workingDirectory } = req.body;
      if (!id || !role) {
        return res.status(400).json({ error: "id and role are required" });
      }
      const agent = await orchestrator.spawnAgent({
        id,
        role,
        model,
        isLead: orchestrator.getAgents().length === 0,
        systemPrompt,
        workingDirectory,
      });
      res.status(201).json(agent);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/agents/:id", async (req, res) => {
    try {
      await orchestrator.despawnAgent(req.params.id);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── REST: Messages ──────────────────────────────────────────

  app.get("/api/messages", (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(orchestrator.getMessages(limit));
  });

  app.post("/api/messages", async (req, res) => {
    try {
      const { content } = req.body;
      if (!content) return res.status(400).json({ error: "content is required" });
      const msg = await orchestrator.sendMessage(content);
      res.status(201).json(msg);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/dm/:agentId", async (req, res) => {
    try {
      const { content } = req.body;
      if (!content) return res.status(400).json({ error: "content is required" });
      const msg = await orchestrator.sendDM(req.params.agentId, content);
      res.status(201).json(msg);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── REST: Tasks ─────────────────────────────────────────────

  app.get("/api/tasks", (req, res) => {
    const status = req.query.status as string | undefined;
    res.json(orchestrator.getTasks(status));
  });

  app.post("/api/tasks", (req, res) => {
    try {
      const { id, title, description, dependsOn, assignee } = req.body;
      if (!id || !title) return res.status(400).json({ error: "id and title are required" });
      const task = orchestrator.createTask(id, title, description, dependsOn, assignee);
      res.status(201).json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── REST: Mission ───────────────────────────────────────────

  app.get("/api/mission", (_req, res) => {
    const mission = orchestrator.getMission();
    if (!mission) return res.status(404).json({ error: "No mission set" });
    res.json(mission);
  });

  app.put("/api/mission", (req, res) => {
    try {
      const { text } = req.body;
      if (!text) return res.status(400).json({ error: "text is required" });
      orchestrator.setMission(text);
      res.json(orchestrator.getMission());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── REST: Activity ──────────────────────────────────────────

  app.get("/api/activity", (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(orchestrator.getActivity(limit));
  });

  return { app, server, wss };
}

export async function startGateway(port: number = DEFAULT_PORT): Promise<void> {
  const orchestrator = new Orchestrator();

  console.log("⏳ Starting orchestrator...");
  await orchestrator.start();

  const { server } = createGateway(orchestrator);

  server.listen(port, () => {
    console.log(`\n🌐 Gateway running on http://localhost:${port}`);
    console.log(`   WebSocket: ws://localhost:${port}/ws`);
    console.log(`   REST API:  http://localhost:${port}/api\n`);
    console.log("Endpoints:");
    console.log("  GET    /api/health");
    console.log("  GET    /api/status");
    console.log("  GET    /api/agents");
    console.log("  POST   /api/agents         { id, role, model?, workingDirectory? }");
    console.log("  DELETE /api/agents/:id");
    console.log("  GET    /api/messages");
    console.log("  POST   /api/messages       { content }");
    console.log("  POST   /api/dm/:agentId    { content }");
    console.log("  GET    /api/tasks");
    console.log("  POST   /api/tasks          { id, title, description?, dependsOn?, assignee? }");
    console.log("  GET    /api/mission");
    console.log("  PUT    /api/mission         { text }");
    console.log("  GET    /api/activity");
    console.log("");
  });

  const shutdown = async () => {
    console.log("\n🛑 Shutting down...");
    await orchestrator.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
