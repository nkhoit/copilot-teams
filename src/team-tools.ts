import { z } from "zod";
import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { TeamState } from "./team-state.js";
import type { EventBus } from "./orchestrator.js";
import { listTemplates, resolveTemplate } from "./role-templates.js";

const MAX_VOLLEY = 3;

/** Callback for the lead to spawn new agents */
export interface SpawnAgentFn {
  (opts: { id: string; role: string; workingDirectory?: string; model?: string; template?: string }): Promise<void>;
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
    workingDirectory?: string;
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
        // Prevent lead from claiming tasks assigned to other agents
        if (options?.isLead) {
          const tasks = state.getTasks();
          const task = tasks.find((t) => t.id === taskId);
          if (task?.assignee && task.assignee !== agentId) {
            return { success: false, reason: `Task is assigned to ${task.assignee}. As lead, you coordinate — let the assigned worker claim and complete it.` };
          }
        }
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
        // Prevent lead from completing tasks claimed by other agents
        if (options?.isLead) {
          const tasks = state.getTasks();
          const task = tasks.find((t) => t.id === taskId);
          if (task?.assignee && task.assignee !== agentId) {
            return { success: false, reason: `Task is claimed by ${task.assignee}. As lead, you coordinate — let the assigned worker complete it.` };
          }
        }
        const outcome = state.completeTask(taskId, agentId, result);
        if (!outcome.completed) {
          return { success: false, reason: outcome.reason ?? "Failed to complete task" };
        }
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
              dependsOn: (() => { try { return JSON.parse(unblocked.depends_on); } catch { return []; } })(),
              createdAt: unblocked.created_at,
            },
          });
          // Only notify the assignee if they're not the one who just completed the task
          // (they already know about the unblock since they caused it)
          if (unblocked.assignee && unblocked.assignee !== agentId) {
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

    defineTool("team_request_input", {
      description:
        "Signal that you need input from the user before proceeding. Sets your status to 'waiting' so the user " +
        "or orchestrating agent knows you're blocked. Include what you need in the reason. You will be resumed " +
        "when a message is sent to you.",
      parameters: z.object({
        reason: z.string().describe("What input or approval you need (e.g., 'Please review the task plan before I spawn workers')"),
      }),
      skipPermission: true,
      handler: async ({ reason }) => {
        state.setAgentStatus(agentId, "waiting", null, reason);
        state.logActivity("agent.waiting", agentId, { reason });
        emit({
          type: "agent.status",
          agentId,
          status: "waiting" as const,
          currentTask: null,
          waitingReason: reason,
        });
        console.log(`\n⏸️  ${agentId} is waiting: ${reason}`);
        return { waiting: true, reason };
      },
    }),
  ];

  // ── Lead-Only Tools ───────────────────────────────────────

  if (options?.isLead && options.spawnAgent) {
    const spawnAgent = options.spawnAgent;
    const workDir = options.workingDirectory;

    tools.push(
      defineTool("team_list_templates", {
        description:
          "List available role templates. Templates define reusable agent archetypes with persistent operating instructions. " +
          "Use a template name in team_spawn_agent's 'template' parameter to apply it.",
        parameters: z.object({}),
        skipPermission: true,
        handler: async () => {
          const templates = listTemplates(workDir);
          if (templates.length === 0) {
            return { templates: [], hint: "No templates found. You can spawn agents with freeform roles instead." };
          }
          return { templates: templates.map((t) => ({ name: t.name, source: t.source, description: t.description, model: t.model ?? null })) };
        },
      }),
    );

    tools.push(
      defineTool("team_spawn_agent", {
        description:
          "Spawn a new team member with a specific role and working directory. Only the lead can use this. " +
          "Optionally specify a 'template' name to apply a role template (use team_list_templates to discover available templates).",
        parameters: z.object({
          id: z.string().describe("Unique agent ID (e.g., 'backend', 'tester')"),
          role: z.string().describe("Description of the agent's role"),
          workingDirectory: z.string().optional().describe("Directory this agent should work in"),
          model: z.string().optional().describe("Model to use. If omitted, uses the template's model (if any), otherwise defaults to claude-opus-4.6"),
          template: z.string().optional().describe("Name of a role template to apply (e.g., 'qa-tester')"),
        }),
        skipPermission: true,
        handler: async ({ id, role, workingDirectory, model, template }) => {
          try {
            if (template) {
              const resolved = resolveTemplate(template, workDir);
              if (!resolved) {
                const available = listTemplates(workDir).map((t) => t.name);
                return { error: `Template "${template}" not found. Available: ${available.join(", ") || "none"}` };
              }
            }
            await spawnAgent({ id, role, workingDirectory, model, template });
            console.log(`\n👤 Lead spawned agent: ${id} (${role}${template ? `, template: ${template}` : ""})`);
            return { spawned: true, id, role, workingDirectory, template: template ?? null };
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

    tools.push(
      defineTool("team_reject_task", {
        description:
          "Reject a completed task and send it back for rework. The task moves back to 'pending' with feedback. " +
          "Use this when a worker's result doesn't meet quality standards.",
        parameters: z.object({
          taskId: z.string().describe("The task ID to reject"),
          feedback: z.string().describe("What's wrong and what needs to change"),
        }),
        skipPermission: true,
        handler: async ({ taskId, feedback }) => {
          const result = state.rejectTask(taskId, feedback);
          if (!result.rejected) {
            return { error: `Task "${taskId}" not found or not in 'done' status. Only completed tasks can be rejected.` };
          }
          console.log(`\n❌ Lead rejected task: ${taskId} — ${feedback}`);
          emit({ type: "task.rejected", taskId, agentId, feedback });

          // Notify the assignee that their task was rejected
          if (result.assignee) {
            const msg = `TASK REJECTED: Your task "${taskId}" was reviewed and sent back for rework.\n\nFeedback: ${feedback}\n\nPlease claim the task again, address the feedback, and resubmit.`;
            state.addMessage(agentId, msg, null, result.assignee);
            const session = state.getSession(result.assignee);
            if (session) {
              await session.send({ prompt: msg }).catch((err: unknown) => {
                console.error(`⚠️ Failed to notify ${result.assignee} of rejection:`, err);
              });
            }
          }
          return { rejected: true, taskId, assignee: result.assignee ?? null, feedback };
        },
      }),
    );
  }

  return tools;
}
