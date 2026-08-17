import type { Pool, PoolClient } from "pg";

import type {
  AcceptedLineEvent,
  LineEventInbox,
} from "../http/webhook.js";

export type EncryptDeliveryCredential = (
  plaintext: string,
) => Buffer | Promise<Buffer>;

export interface PostgresLineEventInboxOptions {
  encryptDeliveryCredential: EncryptDeliveryCredential;
}

export class LineInboxLedgerNotFoundError extends Error {
  constructor() {
    super("line_inbox_ledger_not_found");
    this.name = "LineInboxLedgerNotFoundError";
  }
}

export class InvalidLineInboxEventError extends Error {
  constructor(
    code:
      | "destination_missing"
      | "group_id_missing"
      | "event_time_invalid"
      | "ciphertext_empty",
  ) {
    super(`invalid_line_inbox_event:${code}`);
    this.name = "InvalidLineInboxEventError";
  }
}

interface AuthorizedTextPayload {
  destination: string;
  source: {
    chatType: "group" | "user";
    userId: string;
  };
  message: {
    type: "text";
    text: string;
  };
  replyTokenCiphertext?: string;
}

interface AuthorizedLifecyclePayload {
  destination: string;
  source: {
    userId?: string;
  };
  event: {
    kind: "edit" | "join";
  };
  replyTokenCiphertext?: string;
}

type AuthorizedPayload = AuthorizedTextPayload | AuthorizedLifecyclePayload;

interface InboxInsert {
  ledgerId: string;
  webhookEventId: string;
  eventType: string;
  lineMessageId: string | null;
  lineEventAt: Date;
  payload: AuthorizedPayload | null;
  status: "pending" | "succeeded";
  processedAt: Date | null;
  outcomeCode: "unauthorized" | "noop" | null;
}

/**
 * PostgreSQL transactional inbox for normalized LINE events.
 *
 * All ledger resolutions and inserts for one webhook request are committed as
 * a single unit. A missing ledger therefore rolls the whole request back, so
 * the HTTP boundary can return 503 and allow LINE to redeliver it.
 */
export class PostgresLineEventInbox implements LineEventInbox {
  readonly #pool: Pool;
  readonly #encryptDeliveryCredential: EncryptDeliveryCredential;

  constructor(pool: Pool, options: PostgresLineEventInboxOptions) {
    this.#pool = pool;
    this.#encryptDeliveryCredential = options.encryptDeliveryCredential;
  }

  async acceptBatch(
    destination: string,
    events: readonly AcceptedLineEvent[],
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }
    if (destination.trim().length === 0) {
      throw new InvalidLineInboxEventError("destination_missing");
    }

    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");

