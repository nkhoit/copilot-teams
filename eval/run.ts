/**
 * Eval runner — runs a benchmark mission end-to-end and produces a scorecard.
 *
 * Usage:
 *   npx tsx eval/run.ts [benchmark-id]           # run one benchmark (default: notes-api)
 *   npx tsx eval/run.ts --all                     # run all benchmarks
 *   npx tsx eval/run.ts --list                    # list available benchmarks
 *   npx tsx eval/run.ts --history [benchmark-id]  # show past results
 */

import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { benchmarks, getBenchmark, type Benchmark } from "./benchmarks.js";

const EVAL_DIR = join(homedir(), ".copilot-teams", "eval");
const RESULTS_FILE = join(EVAL_DIR, "results.json");
const WORK_BASE = join(homedir(), "Workspace");

interface EvalResult {
  benchmarkId: string;
  benchmarkName: string;
  promptVersion: string;
  timestamp: string;
  success: boolean;
  wallTimeSeconds: number;
  testsPassed: number;
  testsFailed: number;
  testsTotal: number;
  testPassRate: number;
  rejections: number;
  userNudges: number;
  totalMessages: number;
  agentCount: number;
  taskCount: number;
  stuckResets: number;
  error?: string;
}

// ── Daemon API helpers ───────────────────────────────────────

function getDaemonUrl(): string {
  const configPath = join(homedir(), ".copilot-teams", "daemon.json");
  if (!existsSync(configPath)) {
    throw new Error("Daemon not running. Start with: cpt daemon start");
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return `http://localhost:${config.port}`;
}

async function api(method: string, path: string, body?: any): Promise<any> {
  const url = `${getDaemonUrl()}${path}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(`API error: ${(data as any).error ?? res.statusText}`);
  return data;
}

async function waitForTeamState(
  teamId: string,
  targetState: string,
  timeoutMs: number,
  pollMs = 10_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;
  while (Date.now() < deadline) {
    let status: any;
    try {
      status = await api("GET", `/api/teams/${teamId}`);
      consecutiveErrors = 0;
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        throw new Error(`Daemon unreachable after ${consecutiveErrors} attempts — it may have crashed`);
      }
      console.log(`  ⚠️  Daemon unreachable (attempt ${consecutiveErrors}/3), retrying...`);
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    // Check for waiting lead (needs plan approval)
    const lead = status.agents?.find((a: any) => a.id === "lead" || a.role === "lead");
    if (lead?.status === "waiting" && lead.waitingReason) {
      console.log("  📋 Lead proposed a plan — auto-approving...");
      await api("POST", `/api/teams/${teamId}/messages`, { content: "Approved. Go ahead." });
    }

    if (status.state === targetState) return status;

    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timeout: team ${teamId} did not reach state "${targetState}" within ${timeoutMs / 1000}s`);
}

// ── Scoring ────────────────────────────────────────────────

