import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AcceptedLineEvent } from "../../src/http/webhook.js";
import {
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
    const migrationDirectory = resolve(process.cwd(), "db/migrations");
    const migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
    for (const name of migrations) {
      const migration = await readFile(resolve(migrationDirectory, name), "utf8");
      await adminClient.query(migration.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""));
    }

    const ledger = await adminClient.query<{ id: string }>(
      `INSERT INTO ledger (name, line_group_id)
       VALUES ('Inbox test ledger', 'C-ledger')
       RETURNING id::text AS id`,
    );
    ledgerId = ledger.rows[0]!.id;
    await adminClient.query(
      `INSERT INTO member (ledger_id, line_user_id, display_name)
       VALUES ($1, 'U-private', '私聊會員')`,
      [ledgerId],
    );

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
      acceptedEvent(
        { ...textEvent("E-pairing", "M-pairing", "配對"), source: { type: "group", groupId: "C-ledger", userId: "U-partner" } },
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

    expect(result.rows).toHaveLength(4);
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
      result.rows.find((row) => row.webhook_event_id === "E-pairing"),
    ).toMatchObject({
      payload_json: {
        source: { userId: "U-partner" },
        message: { type: "text", text: "配對" },
      },
      status: "pending",
      outcome_code: null,
    });
    expect(
      result.rows.find((row) => row.webhook_event_id === "E-unsend"),
    ).toMatchObject({ payload_json: null, status: "pending" });
    expect(encryptDeliveryCredential).toHaveBeenCalledTimes(2);
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

  it("routes a one-to-one message to the member's configured ledger", async () => {
    const inbox = testInbox();
    const privateMessage = {
      ...textEvent("E-private", "M-private", "咖啡 80"),
      source: { type: "user", userId: "U-private" },
    };

    await inbox.acceptBatch("U-bot", [acceptedEvent(privateMessage)]);

    const result = await pool.query<{ ledger_id: string; payload_json: unknown }>(
      `SELECT ledger_id::text, payload_json FROM inbound_event
        WHERE webhook_event_id = 'E-private'`,
    );
    expect(result.rows[0]).toMatchObject({
      ledger_id: ledgerId,
      payload_json: { source: { chatType: "user", userId: "U-private" } },
    });
  });

  it("ignores an unknown one-to-one sender without persisting content", async () => {
    const inbox = testInbox();
    const privateMessage = {
      ...textEvent("E-private-stranger", "M-private-stranger", "秘密 999"),
      source: { type: "user", userId: "U-stranger" },
    };
    await inbox.acceptBatch("U-bot", [acceptedEvent(privateMessage, false)]);
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM inbound_event WHERE webhook_event_id='E-private-stranger'",
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("provisions an isolated ledger instead of failing a batch for a new group", async () => {
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

    await expect(inbox.acceptBatch("U-bot", [known, missing])).resolves.toBeUndefined();

    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM inbound_event
        WHERE webhook_event_id IN ('E-before-missing', 'E-missing-ledger')`,
    );
    expect(result.rows[0]?.count).toBe("2");
    const provisioned = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ledger WHERE line_group_id='C-does-not-exist'",
    );
    expect(provisioned.rows[0]?.count).toBe("1");
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

  it("provisions an isolated ledger and keeps only onboarding text for a new group", async () => {
    const inbox = testInbox();
    const pairing = {
      ...textEvent("E-public-pairing", "M-public-pairing", "建立配對"),
      source: { type: "group" as const, groupId: "C-new-couple", userId: "U-new" },
    };
    const status = {
      ...textEvent("E-public-pairing-status", "M-public-pairing-status", "配對狀態"),
      source: { type: "group" as const, groupId: "C-new-couple", userId: "U-new" },
    };
    await inbox.acceptBatch("U-bot", [pairing, status].map((event) => ({
      event,
      authorization: { authorized: false as const, reason: "member_not_allowed" as const },
    })));

    const result = await pool.query<{ ledger_count: string; tag_count: string; texts: string[] }>(
      `SELECT count(DISTINCT l.id)::text AS ledger_count,
              count(DISTINCT t.id)::text AS tag_count,
              array_agg(DISTINCT ie.payload_json->'message'->>'text'
                        ORDER BY ie.payload_json->'message'->>'text') AS texts
         FROM ledger l
         JOIN tag t ON t.ledger_id=l.id AND t.is_system
         JOIN inbound_event ie ON ie.ledger_id=l.id
        WHERE l.line_group_id='C-new-couple'`,
    );
    expect(result.rows[0]).toEqual({
      ledger_count: "1",
      tag_count: "14",
      texts: ["建立配對", "配對狀態"],
    });
  });

  it("provisions a private personal ledger without pairing and prefers it over a couple membership", async () => {
    const inbox = testInbox();
    const first = {
      ...textEvent("E-solo-first", "M-solo-first", "咖啡 80"),
      source: { type: "user" as const, userId: "U-solo" },
    };
    await inbox.acceptBatch("U-bot", [acceptedEvent(first)]);

    const personal = await pool.query<{
      id: string; route: string; kind: string; tag_count: string; text: string;
    }>(
      `SELECT ledger.id::text,ledger.line_group_id AS route,member.membership_kind AS kind,
              count(DISTINCT tag.id)::text AS tag_count,
              max(event.payload_json->'message'->>'text') AS text
         FROM ledger
         JOIN member ON member.ledger_id=ledger.id AND member.line_user_id='U-solo' AND member.is_active
         JOIN tag ON tag.ledger_id=ledger.id AND tag.is_system
         JOIN inbound_event event ON event.ledger_id=ledger.id
        WHERE ledger.line_group_id='user:U-solo'
        GROUP BY ledger.id,member.membership_kind`,
    );
    expect(personal.rows[0]).toMatchObject({
      route: "user:U-solo", kind: "personal", tag_count: "14", text: "咖啡 80",
    });

    await pool.query(
      `INSERT INTO member (ledger_id,line_user_id,display_name,membership_kind)
       VALUES ($1,'U-solo','群組身份','couple')`,
      [ledgerId],
    );
    const second = {
      ...textEvent("E-solo-second", "M-solo-second", "晚餐 120"),
      source: { type: "user" as const, userId: "U-solo" },
    };
    await inbox.acceptBatch("U-bot", [acceptedEvent(second)]);
    const routed = await pool.query<{ ledger_id: string }>(
      "SELECT ledger_id::text FROM inbound_event WHERE webhook_event_id='E-solo-second'",
    );
    expect(routed.rows[0]?.ledger_id).toBe(personal.rows[0]?.id);
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
