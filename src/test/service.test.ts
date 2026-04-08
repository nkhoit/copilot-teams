import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Mock child_process globally so install/uninstall never call real binaries
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

describe("service", () => {
  // ── Helper tests ─────────────────────────────────────────────

  describe("getNodePath", () => {
    it("returns process.execPath", async () => {
      const { getNodePath } = await import("../service.js");
      expect(getNodePath()).toBe(process.execPath);
    });
  });

  describe("getDaemonScript", () => {
    it("resolves to dist/index.js or throws if missing", async () => {
      const { getDaemonScript } = await import("../service.js");
      try {
        const result = getDaemonScript();
        expect(existsSync(result)).toBe(true);
        expect(result.endsWith(join("dist", "index.js"))).toBe(true);
      } catch (err: any) {
        expect(err.message).toMatch(/Daemon script not found/);
      }
    });

    it("throws with clear message when dist/index.js is missing", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: vi.fn(),
        spawn: vi.fn(),
      }));
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: (p: string) =>
            typeof p === "string" && p.endsWith(join("dist", "index.js")) ? false : actual.existsSync(p),
        };
      });
      const service = await import("../service.js");
      expect(() => service.getDaemonScript()).toThrow(/Daemon script not found/);
    });
  });

  describe("getLogPaths", () => {
    it("returns paths under ~/.copilot-teams/", async () => {
      const { getLogPaths } = await import("../service.js");
      const logs = getLogPaths();
      expect(logs.stdout).toContain(".copilot-teams");
      expect(logs.stdout).toContain("daemon.stdout.log");
      expect(logs.stderr).toContain(".copilot-teams");
      expect(logs.stderr).toContain("daemon.stderr.log");
    });
  });

  // ── install / uninstall ──────────────────────────────────────

  describe("install", () => {
    let origExit: typeof process.exit;
    let exitCode: number | undefined;

    beforeEach(() => {
      vi.clearAllMocks();
      exitCode = undefined;
      origExit = process.exit;
      process.exit = vi.fn((code?: number) => {
        exitCode = code ?? 0;
        throw new Error(`process.exit(${code})`);
      }) as any;
    });

    afterEach(() => {
      process.exit = origExit;
    });

    it("calls launchctl on darwin", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: vi.fn(),
        spawn: vi.fn(),
      }));
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return { ...actual, existsSync: () => true };
      });
      const service = await import("../service.js");
      const cp = await import("node:child_process");

      service.install({ platform: "darwin" });

      expect(cp.execFileSync).toHaveBeenCalledWith(
        "launchctl",
        expect.arrayContaining(["load"]),
      );
    });

    it("calls systemctl on linux", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: vi.fn(),
        spawn: vi.fn(),
      }));
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return { ...actual, existsSync: () => true };
      });
      const service = await import("../service.js");
      const cp = await import("node:child_process");

      service.install({ platform: "linux" });

      expect(cp.execFileSync).toHaveBeenCalledWith(
        "systemctl",
        expect.arrayContaining(["--user", "enable", "--now"]),
      );
    });

    it("writes a .vbs file to the Startup folder on win32", async () => {
      vi.resetModules();
      const written = new Map<string, string>();
      vi.doMock("node:child_process", () => ({
        execFileSync: vi.fn(),
        spawn: vi.fn(),
      }));
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: () => true,
          mkdirSync: vi.fn(),
          writeFileSync: vi.fn((path: string, content: string) => {
            written.set(path, content);
          }),
        };
      });
      const service = await import("../service.js");

      service.install({ platform: "win32" });

      const vbsEntries = [...written.entries()].filter(([p]) => p.endsWith(".vbs"));
      expect(vbsEntries.length).toBe(1);
      const [vbsPath, vbsContent] = vbsEntries[0];
      expect(vbsPath).toContain("Startup");
      expect(vbsPath).toContain("CopilotTeamsDaemon.vbs");
      expect(vbsContent).toContain("WScript.Shell");
    });

    it("exits with error on unsupported platform", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: vi.fn(),
        spawn: vi.fn(),
      }));
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return { ...actual, existsSync: () => true };
      });
      const service = await import("../service.js");

      expect(() => service.install({ platform: "freebsd" })).toThrow("process.exit(1)");
      expect(exitCode).toBe(1);
    });
  });

  describe("uninstall", () => {
    let origExit: typeof process.exit;
    let exitCode: number | undefined;

    beforeEach(() => {
      vi.clearAllMocks();
      exitCode = undefined;
      origExit = process.exit;
      process.exit = vi.fn((code?: number) => {
        exitCode = code ?? 0;
        throw new Error(`process.exit(${code})`);
      }) as any;
    });

    afterEach(() => {
      process.exit = origExit;
    });

    it("removes the .vbs file on win32", async () => {
      vi.resetModules();
      const removed: string[] = [];
      vi.doMock("node:child_process", () => ({
        execFileSync: vi.fn(),
        spawn: vi.fn(),
      }));
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: (p: string) =>
            p.endsWith(".vbs") ? true : actual.existsSync(p),
          readFileSync: (p: string, enc?: string) => {
            if (typeof p === "string" && p.endsWith("daemon.json"))
              return JSON.stringify({ pid: 99999 });
            return actual.readFileSync(p, enc as any);
          },
          rmSync: vi.fn((p: string) => {
            removed.push(p);
          }),
        };
      });
      const service = await import("../service.js");

      service.uninstall({ platform: "win32" });

      const vbsRemoved = removed.filter((p) => p.endsWith(".vbs"));
      expect(vbsRemoved.length).toBe(1);
      expect(vbsRemoved[0]).toContain("CopilotTeamsDaemon.vbs");
    });

    it("exits with error on unsupported platform", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: vi.fn(),
        spawn: vi.fn(),
      }));
      const service = await import("../service.js");

      expect(() => service.uninstall({ platform: "freebsd" })).toThrow("process.exit(1)");
      expect(exitCode).toBe(1);
    });
  });
});