async function scoreRun(
  teamId: string,
  benchmark: Benchmark,
  workDir: string,
  wallTimeSeconds: number,
): Promise<EvalResult> {
  const promptVersion = getPromptVersion();
  const result: EvalResult = {
    benchmarkId: benchmark.id,
    benchmarkName: benchmark.name,
    promptVersion,
    timestamp: new Date().toISOString(),
    success: false,
    wallTimeSeconds,
    testsPassed: 0,
    testsFailed: 0,
    testsTotal: 0,
    testPassRate: 0,
    rejections: 0,
    userNudges: 0,
    totalMessages: 0,
    agentCount: 0,
    taskCount: 0,
    stuckResets: 0,
  };

  // Get team status (may fail if daemon crashed)
  try {
    const status = await api("GET", `/api/teams/${teamId}`);
    result.agentCount = status.agents?.length ?? 0;
    result.taskCount = status.tasks?.length ?? 0;
    result.success = status.state === "completed";

    // Get activity for scoring
    const activity = await api("GET", `/api/teams/${teamId}/activity?limit=500`);
    result.rejections = activity.filter((a: any) => a.type === "task.rejected").length;
    result.stuckResets = activity.filter((a: any) =>
      a.type === "task.reset" || a.type === "tasks.reset_agent" || a.type === "tasks.reset_orphaned",
    ).length;

    // Get messages
    const messages = await api("GET", `/api/teams/${teamId}/messages?limit=500`);
    result.totalMessages = messages.length;
    // User nudges = messages from "user" after the initial approval
    const userMessages = messages.filter((m: any) => m.from === "user");
    result.userNudges = Math.max(0, userMessages.length - 1); // subtract the approval
  } catch {
    console.log("  ⚠️  Daemon unreachable — scoring from filesystem only");
  }

  // Run verification tests
  try {
    const output = execSync(benchmark.verifyCommand, {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 60_000,
    });
    const passedMatch = output.match(benchmark.testPattern.passed);
    const failedMatch = output.match(benchmark.testPattern.failed);
    const totalMatch = output.match(benchmark.testPattern.total);

    result.testsPassed = passedMatch ? parseInt(passedMatch[1]) : 0;
    result.testsFailed = failedMatch ? parseInt(failedMatch[1]) : 0;
    result.testsTotal = totalMatch ? parseInt(totalMatch[1]) : result.testsPassed;
    result.testPassRate = result.testsTotal > 0 ? result.testsPassed / result.testsTotal : 0;
  } catch (err: any) {
    // Tests failed — try to extract counts from the error output
    const output = err.stdout ?? err.stderr ?? "";
    const passedMatch = output.match(benchmark.testPattern.passed);
    const failedMatch = output.match(benchmark.testPattern.failed);
    const totalMatch = output.match(benchmark.testPattern.total);

    result.testsPassed = passedMatch ? parseInt(passedMatch[1]) : 0;
    result.testsFailed = failedMatch ? parseInt(failedMatch[1]) : 0;
    result.testsTotal = totalMatch ? parseInt(totalMatch[1]) : result.testsPassed + result.testsFailed;
    result.testPassRate = result.testsTotal > 0 ? result.testsPassed / result.testsTotal : 0;
    result.error = `Tests exited with code ${err.status}`;
  }

  return result;
}

function getPromptVersion(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}

// ── Results persistence ──────────────────────────────────────

