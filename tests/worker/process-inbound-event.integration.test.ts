import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { processNextInboundEvent } from "../../src/worker/index.js";

const { Client, Pool } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithPostgres("processNextInboundEvent integration", () => {
  const schemaName = `worker_test_${randomBytes(8).toString("hex")}`;
  let admin: InstanceType<typeof Client>;
  let pool: InstanceType<typeof Pool>;
  let ledgerId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin.query("SELECT pg_advisory_lock(1947823612)");
    await admin.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await admin.query("SELECT pg_advisory_unlock(1947823612)");
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    await admin.query(`SET search_path TO ${schemaName}, public`);
    const migration = await readFile(
      resolve("db/migrations/001_initial.up.sql"),
      "utf8",
    );
    await admin.query(
      migration.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""),
    );
    await admin.query(await readFile(resolve("db/migrations/002_personal_default_mode.sql"), "utf8"));
    await admin.query(await readFile(resolve("db/migrations/003_native_family_system_tag.sql"), "utf8"));
    await admin.query(await readFile(resolve("db/migrations/004_category_knowledge.sql"), "utf8"));
    const ledger = await admin.query<{ id: string }>(
      `INSERT INTO ledger (name, line_group_id) VALUES ('Worker ledger', 'C-worker')
       RETURNING id::text AS id`,
    );
    ledgerId = ledger.rows[0]!.id;
    await admin.query(
      `INSERT INTO member (ledger_id, line_user_id, display_name)
       VALUES ($1, 'U-ming', '小明'), ($1, 'U-mei', '小美')`,
      [ledgerId],
    );
    await admin.query(
      `INSERT INTO tag (ledger_id, type, code, display_name, normalized_name, is_system)
       SELECT $1, x.type::tag_type, x.code, x.name, x.name, true
       FROM (VALUES
         ('category','food','食物'), ('category','transport','交通'),
         ('category','entertainment','娛樂'), ('category','household','居家'),
         ('category','shopping','購物'), ('category','health','醫療健康'),
         ('category','travel','旅遊'), ('category','uncategorized','未分類'),
         ('meal','breakfast','早餐'), ('meal','lunch','午餐'),
         ('meal','afternoon_tea','下午茶'), ('meal','dinner','晚餐'),
         ('meal','late_night','宵夜'),
         ('custom','native_family','原生家庭')
       ) AS x(type, code, name)`,
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
    if (admin !== undefined) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await admin.end();
    }
  });

  it("atomically creates a personal expense, typed tags, audit, outbox and succeeds inbox", async () => {
    await insertTextEvent("E-create", "M-create", "個人 牛肉麵 150 #約會");
    const result = await processNextInboundEvent(pool, {
      generatePublicId: () => "K7M2Q9TX",
    });
    expect(result).toEqual({
      processed: true,
      webhookEventId: "E-create",
      outcome: "applied",
      publicId: "K7M2Q9TX",
    });

    const expense = await pool.query<{
      public_id: string; scope: string; payer: string; owner: string; source_text: string;
    }>(
      `SELECT et.public_id, et.scope::text, payer.display_name AS payer,
              owner.display_name AS owner, et.source_text
         FROM expense_transaction et
         JOIN member payer ON payer.id = et.payer_member_id
         JOIN member owner ON owner.id = et.personal_owner_member_id
        WHERE et.source_webhook_event_id = 'E-create'`,
    );
    expect(expense.rows[0]).toMatchObject({
      public_id: "K7M2Q9TX", scope: "personal", payer: "小明", owner: "小明",
      source_text: "個人 牛肉麵 150 #約會",
    });
    const tags = await pool.query<{ type: string; code: string; source: string; actor: string | null }>(
      `SELECT t.type::text AS type, t.code, tt.source::text AS source,
              tt.assigned_by_member_id::text AS actor
         FROM transaction_tag tt JOIN tag t ON t.id = tt.tag_id
        ORDER BY t.type, t.code`,
    );
    expect(tags.rows.map(({ type, source, actor }) => ({ type, source, actor: actor !== null })))
      .toEqual([
        { type: "category", source: "inferred", actor: false },
        { type: "meal", source: "inferred", actor: false },
        { type: "custom", source: "explicit", actor: true },
      ]);
    const counts = await pool.query<{ audit: string; outbox: string; payload: unknown; outcome: string }>(
      `SELECT
         (SELECT count(*)::text FROM transaction_event) AS audit,
         (SELECT count(*)::text FROM outbox_message) AS outbox,
         ie.payload_json AS payload, ie.outcome_code AS outcome
       FROM inbound_event ie WHERE webhook_event_id = 'E-create'`,
    );
    expect(counts.rows[0]).toMatchObject({ audit: "1", outbox: "1", payload: null, outcome: "applied" });
  });

  it("classifies common spending from DB knowledge and infers its meal window", async () => {
    await insertTextEvent("E-knowledge-toast", "M-knowledge-toast", "肉蛋吐司 85");
    expect(await processNextInboundEvent(pool, { generatePublicId: () => "T2AST888" }))
      .toMatchObject({ outcome: "applied", publicId: "T2AST888" });
    const tags = await pool.query<{ type: string; code: string; rule_key: string }>(
      `SELECT tt.tag_type::text AS type, t.code, tt.rule_key
         FROM expense_transaction et
         JOIN transaction_tag tt ON tt.transaction_id=et.id AND tt.ledger_id=et.ledger_id
         JOIN tag t ON t.id=tt.tag_id AND t.ledger_id=tt.ledger_id
        WHERE et.public_id='T2AST888' AND tt.tag_type IN ('category','meal')
        ORDER BY tt.tag_type`,
    );
    expect(tags.rows).toEqual([
      expect.objectContaining({ type: "category", code: "food", rule_key: expect.stringContaining("knowledge:system_seed") }),
      expect.objectContaining({ type: "meal", code: "lunch" }),
    ]);
    await pool.query("DELETE FROM expense_transaction WHERE public_id='T2AST888'");
  });

  it("learns a ledger-specific exact rule from a manual category correction", async () => {
    await insertTextEvent("E-learn-create", "M-learn-create", "神秘商品 42");
    expect(await processNextInboundEvent(pool, { generatePublicId: () => "K3ARN888" }))
      .toMatchObject({ outcome: "applied" });
    await insertTextEvent("E-learn-update", "M-learn-update", "改 #K3ARN888 分類 購物");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied" });
    await insertTextEvent("E-learn-reuse", "M-learn-reuse", "神秘商品 55");
    expect(await processNextInboundEvent(pool, { generatePublicId: () => "R3S3X888" }))
      .toMatchObject({ outcome: "applied" });
    const result = await pool.query<{ code: string; source: string; rules: string }>(
      `SELECT t.code, tt.source::text AS source,
              (SELECT count(*)::text FROM category_knowledge_rule
                WHERE ledger_id=$1 AND normalized_pattern='神秘商品' AND source='member_correction') AS rules
         FROM expense_transaction et
         JOIN transaction_tag tt ON tt.transaction_id=et.id AND tt.tag_type='category'
         JOIN tag t ON t.id=tt.tag_id
        WHERE et.public_id='R3S3X888'`,
      [ledgerId],
    );
    expect(result.rows[0]).toMatchObject({ code: "shopping", source: "inferred", rules: "1" });
    await pool.query("DELETE FROM expense_transaction WHERE public_id IN ('K3ARN888','R3S3X888')");
  });

  it("retries a ledger-local public ID collision without partial rows", async () => {
    await insertTextEvent("E-collision", "M-collision", "咖啡 80");
    const ids = ["K7M2Q9TX", "ABCDEFGH"];
    const result = await processNextInboundEvent(pool, { generatePublicId: () => ids.shift()! });
    expect(result).toMatchObject({ outcome: "applied", publicId: "ABCDEFGH" });
    const count = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM expense_transaction");
    expect(count.rows[0]?.count).toBe("2");
  });

  it("rejects parse errors with no business mutation and treats non-text as noop", async () => {
    await insertTextEvent("E-reject", "M-reject", "牛肉麵 0");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "rejected" });
    await admin.query(
      `INSERT INTO inbound_event
       (webhook_event_id, ledger_id, event_type, line_message_id, line_event_at, payload_json)
       VALUES ('E-image', $1, 'message', 'M-image', now(), NULL)`,
      [ledgerId],
    );
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "noop" });
    const outcomes = await pool.query<{ outcome_code: string }>(
      `SELECT outcome_code FROM inbound_event
        WHERE webhook_event_id IN ('E-reject','E-image') ORDER BY webhook_event_id`,
    );
    expect(outcomes.rows.map((row) => row.outcome_code)).toEqual(["noop", "rejected"]);
  });

  it("routes read commands before create and returns recent active expenses", async () => {
    const before = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM expense_transaction");
    await insertTextEvent("E-recent", "M-recent", "最近 5");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied" });
    const after = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM expense_transaction");
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    const reply = await pool.query<{ payload: { messages: Array<{ type: string; altText: string; contents: unknown }> } }>(
      `SELECT payload_json AS payload FROM outbox_message WHERE source_webhook_event_id='E-recent'`,
    );
    expect(reply.rows[0]?.payload.messages[0]).toMatchObject({ type: "flex" });
    expect(reply.rows[0]?.payload.messages[0]?.altText).toContain("小明個人最近 2 筆");
    expect(JSON.stringify(reply.rows[0]?.payload.messages[0]?.contents)).toContain('"label":"編輯"');
    expect(JSON.stringify(reply.rows[0]?.payload.messages[0]?.contents)).toContain('"text":"查 #K7M2Q9TX"');
  });

  it("updates an owned personal expense and records exactly one before/after audit", async () => {
    await insertTextEvent("E-update", "M-update", "改 #K7M2Q9TX 金額 180");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied", publicId: "K7M2Q9TX" });
    const expense = await pool.query<{ amount: string; version: string }>(
      `SELECT amount_minor::text AS amount, row_version::text AS version
         FROM expense_transaction WHERE public_id='K7M2Q9TX'`,
    );
    expect(expense.rows[0]).toEqual({ amount: "180", version: "2" });
    const audit = await pool.query<{ event_type: string; before_data: { amountMinor: number }; after_data: { amountMinor: number } }>(
      `SELECT event_type::text, before_data, after_data FROM transaction_event
        WHERE source_webhook_event_id='E-update'`,
    );
    expect(audit.rows[0]).toMatchObject({ event_type: "updated", before_data: { amountMinor: 150 }, after_data: { amountMinor: 180 } });
    const card = await pool.query<{ contents: unknown }>(
      `SELECT payload_json->'messages'->0->'contents' AS contents FROM outbox_message
        WHERE source_webhook_event_id='E-update'`,
    );
    expect(JSON.stringify(card.rows[0]?.contents)).toContain('"fillInText":"改 #K7M2Q9TX 金額 180"');
  });

  it("replaces explicit custom tags and returns the refreshed edit card", async () => {
    await insertTextEvent("E-tags-replace", "M-tags-replace", "改 #K7M2Q9TX 標籤 #食物 #午餐 #公司 #午休");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied", publicId: "K7M2Q9TX" });
    const state = await pool.query<{ tags: string[]; contents: unknown }>(
      `SELECT ARRAY(
          SELECT t.normalized_name FROM expense_transaction et
          JOIN transaction_tag tt ON tt.transaction_id=et.id AND tt.ledger_id=et.ledger_id
          JOIN tag t ON t.id=tt.tag_id AND t.ledger_id=tt.ledger_id
          WHERE et.public_id='K7M2Q9TX' AND tt.tag_type='custom' AND tt.source='explicit'
          ORDER BY t.normalized_name
        ) AS tags,
        (SELECT payload_json->'messages'->0->'contents' FROM outbox_message
          WHERE source_webhook_event_id='E-tags-replace') AS contents`,
    );
    expect(state.rows[0]?.tags).toEqual(["公司", "午休"]);
    expect(JSON.stringify(state.rows[0]?.contents)).toContain('"fillInText":"改 #K7M2Q9TX 標籤 #食物 #午餐 #公司 #午休"');
  });

  it("rejects another member mutating a personal expense without an audit", async () => {
    await insertTextEvent("E-denied", "M-denied", "取消 #K7M2Q9TX", "U-mei");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "rejected" });
    const state = await pool.query<{ status: string; audit: string }>(
      `SELECT status::text, (SELECT count(*)::text FROM transaction_event WHERE source_webhook_event_id='E-denied') AS audit
         FROM expense_transaction WHERE public_id='K7M2Q9TX'`,
    );
    expect(state.rows[0]).toEqual({ status: "active", audit: "0" });
  });

  it("soft-cancels and restores idempotently", async () => {
    await insertTextEvent("E-void", "M-void", "取消 #K7M2Q9TX");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied" });
    await insertTextEvent("E-void-again", "M-void-again", "取消 #K7M2Q9TX");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "noop" });
    await insertTextEvent("E-restore", "M-restore", "還原 #K7M2Q9TX");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied" });
    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type::text FROM transaction_event
        WHERE transaction_id=(SELECT id FROM expense_transaction WHERE public_id='K7M2Q9TX')
          AND event_type IN ('voided','restored') ORDER BY created_at`,
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(["voided", "restored"]);
  });

  it("reports a unique monthly total when an expense has multiple tags", async () => {
    await insertTextEvent("E-month", "M-month", "本月");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied" });
    const reply = await pool.query<{ payload: { messages: Array<{ type: string; altText: string }> } }>(
      `SELECT payload_json AS payload FROM outbox_message WHERE source_webhook_event_id='E-month'`,
    );
    expect(reply.rows[0]?.payload.messages[0]).toMatchObject({ type: "flex" });
    expect(reply.rows[0]?.payload.messages[0]?.altText).toContain("2 筆，合計 260 元");
  });

  it("returns Flex cards for weekly reports, search and category ranking", async () => {
    const commands = [
      ["E-week", "週報", "本週"],
      ["E-search", "找 咖啡", "搜尋「咖啡」"],
      ["E-ranking", "分類排行", "分類排行"],
      ["E-help", "說明", "記帳：牛肉麵"],
      ["E-knowledge-card", "分類規則", "分類知識表"],
    ] as const;
    for (const [eventId, text, expectedAlt] of commands) {
      await insertTextEvent(eventId, `M-${eventId}`, text);
      expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied" });
      const reply = await pool.query<{ type: string; alt_text: string; contents_type: string }>(
        `SELECT payload_json->'messages'->0->>'type' AS type,
                payload_json->'messages'->0->>'altText' AS alt_text,
                payload_json->'messages'->0->'contents'->>'type' AS contents_type
           FROM outbox_message WHERE source_webhook_event_id=$1`,
        [eventId],
      );
      expect(reply.rows[0]?.type).toBe("flex");
      expect(reply.rows[0]?.alt_text).toContain(expectedAlt);
      expect(["bubble", "carousel"]).toContain(reply.rows[0]?.contents_type);
    }
  });

  it("applies typed field and custom-tag updates while preserving invariants", async () => {
    await insertTextEvent("E-variant-create", "M-variant-create", "共同 牛肉麵 150");
    expect(await processNextInboundEvent(pool, { generatePublicId: () => "V4R2ANT3" }))
      .toMatchObject({ outcome: "applied" });

    const commands = [
      ["E-item", "改 #V4R2ANT3 項目 計程車"],
      ["E-category", "改 #V4R2ANT3 分類 食物"],
      ["E-meal", "改 #V4R2ANT3 餐別 晚餐"],
      ["E-date", "改 #V4R2ANT3 日期 昨天"],
      ["E-time", "改 #V4R2ANT3 時間 未知"],
      ["E-tags-add", "加 #V4R2ANT3 標籤 #台南 #約會"],
      ["E-tags-remove", "移除 #V4R2ANT3 標籤 #台南"],
      ["E-scope", "改 #V4R2ANT3 範圍 個人"],
      ["E-owner", "改 #V4R2ANT3 所有人 小美"],
    ] as const;
    for (const [eventId, text] of commands) {
      await insertTextEvent(eventId, `M-${eventId}`, text);
      expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied" });
    }

    const state = await pool.query<{
      description: string; category: string; category_source: string;
      meal: string; meal_source: string; occurred_on: string;
      occurred_at: Date | null; scope: string; owner: string; customs: string[];
    }>(
      `SELECT et.description, category.code AS category, ctt.source::text AS category_source,
              meal.code AS meal, mtt.source::text AS meal_source, et.occurred_on::text,
              et.occurred_at, et.scope::text, owner.display_name AS owner,
              ARRAY(SELECT t.normalized_name FROM transaction_tag xtt JOIN tag t ON t.id=xtt.tag_id
                     WHERE xtt.transaction_id=et.id AND xtt.tag_type='custom' ORDER BY t.normalized_name) AS customs
         FROM expense_transaction et
         JOIN transaction_tag ctt ON ctt.transaction_id=et.id AND ctt.tag_type='category'
         JOIN tag category ON category.id=ctt.tag_id
         JOIN transaction_tag mtt ON mtt.transaction_id=et.id AND mtt.tag_type='meal'
         JOIN tag meal ON meal.id=mtt.tag_id
         JOIN member owner ON owner.id=et.personal_owner_member_id
        WHERE et.public_id='V4R2ANT3'`,
    );
    expect(state.rows[0]).toMatchObject({
      description: "計程車", category: "food", category_source: "explicit",
      meal: "dinner", meal_source: "explicit", occurred_on: "2026-08-12",
      occurred_at: null, scope: "personal", owner: "小美", customs: ["約會"],
    });
    const audit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM transaction_event
        WHERE transaction_id=(SELECT id FROM expense_transaction WHERE public_id='V4R2ANT3')`,
    );
    expect(audit.rows[0]?.count).toBe("10");
  });

  it("handles LINE edits without saving edited text or changing the expense", async () => {
    const before = await pool.query<{ amount: string; audits: string }>(
      `SELECT amount_minor::text AS amount,
              (SELECT count(*)::text FROM transaction_event WHERE transaction_id=et.id) AS audits
         FROM expense_transaction et WHERE public_id='K7M2Q9TX'`,
    );
    await insertLifecycleEvent("E-edit-notice", "messageEdited", "edit", "M-create", "U-ming");
    expect(await processNextInboundEvent(pool)).toMatchObject({
      outcome: "applied",
      publicId: "K7M2Q9TX",
    });
    const after = await pool.query<{ amount: string; audits: string }>(
      `SELECT amount_minor::text AS amount,
              (SELECT count(*)::text FROM transaction_event WHERE transaction_id=et.id) AS audits
         FROM expense_transaction et WHERE public_id='K7M2Q9TX'`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const delivery = await pool.query<{
      purpose: string; payload: { messages: Array<{ text: string }> };
      inbox_payload: unknown;
    }>(
      `SELECT om.purpose, om.payload_json AS payload, ie.payload_json AS inbox_payload
         FROM outbox_message om JOIN inbound_event ie
           ON ie.webhook_event_id=om.source_webhook_event_id
        WHERE om.source_webhook_event_id='E-edit-notice'`,
    );
    expect(delivery.rows[0]?.purpose).toBe("expense_edit_notice");
    expect(delivery.rows[0]?.payload.messages[0]?.text)
      .toBe("原帳目未變更；請使用「改 #K7M2Q9TX 欄位 新值」。");
    expect(delivery.rows[0]?.inbox_payload).toBeNull();
  });

  it("replies with onboarding when the bot joins the ledger group", async () => {
    await insertLifecycleEvent("E-join", "join", "join", null);
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied" });
    const delivery = await pool.query<{ text: string; inbox_payload: unknown }>(
      `SELECT om.payload_json->'messages'->0->>'text' AS text,
              ie.payload_json AS inbox_payload
         FROM outbox_message om JOIN inbound_event ie
           ON ie.webhook_event_id=om.source_webhook_event_id
        WHERE om.source_webhook_event_id='E-join'`,
    );
    expect(delivery.rows[0]?.text).toContain("牛肉麵 150");
    expect(delivery.rows[0]?.text).toContain("個人 咖啡 80");
    expect(delivery.rows[0]?.inbox_payload).toBeNull();
  });

  it("persists a group-wide personal/shared mode while explicit scope still wins", async () => {
    await insertTextEvent("E-mode-personal", "M-mode-personal", "切換個人模式");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "noop" });
    await insertTextEvent("E-mode-personal-create", "M-mode-personal-create", "早餐 90");
    expect(await processNextInboundEvent(pool, { generatePublicId: () => "PERS2NAX" }))
      .toMatchObject({ outcome: "applied", publicId: "PERS2NAX" });
    await insertTextEvent("E-mode-explicit", "M-mode-explicit", "共同 午餐 120");
    expect(await processNextInboundEvent(pool, { generatePublicId: () => "EXP72CXT" }))
      .toMatchObject({ outcome: "applied", publicId: "EXP72CXT" });

    const personalMode = await pool.query<{ mode: string; scope: string; has_owner: boolean; explicit_scope: string }>(
      `SELECT l.default_scope::text AS mode, personal.scope::text AS scope,
              personal.personal_owner_member_id IS NOT NULL AS has_owner,
              explicit.scope::text AS explicit_scope
         FROM ledger l
         JOIN expense_transaction personal ON personal.ledger_id=l.id AND personal.public_id='PERS2NAX'
         JOIN expense_transaction explicit ON explicit.ledger_id=l.id AND explicit.public_id='EXP72CXT'
        WHERE l.id=$1`,
      [ledgerId],
    );
    expect(personalMode.rows[0]).toEqual({ mode: "personal", scope: "personal", has_owner: true, explicit_scope: "shared" });

    await insertTextEvent("E-mode-shared", "M-mode-shared", "切換共同模式");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied" });
    const modeReply = await pool.query<{ type: string; alt_text: string }>(
      `SELECT payload_json->'messages'->0->>'type' AS type,
              payload_json->'messages'->0->>'altText' AS alt_text
         FROM outbox_message WHERE source_webhook_event_id='E-mode-shared'`,
    );
    expect(modeReply.rows[0]).toMatchObject({ type: "flex" });
    expect(modeReply.rows[0]?.alt_text).toContain("已切換為共同模式");
  });

  it("scopes default recent and monthly cards to the member who clicks", async () => {
    await insertTextEvent("E-mei-personal", "M-mei-personal", "個人 女友咖啡 70", "U-mei");
    expect(await processNextInboundEvent(pool, { generatePublicId: () => "ME2PERSN" }))
      .toMatchObject({ outcome: "applied", publicId: "ME2PERSN" });

    for (const [eventId, text, expected] of [["E-mei-recent", "最近 5", "女友咖啡"], ["E-mei-month", "月報", "小美個人"]] as const) {
      await insertTextEvent(eventId, `M-${eventId}`, text, "U-mei");
      expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied" });
      const reply = await pool.query<{ alt_text: string }>(
        `SELECT payload_json->'messages'->0->>'altText' AS alt_text
           FROM outbox_message WHERE source_webhook_event_id=$1`,
        [eventId],
      );
      expect(reply.rows[0]?.alt_text).toContain(expected);
      expect(reply.rows[0]?.alt_text).not.toContain("牛肉麵");
      expect(reply.rows[0]?.alt_text).not.toContain("早餐");
    }
  });

  it("persists and queries the inferred 原生家庭 system context tag", async () => {
    await insertTextEvent("E-native-family", "M-native-family", "孝親費 5000");
    expect(await processNextInboundEvent(pool, { generatePublicId: () => "FAM2XY88" }))
      .toMatchObject({ outcome: "applied", publicId: "FAM2XY88" });
    const tag = await pool.query<{ source: string; actor: string | null; is_system: boolean; category: string }>(
      `SELECT context.source::text, context.assigned_by_member_id::text AS actor,
              context_tag.is_system, category_tag.code AS category
         FROM expense_transaction et
         JOIN transaction_tag context ON context.transaction_id=et.id AND context.tag_type='custom'
         JOIN tag context_tag ON context_tag.id=context.tag_id AND context_tag.code='native_family'
         JOIN transaction_tag category ON category.transaction_id=et.id AND category.tag_type='category'
         JOIN tag category_tag ON category_tag.id=category.tag_id
        WHERE et.public_id='FAM2XY88'`,
    );
    expect(tag.rows[0]).toEqual({ source: "inferred", actor: null, is_system: true, category: "household" });

    await insertTextEvent("E-native-family-query", "M-native-family-query", "本月 #原生家庭");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied" });
    const reply = await pool.query<{ alt_text: string }>(
      `SELECT payload_json->'messages'->0->>'altText' AS alt_text
         FROM outbox_message WHERE source_webhook_event_id='E-native-family-query'`,
    );
    expect(reply.rows[0]?.alt_text).toContain("5,000 元");

    await insertTextEvent("E-native-family-update", "M-native-family-update", "改 #FAM2XY88 項目 自己房租");
    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied" });
    const remaining = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM transaction_tag tt
        WHERE tt.transaction_id=(SELECT id FROM expense_transaction WHERE public_id='FAM2XY88')
          AND tt.tag_type='custom' AND tt.source='inferred'`,
    );
    expect(remaining.rows[0]?.count).toBe("0");
  });

  it("pairs exactly one second member and returns an idempotent confirmation", async () => {
    const pairingLedger = await admin.query<{ id: string }>(
      "INSERT INTO ledger (name,line_group_id) VALUES ('Pairing ledger','C-pairing') RETURNING id::text",
    );
    const pairingLedgerId = pairingLedger.rows[0]!.id;
    await admin.query(
      "INSERT INTO member (ledger_id,line_user_id,display_name) VALUES ($1,'U-owner','帳本主人')",
      [pairingLedgerId],
    );
    await admin.query(
      `INSERT INTO inbound_event
       (webhook_event_id,ledger_id,event_type,line_message_id,line_event_at,payload_json)
       VALUES ('E-pair-member',$1,'message','M-pair-member','2026-08-13T04:10:00.123Z',$2::jsonb)`,
      [pairingLedgerId, JSON.stringify({
        destination: "U-bot", source: { userId: "U-partner" },
        message: { type: "text", text: "配對" },
        replyTokenCiphertext: Buffer.from("cipher-pair").toString("base64"),
      })],
    );

    expect(await processNextInboundEvent(pool)).toMatchObject({ outcome: "applied" });
    const paired = await pool.query<{ display_name: string; count: string }>(
      `SELECT max(display_name) FILTER (WHERE line_user_id='U-partner') AS display_name,
              count(*)::text AS count FROM member WHERE ledger_id=$1 AND is_active`,
      [pairingLedgerId],
    );
    expect(paired.rows[0]).toEqual({ display_name: "另一半", count: "2" });
    const reply = await pool.query<{ text: string }>(
      "SELECT payload_json->'messages'->0->>'text' AS text FROM outbox_message WHERE source_webhook_event_id='E-pair-member'",
    );
    expect(reply.rows[0]?.text).toContain("配對成功");
  });

  it("journals an unsend before purging the matching expense", async () => {
    await admin.query(
      `INSERT INTO inbound_event
       (webhook_event_id, ledger_id, event_type, line_message_id, line_event_at)
       VALUES ('E-unsend', $1, 'unsend', 'M-create',
               '2026-08-13T04:20:00.000Z')`,
      [ledgerId],
    );
    const journaled: unknown[] = [];

    expect(
      await processNextInboundEvent(pool, {
        appendDeletionJournal: async (entry) => {
          journaled.push(entry);
        },
      }),
    ).toMatchObject({ outcome: "applied" });
    expect(journaled).toEqual([
      expect.objectContaining({
        ledgerId,
        lineMessageId: "M-create",
        unsendWebhookEventId: "E-unsend",
      }),
    ]);
    const remaining = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM expense_transaction
        WHERE source_message_id = 'M-create'`,
    );
    expect(remaining.rows[0]?.count).toBe("0");
  });

  async function insertTextEvent(eventId: string, messageId: string, text: string, userId = "U-ming"): Promise<void> {
    await admin.query(
      `INSERT INTO inbound_event
       (webhook_event_id, ledger_id, event_type, line_message_id, line_event_at, payload_json)
       VALUES ($1, $2, 'message', $3, '2026-08-13T04:10:00.123Z', $4::jsonb)`,
      [eventId, ledgerId, messageId, JSON.stringify({
        destination: "U-bot", source: { userId },
        message: { type: "text", text },
        replyTokenCiphertext: Buffer.from(`cipher-${eventId}`).toString("base64"),
      })],
    );
  }

  async function insertLifecycleEvent(
    eventId: string,
    eventType: "messageEdited" | "join",
    kind: "edit" | "join",
    messageId: string | null,
    userId?: string,
  ): Promise<void> {
    await admin.query(
      `INSERT INTO inbound_event
       (webhook_event_id, ledger_id, event_type, line_message_id, line_event_at, payload_json)
       VALUES ($1, $2, $3, $4, '2026-08-13T04:15:00.000Z', $5::jsonb)`,
      [eventId, ledgerId, eventType, messageId, JSON.stringify({
        destination: "U-bot",
        source: { ...(userId === undefined ? {} : { userId }) },
        event: { kind },
        replyTokenCiphertext: Buffer.from(`cipher-${eventId}`).toString("base64"),
      })],
    );
  }
});
