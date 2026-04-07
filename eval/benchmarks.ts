/**
 * Benchmark definitions for eval runs.
 * Each benchmark is a standardized mission with a verification command.
 */

export interface Benchmark {
  id: string;
  name: string;
  mission: string;
  /** Command to verify output (should exit 0 on success). Run from workingDirectory. */
  verifyCommand: string;
  /** Regex to extract pass/fail counts from verify output */
  testPattern: {
    passed: RegExp;
    failed: RegExp;
    total: RegExp;
  };
  /** Rough expected duration in seconds (for timeout) */
  timeoutSeconds: number;
}

const VITEST_PATTERN = {
  passed: /(\d+) passed/,
  failed: /(\d+) failed/,
  total: /Tests\s+(\d+)/,
};

export const benchmarks: Benchmark[] = [
  {
    id: "notes-api",
    name: "Notes CRUD API",
    mission: `Build a simple REST API in TypeScript with Express and better-sqlite3.

## Requirements
- CRUD endpoints for "notes" (id, title, content, createdAt, updatedAt)
- Input validation with zod
- Error handling middleware
- Tests with vitest + supertest (aim for full coverage)

## Tech
- TypeScript strict mode, Express, better-sqlite3, zod, vitest, supertest
- Separate app.ts (export app) and index.ts (listen) for testability`,
    verifyCommand: "npx vitest run 2>&1",
    testPattern: VITEST_PATTERN,
    timeoutSeconds: 900,
  },
  {
    id: "todo-cli",
    name: "Todo CLI App",
    mission: `Build a CLI-based Todo List application in TypeScript.

## Requirements
- Add, list, complete, delete, and search todos
- Todos have: id (uuid), title, done (boolean), priority (low/medium/high), createdAt
- Filter by status (done/pending) and priority
- Persist data to a JSON file
- Input validation with zod
- Comprehensive tests with vitest (aim for full coverage of all commands)

## Tech
- TypeScript strict mode, Node.js, zod, uuid, vitest
- Separate core logic (todo-store.ts) from CLI entry point (cli.ts) for testability`,
    verifyCommand: "npx vitest run 2>&1",
    testPattern: VITEST_PATTERN,
    timeoutSeconds: 900,
  },
  {
    id: "hit-counter",
    name: "Hit Counter Service",
    mission: `Build a hit counter HTTP service in TypeScript.

## Requirements
- Express server with endpoints: POST /hit/:page (increment), GET /count/:page (read), GET /top (top 10 pages)
- Persist counts in better-sqlite3
- Input validation with zod (page names alphanumeric+hyphens, max 100 chars)
- Comprehensive tests with vitest + supertest

## Tech
- TypeScript strict mode, Express, better-sqlite3, zod, vitest, supertest
- Separate app.ts (export app) and server.ts (listen) for testability`,
    verifyCommand: "npx vitest run 2>&1",
    testPattern: VITEST_PATTERN,
    timeoutSeconds: 900,
  },
];

export function getBenchmark(id: string): Benchmark | undefined {
  return benchmarks.find((b) => b.id === id);
}
