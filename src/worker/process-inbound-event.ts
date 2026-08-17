import type { Pool, PoolClient } from "pg";

import {
  formatExpenseParseErrorReply,
  formatSavedExpenseReply,
  lineTextReply,
} from "../application/expense-reply.js";
import { generatePublicId } from "../application/public-id.js";
import {
  pairingGuideCard,
  pairingStatusCard,
  standalonePersonalCard,
  unpairConsentCard,
} from "../application/line-cards.js";
import { inferMeal, parseExpenseMessage, parseLedgerCommand } from "../domain/index.js";
import type { LedgerCommand, ParsedExpense, TypedTag } from "../domain/index.js";
import type { LineReplyMessage } from "../outbox/payload.js";
import { processLedgerCommand } from "./process-ledger-command.js";
import { resolveCategoryKnowledge } from "./category-knowledge.js";

const MAX_PUBLIC_ID_ATTEMPTS = 8;

export type ProcessInboundEventResult =
  | { readonly processed: false }
  | {
      readonly processed: true;
      readonly webhookEventId: string;
      readonly outcome:
        | "applied"
        | "rejected"
        | "noop"
        | "ignored_unsent"
        | "retry_scheduled"
        | "dead_letter";
      readonly publicId?: string;
    };

export interface ProcessInboundEventOptions {
  readonly generatePublicId?: () => string;
  readonly appendDeletionJournal?: (
    entry: DeletionJournalEntry,
  ) => Promise<void>;
}

export interface DeletionJournalEntry {
  readonly ledgerId: string;
  readonly lineMessageId: string;
  readonly unsendWebhookEventId: string;
  readonly unsentAt: string;
}

interface ClaimedEvent {
  webhook_event_id: string;
  ledger_id: string;
  event_type: string;
  line_message_id: string | null;
  line_event_at: Date;
  received_at: Date;
  payload_json: unknown;
}

interface LedgerMember {
  ledger_id: string;
  line_group_id: string;
  timezone: string;
  default_scope: "shared" | "personal";
  allow_bare_entry: boolean;
  member_id: string;
  display_name: string;
  membership_kind: "personal" | "couple";
  line_user_id: string;
  couple_ledger_id: string | null;
  couple_member_id: string | null;
}

interface TextPayload {
  destination: string;
  source: { chatType: "group" | "user"; userId: string };
  message: { type: "text"; text: string };
  replyTokenCiphertext?: string;
}

type PairingManagementAction = "status" | "request_unpair" | "confirm_unpair" | "reject_unpair" | "cancel_unpair";

interface LifecyclePayload {
  destination: string;
  source: { userId?: string };
  event: { kind: "edit" | "join" };
  replyTokenCiphertext?: string;
}

/**
 * Claims and processes at most one inbox row. The claim, expense mutation,
 * typed tags, audit, reply outbox and inbox completion share one transaction.
 */
export async function processNextInboundEvent(
  pool: Pool,
  options: ProcessInboundEventOptions = {},
): Promise<ProcessInboundEventResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const event = await claimNext(client);
    if (event === null) {
      await client.query("COMMIT");
      return { processed: false };
    }

    let result: ProcessInboundEventResult;
    if (event.event_type === "unsend") {
      result = await processUnsend(client, event, options);
    } else if (event.event_type === "messageEdited" || event.event_type === "join") {
      result = await processLifecycleEvent(client, event);
    } else if (event.event_type !== "message") {
      await finish(client, event, "noop");
      result = processedResult(event, "noop");
    } else {
      result = await processMessage(client, event, options);
    }

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function processLifecycleEvent(
  client: PoolClient,
  event: ClaimedEvent,
): Promise<ProcessInboundEventResult> {
  const payload = decodeLifecyclePayload(event.payload_json);
  if (payload === null) {
    await finish(client, event, "noop");
    return processedResult(event, "noop");
  }

  const ledger = await client.query<{ line_group_id: string }>(
    "SELECT line_group_id FROM ledger WHERE id = $1",
    [event.ledger_id],
  );
  const destination = ledger.rows[0]?.line_group_id ?? null;

  if (payload.event.kind === "join") {
    const reply = [
      "歡迎使用 DINERO 兩人記帳！",
      "第一位請輸入「建立配對」，第二位再輸入「配對」。",
      "完成後輸入「設定暱稱 你的名字」。",
      "預設是個人模式；約會時再輸入「切換共同模式」。",
      "配對後可用「配對狀態」查看；解除必須雙方同意。",
      "傳送「使用說明」可查看完整功能。",
    ].join("\n");
    await enqueueReply(
      client,
      event,
      destination,
      payload.replyTokenCiphertext,
      "ledger_onboarding",
      reply,
      pairingGuideCard(reply),
    );
    await finish(client, event, "applied");
    return processedResult(event, "applied");
  }

  if (event.line_message_id === null || payload.source.userId === undefined) {
    await finish(client, event, "noop");
    return processedResult(event, "noop");
  }
  const identity = await loadIdentity(
    client,
    event.ledger_id,
    payload.source.userId,
  );
  if (identity === null || await lockAndCheckTombstone(client, event)) {
    await finish(client, event, "noop");
    return processedResult(event, "noop");
  }
  const expense = await client.query<{ public_id: string }>(
    `SELECT public_id FROM expense_transaction
      WHERE ledger_id = $1 AND source_message_id = $2`,
    [event.ledger_id, event.line_message_id],
  );
  const publicId = expense.rows[0]?.public_id;
  if (publicId === undefined) {
    await finish(client, event, "noop");
    return processedResult(event, "noop");
  }
  await enqueueReply(
    client,
    event,
    destination,
    payload.replyTokenCiphertext,
    "expense_edit_notice",
    `原帳目未變更；請使用「改 #${publicId} 欄位 新值」。`,
  );
  await finish(client, event, "applied");
  return {
    processed: true,
    webhookEventId: event.webhook_event_id,
    outcome: "applied",
    publicId,
  };
}

