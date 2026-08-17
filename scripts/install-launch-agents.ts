import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const workspace = await realpath(process.cwd());
const nodePath = await realpath(process.execPath);
const cloudflaredPath = findExecutable("cloudflared");
const userId = process.getuid?.();
if (userId === undefined) throw new Error("launchd installation requires macOS");

await access(resolve(workspace, ".env"));
await access(resolve(workspace, "dist/server.js"));
await access(resolve(workspace, "dist/runtime/managed-line-tunnel.js"));
await mkdir(resolve(workspace, ".local/logs"), { recursive: true });
const launchAgentsDirectory = resolve(homedir(), "Library/LaunchAgents");
await mkdir(launchAgentsDirectory, { recursive: true });

const labels = ["com.dinero.line-bot.server", "com.dinero.line-bot.tunnel"] as const;
for (const label of labels) {
  const templatePath = resolve(workspace, `ops/launchd/${label}.plist.template`);
  const destinationPath = resolve(launchAgentsDirectory, `${label}.plist`);
  const template = await readFile(templatePath, "utf8");
  const rendered = template
    .replaceAll("__WORKSPACE__", escapeXml(workspace))
    .replaceAll("__NODE_PATH__", escapeXml(nodePath))
    .replaceAll("__CLOUDFLARED_PATH__", escapeXml(cloudflaredPath));
  await writeFile(destinationPath, rendered, { encoding: "utf8", mode: 0o600 });
  await chmod(destinationPath, 0o600);
  run("/usr/bin/plutil", ["-lint", destinationPath]);
}

for (const label of [...labels].reverse()) {
  spawnSync("/bin/launchctl", ["bootout", `gui/${userId}/${label}`], {
    stdio: "ignore",
  });
}
for (const label of labels) {
  const destinationPath = resolve(launchAgentsDirectory, `${label}.plist`);
  await bootstrapWithRetry(userId, destinationPath);
  run("/bin/launchctl", ["kickstart", `gui/${userId}/${label}`]);
}

process.stdout.write(`launch_agents_installed:${labels.join(",")}\n`);

function findExecutable(name: string): string {
  const result = spawnSync("/usr/bin/which", [name], {
    encoding: "utf8",
    env: process.env,
  });
  const path = result.stdout.trim();
  if (result.status !== 0 || path.length === 0) {
    throw new Error(`${name} is required`);
  }
  return path;
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}`);
  }
}

async function bootstrapWithRetry(userId: number, plistPath: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = spawnSync("/bin/launchctl", ["bootstrap", `gui/${userId}`, plistPath], {
      stdio: attempt === 9 ? "inherit" : "ignore",
    });
    if (result.status === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * (attempt + 1)));
  }
  throw new Error("command failed: /bin/launchctl bootstrap");
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character]!);
}
