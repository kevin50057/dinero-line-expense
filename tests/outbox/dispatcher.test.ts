import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createCredentialCipher } from "../../src/security/credential-cipher.js";
import {
  PostgresLineReplyOutboxDispatcher,
  type LineReplyClient,
} from "../../src/outbox/index.js";

interface FakeResult {
  readonly rows: readonly unknown[];
  readonly rowCount: number | null;
}

interface RecordedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

type QueryHandler = (
  sql: string,
  parameters: readonly unknown[],
) => FakeResult | Promise<FakeResult>;

const fixedNow = new Date("2026-08-13T04:00:00.000Z");
const cipher = createCredentialCipher(Buffer.alloc(32, 7));

function fakePool(handler: QueryHandler): {
  pool: Pick<Pool, "connect">;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const pool = {
    async connect() {
      return {
        async query(sql: string, parameters: unknown[] = []) {
          queries.push({ sql, parameters });
          return handler(sql, parameters);
        },
        release() {},
      };
    },
  } as unknown as Pick<Pool, "connect">;
  return { pool, queries };
}

function claimedRow(
  overrides: Partial<{
    payload_json: unknown;
    attempt_count: number;
    previous_attempt_count: number;
    created_at: Date;
    expires_at: Date;
    locked_at: Date;
    delivery_credential_ciphertext: Buffer | null;
  }> = {},
) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    payload_json: { messages: [{ type: "text", text: "已記帳" }] },
    attempt_count: 1,
    previous_attempt_count: 0,
    created_at: new Date(fixedNow.getTime() - 1_000),
    expires_at: new Date(fixedNow.getTime() + 54_000),
    locked_at: fixedNow,
    delivery_credential_ciphertext: cipher.encrypt("reply-token"),
    ...overrides,
  };
}

function processPool(
  row: ReturnType<typeof claimedRow>,
  finalRowCount = 1,
) {
  return fakePool((sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: null };
    }
    if (sql.includes("WITH next_message AS")) {
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: finalRowCount };
  });
}

