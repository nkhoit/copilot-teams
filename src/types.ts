/** Shared types for the copilot-teams gateway API */

// ── Core domain types ──────────────────────────────────────────

export interface Agent {
  id: string;
  role: string;
  model: string;
  status: "idle" | "working" | "waiting";
  currentTask: string | null;
  workingDirectory: string | null;
  waitingReason: string | null;
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

// ── Team (multi-team) ──────────────────────────────────────────

export interface TeamInfo {
  id: string;
  state: TeamStatusState;
  mission: Mission | null;
  workingDirectory: string;
  agentCount: number;
  createdAt: number;
}

export interface TeamStatus {
  id: string;
  state: TeamStatusState;
  mission: Mission | null;
  workingDirectory: string;
  agents: Agent[];
  tasks: Task[];
  createdAt: number;
}

export interface DaemonStatus {
  pid: number;
  port: number;
  uptime: number;
  started: string;
  teams: TeamInfo[];
}

// ── REST request/response shapes ───────────────────────────────

export interface CreateTeamRequest {
  id: string;
  mission?: string;
  workingDirectory?: string;
  leadPrompt?: string;
}

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

// ── WebSocket event types ──────────────────────────────────────

export type ServerEvent =
  | { type: "agent.joined"; teamId: string; agent: Agent }
  | { type: "agent.left"; teamId: string; agentId: string }
  | { type: "agent.status"; teamId: string; agentId: string; status: Agent["status"]; currentTask: string | null; waitingReason?: string }
  | { type: "message.dm"; teamId: string; message: Message }
  | { type: "task.created"; teamId: string; task: Task }
  | { type: "task.claimed"; teamId: string; taskId: string; agentId: string }
  | { type: "task.completed"; teamId: string; taskId: string; agentId: string; result: string }
  | { type: "task.rejected"; teamId: string; taskId: string; agentId: string; feedback: string }
  | { type: "task.unblocked"; teamId: string; task: Task }
  | { type: "mission.updated"; teamId: string; text: string }
  | { type: "mission.completed"; teamId: string; summary: string }
  | { type: "agent.thinking"; teamId: string; agentId: string; content: string }
  | { type: "activity"; teamId: string; activity: Activity }
  | { type: "team.created"; team: TeamInfo }
  | { type: "team.deleted"; teamId: string }
  | { type: "team.state_changed"; teamId: string; state: TeamStatusState }
  | { type: "error"; message: string };

export type ClientCommand =
  | { type: "message"; teamId: string; content: string }
  | { type: "dm"; teamId: string; to: string; content: string }
  | { type: "mission.update"; teamId: string; text: string }
  | { type: "task.create"; teamId: string; id: string; title: string; description?: string; dependsOn?: string[]; assignee?: string };
