#!/usr/bin/env node

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const action = process.argv[2];
if (!["install", "uninstall"].includes(action)) {
  console.error("Usage: manage-launch-agents.mjs <install|uninstall>");
  process.exit(1);
}

if (process.platform !== "darwin") {
  console.error("The launch agent installer is only supported on macOS.");
  process.exit(1);
}

const uid = process.getuid?.();
if (uid === undefined) {
  console.error("Could not determine the current user ID.");
  process.exit(1);
}

const home = homedir();
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launchAgentsDirectory = resolve(home, "Library/LaunchAgents");
const logsDirectory = resolve(home, "Library/Logs/teamsmonkey");
const domain = `gui/${uid}`;
const debugArguments = "--remote-debugging-port=9223";

const agents = [
  {
    label: "com.guyfaux.teamsmonkey-env",
    plist: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.guyfaux.teamsmonkey-env</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/launchctl</string>
    <string>setenv</string>
    <string>WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS</string>
    <string>${debugArguments}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`,
  },
  {
    label: "com.guyfaux.teamsmonkey-loader",
    plist: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.guyfaux.teamsmonkey-loader</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(resolve(repository, "teamsmonkey-loader.mjs"))}</string>
    <string>--port</string>
    <string>9223</string>
    <string>--scripts</string>
    <string>${escapeXml(resolve(process.env.TEAMSMONKEY_SCRIPT_PATH ?? resolve(home, ".config/teamsmonkey/scripts")))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repository)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(resolve(logsDirectory, "loader.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(resolve(logsDirectory, "loader-error.log"))}</string>
</dict>
</plist>
`,
  },
];

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function runLaunchctl(args, allowedStatuses = [0]) {
  const result = spawnSync("/bin/launchctl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!allowedStatuses.includes(result.status)) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`launchctl ${args.join(" ")} failed: ${detail}`);
  }
}

function plistPath(agent) {
  return resolve(launchAgentsDirectory, `${agent.label}.plist`);
}

function unload(agent) {
  runLaunchctl(["bootout", `${domain}/${agent.label}`], [0, 3]);
}

function install() {
  mkdirSync(launchAgentsDirectory, { recursive: true });
  mkdirSync(logsDirectory, { recursive: true });

  for (const agent of agents) {
    unload(agent);
    writeFileSync(plistPath(agent), agent.plist, "utf8");
    runLaunchctl(["bootstrap", domain, plistPath(agent)]);
  }

  runLaunchctl([
    "setenv",
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    debugArguments,
  ]);
  console.log("Installed and started the Teams userscript launch agents.");
  console.log("Fully quit and reopen Teams to enable its CDP endpoint.");
  console.log(`Loader logs: ${resolve(logsDirectory, "loader.log")}`);
}

function uninstall() {
  for (const agent of agents.toReversed()) {
    unload(agent);
    rmSync(plistPath(agent), { force: true });
  }
  runLaunchctl(["unsetenv", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"]);
  console.log("Stopped and removed the Teams userscript launch agents.");
  console.log("Fully quit and reopen Teams to disable its CDP endpoint.");
}

if (action === "install") {
  install();
} else {
  uninstall();
}
