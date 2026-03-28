import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { TeamState, createTeamTools } from "./team-tools.js";

/**
 * Milestone 1: Two agents can talk to each other.
 *
 * This test harness:
 * 1. Starts a CopilotClient (one CLI server)
 * 2. Creates two SDK sessions with team tools injected
 * 3. Tells Agent A to collaborate with Agent B
 * 4. Watches console output to see if they coordinate
 */

const AGENT_A_PROMPT = `
You are "alice" — a security researcher on a development team.
Your teammate "bob" is a backend engineer.

You have access to team coordination tools:
- team_send(message): Post to #general (everyone sees it)
- team_dm(to, message): Send a private message to a teammate
- team_get_roster(): See who's on the team

Use these tools to communicate. Do NOT just describe what you'd do — actually call the tools.
`.trim();

const AGENT_B_PROMPT = `
You are "bob" — a backend engineer on a development team.
Your teammate "alice" is a security researcher.

You have access to team coordination tools:
- team_send(message): Post to #general (everyone sees it)
- team_dm(to, message): Send a private message to a teammate
- team_get_roster(): See who's on the team

Use these tools to communicate. Do NOT just describe what you'd do — actually call the tools.
When you receive messages, respond thoughtfully and use the tools to reply.
`.trim();

async function main() {
  console.log("🚀 Starting Copilot Teams — Milestone 1");
  console.log("   Testing: Can two agents talk to each other?\n");

  // Shared team state (in-memory for M1)
  const teamState = new TeamState();

  // Start the SDK client
  console.log("⏳ Starting CopilotClient...");
  const client = new CopilotClient();
  await client.start();
  console.log("✅ CopilotClient ready\n");

  // Create Alice's session
  console.log("⏳ Spawning alice (security researcher)...");
  const aliceTools = createTeamTools(teamState, "alice");
  const alice = await client.createSession({
    model: "claude-sonnet-4",
    tools: aliceTools,
    systemMessage: { mode: "append", content: AGENT_A_PROMPT },
    onPermissionRequest: approveAll,
  });
  teamState.registerAgent("alice", "security researcher", alice);
  console.log("✅ alice ready");

  // Create Bob's session
  console.log("⏳ Spawning bob (backend engineer)...");
  const bobTools = createTeamTools(teamState, "bob");
  const bob = await client.createSession({
    model: "claude-sonnet-4",
    tools: bobTools,
    systemMessage: { mode: "append", content: AGENT_B_PROMPT },
    onPermissionRequest: approveAll,
  });
  teamState.registerAgent("bob", "backend engineer", bob);
  console.log("✅ bob ready\n");

  // Wire up streaming so we can see what agents are thinking
  for (const [id, session] of teamState.sessions) {
    session.on("assistant.message", (event) => {
      console.log(`\n🤖 [${id} thinks]: ${event.data.content}`);
    });

    session.on("tool.execution_start", (event) => {
      console.log(`\n🔧 [${id}] calling tool: ${event.data.toolName}`);
    });

    session.on("session.idle", () => {
      console.log(`\n⏸️  [${id}] idle`);
    });
  }

  // The test: tell Alice to coordinate with Bob
  console.log("═".repeat(60));
  console.log("📝 Sending task to alice...");
  console.log("═".repeat(60));

  await alice.sendAndWait({
    prompt:
      "Check the team roster, then send a message to #general introducing yourself. " +
      "Also DM bob directly and ask him what endpoints he's been working on lately.",
  }, 120_000);

  // Give Bob a moment to process Alice's messages, then nudge him
  console.log("\n" + "═".repeat(60));
  console.log("📝 Nudging bob to check his messages...");
  console.log("═".repeat(60));

  await bob.sendAndWait({
    prompt:
      "Check #general and respond to any messages. Also check your DMs and reply. " +
      "Keep your responses concise — don't start a long back-and-forth.",
  }, 120_000);

  // Summary
  console.log("\n" + "═".repeat(60));
  console.log("📊 Message Log:");
  console.log("═".repeat(60));
  for (const msg of teamState.messages) {
    if (msg.channel) {
      console.log(`  [${msg.channel}] ${msg.from}: ${msg.content}`);
    } else {
      console.log(`  [DM] ${msg.from} → ${msg.to}: ${msg.content}`);
    }
  }
  console.log(`\nTotal messages exchanged: ${teamState.messages.length}`);

  // Cleanup
  console.log("\n🧹 Cleaning up...");
  await alice.disconnect();
  await bob.disconnect();
  await client.stop();
  console.log("✅ Done!");
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
