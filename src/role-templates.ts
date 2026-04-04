import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GLOBAL_ROLES_DIR = join(homedir(), ".copilot-teams", "roles");

export interface TemplateInfo {
  name: string;
  source: "project" | "global";
  description: string;
  model?: string;
  path: string;
}

export interface ResolvedTemplate {
  name: string;
  source: "project" | "global";
  content: string;
  model?: string;
  promptMode?: "replace" | "extend";
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
 * Parse simple YAML-like frontmatter from template content.
 * Frontmatter is delimited by `---` lines at the start of the file.
 * Supported fields: model, prompt (replace|extend)
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: raw };

  const fmLines: string[] = [];
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIdx = i;
      break;
    }
    fmLines.push(lines[i]!);
  }

  if (endIdx === -1) return { frontmatter: {}, body: raw };

  const frontmatter: Record<string, string> = {};
  for (const line of fmLines) {
    const match = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (match) frontmatter[match[1]!] = match[2]!.trim();
  }

  const body = lines.slice(endIdx + 1).join("\n").replace(/^\n+/, "");
  return { frontmatter, body };
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
      const raw = readFileSync(projectPath, "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);
      return {
        name,
        source: "project",
        content: body,
        model: frontmatter["model"],
        promptMode: (frontmatter["prompt"] as "replace" | "extend") ?? undefined,
      };
    }
  }

  // Global fallback
  const globalPath = join(GLOBAL_ROLES_DIR, `${name}.md`);
  if (existsSync(globalPath)) {
    const raw = readFileSync(globalPath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    return {
      name,
      source: "global",
      content: body,
      model: frontmatter["model"],
      promptMode: (frontmatter["prompt"] as "replace" | "extend") ?? undefined,
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
    const raw = readFileSync(fullPath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);

    const description = extractDescription(body);

    results.push({ name, source, description, model: frontmatter["model"], path: fullPath });
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
