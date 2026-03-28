import { z } from "zod";
import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { TeamState } from "./team-state.js";
import type { EventBus } from "./orchestrator.js";

const MAX_VOLLEY = 3;

/**
 * Create the team coordination tools for a specific agent.
 * These tools are injected into each SDK session via defineTool().
 */
export function createTeamTools(
  state: TeamState,
  agentId: string,
  eventBus?: EventBus,
): Tool<any>[] {
  const emit = (event: any) => eventBus?.emit("event", event);

  return [
    // ── Communication ─────────────────────────────────────────

    defineTool("team_send", {
      description:
        "Send a message to the #general channel. All team members can see it.",
      parameters: z.object({
        message: z.string().describe("The message content to post"),
      }),
      skipPermission: true,
      handler: async ({ message }) => {
        const msg = state.addMessage(agentId, message, "#general", null);
        state.resetVolley(agentId);
        console.log(`\n💬 [#general] ${agentId}: ${message}`);
        emit({ type: "message.channel", message: msg });

        for (const [id, session] of state.getAllSessions()) {
          if (id !== agentId) {
            await session.send({
              prompt: `[#general — ${agentId}]: ${message}`,
            });
          }
        }
        return { sent: true, channel: "#general" };
      },
    }),

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
            reason: `Volley limit (${MAX_VOLLEY}) reached with ${to}. Do real work (complete a task, post to #general) before DMing again.`,
          };
        }

        const msg = state.addMessage(agentId, message, null, to);
        console.log(`\n📨 [DM] ${agentId} → ${to}: ${message}`);
        emit({ type: "message.dm", message: msg });

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

        // Notify assignee
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

        // Notify agents about unblocked tasks
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
}
