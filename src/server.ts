import pg from "pg";

import { loadConfig } from "./config.js";
import { postgresHealthCheck, startHttpServer } from "./http/server.js";
import { PostgresLineEventInbox } from "./infra/index.js";
import {
  createLineReplyHttpClient,
  PostgresLineReplyOutboxDispatcher,
} from "./outbox/index.js";
import { FileDeletionJournal } from "./privacy/index.js";
import { runWorkerLoop } from "./runtime/worker-loop.js";
import { createCredentialCipher } from "./security/credential-cipher.js";
import { processNextInboundEvent } from "./worker/index.js";

const { Pool } = pg;
const config = loadConfig();
const credentialCipher = createCredentialCipher(config.outboxCredentialKey);
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  application_name: "couple-expense-line-bot",
});
const inbox = new PostgresLineEventInbox(pool, {
  encryptDeliveryCredential: (plaintext) => credentialCipher.encrypt(plaintext),
});
const outbox = new PostgresLineReplyOutboxDispatcher({
  pool,
  credentialCipher,
  lineClient: createLineReplyHttpClient({
    channelAccessToken: config.line.channelAccessToken,
  }),
});
const workerController = new AbortController();
const deletionJournal = new FileDeletionJournal(config.deletionJournalDirectory);

// Fail closed before opening the webhook port if the independent journal is
// unavailable or corrupt. Replay is idempotent and must precede new traffic.
await replayDeletionJournal();

const server = startHttpServer({
  port: config.port,
  channelSecret: config.line.channelSecret,
  allowedGroupId: config.line.groupId,
  allowedMemberUserIds: config.line.memberUserIds,
  publicSignupEnabled: config.line.publicSignupEnabled,
  inbox,
  healthCheck: postgresHealthCheck(pool),
});

const inboundLoop = runWorkerLoop({
  signal: workerController.signal,
  work: async () =>
    (
      await processNextInboundEvent(pool, {
        appendDeletionJournal: async (entry) => {
          await deletionJournal.append(entry);
        },
      })
    ).processed,
  onError: (error) => reportWorkerError("inbound", error),
});
const outboxLoop = runWorkerLoop({
  signal: workerController.signal,
  work: async () => {
    const result = await outbox.processOne();
    if (result.status === "dead_letter") {
      process.stderr.write(`outbox_dead_letter:${result.errorCode}\n`);
    }
    return result.status !== "idle";
  },
  onError: (error) => reportWorkerError("outbox", error),
});
void outbox.recoverExpiredLeases().catch((error: unknown) => {
  reportWorkerError("outbox_recovery", error);
});
const retentionTimer = setInterval(() => {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  void outbox.redactCompletedPayloads(oneDayAgo).catch((error: unknown) => {
    reportWorkerError("outbox_retention", error);
  });
}, 60 * 60 * 1_000);
retentionTimer.unref();

let shuttingDown = false;
async function shutDown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  workerController.abort();
  clearInterval(retentionTimer);

  const forcedExit = setTimeout(() => {
    process.stderr.write("shutdown_timeout\n");
    process.exit(1);
  }, 10_000);
  forcedExit.unref();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await Promise.all([inboundLoop, outboxLoop]);
  await pool.end();
  clearTimeout(forcedExit);
  process.stdout.write(`server_stopped:${signal}\n`);
}

process.once("SIGINT", () => void shutDown("SIGINT"));
process.once("SIGTERM", () => void shutDown("SIGTERM"));

server.on("listening", () => {
  process.stdout.write(`server_listening:${config.port}\n`);
});

server.on("error", (error) => {
  process.stderr.write(`server_error:${error.name}\n`);
});

function reportWorkerError(worker: string, error: unknown): void {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  // Never print the database/provider error message: it can contain payloads.
  process.stderr.write(`worker_error:${worker}:${errorName}\n`);
}

async function replayDeletionJournal(): Promise<void> {
  const entries = await deletionJournal.entries();
  if (entries.length === 0) return;

  const client = await pool.connect();
  try {
    for (const entry of entries) {
      await client.query("BEGIN");
      try {
        const event = await client.query<{ webhook_event_id: string }>(
          `SELECT webhook_event_id
             FROM inbound_event
            WHERE ledger_id = $1
              AND webhook_event_id = $2
              AND event_type = 'unsend'
              AND line_message_id = $3`,
          [entry.ledgerId, entry.unsendWebhookEventId, entry.lineMessageId],
        );
        if (event.rowCount !== 1) {
          // A journal entry without its main-DB unsend row can be normal only
          // after restoring a backup older than the event. Recreate the
          // content-free metadata needed by the constrained purge function.
          const ledger = await client.query(
            "SELECT 1 FROM ledger WHERE id = $1",
            [entry.ledgerId],
          );
          if (ledger.rowCount !== 1) {
            await client.query("COMMIT");
            continue;
          }
          const restored = await client.query(
            `INSERT INTO inbound_event (
               webhook_event_id, ledger_id, event_type, line_message_id,
               line_event_at, status, processed_at, outcome_code
             ) VALUES ($1, $2, 'unsend', $3, $4, 'succeeded',
                       clock_timestamp(), 'applied')
             ON CONFLICT (webhook_event_id) DO NOTHING`,
            [
              entry.unsendWebhookEventId,
              entry.ledgerId,
              entry.lineMessageId,
              entry.unsentAt,
            ],
          );
          if (restored.rowCount !== 1) {
            throw new Error("deletion_journal_event_conflict");
          }
        }
        await client.query(
          "SELECT purge_line_message_after_unsend($1, $2, $3, $4)",
          [
            entry.ledgerId,
            entry.lineMessageId,
            entry.unsendWebhookEventId,
            entry.unsentAt,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
  } finally {
    client.release();
  }
}