async function processUnsend(
  client: PoolClient,
  event: ClaimedEvent,
  options: ProcessInboundEventOptions,
): Promise<ProcessInboundEventResult> {
  if (event.line_message_id === null || event.line_message_id.length === 0) {
    await markDeadLetter(client, event, "unsend_message_id_missing");
    return processedResult(event, "dead_letter");
  }

  if (options.appendDeletionJournal === undefined) {
    await releaseForRetry(client, event, "unsend_journal_not_configured");
    return processedResult(event, "retry_scheduled");
  }

  // Append before the main DB commit. If the DB transaction rolls back, the
  // durable entry is harmless and an idempotent retry/replay completes purge.
  await options.appendDeletionJournal({
    ledgerId: event.ledger_id,
    lineMessageId: event.line_message_id,
    unsendWebhookEventId: event.webhook_event_id,
    unsentAt: event.line_event_at.toISOString(),
  });
  await client.query(
    "SELECT purge_line_message_after_unsend($1, $2, $3, $4)",
    [
      event.ledger_id,
      event.line_message_id,
      event.webhook_event_id,
      event.line_event_at,
    ],
  );
  await finish(client, event, "applied");
  return processedResult(event, "applied");
}

async function claimNext(client: PoolClient): Promise<ClaimedEvent | null> {
  const result = await client.query<ClaimedEvent>(
    `SELECT webhook_event_id, ledger_id::text, event_type, line_message_id,
            line_event_at, created_at AS received_at, payload_json
       FROM inbound_event
      WHERE status = 'pending' AND available_at <= clock_timestamp()
      ORDER BY available_at, created_at, webhook_event_id
      FOR UPDATE SKIP LOCKED
      LIMIT 1`,
  );
  const event = result.rows[0];
  if (event === undefined) return null;

  await client.query(
    `UPDATE inbound_event
        SET status = 'processing', locked_at = clock_timestamp(),
            attempt_count = attempt_count + 1, last_error_code = NULL
      WHERE webhook_event_id = $1`,
    [event.webhook_event_id],
  );
  return event;
}

