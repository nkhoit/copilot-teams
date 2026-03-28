import Database from "better-sqlite3";
import type { CopilotSession } from "@github/copilot-sdk";

export interface AgentInfo {
  id: string;
  role: string;
  model: string;
  status: "idle" | "working";
  currentTask: string | null;
}

export interface TeamMessage {
  id: number;
  from_agent: string;
  to_agent: string | null;
  channel: string | null;
  content: string;
  timestamp: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: "pending" | "blocked" | "in_progress" | "done";
  assignee: string | null;
  depends_on: string; // JSON array
  result: string | null;
  created_at: number;
}

export class TeamState {
  private db: Database.Database;
  // Sessions live in-memory (not serializable)
  private sessions: Map<string, CopilotSession> = new Map();
  // Volley counter for anti-ping-pong
  private volleyCounts: Map<string, number> = new Map();

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'gpt-5',
        status TEXT NOT NULL DEFAULT 'idle',
        current_task TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT,
        channel TEXT,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        assignee TEXT,
        depends_on TEXT NOT NULL DEFAULT '[]',
        result TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );
    `);
  }

  // --- Agent Management ---

  registerAgent(id: string, role: string, model: string, session: CopilotSession): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO agents (id, role, model, status) VALUES (?, ?, ?, 'idle')",
    ).run(id, role, model);
    this.sessions.set(id, session);
  }

  deregisterAgent(id: string): void {
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    this.sessions.delete(id);
  }

  getAgent(id: string): AgentInfo | undefined {
    return this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentInfo | undefined;
  }

  getRoster(): AgentInfo[] {
    return this.db.prepare("SELECT * FROM agents").all() as AgentInfo[];
  }

  getSession(id: string): CopilotSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): Map<string, CopilotSession> {
    return this.sessions;
  }

  setAgentStatus(id: string, status: "idle" | "working", currentTask?: string | null): void {
    this.db.prepare(
      "UPDATE agents SET status = ?, current_task = ? WHERE id = ?",
    ).run(status, currentTask ?? null, id);
  }

  // --- Messages ---

  addMessage(from: string, content: string, channel: string | null, to: string | null): TeamMessage {
    const stmt = this.db.prepare(
      "INSERT INTO messages (from_agent, to_agent, channel, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    const timestamp = Date.now();
    const result = stmt.run(from, to, channel, content, timestamp);
    return {
      id: result.lastInsertRowid as number,
      from_agent: from,
      to_agent: to,
      channel,
      content,
      timestamp,
    };
  }

  getChannelMessages(channel: string, limit: number = 50): TeamMessage[] {
    return this.db.prepare(
      "SELECT * FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?",
    ).all(channel, limit) as TeamMessage[];
  }

  // --- Volley Counter (anti-ping-pong) ---

  private volleyKey(a: string, b: string): string {
    return [a, b].sort().join(":");
  }

  getVolleyCount(from: string, to: string): number {
    return this.volleyCounts.get(this.volleyKey(from, to)) ?? 0;
  }

  incrementVolley(from: string, to: string): number {
    const key = this.volleyKey(from, to);
    const count = (this.volleyCounts.get(key) ?? 0) + 1;
    this.volleyCounts.set(key, count);
    return count;
  }

  resetVolley(agentId: string): void {
    for (const [key] of this.volleyCounts) {
      if (key.includes(agentId)) {
        this.volleyCounts.set(key, 0);
      }
    }
  }

  // --- Tasks ---

  createTask(
    id: string,
    title: string,
    description: string,
    dependsOn: string[] = [],
    assignee?: string,
  ): Task {
    const status = dependsOn.length > 0 ? "blocked" : "pending";
    this.db.prepare(
      "INSERT INTO tasks (id, title, description, status, assignee, depends_on) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, title, description, status, assignee ?? null, JSON.stringify(dependsOn));

    return {
      id,
      title,
      description,
      status,
      assignee: assignee ?? null,
      depends_on: JSON.stringify(dependsOn),
      result: null,
      created_at: Date.now(),
    };
  }

  claimTask(taskId: string, agentId: string): { success: boolean; reason?: string } {
    // Use atomic UPDATE with WHERE conditions to prevent race conditions
    // This only updates if the task is still in 'pending' status
    const result = this.db.prepare(`
      UPDATE tasks 
      SET status = 'in_progress', assignee = ? 
      WHERE id = ? AND status = 'pending'
    `).run(agentId, taskId);

    if (result.changes === 0) {
      // Task wasn't updated - check why
      const task = this.db.prepare("SELECT status, assignee FROM tasks WHERE id = ?").get(taskId) as { status: string; assignee: string | null } | undefined;
      if (!task) return { success: false, reason: "Task not found" };
      if (task.status === "blocked") return { success: false, reason: "Task is blocked by dependencies" };
      if (task.status === "in_progress") return { success: false, reason: `Task already claimed by ${task.assignee}` };
      if (task.status === "done") return { success: false, reason: "Task already completed" };
      return { success: false, reason: "Failed to claim task" };
    }

    this.setAgentStatus(agentId, "working", taskId);
    return { success: true };
  }

  completeTask(taskId: string, agentId: string, result: string): {
    completed: boolean;
    unblocked: Task[];
  } {
    this.db.prepare(
      "UPDATE tasks SET status = 'done', result = ? WHERE id = ? AND assignee = ?",
    ).run(result, taskId, agentId);
    this.setAgentStatus(agentId, "idle", null);

    // Find and unblock tasks that depended on this one
    const unblocked: Task[] = [];
    const blockedTasks = this.db.prepare(
      "SELECT * FROM tasks WHERE status = 'blocked'",
    ).all() as Task[];

    for (const task of blockedTasks) {
      const deps: string[] = JSON.parse(task.depends_on);
      const allDone = deps.every((depId) => {
        const dep = this.db.prepare("SELECT status FROM tasks WHERE id = ?").get(depId) as { status: string } | undefined;
        return dep?.status === "done";
      });

      if (allDone) {
        this.db.prepare("UPDATE tasks SET status = 'pending' WHERE id = ?").run(task.id);
        const updated = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as Task;
        unblocked.push(updated);
      }
    }

    return { completed: true, unblocked };
  }

  getTasks(status?: string): Task[] {
    if (status) {
      return this.db.prepare("SELECT * FROM tasks WHERE status = ?").all(status) as Task[];
    }
    return this.db.prepare("SELECT * FROM tasks ORDER BY created_at").all() as Task[];
  }

  getUnblockedTasks(): Task[] {
    return this.db.prepare(
      "SELECT * FROM tasks WHERE status = 'pending' AND assignee IS NULL",
    ).all() as Task[];
  }

  close(): void {
    this.db.close();
  }
}