      const ledgerIdsBySource = new Map<string, string>();
      for (const acceptedEvent of events) {
        // Events outside this product's configured group have no ledger to
        // attach to and cannot cause a side effect. Acknowledge them without
        // persistence instead of returning 503 and inducing endless LINE
        // redelivery. Unknown members in the configured group still get a
        // content-free inbox row for deduplication.
        if (isUnroutableUnauthorizedEvent(acceptedEvent)) {
          continue;
        }

        const source = acceptedEvent.event.source;
        const sourceKey = source.type === "user"
          ? `user:${source.userId ?? ""}`
          : `group:${source.groupId ?? ""}`;
        let ledgerId = ledgerIdsBySource.get(sourceKey);
        if (ledgerId === undefined) {
          if (source.type === "user" && source.userId !== undefined) {
            const personalLedgerId = await resolvePersonalLedgerId(client, source.userId);
            if (personalLedgerId !== null) {
              ledgerId = personalLedgerId;
            } else if (acceptedEvent.authorization.authorized && isPrivateSelfServiceText(acceptedEvent.event)) {
              ledgerId = await provisionPrivateLedgerId(client, source.userId);
            } else {
              const coupleLedgerId = await resolveCoupleLedgerId(client, source.userId);
              if (coupleLedgerId === null) continue;
              ledgerId = coupleLedgerId;
            }
          } else {
            const groupId = source.groupId;
            if (groupId === undefined || groupId.length === 0) {
              throw new InvalidLineInboxEventError("group_id_missing");
            }
            ledgerId = await resolveOrProvisionLedgerId(client, groupId);
          }
          ledgerIdsBySource.set(sourceKey, ledgerId);
        }

        const insert = await this.#toInboxInsert(
          client,
          destination,
          ledgerId,
          acceptedEvent,
        );
        await insertEvent(client, insert);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #toInboxInsert(
    client: PoolClient,
    destination: string,
    ledgerId: string,
    acceptedEvent: AcceptedLineEvent,
  ): Promise<InboxInsert> {
    const { event, authorization } = acceptedEvent;
    const lineEventAt = new Date(event.lineEventAtMs);
    if (Number.isNaN(lineEventAt.valueOf())) {
      throw new InvalidLineInboxEventError("event_time_invalid");
    }

    const databaseMember = !authorization.authorized && authorization.reason === "member_not_allowed"
      ? await isActiveLedgerMember(client, ledgerId, event.source.userId)
      : false;
    const onboardingRequest = !authorization.authorized && authorization.reason === "member_not_allowed"
      && isOnboardingRequest(event);
    const unauthorized = !authorization.authorized && !databaseMember && !onboardingRequest;
    const passivePostback = event.kind === "postback";
    const payload = unauthorized || passivePostback
      ? null
      : await this.#authorizedTextPayload(destination, acceptedEvent);

    return {
      ledgerId,
      webhookEventId: event.webhookEventId,
      eventType: event.rawType,
      lineMessageId: event.lineMessageId ?? null,
      lineEventAt,
      payload,
      status: unauthorized || passivePostback ? "succeeded" : "pending",
      processedAt: unauthorized || passivePostback ? new Date() : null,
      outcomeCode: unauthorized ? "unauthorized" : passivePostback ? "noop" : null,
    };
  }

  async #authorizedTextPayload(
    destination: string,
    acceptedEvent: AcceptedLineEvent,
  ): Promise<AuthorizedPayload | null> {
    const { event } = acceptedEvent;
    if (event.kind === "edit" || event.kind === "join") {
      const payload: AuthorizedLifecyclePayload = {
        destination,
        source: {
          ...(event.source.userId === undefined
            ? {}
            : { userId: event.source.userId }),
        },
        event: { kind: event.kind },
      };
      await this.#attachEncryptedReplyToken(payload, event.replyToken);
      return payload;
    }

    if (event.kind !== "message" || event.message?.type !== "text" ||
        typeof event.message.text !== "string") {
      return null;
    }

    const userId = event.source.userId;
    if (userId === undefined) {
      return null;
    }

    const payload: AuthorizedTextPayload = {
      destination,
      source: {
        chatType: event.source.type === "user" ? "user" : "group",
        userId,
      },
      message: {
        type: "text",
        text: event.message.text,
      },
    };

    await this.#attachEncryptedReplyToken(payload, event.replyToken);
    return payload;
  }

  async #attachEncryptedReplyToken(
    payload: { replyTokenCiphertext?: string },
    replyToken: string | undefined,
  ): Promise<void> {
    if (replyToken !== undefined) {
      const ciphertext = await this.#encryptDeliveryCredential(replyToken);
      if (ciphertext.byteLength === 0) {
        throw new InvalidLineInboxEventError("ciphertext_empty");
      }
      payload.replyTokenCiphertext = ciphertext.toString("base64");
    }
  }
}

async function isActiveLedgerMember(client: PoolClient, ledgerId: string, lineUserId: string | undefined): Promise<boolean> {
  if (lineUserId === undefined) return false;
  const result = await client.query(
    "SELECT 1 FROM member WHERE ledger_id=$1 AND line_user_id=$2 AND is_active",
    [ledgerId, lineUserId],
  );
  return result.rowCount === 1;
}