async function processMessage(
  client: PoolClient,
  event: ClaimedEvent,
  options: ProcessInboundEventOptions,
): Promise<ProcessInboundEventResult> {
  // The inbox intentionally stores no content for non-text LINE messages.
  if (event.payload_json === null) {
    await finish(client, event, "noop");
    return processedResult(event, "noop");
  }
  const payload = decodeTextPayload(event.payload_json);
  if (payload === null || event.line_message_id === null) {
    await rejectMalformedPayload(client, event, payload);
    return processedResult(event, "rejected");
  }

  let identity = await loadIdentity(client, event.ledger_id, payload.source.userId);
  if (identity === null) {
    const normalizedText = payload.message.text.normalize("NFKC").trim();
    if (isPairingCommand(normalizedText)) {
      return pairLedgerMember(client, event, payload.source.userId, payload.replyTokenCiphertext);
    }
    if (parsePairingManagementAction(normalizedText) === "status") {
      const destination = await loadLedgerDestination(client, event.ledger_id);
      const reply = "你目前沒有有效配對。請在兩人群組由第一位輸入「建立配對」，第二位輸入「配對」。";
      await enqueueReply(client, event, destination, payload.replyTokenCiphertext,
        "member_pairing_result", reply, pairingGuideCard(reply));
      await finish(client, event, "noop");
      return processedResult(event, "noop");
    }
    const destination = await loadLedgerDestination(client, event.ledger_id);
    const reply = "你還沒完成配對。第一位請輸入「建立配對」，第二位輸入「配對」。";
    await enqueueReply(client, event, destination, payload.replyTokenCiphertext,
      "ledger_onboarding", reply, pairingGuideCard(reply));
    await finish(client, event, "rejected");
    return processedResult(event, "rejected");
  }

  if (isPairingCommand(payload.message.text.normalize("NFKC").trim())) {
    if (identity.membership_kind === "personal") {
      const reply = "你現在就是個人模式，不需要配對也能直接記帳。若要共同記帳，請建立兩人 LINE 群組並把機器人加入。";
      await enqueueReply(client, event, identity.line_group_id, payload.replyTokenCiphertext,
        "member_pairing_result", reply, standalonePersonalCard(reply));
      await finish(client, event, "noop");
      return processedResult(event, "noop");
    }
    await enqueueReply(client, event, identity.line_group_id, payload.replyTokenCiphertext,
      "member_pairing_result", `你已經完成配對，帳本身份是「${identity.display_name}」。`);
    await finish(client, event, "noop");
    return processedResult(event, "noop");
  }

  const pairingAction = parsePairingManagementAction(payload.message.text);
  if (pairingAction !== null) {
    return processPairingManagement(
      client,
      event,
      identity,
      pairingAction,
      payload.replyTokenCiphertext,
    );
  }

  const command = parseLedgerCommand(payload.message.text);
  if (command.kind === "invalid") {
    await enqueueReply(
      client,
      event,
      identity.line_group_id,
      payload.replyTokenCiphertext,
      "ledger_command_result",
      command.message,
    );
    await finish(client, event, "rejected");
    return processedResult(event, "rejected");
  }
  if (command.kind === "command") {
    const publicId = commandPublicId(command.command);
    const targetLedgerId = publicId === null
      ? ledgerCommandRequiresCompletePair(command.command) && identity.membership_kind === "personal"
        ? identity.couple_ledger_id
        : null
      : await resolveAuthorizedCommandLedger(client, identity, publicId);
    if (publicId !== null && targetLedgerId === null) {
      if (await lockAndCheckTombstone(client, event)) {
        await finish(client, event, "ignored_unsent");
        return processedResult(event, "ignored_unsent");
      }
      const reply = "找不到這筆交易。請確認編號是否正確。";
      await enqueueReply(client, event, identity.line_group_id, payload.replyTokenCiphertext,
        "ledger_command_result", reply);
      await finish(client, event, "rejected");
      return processedResult(event, "rejected");
    }
    if (targetLedgerId !== null && targetLedgerId !== event.ledger_id) {
      const targetIdentity = await loadIdentityIncludingInactive(
        client,
        targetLedgerId,
        identity.line_user_id,
      );
      if (targetIdentity !== null) {
        await rehomeInboundEvent(client, event, targetLedgerId);
        identity = targetIdentity;
      }
    }
    if (await lockAndCheckTombstone(client, event)) {
      await finish(client, event, "ignored_unsent");
      return processedResult(event, "ignored_unsent");
    }
    if (ledgerCommandRequiresCompletePair(command.command)
        && !await hasCompletePair(client, event.ledger_id)) {
      const reply = "這是共同功能，必須先完成兩人配對。個人記帳、最近紀錄與個人月報都不需要配對。";
      await enqueueReply(client, event, identity.line_group_id, payload.replyTokenCiphertext,
        "ledger_command_result", reply, standalonePersonalCard(reply));
      await finish(client, event, "rejected");
      return processedResult(event, "rejected");
    }
    const commandResult = await processLedgerCommand(
      client,
      {
        ledgerId: event.ledger_id,
        memberId: identity.member_id,
        displayName: identity.display_name,
        lineUserId: identity.line_user_id,
        coupleLedgerId: identity.couple_ledger_id,
        timezone: identity.timezone,
      },
      { webhookEventId: event.webhook_event_id, eventAt: event.line_event_at },
      command.command,
    );
    await enqueueReply(
      client,
      event,
      identity.line_group_id,
      payload.replyTokenCiphertext,
      "ledger_command_result",
      commandResult.reply,
      commandResult.message,
    );
    await finish(client, event, commandResult.outcome);
    return {
      processed: true,
      webhookEventId: event.webhook_event_id,
      outcome: commandResult.outcome,
      ...(commandResult.publicId === undefined ? {} : { publicId: commandResult.publicId }),
    };
  }

  if (!identity.allow_bare_entry && !hasExplicitScopePrefix(payload.message.text)) {
    await enqueueReply(
      client,
      event,
      identity.line_group_id,
      payload.replyTokenCiphertext,
      "expense_create_rejected",
      "這個帳本請明確以「共同」或「個人」開頭。",
    );
    await finish(client, event, "rejected");
    return processedResult(event, "rejected");
  }

  const parsed = parseExpenseMessage(payload.message.text, {
    eventTimestamp: event.line_event_at,
    timezone: identity.timezone,
    defaultScope: payload.source.chatType === "user" ? "personal" : identity.default_scope,
  });
  if (!parsed.ok) {
    await enqueueReply(
      client,
      event,
      identity.line_group_id,
      payload.replyTokenCiphertext,
      "expense_create_rejected",
      formatExpenseParseErrorReply(parsed.error),
    );
    await finish(client, event, "rejected");
    return processedResult(event, "rejected");
  }

  if (parsed.value.scope === "shared" && !await hasCompletePair(client, event.ledger_id)) {
    const reply = "共同支出必須先完成兩人配對；你仍可直接記成個人支出，例如「晚餐 300」。";
    await enqueueReply(client, event, identity.line_group_id, payload.replyTokenCiphertext,
      "expense_create_rejected", reply, standalonePersonalCard(reply));
    await finish(client, event, "rejected");
    return processedResult(event, "rejected");
  }

  if (await lockAndCheckTombstone(client, event)) {
    await finish(client, event, "ignored_unsent");
    return processedResult(event, "ignored_unsent");
  }

  const publicIdFactory = options.generatePublicId ?? (() => generatePublicId());
  const existing = await findExistingExpense(client, event);
  if (existing !== null) {
    await finish(client, event, "applied");
    return {
      processed: true,
      webhookEventId: event.webhook_event_id,
      outcome: "applied",
      publicId: existing,
    };
  }

  const expense = await applyCategoryKnowledge(client, event.ledger_id, parsed.value);
  const payer = expense.payer === "partner"
    ? await loadPairedPartner(client, event.ledger_id, identity.member_id)
    : { id: identity.member_id, displayName: identity.display_name };
  if (payer === null) {
    await enqueueReply(client, event, identity.line_group_id, payload.replyTokenCiphertext,
      "expense_create_rejected", "指定對方付款只適用於剛好兩位已配對成員的共同帳本。");
    await finish(client, event, "rejected");
    return processedResult(event, "rejected");
  }
  const saved = await insertExpenseWithCollisionRetry(
    client,
    event,
    identity,
    payer.id,
    expense,
    payload.message.text,
    publicIdFactory,
  );
  await insertTypedTags(client, event.ledger_id, saved.id, identity.member_id, expense.tags);
  await insertCreatedAudit(client, event, saved.id, identity.member_id, saved.publicId, expense);
  await enqueueReply(
    client,
    event,
    identity.line_group_id,
    payload.replyTokenCiphertext,
    "expense_create_result",
    formatSavedExpenseReply({
      publicId: saved.publicId,
      expense,
      payerDisplayName: payer.displayName,
    }),
  );
  await finish(client, event, "applied");
  return {
    processed: true,
    webhookEventId: event.webhook_event_id,
    outcome: "applied",
    publicId: saved.publicId,
  };
}

async function applyCategoryKnowledge(
  client: PoolClient,
  ledgerId: string,
  expense: ParsedExpense,
): Promise<ParsedExpense> {
  if (expense.category.source === "explicit") return expense;
  const knowledge = await resolveCategoryKnowledge(client, ledgerId, expense.description);
  if (knowledge === null) return expense;
  const category = knowledge.category;
  const meal = category.code === "food"
    ? expense.meal?.source === "explicit"
      ? expense.meal
      : inferMeal(expense.description, category.code, expense.occurredTime, knowledge.mealEligible)
    : null;
  return {
    ...expense,
    category,
    meal,
    tags: [category, ...(meal === null ? [] : [meal]), ...expense.customTags],
  };
}

