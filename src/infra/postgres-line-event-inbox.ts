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
  outcomeCode: "unauthorized" | null;
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

      const ledgerIdsByGroup = new Map<string, string>();
      for (const acceptedEvent of events) {
        // Events outside this product's configured group have no ledger to
        // attach to and cannot cause a side effect. Acknowledge them without
        // persistence instead of returning 503 and inducing endless LINE
        // redelivery. Unknown members in the configured group still get a
        // content-free inbox row for deduplication.
        if (isUnroutableUnauthorizedEvent(acceptedEvent)) {
          continue;
        }

        const groupId = acceptedEvent.event.source.groupId;
        if (groupId === undefined || groupId.length === 0) {
          throw new InvalidLineInboxEventError("group_id_missing");
        }

        let ledgerId = ledgerIdsByGroup.get(groupId);
        if (ledgerId === undefined) {
          ledgerId = await resolveLedgerId(client, groupId);
          ledgerIdsByGroup.set(groupId, ledgerId);
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
    const pairingRequest = !authorization.authorized && authorization.reason === "member_not_allowed"
      && isPairingRequest(event);
    const unauthorized = !authorization.authorized && !databaseMember && !pairingRequest;
    const payload = unauthorized
      ? null
      : await this.#authorizedTextPayload(destination, acceptedEvent);

    return {
      ledgerId,
      webhookEventId: event.webhookEventId,
      eventType: event.rawType,
      lineMessageId: event.lineMessageId ?? null,
      lineEventAt,
      payload,
      status: unauthorized ? "succeeded" : "pending",
      processedAt: unauthorized ? new Date() : null,
      outcomeCode: unauthorized ? "unauthorized" : null,
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
      source: { userId },
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

function isPairingRequest(event: AcceptedLineEvent["event"]): boolean {
  return event.kind === "message" && event.message?.type === "text"
    && typeof event.message.text === "string"
    && event.message.text.normalize("NFKC").trim() === "配對"
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

async function resolveLedgerId(
  client: PoolClient,
  groupId: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT id::text AS id
       FROM ledger
      WHERE line_group_id = $1`,
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
