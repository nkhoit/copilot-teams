import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GLOBAL_ROLES_DIR = join(homedir(), ".copilot-teams", "roles");

export interface TemplateInfo {
  name: string;
  source: "project" | "global";
  description: string;
  path: string;
}

export interface ResolvedTemplate {
  name: string;
  source: "project" | "global";
  content: string;
}

/**
 * List all available role templates.
 * Project-specific templates shadow global ones with the same name.
 */
export function listTemplates(workingDirectory?: string): TemplateInfo[] {
  const templates = new Map<string, TemplateInfo>();

  // Global templates (lower priority)
  for (const t of scanDir(GLOBAL_ROLES_DIR, "global")) {
    templates.set(t.name, t);
  }

  // Project-specific templates (higher priority — overwrite global)
  if (workingDirectory) {
    const projectDir = join(workingDirectory, ".copilot-teams", "roles");
    for (const t of scanDir(projectDir, "project")) {
      templates.set(t.name, t);
    }
  }

  return Array.from(templates.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a template by name.
 * Project-specific takes priority over global. Returns null if not found.
 */
export function resolveTemplate(name: string, workingDirectory?: string): ResolvedTemplate | null {
  // Project-specific first
  if (workingDirectory) {
    const projectPath = join(workingDirectory, ".copilot-teams", "roles", `${name}.md`);
    if (existsSync(projectPath)) {
      return {
        name,
        source: "project",
        content: readFileSync(projectPath, "utf-8"),
      };
    }
  }

  // Global fallback
  const globalPath = join(GLOBAL_ROLES_DIR, `${name}.md`);
  if (existsSync(globalPath)) {
    return {
      name,
      source: "global",
      content: readFileSync(globalPath, "utf-8"),
    };
  }

  return null;
}

function scanDir(dir: string, source: "project" | "global"): TemplateInfo[] {
  if (!existsSync(dir)) return [];

  const results: TemplateInfo[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const name = entry.name.replace(/\.md$/, "");
    const fullPath = join(dir, entry.name);
    const content = readFileSync(fullPath, "utf-8");

    // Use the first non-empty, non-heading line as description
    const description = extractDescription(content);

    results.push({ name, source, description, path: fullPath });
  }
  return results;
}

function extractDescription(content: string): string {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Return first substantive line, truncated
    return trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
  }
  return "(no description)";
}