async function pairLedgerMember(
  client: PoolClient,
  event: ClaimedEvent,
  lineUserId: string,
  replyTokenCiphertext: string | undefined,
): Promise<ProcessInboundEventResult> {
  const ledger = await client.query<{ line_group_id: string }>(
    "SELECT line_group_id FROM ledger WHERE id=$1 FOR UPDATE",
    [event.ledger_id],
  );
  const destination = ledger.rows[0]?.line_group_id ?? null;
  const members = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM member
      WHERE ledger_id=$1 AND is_active AND membership_kind='couple'`,
    [event.ledger_id],
  );
  const memberCount = Number(members.rows[0]?.count ?? 0);
  if (memberCount >= 2) {
    await enqueueReply(client, event, destination, replyTokenCiphertext,
      "member_pairing_result", "這個帳本目前無法接受新的配對成員。若要更換成員，請由帳本管理者處理。");
    await finish(client, event, "rejected");
    return processedResult(event, "rejected");
  }
  const existing = await client.query<{ line_group_id: string }>(
    `SELECT l.line_group_id
       FROM member m JOIN ledger l ON l.id=m.ledger_id
      WHERE m.line_user_id=$1 AND m.is_active AND m.membership_kind='couple'`,
    [lineUserId],
  );
  if (existing.rowCount !== 0) {
    await enqueueReply(client, event, destination, replyTokenCiphertext,
      "member_pairing_result", "這個 LINE 帳號已經在另一組有效配對中，不能同時加入兩本帳。解除原配對後才能重新加入。");
    await finish(client, event, "rejected");
    return processedResult(event, "rejected");
  }
  const inserted = await client.query(
    `INSERT INTO member (ledger_id,line_user_id,display_name,command_alias,membership_kind)
     SELECT $1::uuid,$2::text,COALESCE(candidate.display_name,'新成員'),
            candidate.display_name,'couple'
       FROM (SELECT (
         SELECT personal.display_name
           FROM member personal
          WHERE personal.line_user_id=$2 AND personal.membership_kind='personal'
            AND personal.is_active
            AND personal.display_name NOT IN ('我','新成員','另一半')
            AND NOT EXISTS (
              SELECT 1 FROM member other
               WHERE other.ledger_id=$1 AND other.is_active
                 AND (lower(btrim(other.display_name))=lower(btrim(personal.display_name))
                   OR lower(btrim(other.command_alias))=lower(btrim(personal.display_name)))
            )
          ORDER BY personal.created_at,personal.id LIMIT 1
       ) AS display_name) candidate
     ON CONFLICT DO NOTHING`,
    [event.ledger_id, lineUserId],
  );
  if (inserted.rowCount !== 1) {
    await enqueueReply(client, event, destination, replyTokenCiphertext,
      "member_pairing_result", "這個 LINE 帳號已有帳本身份，但目前不是啟用狀態。請由帳本管理者處理。");
    await finish(client, event, "rejected");
    return processedResult(event, "rejected");
  }
  const reply = memberCount === 0
    ? "已建立配對！你是第一位成員。請先輸入「設定暱稱 你的名字」，再請另一位在這個群組輸入「配對」。"
    : "配對成功！兩人帳本已可使用。請輸入「設定暱稱 你的名字」；之後可直接輸入「牛肉麵 150」記個人帳，約會時再切換共同模式。";
  await enqueueReply(client, event, destination, replyTokenCiphertext,
    "member_pairing_result", reply);
  await finish(client, event, "applied");
  return processedResult(event, "applied");
}

function isPairingCommand(text: string): boolean {
  return text === "配對" || text === "建立配對" || text === "開始配對";
}

function parsePairingManagementAction(input: string): PairingManagementAction | null {
  const text = input.normalize("NFKC").trim().replace(/\s+/gu, "");
  if (text === "配對狀態") return "status";
  if (text === "解除配對" || text === "申請解除配對") return "request_unpair";
  if (text === "同意解除" || text === "同意解除配對") return "confirm_unpair";
  if (text === "拒絕解除" || text === "拒絕解除配對") return "reject_unpair";
  if (text === "取消解除" || text === "取消解除配對") return "cancel_unpair";
  return null;
}

interface ActivePairMember {
  id: string;
  display_name: string;
}

interface PendingDissolution {
  id: string;
  requested_by_member_id: string;
  requester_name: string;
  expires_at: Date;
}

async function processPairingManagement(
  client: PoolClient,
  event: ClaimedEvent,
  identity: LedgerMember,
  action: PairingManagementAction,
  replyTokenCiphertext: string | undefined,
): Promise<ProcessInboundEventResult> {
  if (identity.membership_kind === "personal") {
    const reply = action === "status"
      ? "你目前使用獨立個人帳，不需要配對；只有共同模式才需要在兩人群組完成配對。"
      : "個人帳沒有配對關係可解除；你可以繼續直接記帳。";
    await enqueueReply(client, event, identity.line_group_id, replyTokenCiphertext,
      "member_pairing_result", reply, standalonePersonalCard(reply));
    await finish(client, event, action === "status" ? "applied" : "rejected");
    return processedResult(event, action === "status" ? "applied" : "rejected");
  }
  await client.query("SELECT id FROM ledger WHERE id=$1 FOR UPDATE", [event.ledger_id]);
  await client.query(
    `UPDATE pairing_dissolution_request
        SET status='expired', responded_at=clock_timestamp()
      WHERE ledger_id=$1 AND status='pending' AND expires_at <= clock_timestamp()`,
    [event.ledger_id],
  );
  const pair = await loadActivePairMembers(client, event.ledger_id);
  if (pair.length !== 2) {
    const reply = "解除配對只適用於已完成的兩人配對。你可以輸入「建立配對」或「配對」完成設定。";
    await enqueueReply(client, event, identity.line_group_id, replyTokenCiphertext,
      "member_pairing_result", reply, pairingGuideCard(reply));
    await finish(client, event, "rejected");
    return processedResult(event, "rejected");
  }
  const actor = pair.find((member) => member.id === identity.member_id);
  const partner = pair.find((member) => member.id !== identity.member_id);
  if (actor === undefined || partner === undefined) throw new Error("active_pair_identity_mismatch");
  const pending = await loadPendingDissolution(client, event.ledger_id);

  if (action === "status") {
    const reply = pending === null
      ? `你目前與「${partner.display_name}」配對中。解除配對必須雙方同意。`
      : `「${pending.requester_name}」已提出解除配對，需在 ${formatPairingTime(pending.expires_at, identity.timezone)} 前由另一方確認。`;
    await enqueueReply(client, event, identity.line_group_id, replyTokenCiphertext,
      "member_pairing_result", reply, pairingStatusCard({
        altText: reply,
        memberName: actor.display_name,
        partnerName: partner.display_name,
        ...(pending === null ? {} : {
          pendingRequestedBy: pending.requester_name,
          pendingExpiresAt: formatPairingTime(pending.expires_at, identity.timezone),
          viewerIsRequester: pending.requested_by_member_id === actor.id,
        }),
      }));
    await finish(client, event, "applied");
    return processedResult(event, "applied");
  }

  if (action === "request_unpair") {
    if (pending !== null) {
      const isRequester = pending.requested_by_member_id === actor.id;
      const reply = isRequester
        ? `解除申請已送出，正在等待「${partner.display_name}」同意。`
        : `「${pending.requester_name}」已提出解除；若你也同意，請輸入「同意解除」。`;
      await enqueueReply(client, event, identity.line_group_id, replyTokenCiphertext,
        "member_pairing_result", reply, unpairConsentCard({
          altText: reply,
          requesterName: pending.requester_name,
          partnerName: isRequester ? partner.display_name : actor.display_name,
          expiresAt: formatPairingTime(pending.expires_at, identity.timezone),
        }));
      await finish(client, event, "noop");
      return processedResult(event, "noop");
    }
    const inserted = await client.query<{ expires_at: Date }>(
      `INSERT INTO pairing_dissolution_request (ledger_id,requested_by_member_id)
       VALUES ($1,$2) RETURNING expires_at`,
      [event.ledger_id, actor.id],
    );
    const expiresAt = inserted.rows[0]!.expires_at;
    const reply = `已提出解除配對，等待「${partner.display_name}」在 24 小時內同意；確認前仍可正常記帳。`;
    await enqueueReply(client, event, identity.line_group_id, replyTokenCiphertext,
      "member_pairing_result", reply, unpairConsentCard({
        altText: reply,
        requesterName: actor.display_name,
        partnerName: partner.display_name,
        expiresAt: formatPairingTime(expiresAt, identity.timezone),
      }));
    await finish(client, event, "applied");
    return processedResult(event, "applied");
  }

  if (pending === null) {
    const reply = "目前沒有等待確認的解除申請。若要開始，請先輸入「解除配對」。";
    await enqueueReply(client, event, identity.line_group_id, replyTokenCiphertext,
      "member_pairing_result", reply);
    await finish(client, event, "rejected");
    return processedResult(event, "rejected");
  }

  const actorRequested = pending.requested_by_member_id === actor.id;
  if (action === "confirm_unpair") {
    if (actorRequested) {
      const reply = "發起人不能替對方同意；請等待配對對象輸入「同意解除」，或輸入「取消解除」。";
      await enqueueReply(client, event, identity.line_group_id, replyTokenCiphertext,
        "member_pairing_result", reply);
      await finish(client, event, "rejected");
      return processedResult(event, "rejected");
    }
    await client.query(
      `UPDATE pairing_dissolution_request
          SET status='confirmed', responded_by_member_id=$2, responded_at=clock_timestamp()
        WHERE id=$1 AND status='pending'`,
      [pending.id, actor.id],
    );
    await client.query(
      "UPDATE member SET is_active=false, updated_at=clock_timestamp() WHERE ledger_id=$1 AND is_active",
      [event.ledger_id],
    );
    const archivedGroupId = `archived:${event.ledger_id}:${identity.line_group_id}`;
    await client.query(
      "UPDATE ledger SET line_group_id=$2, updated_at=clock_timestamp() WHERE id=$1",
      [event.ledger_id, archivedGroupId],
    );
    await client.query("SELECT provision_line_group_ledger($1)", [identity.line_group_id]);
    const reply = "雙方已同意，配對已解除。舊帳本已安全封存；你們現在都能自由建立新的配對。";
    await enqueueReply(client, event, identity.line_group_id, replyTokenCiphertext,
      "member_pairing_result", reply, pairingGuideCard(reply));
    await finish(client, event, "applied");
    return processedResult(event, "applied");
  }

  if (action === "reject_unpair" && actorRequested) {
    const reply = "發起人若不想繼續解除，請輸入「取消解除」。";
    await enqueueReply(client, event, identity.line_group_id, replyTokenCiphertext,
      "member_pairing_result", reply);
    await finish(client, event, "rejected");
    return processedResult(event, "rejected");
  }
  if (action === "cancel_unpair" && !actorRequested) {
    const reply = "你不是申請發起人；若不同意解除，請輸入「拒絕解除」。";
    await enqueueReply(client, event, identity.line_group_id, replyTokenCiphertext,
      "member_pairing_result", reply);
    await finish(client, event, "rejected");
    return processedResult(event, "rejected");
  }

  const status = actorRequested ? "cancelled" : "rejected";
  await client.query(
    `UPDATE pairing_dissolution_request
        SET status=$2, responded_by_member_id=$3, responded_at=clock_timestamp()
      WHERE id=$1 AND status='pending'`,
    [pending.id, status, actorRequested ? null : actor.id],
  );
  const reply = actorRequested
    ? "解除申請已取消，原配對維持不變。"
    : "你已拒絕解除，原配對維持不變。";
  await enqueueReply(client, event, identity.line_group_id, replyTokenCiphertext,
    "member_pairing_result", reply);
  await finish(client, event, "applied");
  return processedResult(event, "applied");
}

async function loadActivePairMembers(client: PoolClient, ledgerId: string): Promise<ActivePairMember[]> {
  const result = await client.query<ActivePairMember>(
    `SELECT id::text,display_name FROM member
      WHERE ledger_id=$1 AND is_active AND membership_kind='couple'
      ORDER BY created_at,id FOR UPDATE`,
    [ledgerId],
  );
  return result.rows;
}

async function hasCompletePair(client: PoolClient, ledgerId: string): Promise<boolean> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM member
      WHERE ledger_id=$1 AND is_active AND membership_kind='couple'`,
    [ledgerId],
  );
  return result.rows[0]?.count === "2";
}

