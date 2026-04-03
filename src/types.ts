/** Shared types for the copilot-teams gateway API */

// ── Core domain types ──────────────────────────────────────────

export interface Agent {
  id: string;
  role: string;
  model: string;
  status: "idle" | "working";
  currentTask: string | null;
  workingDirectory: string | null;
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

export interface Mission {
  text: string;
  updatedAt: number;
  history: Array<{ text: string; updatedAt: number }>;
}

export interface Activity {
  id: number;
  type: string;
  agentId: string | null;
  data: Record<string, any>;
  timestamp: number;
}

export type TeamStatusState = "active" | "completed" | "paused" | "shutdown";

// ── REST request/response shapes ───────────────────────────────

export interface CreateAgentRequest {
  id: string;
  role: string;
  model?: string;
  workingDirectory?: string;
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

export interface UpdateMissionRequest {
  text: string;
}

export interface TeamStatus {
  state: TeamStatusState;
  mission: Mission | null;
  agents: Agent[];
  tasks: Task[];
}

// ── WebSocket event types ──────────────────────────────────────

export type ServerEvent =
  | { type: "agent.joined"; agent: Agent }
  | { type: "agent.left"; agentId: string }
  | { type: "agent.status"; agentId: string; status: Agent["status"]; currentTask: string | null }
  | { type: "message.dm"; message: Message }
  | { type: "task.created"; task: Task }
  | { type: "task.claimed"; taskId: string; agentId: string }
  | { type: "task.completed"; taskId: string; agentId: string; result: string }
  | { type: "task.unblocked"; task: Task }
  | { type: "mission.updated"; text: string }
  | { type: "mission.completed"; summary: string }
  | { type: "agent.thinking"; agentId: string; content: string }
  | { type: "activity"; activity: Activity }
  | { type: "error"; message: string };

export type ClientCommand =
  | { type: "message"; content: string }
  | { type: "dm"; to: string; content: string }
  | { type: "mission.update"; text: string }
  | { type: "task.create"; id: string; title: string; description?: string; dependsOn?: string[]; assignee?: string };
