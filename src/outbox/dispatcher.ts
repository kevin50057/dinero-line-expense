import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { CredentialCipher } from "../security/credential-cipher.js";
import type { LineReplyClient, LineReplyDeliveryResult } from "./line-reply-client.js";
import { parseLineReplyPayload } from "./payload.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_REPLY_TOKEN_LIFETIME_MS = 55_000;
const DEFAULT_LEASE_TIMEOUT_MS = 30_000;

interface ClaimedOutboxRow extends QueryResultRow {
  id: string;
  delivery_credential_ciphertext: Buffer | null;
  payload_json: unknown;
  attempt_count: number;
  previous_attempt_count: number;
  created_at: Date | string;
  expires_at: Date | string;
  locked_at: Date | string;
}

interface RecoveredRow extends QueryResultRow {
  status: "pending" | "dead_letter";
}

export interface LineReplyOutboxDispatcherOptions {
  readonly pool: Pick<Pool, "connect">;
  readonly credentialCipher: CredentialCipher;
  readonly lineClient: LineReplyClient;
  readonly now?: () => Date;
  readonly maxAttempts?: number;
  readonly replyTokenLifetimeMs?: number;
  readonly leaseTimeoutMs?: number;
  readonly retryDelayMs?: (attemptCount: number) => number;
}

export type ProcessOneOutboxResult =
  | { readonly status: "idle" }
  | { readonly status: "sent"; readonly id: string }
  | {
      readonly status: "retry_scheduled";
      readonly id: string;
      readonly attemptCount: number;
      readonly availableAt: Date;
    }
  | {
      readonly status: "dead_letter";
      readonly id: string;
      readonly errorCode: string;
    }
  | { readonly status: "lease_lost"; readonly id: string };

export interface LeaseRecoveryResult {
  readonly recoveredToPending: number;
  readonly deadLettered: number;
}

export interface PayloadRedactionResult {
  readonly redacted: number;
}

/**
 * One-at-a-time PostgreSQL dispatcher for short-lived LINE reply tokens.
 * Claiming commits before network I/O; `sending` plus `locked_at` is its lease.
 */
export class PostgresLineReplyOutboxDispatcher {
  readonly #pool: Pick<Pool, "connect">;
  readonly #credentialCipher: CredentialCipher;
  readonly #lineClient: LineReplyClient;
  readonly #now: () => Date;
  readonly #maxAttempts: number;
  readonly #replyTokenLifetimeMs: number;
  readonly #leaseTimeoutMs: number;
  readonly #retryDelayMs: (attemptCount: number) => number;

