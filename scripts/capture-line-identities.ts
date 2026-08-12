import { createServer, type IncomingMessage } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  parseLineWebhookBody,
  verifyLineWebhookSignature,
} from "../src/line/index.js";

const port = Number(process.env.PORT ?? "3000");
const channelSecret = process.env.LINE_CHANNEL_SECRET;
const outputPath = resolve(".local/line-bootstrap.json");

if (channelSecret === undefined || channelSecret.length === 0) {
  throw new Error("LINE_CHANNEL_SECRET is required");
}

interface CapturedIdentity {
  readonly groupId: string;
  readonly userIds: readonly string[];
  readonly updatedAt: string;
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    send(response, 200, "ok");
    return;
  }
  if (request.method !== "POST" || request.url !== "/webhooks/line") {
    send(response, 404, "not_found");
    return;
  }

  const body = await readBody(request);
  const signatureHeader = request.headers["x-line-signature"];
  const signature = Array.isArray(signatureHeader)
    ? signatureHeader[0]
    : signatureHeader;
  if (!verifyLineWebhookSignature(body, signature, channelSecret)) {
    send(response, 401, "invalid_signature");
    return;
  }

  let webhook;
  try {
    webhook = parseLineWebhookBody(body);
  } catch {
    send(response, 400, "invalid_body");
    return;
  }

  const current = await readCapturedIdentity();
  let groupId = current?.groupId;
  const userIds = new Set(current?.userIds ?? []);
  for (const event of webhook.events) {
    if (event.source.type !== "group" || event.source.groupId === undefined) {
      continue;
    }
    groupId ??= event.source.groupId;
    if (event.source.groupId !== groupId) {
      continue;
    }
    if (event.source.userId !== undefined) {
      userIds.add(event.source.userId);
    }
  }

  if (groupId !== undefined) {
    await saveCapturedIdentity({
      groupId,
      userIds: [...userIds].slice(0, 2),
      updatedAt: new Date().toISOString(),
    });
  }
  send(response, 200, "accepted");
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`line_identity_capture_listening:${port}\n`);
});

async function readCapturedIdentity(): Promise<CapturedIdentity | null> {
  try {
    const value = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.groupId !== "string" || !Array.isArray(record.userIds)) {
      return null;
    }
    return {
      groupId: record.groupId,
      userIds: record.userIds.filter((item): item is string => typeof item === "string"),
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    };
  } catch {
    return null;
  }
}

async function saveCapturedIdentity(value: CapturedIdentity): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > 1_048_576) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function send(
  response: import("node:http").ServerResponse,
  status: number,
  code: string,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ code }));
}
