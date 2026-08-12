import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AcceptedLineEvent } from "../../src/http/webhook.js";
import {
  LineInboxLedgerNotFoundError,
  PostgresLineEventInbox,
} from "../../src/infra/postgres-line-event-inbox.js";
import type { NormalizedLineEvent } from "../../src/line/events.js";

const { Client, Pool } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithPostgres("PostgresLineEventInbox integration", () => {
  const schemaName = `inbox_test_${randomBytes(8).toString("hex")}`;
  let adminClient: InstanceType<typeof Client>;
  let pool: InstanceType<typeof Pool>;
  let ledgerId: string;

  beforeAll(async () => {
    adminClient = new Client({ connectionString: testDatabaseUrl });
    await adminClient.connect();
    await adminClient.query("SELECT pg_advisory_lock(1947823612)");
    await adminClient.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await adminClient.query("SELECT pg_advisory_unlock(1947823612)");
    await adminClient.query(`CREATE SCHEMA ${schemaName}`);
    await adminClient.query(`SET search_path TO ${schemaName}, public`);
    const migration = await readFile(
      resolve(process.cwd(), "db/migrations/001_initial.up.sql"),
      "utf8",
    );
    await adminClient.query(
      migration.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""),
    );

    const ledger = await adminClient.query<{ id: string }>(
      `INSERT INTO ledger (name, line_group_id)
       VALUES ('Inbox test ledger', 'C-ledger')
       RETURNING id::text AS id`,
    );
    ledgerId = ledger.rows[0]!.id;

    pool = new Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 2,
    });
  }, 20_000);

  afterAll(async () => {
    await pool?.end();
    if (adminClient !== undefined) {
      await adminClient.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminClient.end();
    }
  });

  it("atomically inserts a batch and persists plaintext only for authorized text", async () => {
    const encryptDeliveryCredential = vi.fn((plaintext: string) =>
      Buffer.from(`encrypted:${plaintext}`, "utf8"),
    );
    const inbox = new PostgresLineEventInbox(pool, {
      encryptDeliveryCredential,
    });

    await inbox.acceptBatch("U-bot", [
      acceptedEvent(textEvent("E-authorized", "M-authorized", "牛肉麵 150")),
      acceptedEvent(
        textEvent("E-unauthorized", "M-unauthorized", "不能保存的秘密 999"),
        false,
      ),
      acceptedEvent({
        ...baseEvent("E-unsend", "unsend"),
        lineMessageId: "M-authorized",
        source: { type: "group", groupId: "C-ledger" },
      }),
    ]);

    const result = await pool.query<{
      webhook_event_id: string;
      ledger_id: string;
      event_type: string;
      payload_json: unknown;
      status: string;
      outcome_code: string | null;
    }>(
      `SELECT webhook_event_id, ledger_id::text, event_type, payload_json,
              status::text, outcome_code
         FROM inbound_event
        WHERE webhook_event_id LIKE 'E-%'
        ORDER BY webhook_event_id`,
    );

    expect(result.rows).toHaveLength(3);
    const authorized = result.rows.find(
      (row) => row.webhook_event_id === "E-authorized",
    );
    expect(authorized).toMatchObject({
      ledger_id: ledgerId,
      event_type: "message",
      status: "pending",
      outcome_code: null,
      payload_json: {
        destination: "U-bot",
        source: { userId: "U-ming" },
        message: { type: "text", text: "牛肉麵 150" },
        replyTokenCiphertext: Buffer.from(
          "encrypted:reply-E-authorized",
        ).toString("base64"),
      },
    });
    expect(JSON.stringify(authorized?.payload_json)).not.toContain(
      "reply-E-authorized",
    );

    expect(
      result.rows.find((row) => row.webhook_event_id === "E-unauthorized"),
    ).toMatchObject({
      payload_json: null,
      status: "succeeded",
      outcome_code: "unauthorized",
    });
    expect(
      result.rows.find((row) => row.webhook_event_id === "E-unsend"),
    ).toMatchObject({ payload_json: null, status: "pending" });
    expect(encryptDeliveryCredential).toHaveBeenCalledTimes(1);
  });

  it("is idempotent for the same ledger and webhook event ID", async () => {
    const inbox = testInbox();
    const event = acceptedEvent(
      textEvent("E-redelivery", "M-redelivery", "炒麵 80"),
    );

    await inbox.acceptBatch("U-bot", [event]);
    await inbox.acceptBatch("U-bot", [event]);

    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM inbound_event
        WHERE ledger_id = $1 AND webhook_event_id = 'E-redelivery'`,
      [ledgerId],
    );
    expect(result.rows[0]?.count).toBe("1");
  });

  it("rolls back the whole batch when any event has no ledger", async () => {
    const inbox = testInbox();
    const known = acceptedEvent(
      textEvent("E-before-missing", "M-before-missing", "便當 120"),
    );
    const missing = acceptedEvent({
      ...textEvent("E-missing-ledger", "M-missing-ledger", "電影 320"),
      source: {
        type: "group",
        groupId: "C-does-not-exist",
        userId: "U-ming",
      },
    });

    await expect(inbox.acceptBatch("U-bot", [known, missing])).rejects.toBeInstanceOf(
      LineInboxLedgerNotFoundError,
    );

    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM inbound_event
        WHERE webhook_event_id IN ('E-before-missing', 'E-missing-ledger')`,
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("acknowledges an unauthorized foreign group without retrying it forever", async () => {
    const inbox = testInbox();
    const foreign = acceptedEvent(
      {
        ...textEvent("E-foreign-group", "M-foreign-group", "不能保存 999"),
        source: {
          type: "group",
          groupId: "C-foreign",
          userId: "U-stranger",
        },
      },
      false,
    );
    const foreignWithRoutingDenial: AcceptedLineEvent = {
      ...foreign,
      authorization: { authorized: false, reason: "group_not_allowed" },
    };

    await expect(
      inbox.acceptBatch("U-bot", [foreignWithRoutingDenial]),
    ).resolves.toBeUndefined();

    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM inbound_event
        WHERE webhook_event_id = 'E-foreign-group'`,
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("keeps non-text content empty and stores only minimal edit/join delivery metadata", async () => {
    const inbox = testInbox();
    await inbox.acceptBatch("U-bot", [
      acceptedEvent({
        ...baseEvent("E-image", "message"),
        lineMessageId: "M-image",
        message: { id: "M-image", type: "image" },
      }),
      acceptedEvent({
        ...textEvent("E-edit", "M-edit", "編輯後秘密 180"),
        kind: "edit",
        rawType: "messageEdited",
      }),
      acceptedEvent({
        ...baseEvent("E-join", "join"),
        rawType: "join",
        replyToken: "reply-E-join",
      }),
    ]);

    const result = await pool.query<{ webhook_event_id: string; payload_json: unknown }>(
      `SELECT webhook_event_id, payload_json
         FROM inbound_event
        WHERE webhook_event_id IN ('E-image', 'E-edit', 'E-join')
        ORDER BY webhook_event_id`,
    );
    expect(result.rows).toHaveLength(3);
    expect(result.rows.find((row) => row.webhook_event_id === "E-image")?.payload_json).toBeNull();
    expect(result.rows.find((row) => row.webhook_event_id === "E-edit")?.payload_json).toMatchObject({
      destination: "U-bot",
      source: { userId: "U-ming" },
      event: { kind: "edit" },
    });
    expect(result.rows.find((row) => row.webhook_event_id === "E-join")?.payload_json).toMatchObject({
      destination: "U-bot",
      source: {},
      event: { kind: "join" },
    });
    expect(JSON.stringify(result.rows)).not.toContain("編輯後秘密");
    expect(JSON.stringify(result.rows)).not.toContain("reply-E-edit");
    expect(JSON.stringify(result.rows)).not.toContain("reply-E-join");
  });

  function testInbox(): PostgresLineEventInbox {
    return new PostgresLineEventInbox(pool, {
      encryptDeliveryCredential: (plaintext) =>
        Buffer.from(`encrypted:${plaintext}`, "utf8"),
    });
  }
});

function baseEvent(
  webhookEventId: string,
  kind: NormalizedLineEvent["kind"],
): NormalizedLineEvent {
  return {
    webhookEventId,
    kind,
    rawType: kind,
    lineEventAtMs: Date.UTC(2026, 7, 13, 4, 10),
    source: { type: "group", groupId: "C-ledger" },
    isRedelivery: false,
  };
}

function textEvent(
  webhookEventId: string,
  messageId: string,
  text: string,
): NormalizedLineEvent {
  return {
    ...baseEvent(webhookEventId, "message"),
    source: {
      type: "group",
      groupId: "C-ledger",
      userId: "U-ming",
    },
    lineMessageId: messageId,
    message: { id: messageId, type: "text", text },
    replyToken: `reply-${webhookEventId}`,
  };
}

function acceptedEvent(
  event: NormalizedLineEvent,
  authorized = true,
): AcceptedLineEvent {
  return {
    event,
    authorization: authorized
      ? { authorized: true }
      : { authorized: false, reason: "member_not_allowed" },
  };
}