function ledgerCommandRequiresCompletePair(command: LedgerCommand): boolean {
  if (command.kind === "mode") return command.scope === "shared";
  if (command.kind === "bulk_payer") return true;
  if (command.kind === "recent" || command.kind === "period" || command.kind === "ranking") {
    return command.filter.kind === "shared";
  }
  if (command.kind === "update") {
    return (command.change.field === "scope" && command.change.value === "shared")
      || command.change.field === "payer"
      || command.change.field === "owner";
  }
  return false;
}

function commandPublicId(command: LedgerCommand): string | null {
  if (command.kind === "detail" || command.kind === "update" || command.kind === "tags"
      || command.kind === "void" || command.kind === "restore") {
    return command.publicId;
  }
  return null;
}

async function resolveAuthorizedCommandLedger(
  client: PoolClient,
  identity: LedgerMember,
  publicId: string,
): Promise<string | null> {
  const result = await client.query<{ ledger_id: string }>(
    `SELECT expense.ledger_id::text
       FROM expense_transaction expense
       LEFT JOIN member owner
         ON owner.ledger_id=expense.ledger_id AND owner.id=expense.personal_owner_member_id
      WHERE expense.public_id=$1
        AND ((expense.scope='personal' AND owner.line_user_id=$2)
          OR (expense.scope='shared' AND expense.ledger_id=$3::uuid))
      LIMIT 2`,
    [publicId, identity.line_user_id, identity.couple_ledger_id],
  );
  return result.rows.length === 1 ? result.rows[0]!.ledger_id : null;
}