function loadResults(): EvalResult[] {
  if (!existsSync(RESULTS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(RESULTS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveResult(result: EvalResult): void {
  mkdirSync(EVAL_DIR, { recursive: true });
  const results = loadResults();
  results.push(result);
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
}

// ── Display ──────────────────────────────────────────────────

function printScorecard(result: EvalResult): void {
  const pass = result.testPassRate === 1 ? "✅" : result.testPassRate >= 0.8 ? "⚠️" : "❌";
  const success = result.success ? "✅" : "❌";

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  EVAL SCORECARD: ${result.benchmarkName}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Prompt version:   ${result.promptVersion}`);
  console.log(`  Timestamp:        ${result.timestamp}`);
  console.log(`${"─".repeat(60)}`);
  console.log(`  ${success} Mission completed:  ${result.success}`);
  console.log(`  ${pass} Test pass rate:     ${result.testsPassed}/${result.testsTotal} (${(result.testPassRate * 100).toFixed(0)}%)`);
  console.log(`  ⏱️  Wall time:         ${formatDuration(result.wallTimeSeconds)}`);
  console.log(`  🔄 Rejections:        ${result.rejections}`);
  console.log(`  👤 Manual nudges:     ${result.userNudges}`);
  console.log(`  💬 Total messages:    ${result.totalMessages}`);
  console.log(`  🤖 Agents used:       ${result.agentCount}`);
  console.log(`  📋 Tasks:             ${result.taskCount}`);
  console.log(`  ⚠️  Stuck resets:      ${result.stuckResets}`);
  if (result.error) {
    console.log(`  ❌ Error:             ${result.error}`);
  }
  console.log(`${"═".repeat(60)}\n`);
}

function printHistory(benchmarkId?: string): void {
  const results = loadResults();
  const filtered = benchmarkId ? results.filter((r) => r.benchmarkId === benchmarkId) : results;

  if (filtered.length === 0) {
    console.log("No eval results found.");
    return;
  }

  console.log(`\n${"═".repeat(90)}`);
  console.log(`  EVAL HISTORY${benchmarkId ? ` (${benchmarkId})` : ""}`);
  console.log(`${"═".repeat(90)}`);
  console.log(
    `  ${"Date".padEnd(12)} ${"Benchmark".padEnd(15)} ${"Commit".padEnd(8)} ${"Pass".padEnd(8)} ${"Time".padEnd(8)} ${"Rej".padEnd(5)} ${"Nudge".padEnd(6)} ${"Msgs".padEnd(6)} Result`,
  );
  console.log(`${"─".repeat(90)}`);

  for (const r of filtered) {
    const date = r.timestamp.slice(0, 10);
    const passRate = `${(r.testPassRate * 100).toFixed(0)}%`;
    const time = formatDuration(r.wallTimeSeconds);
    const status = r.success && r.testPassRate === 1 ? "✅" : r.success ? "⚠️" : "❌";
    console.log(
      `  ${date.padEnd(12)} ${r.benchmarkId.padEnd(15)} ${r.promptVersion.padEnd(8)} ${passRate.padEnd(8)} ${time.padEnd(8)} ${String(r.rejections).padEnd(5)} ${String(r.userNudges).padEnd(6)} ${String(r.totalMessages).padEnd(6)} ${status}`,
    );
  }
  console.log(`${"═".repeat(90)}\n`);
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

// ── Main runner ──────────────────────────────────────────────

async function runBenchmark(benchmark: Benchmark): Promise<EvalResult> {
  const teamId = `eval-${benchmark.id}-${Date.now()}`;
  const workDir = join(WORK_BASE, teamId);

  console.log(`\n🧪 Running eval: ${benchmark.name}`);
  console.log(`   Team: ${teamId}`);
  console.log(`   Dir:  ${workDir}`);

  // Prepare workspace
  mkdirSync(workDir, { recursive: true });
  const startTime = Date.now();

  try {
    // Create team
    console.log("  📦 Creating team...");
    await api("POST", "/api/teams", {
      id: teamId,
      mission: benchmark.mission,
      workingDirectory: workDir,
    });

    // Spawn lead
    console.log("  🚀 Spawning lead...");
    await api("POST", `/api/teams/${teamId}/agents`, { id: "lead", role: "lead" });

    // Wait for completion
    console.log("  ⏳ Waiting for completion...");
    await waitForTeamState(teamId, "completed", benchmark.timeoutSeconds * 1000);
    const wallTimeSeconds = (Date.now() - startTime) / 1000;

    // Score
    console.log("  📊 Scoring...");
    const result = await scoreRun(teamId, benchmark, workDir, wallTimeSeconds);
    printScorecard(result);
    saveResult(result);

    return result;
  } catch (err: any) {
    console.log(`  ⚠️  Error: ${err.message}`);
    console.log("  📊 Attempting to score from filesystem...");
    // Even if daemon crashed, the work may be done — try scoring from tests
    const wallTimeSeconds = (Date.now() - startTime) / 1000;
    const result = await scoreRun(teamId, benchmark, workDir, wallTimeSeconds);
    result.error = err.message;
    printScorecard(result);
    saveResult(result);
    return result;
  } finally {
    // Cleanup team (leave workspace for inspection)
    try {
      await api("DELETE", `/api/teams/${teamId}`);
    } catch { /* team may not exist */ }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    console.log("\nAvailable benchmarks:");
    for (const b of benchmarks) {
      console.log(`  ${b.id.padEnd(20)} ${b.name}`);
    }
    console.log("");
    return;
  }

  if (args.includes("--history")) {
    const id = args.find((a) => a !== "--history");
    printHistory(id);
    return;
  }

  if (args.includes("--all")) {
    console.log(`\n🧪 Running all ${benchmarks.length} benchmarks...\n`);
    const results: EvalResult[] = [];
    for (const b of benchmarks) {
      results.push(await runBenchmark(b));
    }

    // Summary
    const passed = results.filter((r) => r.success && r.testPassRate === 1).length;
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  EVAL SUITE SUMMARY: ${passed}/${results.length} passed`);
    console.log(`${"═".repeat(60)}\n`);
    return;
  }

  // Single benchmark
  const benchmarkId = args[0] ?? "notes-api";
  const benchmark = getBenchmark(benchmarkId);
  if (!benchmark) {
    console.error(`Unknown benchmark: ${benchmarkId}`);
    console.error(`Available: ${benchmarks.map((b) => b.id).join(", ")}`);
    process.exit(1);
  }

  await runBenchmark(benchmark);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
