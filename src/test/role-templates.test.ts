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
