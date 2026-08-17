import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

const LOCAL_ORIGIN = "http://127.0.0.1:3000";
const CLOUDFLARED_PATH = process.env.CLOUDFLARED_PATH ?? "/opt/homebrew/bin/cloudflared";
const LINE_WEBHOOK_SETTINGS_URL = "https://api.line.me/v2/bot/channel/webhook/endpoint";
const LINE_WEBHOOK_TEST_URL = "https://api.line.me/v2/bot/channel/webhook/test";
const PUBLIC_ORIGIN_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu;

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (channelAccessToken === undefined || channelAccessToken.length === 0) {
  throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
}

await waitForLocalServer();
const cloudflared = spawn(CLOUDFLARED_PATH, [
  "tunnel",
  "--no-autoupdate",
  "--protocol",
  "http2",
  "--url",
  LOCAL_ORIGIN,
], {
  stdio: ["ignore", "pipe", "pipe"],
});

let endpointUpdateStarted = false;
let endpointUpdateCompleted = false;
let shuttingDown = false;
const discoveryTimeout = setTimeout(() => {
  if (!endpointUpdateStarted) {
    process.stderr.write("managed_tunnel_error:public_url_timeout\n");
    cloudflared.kill("SIGTERM");
  }
}, 60_000);
discoveryTimeout.unref();

watchOutput(cloudflared.stdout, "stdout");
watchOutput(cloudflared.stderr, "stderr");

cloudflared.once("error", () => {
  process.stderr.write("managed_tunnel_error:cloudflared_spawn\n");
  process.exitCode = 1;
});

cloudflared.once("exit", (code, signal) => {
  clearTimeout(discoveryTimeout);
  if (!shuttingDown) {
    const reason = signal === null ? `code_${code ?? "unknown"}` : `signal_${signal}`;
    process.stderr.write(`managed_tunnel_exit:${reason}\n`);
    process.exitCode = 1;
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shuttingDown = true;
    clearTimeout(discoveryTimeout);
    cloudflared.kill("SIGTERM");
  });
}

function watchOutput(stream: NodeJS.ReadableStream, source: "stderr" | "stdout"): void {
  const lines = createInterface({ input: stream });
  lines.on("line", (line) => {
    const origin = PUBLIC_ORIGIN_PATTERN.exec(line)?.[0];
    if (origin === undefined) {
      if (/\b(?:ERR|WRN)\b/u.test(line)) {
        process.stderr.write(`cloudflared_${source}:${line.slice(0, 1_000)}\n`);
      }
      return;
    }
    if (endpointUpdateStarted) return;
    endpointUpdateStarted = true;
    clearTimeout(discoveryTimeout);
    process.stdout.write(`managed_tunnel_allocated:${origin}\n`);
    void configureLineWebhook(cloudflared, origin).catch((error: unknown) => {
      const code = error instanceof Error ? error.message : "unknown";
      process.stderr.write(`managed_tunnel_error:webhook_configuration:${code}\n`);
      cloudflared.kill("SIGTERM");
    });
  });
}

async function configureLineWebhook(
  tunnel: ChildProcess,
  publicOrigin: string,
): Promise<void> {
  const endpoint = `${publicOrigin}/webhooks/line`;
  await waitForLineWebhookTest(endpoint, tunnel);
  await lineRequest(LINE_WEBHOOK_SETTINGS_URL, "PUT", { endpoint });

  const settingsResponse = await fetch(LINE_WEBHOOK_SETTINGS_URL, {
    headers: { Authorization: `Bearer ${channelAccessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!settingsResponse.ok) {
    throw new Error(`line_webhook_settings_failed:${settingsResponse.status}`);
  }
  const settings: unknown = await settingsResponse.json();
  if (!isWebhookSettings(settings) || settings.endpoint !== endpoint || !settings.active) {
    throw new Error("line_webhook_settings_mismatch");
  }

  endpointUpdateCompleted = true;
  process.stdout.write(`managed_tunnel_ready:${endpoint}\n`);
}

async function lineRequest(
  url: string,
  method: "POST" | "PUT",
  body: Readonly<Record<string, string>>,
): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`line_webhook_request_failed:${response.status}`);
  const responseText = await response.text();
  return responseText.length === 0 ? null : JSON.parse(responseText) as unknown;
}

async function waitForLocalServer(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${LOCAL_ORIGIN}/readyz`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // launchd starts both services independently; the server may need time.
    }
    await delay(1_000);
  }
  throw new Error("local_server_not_ready");
}

async function waitForLineWebhookTest(
  endpoint: string,
  tunnel: ChildProcess,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (tunnel.exitCode !== null || tunnel.signalCode !== null) {
      throw new Error("cloudflared_exited_before_ready");
    }
    try {
      const result = await lineRequest(LINE_WEBHOOK_TEST_URL, "POST", { endpoint });
      if (isWebhookTestResult(result) && result.success) return;
    } catch {
      // LINE's resolver may need a few seconds to see a new quick-tunnel host.
    }
    await delay(1_000);
  }
  throw new Error("line_webhook_test_timeout");
}

function isWebhookSettings(value: unknown): value is { endpoint: string; active: boolean } {
  return isRecord(value) && typeof value.endpoint === "string" && typeof value.active === "boolean";
}

function isWebhookTestResult(value: unknown): value is { success: boolean } {
  return isRecord(value) && typeof value.success === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

process.on("beforeExit", () => {
  if (!shuttingDown && !endpointUpdateCompleted && cloudflared.exitCode === null) {
    cloudflared.kill("SIGTERM");
  }
});
