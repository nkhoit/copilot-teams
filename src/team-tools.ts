import { z } from "zod";
import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { TeamState } from "./team-state.js";
import type { EventBus } from "./orchestrator.js";

const MAX_VOLLEY = 3;

/** Callback for the lead to spawn new agents */
export interface SpawnAgentFn {
  (opts: { id: string; role: string; workingDirectory?: string; model?: string }): Promise<void>;
}

/** Callback for mission completion */
export interface CompleteMissionFn {
  (summary: string): void;
}

/**
 * Create the team coordination tools for a specific agent.
 * These tools are injected into each SDK session via defineTool().
 */
export function createTeamTools(
  state: TeamState,
  agentId: string,
  options?: {
    eventBus?: EventBus;
    spawnAgent?: SpawnAgentFn;
    completeMission?: CompleteMissionFn;
    isLead?: boolean;
  },
): Tool<any>[] {
  const emit = (event: any) => options?.eventBus?.emit("event", event);

  const tools: Tool<any>[] = [
    // ── Communication ─────────────────────────────────────────

    defineTool("team_dm", {
      description:
        "Send a direct message to a specific teammate. Only they can see it. Set expectsReply=false for FYI messages.",
      parameters: z.object({
        to: z.string().describe("The agent ID to send to"),
        message: z.string().describe("The message content"),
        expectsReply: z
          .boolean()
          .default(true)
          .describe("Set false if this is informational and no reply is needed"),
      }),
      skipPermission: true,
      handler: async ({ to, message, expectsReply }) => {
        const recipient = state.getSession(to);
        if (!recipient) {
          return {
            error: `Agent "${to}" not found. Roster: ${state.getRoster().map((a) => a.id).join(", ")}`,
          };
        }

        const volley = state.incrementVolley(agentId, to);
        if (volley > MAX_VOLLEY) {
          return {
            blocked: true,
            reason: `Volley limit (${MAX_VOLLEY}) reached with ${to}. Do real work (complete a task) before DMing again.`,
          };
        }

        const msg = state.addMessage(agentId, message, null, to);
        console.log(`\n📨 [DM] ${agentId} → ${to}: ${message}`);
        emit({ type: "message.dm", message: { id: msg.id, from: agentId, to, channel: null, content: message, timestamp: msg.timestamp } });

        const tag = expectsReply ? "" : " [NO REPLY NEEDED]";
        await recipient.send({
          prompt: `[DM from ${agentId}]${tag}: ${message}`,
        });

        return { sent: true, to };
      },
    }),

    defineTool("team_get_roster", {
      description: "Get the list of all team members and their roles/status.",
      parameters: z.object({}),
      skipPermission: true,
      handler: async () => state.getRoster(),
    }),

    // ── Task Management ───────────────────────────────────────

    defineTool("team_create_task", {
      description:
        "Create a new task. If dependsOn IDs are provided, the task starts as 'blocked' until those complete.",
      parameters: z.object({
        id: z.string().describe("Unique task ID (kebab-case)"),
        title: z.string().describe("Short title"),
        description: z.string().default("").describe("Detailed description"),
        dependsOn: z.array(z.string()).default([]).describe("Task IDs this depends on"),
        assignee: z.string().optional().describe("Agent ID to assign to"),
      }),
      skipPermission: true,
      handler: async ({ id, title, description, dependsOn, assignee }) => {
        const task = state.createTask(id, title, description, dependsOn, assignee);
        console.log(`\n📋 Task created: ${id} (${task.status})`);
        emit({ type: "task.created", task: { ...task, dependsOn, createdAt: task.created_at } });

        if (assignee) {
          const session = state.getSession(assignee);
          if (session) {
            await session.send({
              prompt: `[TASK ASSIGNED] "${title}" (${id}) — ${description || "No description"}. Status: ${task.status}`,
            });
          }
        }
        return task;
      },
    }),

    defineTool("team_get_tasks", {
      description: "Get all tasks, optionally filtered by status.",
      parameters: z.object({
        status: z
          .enum(["pending", "blocked", "in_progress", "done"])
          .optional()
          .describe("Filter by task status"),
      }),
      skipPermission: true,
      handler: async ({ status }) => state.getTasks(status),
    }),

    defineTool("team_claim_task", {
      description: "Claim a pending task to start working on it.",
      parameters: z.object({
        taskId: z.string().describe("The task ID to claim"),
      }),
      skipPermission: true,
      handler: async ({ taskId }) => {
        const result = state.claimTask(taskId, agentId);
        if (result.success) {
          state.resetVolley(agentId);
          console.log(`\n🏗️  ${agentId} claimed task: ${taskId}`);
          emit({ type: "task.claimed", taskId, agentId });
          emit({
            type: "agent.status",
            agentId,
            status: "working" as const,
            currentTask: taskId,
          });
        }
        return result;
      },
    }),

    defineTool("team_complete_task", {
      description: "Mark a task you claimed as complete, with a result summary.",
      parameters: z.object({
        taskId: z.string().describe("The task ID to complete"),
        result: z.string().describe("Summary of the result / what was done"),
      }),
      skipPermission: true,
      handler: async ({ taskId, result }) => {
        const outcome = state.completeTask(taskId, agentId, result);
        state.resetVolley(agentId);
        console.log(`\n✅ ${agentId} completed task: ${taskId}`);
        emit({ type: "task.completed", taskId, agentId, result });
        emit({
          type: "agent.status",
          agentId,
          status: "idle" as const,
          currentTask: null,
        });

        for (const unblocked of outcome.unblocked) {
          console.log(`\n🔓 Task unblocked: ${unblocked.id}`);
          emit({
            type: "task.unblocked",
            task: {
              ...unblocked,
              dependsOn: JSON.parse(unblocked.depends_on),
              createdAt: unblocked.created_at,
            },
          });
          if (unblocked.assignee) {
            const session = state.getSession(unblocked.assignee);
            if (session) {
              await session.send({
                prompt: `[TASK UNBLOCKED] "${unblocked.title}" (${unblocked.id}) is now ready to work on!`,
              });
            }
          }
        }
        return outcome;
      },
    }),
  ];

  // ── Lead-Only Tools ───────────────────────────────────────

  if (options?.isLead && options.spawnAgent) {
    const spawnAgent = options.spawnAgent;

    tools.push(
      defineTool("team_spawn_agent", {
        description:
          "Spawn a new team member with a specific role and working directory. Only the lead can use this.",
        parameters: z.object({
          id: z.string().describe("Unique agent ID (e.g., 'backend', 'tester')"),
          role: z.string().describe("Description of the agent's role"),
          workingDirectory: z.string().optional().describe("Directory this agent should work in"),
          model: z.string().optional().describe("Model to use (default: claude-sonnet-4)"),
        }),
        skipPermission: true,
        handler: async ({ id, role, workingDirectory, model }) => {
          try {
            await spawnAgent({ id, role, workingDirectory, model });
            console.log(`\n👤 Lead spawned agent: ${id} (${role})`);
            return { spawned: true, id, role, workingDirectory };
          } catch (err: any) {
            return { error: err.message };
          }
        },
      }),
    );
  }

  if (options?.isLead && options.completeMission) {
    const completeMission = options.completeMission;

    tools.push(
      defineTool("team_complete_mission", {
        description:
          "Declare the current mission as fulfilled. Include a summary of what was accomplished.",
        parameters: z.object({
          summary: z.string().describe("Summary of what was accomplished"),
        }),
        skipPermission: true,
        handler: async ({ summary }) => {
          completeMission(summary);
          console.log(`\n🎯 Mission completed: ${summary}`);
          return { completed: true, summary };
        },
      }),
    );
  }

  return tools;
}
