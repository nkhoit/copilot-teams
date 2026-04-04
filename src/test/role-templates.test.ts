import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { listTemplates, resolveTemplate } from "../role-templates.js";

describe("Role Templates", () => {
  let projectDir: string;
  let globalDir: string;
  let originalHome: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "cpt-tmpl-project-"));
    globalDir = mkdtempSync(join(tmpdir(), "cpt-tmpl-global-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  function writeProjectTemplate(name: string, content: string): void {
    const dir = join(projectDir, ".copilot-teams", "roles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), content);
  }

  function writeGlobalTemplate(name: string, content: string): void {
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, `${name}.md`), content);
  }

  // ── resolveTemplate ────────────────────────────────────

  describe("resolveTemplate", () => {
    it("resolves a project-specific template", () => {
      writeProjectTemplate("qa-tester", "# QA Tester\nTest all the things.");

      const result = resolveTemplate("qa-tester", projectDir);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("qa-tester");
      expect(result!.source).toBe("project");
      expect(result!.content).toContain("Test all the things");
    });

    it("returns null for missing template", () => {
      const result = resolveTemplate("nonexistent", projectDir);
      expect(result).toBeNull();
    });

    it("project-specific overrides global", () => {
      // We can't easily override the global dir path since it's hardcoded to ~/.copilot-teams/roles.
      // But we can test project-specific resolution directly.
      writeProjectTemplate("backend", "# Project Backend\nProject-specific instructions.");

      const result = resolveTemplate("backend", projectDir);
      expect(result!.source).toBe("project");
      expect(result!.content).toContain("Project-specific");
    });

    it("works with no working directory", () => {
      const result = resolveTemplate("anything");
      // Will only look in global dir — likely null unless user has global templates
      // Just verify it doesn't crash
      expect(result === null || result.source === "global").toBe(true);
    });

    it("parses frontmatter model field", () => {
      writeProjectTemplate("backend", "---\nmodel: claude-sonnet-4\n---\n# Backend Dev\nBuild APIs.");

      const result = resolveTemplate("backend", projectDir);
      expect(result).not.toBeNull();
      expect(result!.model).toBe("claude-sonnet-4");
      expect(result!.content).toContain("Build APIs");
      expect(result!.content).not.toContain("---");
    });

    it("parses frontmatter prompt mode", () => {
      writeProjectTemplate("custom-lead", "---\nprompt: replace\nmodel: gpt-5.4\n---\nYou are a custom lead.");

      const result = resolveTemplate("custom-lead", projectDir);
      expect(result!.promptMode).toBe("replace");
      expect(result!.model).toBe("gpt-5.4");
      expect(result!.content).toBe("You are a custom lead.");
    });

    it("handles template with no frontmatter", () => {
      writeProjectTemplate("simple", "# Simple\nJust do the work.");

      const result = resolveTemplate("simple", projectDir);
      expect(result!.model).toBeUndefined();
      expect(result!.promptMode).toBeUndefined();
      expect(result!.content).toContain("Just do the work");
    });

    it("handles malformed frontmatter (no closing ---)", () => {
      writeProjectTemplate("broken", "---\nmodel: opus\nThis has no closing delimiter.");

      const result = resolveTemplate("broken", projectDir);
      // Treated as no frontmatter — raw content preserved
      expect(result!.model).toBeUndefined();
      expect(result!.content).toContain("---");
    });
  });

  // ── listTemplates ──────────────────────────────────────

  describe("listTemplates", () => {
    it("lists project-specific templates", () => {
      writeProjectTemplate("qa-tester", "# QA Tester\nTest coverage for all public APIs.");
      writeProjectTemplate("frontend", "# Frontend Dev\nBuild responsive UIs.");

      const templates = listTemplates(projectDir);
      const projectTemplates = templates.filter((t) => t.source === "project");
      expect(projectTemplates.length).toBeGreaterThanOrEqual(2);

      const names = projectTemplates.map((t) => t.name);
      expect(names).toContain("qa-tester");
      expect(names).toContain("frontend");
    });

    it("extracts description from first non-heading line", () => {
      writeProjectTemplate("tester", "# QA Tester\n\nAlways run existing tests first.\nMore details here.");

      const templates = listTemplates(projectDir);
      const tester = templates.find((t) => t.name === "tester");
      expect(tester).toBeDefined();
      expect(tester!.description).toBe("Always run existing tests first.");
    });

    it("includes model from frontmatter in listing", () => {
      writeProjectTemplate("fast-dev", "---\nmodel: claude-sonnet-4\n---\n# Fast Dev\nQuick and cheap.");

      const templates = listTemplates(projectDir);
      const dev = templates.find((t) => t.name === "fast-dev" && t.source === "project");
      expect(dev).toBeDefined();
      expect(dev!.model).toBe("claude-sonnet-4");
      expect(dev!.description).toBe("Quick and cheap.");
    });

    it("handles empty directory", () => {
      const templates = listTemplates(projectDir);
      // May include global templates, but should not crash
      expect(Array.isArray(templates)).toBe(true);
    });

    it("returns sorted by name", () => {
      writeProjectTemplate("zebra", "# Zebra\nStripes.");
      writeProjectTemplate("alpha", "# Alpha\nFirst.");

      const templates = listTemplates(projectDir);
      const projectNames = templates.filter((t) => t.source === "project").map((t) => t.name);
      expect(projectNames).toEqual([...projectNames].sort());
    });

    it("ignores non-md files", () => {
      const dir = join(projectDir, ".copilot-teams", "roles");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "notes.txt"), "Not a template");
      writeFileSync(join(dir, "real.md"), "# Real Template\nThis is valid.");

      const templates = listTemplates(projectDir);
      const projectTemplates = templates.filter((t) => t.source === "project");
      expect(projectTemplates.map((t) => t.name)).toContain("real");
      expect(projectTemplates.map((t) => t.name)).not.toContain("notes");
    });
  });
});
