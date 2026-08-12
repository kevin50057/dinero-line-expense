import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Pool } from "pg";

import type { LineEventInbox } from "./webhook.js";
import { handleLineWebhook } from "./webhook.js";

const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

export interface HttpServerDependencies {
  port: number;
  channelSecret: string;
  allowedGroupId: string;
  allowedMemberUserIds: ReadonlySet<string>;
  inbox: LineEventInbox;
  healthCheck?: () => Promise<void>;
}

export function startHttpServer(dependencies: HttpServerDependencies) {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && request.url === "/readyz") {
      if (dependencies.healthCheck === undefined) {
        sendJson(response, 200, { status: "ready" });
        return;
      }

      try {
        await dependencies.healthCheck();
        sendJson(response, 200, { status: "ready" });
      } catch {
        sendJson(response, 503, { status: "unavailable" });
      }
      return;
    }

    if (request.method !== "POST" || request.url !== "/webhooks/line") {
      sendJson(response, 404, { code: "not_found" });
      return;
    }

    try {
      const rawBody = await readBody(request, MAX_WEBHOOK_BODY_BYTES);
      const signatureHeader = request.headers["x-line-signature"];
      const signature = Array.isArray(signatureHeader)
        ? signatureHeader[0]
        : signatureHeader;
      const result = await handleLineWebhook(rawBody, signature, dependencies);
      sendJson(response, result.status, { code: result.code });
    } catch (error) {
      const status = error instanceof BodyTooLargeError ? 413 : 500;
      const code = error instanceof BodyTooLargeError ? "body_too_large" : "internal_error";
      sendJson(response, status, { code });
    }
  });

  server.listen(dependencies.port);
  return server;
}

export function postgresHealthCheck(
  pool: Pick<Pool, "query">,
): () => Promise<void> {
  return async () => {
    await pool.query("SELECT 1");
  };
}

class BodyTooLargeError extends Error {}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > maximumBytes) {
      request.destroy();
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, receivedBytes);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
