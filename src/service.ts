/**
 * Daemon service installer / uninstaller.
 *
 * `install()`   — registers the copilot-teams daemon as an auto-start
 *                  background service and starts it immediately.
 * `uninstall()` — stops the daemon and removes the auto-start registration.
 */

import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { execFileSync } from "node:child_process";

// ── Constants ───────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".copilot-teams");

const STDOUT_LOG = join(CONFIG_DIR, "daemon.stdout.log");
const STDERR_LOG = join(CONFIG_DIR, "daemon.stderr.log");

const LAUNCHD_LABEL = "com.copilot-teams.daemon";
const LAUNCHD_PLIST = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);

const SYSTEMD_UNIT = "copilot-teams.service";
const SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");
const SYSTEMD_SERVICE = join(SYSTEMD_DIR, SYSTEMD_UNIT);

// ── Helpers ─────────────────────────────────────────────────────

/** Returns the absolute path of the running Node.js binary. */
export function getNodePath(): string {
  return process.execPath;
}

/** Resolves `dist/index.js` relative to the package root. */
export function getDaemonScript(): string {
  const packageRoot = resolve(import.meta.dirname, "..");
  const script = join(packageRoot, "dist", "index.js");
  if (!existsSync(script)) {
    throw new Error(`Daemon script not found: ${script}`);
  }
  return script;
}

/** Returns the paths used for stdout / stderr logs. */
export function getLogPaths(): { stdout: string; stderr: string } {
  return { stdout: STDOUT_LOG, stderr: STDERR_LOG };
}

// ── macOS (launchd) ─────────────────────────────────────────────

function launchdPlist(nodePath: string, daemonScript: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${daemonScript}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>${STDOUT_LOG}</string>

  <key>StandardErrorPath</key>
  <string>${STDERR_LOG}</string>
</dict>
</plist>
`;
}

function installDarwin(nodePath: string, daemonScript: string): void {
  const agentsDir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(agentsDir, { recursive: true });

  writeFileSync(LAUNCHD_PLIST, launchdPlist(nodePath, daemonScript));
  execFileSync("launchctl", ["load", "-w", LAUNCHD_PLIST]);

  console.log(`✅ Installed launchd service: ${LAUNCHD_PLIST}`);
}

function uninstallDarwin(): void {
  if (!existsSync(LAUNCHD_PLIST)) {
    console.log("Service is not installed.");
    return;
  }
  try {
    execFileSync("launchctl", ["unload", "-w", LAUNCHD_PLIST]);
  } catch {
    // service may already be unloaded
  }
  rmSync(LAUNCHD_PLIST, { force: true });
  console.log("✅ Uninstalled launchd service.");
}

// ── Linux (systemd user) ────────────────────────────────────────

function systemdUnit(nodePath: string, daemonScript: string): string {
  return `[Unit]
Description=Copilot Teams Daemon

[Service]
ExecStart=${nodePath} ${daemonScript}
Restart=on-failure
StandardOutput=append:${STDOUT_LOG}
StandardError=append:${STDERR_LOG}

[Install]
WantedBy=default.target
`;
}

function installLinux(nodePath: string, daemonScript: string): void {
  mkdirSync(SYSTEMD_DIR, { recursive: true });

  writeFileSync(SYSTEMD_SERVICE, systemdUnit(nodePath, daemonScript));
  execFileSync("systemctl", ["--user", "daemon-reload"]);
  execFileSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);

  console.log(`✅ Installed systemd user service: ${SYSTEMD_SERVICE}`);
}

function uninstallLinux(): void {
  if (!existsSync(SYSTEMD_SERVICE)) {
    console.log("Service is not installed.");
    return;
  }
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
  } catch {
    // service may already be disabled
  }
  rmSync(SYSTEMD_SERVICE, { force: true });
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"]);
  } catch {
    // best-effort reload
  }
  console.log("✅ Uninstalled systemd user service.");
}

// ── Public API ──────────────────────────────────────────────────

export function install(overrides?: { platform?: string }): void {
  const nodePath = getNodePath();
  const daemonScript = getDaemonScript();
  const os = overrides?.platform ?? platform();

  mkdirSync(CONFIG_DIR, { recursive: true });

  switch (os) {
    case "darwin":
      installDarwin(nodePath, daemonScript);
      break;
    case "linux":
      installLinux(nodePath, daemonScript);
      break;
    default:
      console.error(`❌ Unsupported platform: ${os}`);
      process.exit(1);
  }

  console.log(`   Logs: ${STDOUT_LOG}`);
  console.log(`          ${STDERR_LOG}`);
}

export function uninstall(overrides?: { platform?: string }): void {
  const os = overrides?.platform ?? platform();

  switch (os) {
    case "darwin":
      uninstallDarwin();
      break;
    case "linux":
      uninstallLinux();
      break;
    default:
      console.error(`❌ Unsupported platform: ${os}`);
      process.exit(1);
  }
}