async function rehomeInboundEvent(
  client: PoolClient,
  event: ClaimedEvent,
  targetLedgerId: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE inbound_event SET ledger_id=$2
      WHERE webhook_event_id=$1 AND ledger_id=$3`,
    [event.webhook_event_id, targetLedgerId, event.ledger_id],
  );
  if (result.rowCount !== 1) throw new Error("inbound_event_rehome_failed");
  event.ledger_id = targetLedgerId;
}

async function loadPendingDissolution(client: PoolClient, ledgerId: string): Promise<PendingDissolution | null> {
  const result = await client.query<PendingDissolution>(
    `SELECT request.id::text,request.requested_by_member_id::text,
            requester.display_name AS requester_name,request.expires_at
       FROM pairing_dissolution_request request
       JOIN member requester ON requester.id=request.requested_by_member_id
      WHERE request.ledger_id=$1 AND request.status='pending'
      FOR UPDATE OF request`,
    [ledgerId],
  );
  return result.rows[0] ?? null;
}

function formatPairingTime(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

async function loadLedgerDestination(client: PoolClient, ledgerId: string): Promise<string | null> {
  const result = await client.query<{ line_group_id: string }>(
    "SELECT line_group_id FROM ledger WHERE id=$1",
    [ledgerId],
  );
  return result.rows[0]?.line_group_id ?? null;
}

async function loadIdentity(
  client: PoolClient,
  ledgerId: string,
  lineUserId: string,
): Promise<LedgerMember | null> {
  return loadIdentityByStatus(client, ledgerId, lineUserId, true);
}

async function loadIdentityIncludingInactive(
  client: PoolClient,
  ledgerId: string,
  lineUserId: string,
): Promise<LedgerMember | null> {
  return loadIdentityByStatus(client, ledgerId, lineUserId, false);
}

async function loadIdentityByStatus(
  client: PoolClient,
  ledgerId: string,
  lineUserId: string,
  activeOnly: boolean,
): Promise<LedgerMember | null> {
  const result = await client.query<LedgerMember>(
    `SELECT l.id::text AS ledger_id, l.line_group_id, l.timezone,
            l.default_scope::text, l.allow_bare_entry,
            m.id::text AS member_id,
            CASE WHEN m.display_name IN ('我','新成員','另一半')
                 THEN COALESCE(couple.display_name,m.display_name)
                 ELSE m.display_name END AS display_name,
            m.membership_kind,m.line_user_id,
            couple.ledger_id::text AS couple_ledger_id,
            couple.id::text AS couple_member_id
       FROM ledger l
       JOIN member m ON m.ledger_id = l.id AND m.line_user_id = $2
       LEFT JOIN LATERAL (
         SELECT paired.id,paired.ledger_id,paired.display_name
           FROM member paired
          WHERE paired.line_user_id=$2 AND paired.is_active
            AND paired.membership_kind='couple'
          ORDER BY paired.created_at,paired.id LIMIT 1
       ) couple ON true
      WHERE l.id = $1 AND ($3::boolean=false OR m.is_active)`,
    [ledgerId, lineUserId, activeOnly],
  );
  return result.rows[0] ?? null;
}

async function findExistingExpense(client: PoolClient, event: ClaimedEvent): Promise<string | null> {
  const result = await client.query<{ public_id: string }>(
    `SELECT public_id FROM expense_transaction
      WHERE ledger_id = $1
        AND (source_webhook_event_id = $2 OR source_message_id = $3)
      LIMIT 1`,
    [event.ledger_id, event.webhook_event_id, event.line_message_id],
  );
  return result.rows[0]?.public_id ?? null;
}

async function insertExpenseWithCollisionRetry(
  client: PoolClient,
  event: ClaimedEvent,
  identity: LedgerMember,
  payerMemberId: string,
  expense: ParsedExpense,
  sourceText: string,
  makePublicId: () => string,
): Promise<{ id: string; publicId: string }> {
  for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt += 1) {
    const publicId = makePublicId();
    if (!/^[0-9A-HJKMNP-TV-Z]{8,}$/u.test(publicId)) {
      throw new Error("invalid_generated_public_id");
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO expense_transaction (
         ledger_id, public_id, created_by_member_id, payer_member_id,
         personal_owner_member_id, scope, amount_minor, currency, description,
         occurred_on, occurred_date_source, occurred_at, occurred_time_source,
         occurred_time_precision, source_webhook_event_id, source_message_id,
         source_text
       )
       SELECT $1::uuid, $2::text, $3::uuid, $4::uuid,
              CASE WHEN $5::expense_scope = 'personal' THEN $3::uuid ELSE NULL END,
              $5::expense_scope, $6::bigint, $7::text, $8::text, $9::date,
              $10::occurred_date_source, $11::timestamptz,
              $12::occurred_time_source, $13::time_precision,
              $14::text, $15::text, $16::text
       ON CONFLICT (public_id) DO NOTHING
       RETURNING id::text AS id`,
      [
        event.ledger_id, publicId, identity.member_id, payerMemberId, expense.scope,
        expense.amountMinor, expense.currency, expense.description,
        expense.occurredOn, expense.occurredDateSource, expense.occurredAt,
        expense.occurredTimeSource, expense.occurredTimePrecision,
        event.webhook_event_id, event.line_message_id, sourceText,
      ],
    );
    const id = result.rows[0]?.id;
    if (id !== undefined) return { id, publicId };
  }
  throw new Error("public_id_collision_limit_exceeded");
}

