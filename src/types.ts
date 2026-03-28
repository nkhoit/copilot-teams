/** Shared types for the copilot-teams gateway API */

// ── Core domain types ──────────────────────────────────────────

export interface Agent {
  id: string;
  role: string;
  model: string;
  status: "idle" | "working";
  currentTask: string | null;
}

export interface Channel {
  id: string;
  name: string;
  description?: string;
}

export interface Message {
  id: number;
  from: string;
  to: string | null;
  channel: string | null;
  content: string;
  timestamp: number;
}

export type TaskStatus = "pending" | "blocked" | "in_progress" | "done";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: string | null;
  dependsOn: string[];
  result: string | null;
  createdAt: number;
}

// ── REST request/response shapes ───────────────────────────────

export interface CreateAgentRequest {
  id: string;
  role: string;
  model?: string;
  systemPrompt?: string;
}

export interface SendMessageRequest {
  content: string;
}

export interface CreateTaskRequest {
  id: string;
  title: string;
  description?: string;
  dependsOn?: string[];
  assignee?: string;
}

export interface TeamStatus {
  agents: Agent[];
  tasks: Task[];
  channels: Channel[];
}

// ── WebSocket event types ──────────────────────────────────────

export type ServerEvent =
  | { type: "agent.joined"; agent: Agent }
  | { type: "agent.left"; agentId: string }
  | { type: "agent.status"; agentId: string; status: Agent["status"]; currentTask: string | null }
  | { type: "message.channel"; message: Message }
  | { type: "message.dm"; message: Message }
  | { type: "task.created"; task: Task }
  | { type: "task.claimed"; taskId: string; agentId: string }
  | { type: "task.completed"; taskId: string; agentId: string; result: string }
  | { type: "task.unblocked"; task: Task }
  | { type: "agent.thinking"; agentId: string; content: string }
  | { type: "error"; message: string };

export type ClientCommand =
  | { type: "message"; channel: string; content: string }
  | { type: "dm"; to: string; content: string }
  | { type: "task.create"; id: string; title: string; description?: string; dependsOn?: string[]; assignee?: string };