describe("PostgresLineReplyOutboxDispatcher", () => {
  it("claims with SKIP LOCKED, delivers once, and clears the sent token", async () => {
    const row = claimedRow();
    const database = processPool(row);
    const deliver = vi
      .fn<LineReplyClient["deliver"]>()
      .mockResolvedValue({ kind: "success" });
    const dispatcher = new PostgresLineReplyOutboxDispatcher({
      pool: database.pool,
      credentialCipher: cipher,
      lineClient: { deliver },
      now: () => fixedNow,
    });

    await expect(dispatcher.processOne()).resolves.toEqual({
      status: "sent",
      id: row.id,
    });
    expect(deliver).toHaveBeenCalledWith("reply-token", {
      messages: [{ type: "text", text: "已記帳" }],
    });

    const claim = database.queries.find((query) =>
      query.sql.includes("WITH next_message AS"),
    );
    expect(claim?.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(claim?.sql).toContain("delivery_kind = 'line_reply'");
    const sent = database.queries.find((query) =>
      query.sql.includes("status = 'sent'::outbox_status"),
    );
    expect(sent?.sql).toContain("delivery_credential_ciphertext = NULL");
    expect(JSON.stringify(sent?.parameters)).not.toContain("reply-token");
  });

  it("dead-letters an expired reply token without calling LINE", async () => {
    const row = claimedRow({
      created_at: new Date(fixedNow.getTime() - 55_000),
      expires_at: fixedNow,
    });
    const database = processPool(row);
    const deliver = vi.fn<LineReplyClient["deliver"]>();
    const dispatcher = new PostgresLineReplyOutboxDispatcher({
      pool: database.pool,
      credentialCipher: cipher,
      lineClient: { deliver },
      now: () => fixedNow,
    });

    await expect(dispatcher.processOne()).resolves.toEqual({
      status: "dead_letter",
      id: row.id,
      errorCode: "reply_token_expired",
    });
    expect(deliver).not.toHaveBeenCalled();
    const dead = database.queries.find((query) =>
      query.sql.includes("status = 'dead_letter'::outbox_status"),
    );
    expect(dead?.sql).toContain("delivery_credential_ciphertext = NULL");
  });

  it("dead-letters malformed payload at runtime", async () => {
    const row = claimedRow({
      payload_json: { messages: [{ type: "image", original: "secret" }] },
    });
    const database = processPool(row);
    const deliver = vi.fn<LineReplyClient["deliver"]>();
    const dispatcher = new PostgresLineReplyOutboxDispatcher({
      pool: database.pool,
      credentialCipher: cipher,
      lineClient: { deliver },
      now: () => fixedNow,
    });

    await expect(dispatcher.processOne()).resolves.toMatchObject({
      status: "dead_letter",
      errorCode: "invalid_payload",
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("schedules a bounded retry while the token remains valid", async () => {
    const row = claimedRow();
    const database = processPool(row);
    const dispatcher = new PostgresLineReplyOutboxDispatcher({
      pool: database.pool,
      credentialCipher: cipher,
      lineClient: {
        async deliver() {
          return {
            kind: "retryable_failure",
            errorCode: "line_http_500",
          };
        },
      },
      now: () => fixedNow,
    });

    await expect(dispatcher.processOne()).resolves.toEqual({
      status: "retry_scheduled",
      id: row.id,
      attemptCount: 1,
      availableAt: new Date(fixedNow.getTime() + 500),
    });
    const retry = database.queries.find((query) =>
      query.sql.includes("status = 'pending'::outbox_status"),
    );
    expect(retry?.sql).not.toContain("delivery_credential_ciphertext = NULL");
    expect(retry?.parameters[3]).toBe("line_http_500");
  });

  it("dead-letters a retryable failure after the final attempt", async () => {
    const row = claimedRow({
      attempt_count: 3,
      previous_attempt_count: 2,
    });
    const database = processPool(row);
    const deliver = vi
      .fn<LineReplyClient["deliver"]>()
      .mockResolvedValue({
        kind: "retryable_failure",
        errorCode: "line_http_429",
      });
    const dispatcher = new PostgresLineReplyOutboxDispatcher({
      pool: database.pool,
      credentialCipher: cipher,
      lineClient: { deliver },
      now: () => fixedNow,
      maxAttempts: 3,
    });

    await expect(dispatcher.processOne()).resolves.toMatchObject({
      status: "dead_letter",
      errorCode: "line_http_429",
    });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("does not add a push fallback when no retry fits before expiry", async () => {
    const row = claimedRow({
      created_at: new Date(fixedNow.getTime() - 54_900),
      expires_at: new Date(fixedNow.getTime() + 100),
    });
    const database = processPool(row);
    const dispatcher = new PostgresLineReplyOutboxDispatcher({
      pool: database.pool,
      credentialCipher: cipher,
      lineClient: {
        async deliver() {
          return {
            kind: "retryable_failure",
            errorCode: "line_network_error",
          };
        },
      },
      now: () => fixedNow,
    });

    await expect(dispatcher.processOne()).resolves.toMatchObject({
      status: "dead_letter",
      errorCode: "line_network_error",
    });
    expect(
      database.queries.some((query) =>
        query.sql.toLowerCase().includes("push"),
      ),
    ).toBe(false);
  });

  it("reports a lost lease instead of overwriting a recovered row", async () => {
    const row = claimedRow();
    const database = processPool(row, 0);
    const dispatcher = new PostgresLineReplyOutboxDispatcher({
      pool: database.pool,
      credentialCipher: cipher,
      lineClient: { async deliver() { return { kind: "success" }; } },
      now: () => fixedNow,
    });

    await expect(dispatcher.processOne()).resolves.toEqual({
      status: "lease_lost",
      id: row.id,
    });
    const final = database.queries.at(-1);
    expect(final?.sql).toContain("locked_at = $2");
  });

  it("recovers abandoned leases and clears credentials for exhausted rows", async () => {
    const database = fakePool((sql) => {
      expect(sql).toContain("delivery_kind = 'line_reply'");
      expect(sql).toContain("delivery_credential_ciphertext = CASE");
      return {
        rows: [
          { status: "pending" },
          { status: "pending" },
          { status: "dead_letter" },
        ],
        rowCount: 3,
      };
    });
    const dispatcher = new PostgresLineReplyOutboxDispatcher({
      pool: database.pool,
      credentialCipher: cipher,
      lineClient: { async deliver() { return { kind: "success" }; } },
      now: () => fixedNow,
      maxAttempts: 3,
      leaseTimeoutMs: 30_000,
    });

    await expect(dispatcher.recoverExpiredLeases()).resolves.toEqual({
      recoveredToPending: 2,
      deadLettered: 1,
    });
    expect(database.queries[0]?.parameters).toEqual([
      fixedNow,
      30_000,
      3,
    ]);
  });

  it("returns idle when no pending reply is claimable", async () => {
    const database = fakePool((sql) => {
      if (sql.includes("WITH next_message AS")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: null };
    });
    const dispatcher = new PostgresLineReplyOutboxDispatcher({
      pool: database.pool,
      credentialCipher: cipher,
      lineClient: { async deliver() { return { kind: "success" }; } },
      now: () => fixedNow,
    });

    await expect(dispatcher.processOne()).resolves.toEqual({ status: "idle" });
  });
});