function isOnboardingRequest(event: AcceptedLineEvent["event"]): boolean {
  return event.kind === "message" && event.message?.type === "text"
    && typeof event.message.text === "string"
    && ["配對", "建立配對", "開始配對", "配對狀態", "說明", "使用說明", "配對說明"]
      .includes(event.message.text.normalize("NFKC").trim())
    && event.source.userId !== undefined;
}

function isUnroutableUnauthorizedEvent(event: AcceptedLineEvent): boolean {
  if (event.authorization.authorized) {
    return false;
  }

  return (
    event.authorization.reason === "source_not_group" ||
    event.authorization.reason === "group_id_missing" ||
    event.authorization.reason === "group_not_allowed"
  );
}

async function resolvePersonalLedgerId(
  client: PoolClient,
  lineUserId: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT l.id::text AS id
       FROM ledger l
      JOIN member m ON m.ledger_id = l.id
      WHERE m.line_user_id = $1
        AND m.is_active
        AND m.membership_kind = 'personal'
      LIMIT 1`,
    [lineUserId],
  );
  const ledgerId = result.rows[0]?.id;
  if (ledgerId === undefined) {
    return null;
  }
  return ledgerId;
}

async function resolveCoupleLedgerId(client: PoolClient, lineUserId: string): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT l.id::text AS id
       FROM ledger l JOIN member m ON m.ledger_id=l.id
      WHERE m.line_user_id=$1 AND m.is_active AND m.membership_kind='couple'
      LIMIT 1`,
    [lineUserId],
  );
  return result.rows[0]?.id ?? null;
}

function isPrivateSelfServiceText(event: AcceptedLineEvent["event"]): boolean {
  return event.source.type === "user"
    && event.kind === "message"
    && event.message?.type === "text"
    && typeof event.message.text === "string"
    && event.source.userId !== undefined;
}

async function provisionPrivateLedgerId(client: PoolClient, lineUserId: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    "SELECT provision_line_user_ledger($1)::text AS id",
    [lineUserId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new LineInboxLedgerNotFoundError();
  await client.query(
    `UPDATE member personal
        SET display_name=paired.display_name,command_alias=paired.display_name,
            updated_at=clock_timestamp()
       FROM member paired
      WHERE personal.ledger_id=$1 AND personal.line_user_id=$2
        AND personal.membership_kind='personal'
        AND personal.display_name IN ('我','新成員','另一半')
        AND paired.line_user_id=personal.line_user_id
        AND paired.membership_kind='couple' AND paired.is_active
        AND paired.display_name NOT IN ('我','新成員','另一半')`,
    [id, lineUserId],
  );
  return id;
}

async function resolveOrProvisionLedgerId(
  client: PoolClient,
  groupId: string,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "SELECT id::text AS id FROM ledger WHERE line_group_id=$1",
    [groupId],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId !== undefined) return existingId;

  const result = await client.query<{ id: string }>(
    "SELECT provision_line_group_ledger($1)::text AS id",
    [groupId],
  );

  const ledgerId = result.rows[0]?.id;
  if (result.rowCount !== 1 || ledgerId === undefined) {
    throw new LineInboxLedgerNotFoundError();
  }
  return ledgerId;
}

async function insertEvent(
  client: PoolClient,
  insert: InboxInsert,
): Promise<void> {
  await client.query(
    `INSERT INTO inbound_event (
       webhook_event_id,
       ledger_id,
       event_type,
       line_message_id,
       line_event_at,
       payload_json,
       status,
       processed_at,
       outcome_code
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     ON CONFLICT (webhook_event_id) DO NOTHING`,
    [
      insert.webhookEventId,
      insert.ledgerId,
      insert.eventType,
      insert.lineMessageId,
      insert.lineEventAt,
      insert.payload === null ? null : JSON.stringify(insert.payload),
      insert.status,
      insert.processedAt,
      insert.outcomeCode,
    ],
  );
}