async function loadPairedPartner(
  client: PoolClient,
  ledgerId: string,
  actorMemberId: string,
): Promise<{ id: string; displayName: string } | null> {
  const result = await client.query<{ id: string; display_name: string }>(
    `SELECT id::text,display_name FROM member
      WHERE ledger_id=$1 AND id<>$2 AND is_active ORDER BY created_at,id LIMIT 2`,
    [ledgerId, actorMemberId],
  );
  return result.rows.length === 1
    ? { id: result.rows[0]!.id, displayName: result.rows[0]!.display_name }
    : null;
}

async function insertTypedTags(
  client: PoolClient,
  ledgerId: string,
  transactionId: string,
  memberId: string,
  assignments: readonly TypedTag[],
): Promise<void> {
  for (const assignment of assignments) {
    const tag = assignment.type === "custom"
      ? assignment.source === "inferred"
        ? await loadSystemTag(client, ledgerId, "custom", assignment.code)
        : await upsertCustomTag(client, ledgerId, assignment.displayName, assignment.normalizedName)
      : await loadSystemTag(client, ledgerId, assignment.type, assignment.code);
    await client.query(
      `INSERT INTO transaction_tag (
         ledger_id, transaction_id, tag_id, tag_type, source, rule_key,
         rule_version, assigned_by_member_id
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::tag_type,
                 $5::assignment_source, $6::text, $7::text,
                 CASE WHEN $5::assignment_source = 'explicit'
                      THEN $8::uuid ELSE NULL END)`,
      [ledgerId, transactionId, tag, assignment.type, assignment.source,
        assignment.ruleKey, assignment.ruleVersion, memberId],
    );
  }
}

async function loadSystemTag(
  client: PoolClient,
  ledgerId: string,
  type: "category" | "meal" | "custom",
  code: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM tag
      WHERE ledger_id = $1 AND type = $2 AND code = $3
        AND is_system AND is_active`,
    [ledgerId, type, code],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`system_tag_missing:${type}:${code}`);
  return id;
}

async function upsertCustomTag(
  client: PoolClient,
  ledgerId: string,
  displayName: string,
  normalizedName: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO tag (
       ledger_id, type, code, display_name, normalized_name, is_system, is_active
     ) VALUES ($1, 'custom', encode(digest($2::text, 'sha256'::text), 'hex'),
               $3, $2, false, true)
     ON CONFLICT (ledger_id, normalized_name) WHERE is_active
     DO UPDATE SET updated_at = tag.updated_at
     RETURNING id::text AS id`,
    [ledgerId, normalizedName, displayName],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("custom_tag_upsert_failed");
  return id;
}

async function insertCreatedAudit(
  client: PoolClient,
  event: ClaimedEvent,
  transactionId: string,
  memberId: string,
  publicId: string,
  expense: ParsedExpense,
): Promise<void> {
  const snapshot = {
    publicId,
    amountMinor: expense.amountMinor,
    currency: expense.currency,
    description: expense.description,
    scope: expense.scope,
    occurredOn: expense.occurredOn,
    occurredAt: expense.occurredAt,
    tags: expense.tags,
  };
  await client.query(
    `INSERT INTO transaction_event (
       ledger_id, transaction_id, actor_member_id, source_webhook_event_id,
       event_type, changed_fields, after_data, schema_version
     ) VALUES ($1, $2, $3, $4, 'created', $5::jsonb, $6::jsonb, 1)`,
    [event.ledger_id, transactionId, memberId, event.webhook_event_id,
      JSON.stringify(Object.keys(snapshot)), JSON.stringify(snapshot)],
  );
}

