import { z } from "zod";
import { defineTool } from "@github/copilot-sdk";
import type { Tool, CopilotSession } from "@github/copilot-sdk";

/**
 * In-memory team state for M1.
 * Will be replaced with SQLite in M2.
 */
export interface TeamMessage {
  id: string;
  from: string;
  to: string | null; // null = channel message
  channel: string | null; // null = DM
  content: string;
  timestamp: number;
}

export interface AgentInfo {
  id: string;
  role: string;
  status: "idle" | "working";
}

export class TeamState {
  agents: Map<string, AgentInfo> = new Map();
  sessions: Map<string, CopilotSession> = new Map();
  messages: TeamMessage[] = [];

  registerAgent(id: string, role: string, session: CopilotSession): void {
    this.agents.set(id, { id, role, status: "idle" });
    this.sessions.set(id, session);
  }

  getRoster(): AgentInfo[] {
    return [...this.agents.values()];
  }

  getSession(id: string): CopilotSession | undefined {
    return this.sessions.get(id);
  }

  addMessage(
    from: string,
    content: string,
    channel: string | null,
    to: string | null,
  ): TeamMessage {
    const msg: TeamMessage = {
      id: `msg-${this.messages.length}`,
      from,
      to,
      channel,
      content,
      timestamp: Date.now(),
    };
    this.messages.push(msg);
    return msg;
  }

  getMessagesFor(agentId: string): TeamMessage[] {
    return this.messages.filter(
      (m) => m.to === agentId || (m.channel && m.to === null),
    );
  }
}

/**
 * Create the team coordination tools for a specific agent.
 * These tools are injected into each SDK session via defineTool().
 */
export function createTeamTools(
  state: TeamState,
  agentId: string,
): Tool<any>[] {
  return [
    defineTool("team_send", {
      description:
        "Send a message to the #general channel. All team members can see it.",
      parameters: z.object({
        message: z.string().describe("The message content to post"),
      }),
      skipPermission: true,
      handler: async ({ message }) => {
        state.addMessage(agentId, message, "#general", null);
        console.log(`\n💬 [#general] ${agentId}: ${message}`);

        // Push to all other agents
        for (const [id, session] of state.sessions) {
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
        "Send a direct message to a specific teammate. Only they can see it.",
      parameters: z.object({
        to: z.string().describe("The agent ID to send to"),
        message: z.string().describe("The message content"),
      }),
      skipPermission: true,
      handler: async ({ to, message }) => {
        const recipient = state.getSession(to);
        if (!recipient) {
          return { error: `Agent "${to}" not found. Roster: ${state.getRoster().map((a) => a.id).join(", ")}` };
        }

        state.addMessage(agentId, message, null, to);
        console.log(`\n📨 [DM] ${agentId} → ${to}: ${message}`);

        await recipient.send({
          prompt: `[DM from ${agentId}]: ${message}`,
        });

        return { sent: true, to };
      },
    }),

    defineTool("team_get_roster", {
      description: "Get the list of all team members and their roles.",
      parameters: z.object({}),
      skipPermission: true,
      handler: async () => {
        return state.getRoster();
      },
    }),
  ];
}