  constructor(options: LineReplyOutboxDispatcherOptions) {
    this.#pool = options.pool;
    this.#credentialCipher = options.credentialCipher;
    this.#lineClient = options.lineClient;
    this.#now = options.now ?? (() => new Date());
    this.#maxAttempts = requirePositiveInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      "maxAttempts",
    );
    this.#replyTokenLifetimeMs = requirePositiveInteger(
      options.replyTokenLifetimeMs ?? DEFAULT_REPLY_TOKEN_LIFETIME_MS,
      "replyTokenLifetimeMs",
    );
    this.#leaseTimeoutMs = requirePositiveInteger(
      options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS,
      "leaseTimeoutMs",
    );
    this.#retryDelayMs =
      options.retryDelayMs ??
      ((attemptCount) => Math.min(500 * 2 ** (attemptCount - 1), 5_000));
  }

  async processOne(): Promise<ProcessOneOutboxResult> {
    const claimed = await this.#claimOne(this.#safeNow());
    if (claimed === null) {
      return { status: "idle" };
    }

    const createdAt = parseDatabaseDate(claimed.created_at);
    const lockedAt = parseDatabaseDate(claimed.locked_at);
    const configuredDeadline = parseDatabaseDate(claimed.expires_at);
    const fallbackDeadline = new Date(
      createdAt.getTime() + this.#replyTokenLifetimeMs,
    );
    const deadline = new Date(
      Math.min(configuredDeadline.getTime(), fallbackDeadline.getTime()),
    );
    const beforeDelivery = this.#safeNow();

    if (claimed.previous_attempt_count >= this.#maxAttempts) {
      return this.#deadLetter(
        claimed.id,
        lockedAt,
        "max_attempts_exceeded",
      );
    }
    if (beforeDelivery.getTime() >= deadline.getTime()) {
      return this.#deadLetter(
        claimed.id,
        lockedAt,
        "reply_token_expired",
      );
    }

    let payload;
    try {
      payload = parseLineReplyPayload(claimed.payload_json);
    } catch {
      return this.#deadLetter(claimed.id, lockedAt, "invalid_payload");
    }

    let replyToken: string;
    try {
      const ciphertext = claimed.delivery_credential_ciphertext;
      if (!(ciphertext instanceof Uint8Array)) {
        throw new Error("missing credential");
      }
      replyToken = this.#credentialCipher.decrypt(ciphertext);
      if (replyToken.length === 0) {
        throw new Error("empty credential");
      }
    } catch {
      return this.#deadLetter(claimed.id, lockedAt, "invalid_credential");
    }

    let delivery: LineReplyDeliveryResult;
    try {
      delivery = await this.#lineClient.deliver(replyToken, payload);
    } catch {
      delivery = {
        kind: "retryable_failure",
        errorCode: "line_client_error",
      };
    } finally {
      // Best-effort cleanup of the local ciphertext buffer. JavaScript strings
      // cannot be reliably zeroized; importantly, neither value is logged or
      // returned from this class.
      claimed.delivery_credential_ciphertext?.fill(0);
    }

    if (delivery.kind === "success") {
      return this.#markSent(claimed.id, lockedAt, this.#safeNow());
    }
    const deliveryErrorCode = sanitizeErrorCode(delivery.errorCode);
    if (delivery.kind === "permanent_failure") {
      return this.#deadLetter(claimed.id, lockedAt, deliveryErrorCode);
    }

    const afterDelivery = this.#safeNow();
    if (claimed.attempt_count >= this.#maxAttempts) {
      return this.#deadLetter(claimed.id, lockedAt, deliveryErrorCode);
    }

    const retryDelayMs = this.#retryDelayMs(claimed.attempt_count);
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
      return this.#deadLetter(claimed.id, lockedAt, "invalid_retry_delay");
    }
    const availableAt = new Date(afterDelivery.getTime() + retryDelayMs);
    if (availableAt.getTime() >= deadline.getTime()) {
      return this.#deadLetter(claimed.id, lockedAt, deliveryErrorCode);
    }

    const updated = await this.#updateSendingRow(
      claimed.id,
      lockedAt,
      `
        UPDATE outbox_message
        SET status = 'pending'::outbox_status,
            locked_at = NULL,
            available_at = $3,
            last_error_code = $4
        WHERE id = $1
          AND status = 'sending'
          AND locked_at = $2
      `,
      [claimed.id, lockedAt, availableAt, deliveryErrorCode],
    );

    return updated
      ? {
          status: "retry_scheduled",
          id: claimed.id,
          attemptCount: claimed.attempt_count,
          availableAt,
        }
      : { status: "lease_lost", id: claimed.id };
  }

  /** Requeues abandoned leases, except rows whose attempts/token are exhausted. */
  async recoverExpiredLeases(
    now: Date = this.#safeNow(),
  ): Promise<LeaseRecoveryResult> {
    assertValidDate(now);
    const client = await this.#pool.connect();
    try {
      const result = await client.query<RecoveredRow>(
        `
          UPDATE outbox_message
          SET status = CASE
                WHEN attempt_count >= $3
                  OR expires_at <= $1
                  THEN 'dead_letter'::outbox_status
                ELSE 'pending'::outbox_status
              END,
              locked_at = NULL,
              available_at = CASE
                WHEN attempt_count >= $3 OR expires_at <= $1
                  THEN available_at
                ELSE $1
              END,
              delivery_credential_ciphertext = CASE
                WHEN attempt_count >= $3 OR expires_at <= $1
                  THEN NULL
                ELSE delivery_credential_ciphertext
              END,
              last_error_code = CASE
                WHEN expires_at <= $1
                  THEN 'reply_token_expired'
                WHEN attempt_count >= $3
                  THEN 'max_attempts_exceeded'
                ELSE 'sending_lease_expired'
              END
          WHERE delivery_kind = 'line_reply'
            AND status = 'sending'
            AND locked_at <= $1::timestamptz - ($2::double precision * interval '1 millisecond')
          RETURNING status
        `,
        [now, this.#leaseTimeoutMs, this.#maxAttempts],
      );
      let recoveredToPending = 0;
      let deadLettered = 0;
      for (const row of result.rows) {
        if (row.status === "pending") {
          recoveredToPending += 1;
        } else {
          deadLettered += 1;
        }
      }
      return { recoveredToPending, deadLettered };
    } finally {
      client.release();
    }
  }

  /** Removes retained reply text after a short debugging/privacy window. */
  async redactCompletedPayloads(
    olderThan: Date,
  ): Promise<PayloadRedactionResult> {
    assertValidDate(olderThan);
    const client = await this.#pool.connect();
    try {
      const result = await client.query(
        `UPDATE outbox_message
            SET payload_json = NULL,
                payload_redacted_at = COALESCE(payload_redacted_at, $1)
          WHERE delivery_kind = 'line_reply'
            AND status IN ('sent', 'dead_letter')
            AND payload_json IS NOT NULL
            AND created_at <= $1`,
        [olderThan],
      );
      return { redacted: result.rowCount ?? 0 };
    } finally {
      client.release();
    }
  }

  async #claimOne(now: Date): Promise<ClaimedOutboxRow | null> {
    const client = await this.#pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const result = await client.query<ClaimedOutboxRow>(
        `
          WITH next_message AS (
            SELECT id, attempt_count
            FROM outbox_message
            WHERE delivery_kind = 'line_reply'
              AND status = 'pending'
              AND available_at <= $1
            ORDER BY available_at, created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE outbox_message AS message
          SET status = 'sending'::outbox_status,
              locked_at = $1,
              attempt_count = CASE
                WHEN next_message.attempt_count < $2
                  THEN message.attempt_count + 1
                ELSE message.attempt_count
              END,
              last_error_code = NULL
          FROM next_message
          WHERE message.id = next_message.id
          RETURNING message.id,
                    message.delivery_credential_ciphertext,
                    message.payload_json,
                    message.attempt_count,
                    next_message.attempt_count AS previous_attempt_count,
                    message.created_at,
                    message.expires_at,
                    message.locked_at
        `,
        [now, this.#maxAttempts],
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return result.rows[0] ?? null;
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original database error.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async #markSent(
    id: string,
    lockedAt: Date,
    sentAt: Date,
  ): Promise<ProcessOneOutboxResult> {
    const updated = await this.#updateSendingRow(
      id,
      lockedAt,
      `
        UPDATE outbox_message
        SET status = 'sent'::outbox_status,
            locked_at = NULL,
            sent_at = $3,
            delivery_credential_ciphertext = NULL,
            last_error_code = NULL
        WHERE id = $1
          AND status = 'sending'
          AND locked_at = $2
      `,
      [id, lockedAt, sentAt],
    );
    return updated ? { status: "sent", id } : { status: "lease_lost", id };
  }

  async #deadLetter(
    id: string,
    lockedAt: Date,
    errorCode: string,
  ): Promise<ProcessOneOutboxResult> {
    const sanitizedErrorCode = sanitizeErrorCode(errorCode);
    const updated = await this.#updateSendingRow(
      id,
      lockedAt,
      `
        UPDATE outbox_message
        SET status = 'dead_letter'::outbox_status,
            locked_at = NULL,
            delivery_credential_ciphertext = NULL,
            last_error_code = $3
        WHERE id = $1
          AND status = 'sending'
          AND locked_at = $2
      `,
      [id, lockedAt, sanitizedErrorCode],
    );
    return updated
      ? { status: "dead_letter", id, errorCode: sanitizedErrorCode }
      : { status: "lease_lost", id };
  }

  async #updateSendingRow(
    id: string,
    lockedAt: Date,
    sql: string,
    parameters: unknown[],
  ): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      const result = await client.query(sql, parameters);
      return result.rowCount === 1;
    } finally {
      client.release();
    }
  }

  #safeNow(): Date {
    const value = this.#now();
    assertValidDate(value);
    return value;
  }
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function parseDatabaseDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  assertValidDate(date);
  return date;
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid database timestamp");
  }
}

function sanitizeErrorCode(value: string): string {
  return /^[a-z0-9_]{1,100}$/u.test(value) ? value : "line_delivery_error";
}