async function enqueueReply(
  client: PoolClient,
  event: ClaimedEvent,
  destinationRef: string | null,
  replyTokenCiphertext: string | undefined,
  purpose:
    | "expense_create_result"
    | "expense_create_rejected"
    | "ledger_command_result"
    | "ledger_onboarding"
    | "member_pairing_result"
    | "expense_edit_notice",
  text: string,
  message?: LineReplyMessage,
): Promise<void> {
  if (replyTokenCiphertext === undefined || destinationRef === null) return;
  const credential = decodeCiphertext(replyTokenCiphertext);
  if (credential === null) throw new Error("invalid_reply_token_ciphertext");
  await client.query(
    `INSERT INTO outbox_message (
       ledger_id, source_webhook_event_id, purpose, delivery_kind,
       destination_ref, delivery_credential_ciphertext, payload_json, expires_at
     ) VALUES ($1, $2, $3, 'line_reply', $4, $5, $6::jsonb,
               $7::timestamptz + interval '55 seconds')
     ON CONFLICT (ledger_id, source_webhook_event_id, purpose) DO NOTHING`,
    [event.ledger_id, event.webhook_event_id, purpose, destinationRef,
      credential, JSON.stringify(message === undefined ? lineTextReply(text) : { messages: [message] }), event.received_at],
  );
}

async function lockAndCheckTombstone(
  client: PoolClient,
  event: ClaimedEvent,
): Promise<boolean> {
  if (event.line_message_id === null) return false;
  await client.query("SELECT lock_line_message($1, $2)", [
    event.ledger_id,
    event.line_message_id,
  ]);
  const tombstone = await client.query(
    `SELECT 1 FROM message_tombstone
      WHERE ledger_id = $1 AND line_message_id = $2`,
    [event.ledger_id, event.line_message_id],
  );
  return (tombstone.rowCount ?? 0) > 0;
}

async function finish(
  client: PoolClient,
  event: ClaimedEvent,
  outcome: "applied" | "rejected" | "noop" | "ignored_unsent",
): Promise<void> {
  await client.query(
    `UPDATE inbound_event
        SET status = 'succeeded', locked_at = NULL, processed_at = clock_timestamp(),
            outcome_code = $2, payload_json = NULL,
            payload_redacted_at = CASE WHEN payload_json IS NULL THEN payload_redacted_at
                                       ELSE clock_timestamp() END,
            last_error_code = NULL
      WHERE webhook_event_id = $1`,
    [event.webhook_event_id, outcome],
  );
}

async function markDeadLetter(
  client: PoolClient,
  event: ClaimedEvent,
  errorCode: string,
): Promise<void> {
  await client.query(
    `UPDATE inbound_event
        SET status = 'dead_letter', locked_at = NULL,
            processed_at = clock_timestamp(), outcome_code = NULL,
            last_error_code = $2
      WHERE webhook_event_id = $1`,
    [event.webhook_event_id, errorCode],
  );
}

async function releaseForRetry(
  client: PoolClient,
  event: ClaimedEvent,
  errorCode: string,
): Promise<void> {
  await client.query(
    `UPDATE inbound_event
        SET status = 'pending', locked_at = NULL,
            available_at = clock_timestamp() + interval '60 seconds',
            last_error_code = $2
      WHERE webhook_event_id = $1`,
    [event.webhook_event_id, errorCode],
  );
}

async function rejectMalformedPayload(
  client: PoolClient,
  event: ClaimedEvent,
  payload: TextPayload | null,
): Promise<void> {
  if (payload !== null) {
    const ledger = await client.query<{ line_group_id: string }>(
      "SELECT line_group_id FROM ledger WHERE id = $1",
      [event.ledger_id],
    );
    await enqueueReply(client, event, ledger.rows[0]?.line_group_id ?? null,
      payload.replyTokenCiphertext, "expense_create_rejected", "無法讀取這則記帳訊息，請再試一次。");
  }
  await finish(client, event, "rejected");
}

function decodeTextPayload(value: unknown): TextPayload | null {
  if (!isRecord(value) || typeof value.destination !== "string" ||
      !isRecord(value.source) || typeof value.source.userId !== "string" ||
      !isRecord(value.message) || value.message.type !== "text" ||
      typeof value.message.text !== "string") return null;
  const token = value.replyTokenCiphertext;
  if (token !== undefined && typeof token !== "string") return null;
  if (typeof token === "string" && decodeCiphertext(token) === null) return null;
  return {
    destination: value.destination,
    source: {
      chatType: value.source.chatType === "user" ? "user" : "group",
      userId: value.source.userId,
    },
    message: { type: "text", text: value.message.text },
    ...(typeof token === "string" ? { replyTokenCiphertext: token } : {}),
  };
}

function decodeLifecyclePayload(value: unknown): LifecyclePayload | null {
  if (!isRecord(value) || typeof value.destination !== "string" ||
      !isRecord(value.source) || !isRecord(value.event) ||
      (value.event.kind !== "edit" && value.event.kind !== "join")) return null;
  const userId = value.source.userId;
  if (userId !== undefined && typeof userId !== "string") return null;
  const token = value.replyTokenCiphertext;
  if (token !== undefined && typeof token !== "string") return null;
  if (typeof token === "string" && decodeCiphertext(token) === null) return null;
  return {
    destination: value.destination,
    source: { ...(typeof userId === "string" ? { userId } : {}) },
    event: { kind: value.event.kind },
    ...(typeof token === "string" ? { replyTokenCiphertext: token } : {}),
  };
}

function decodeCiphertext(value: string): Buffer | null {
  if (value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === 0 || decoded.toString("base64") !== value ? null : decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExplicitScopePrefix(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  return /^(?:共同|個人)(?:\s|$)/u.test(normalized);
}

function processedResult(
  event: ClaimedEvent,
  outcome:
    | "applied"
    | "rejected"
    | "noop"
    | "ignored_unsent"
    | "retry_scheduled"
    | "dead_letter",
): ProcessInboundEventResult {
  return { processed: true, webhookEventId: event.webhook_event_id, outcome };
}
