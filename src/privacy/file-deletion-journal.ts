import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

const SCHEMA_VERSION = 1 as const;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_IDENTIFIER_BYTES = 1_024;
const MAX_RECORD_BYTES = 8_192;
const JOURNAL_FILE_PATTERN = /^(?<key>[a-f0-9]{64})\.json$/u;
const TEMPORARY_FILE_PATTERN =
  /^\.[a-f0-9]{64}\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/u;
const ISO_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const APPEND_INPUT_KEYS = [
  "ledgerId",
  "lineMessageId",
  "unsendWebhookEventId",
  "unsentAt",
] as const;

const STORED_ENTRY_KEYS = [
  "ledgerId",
  "lineMessageId",
  "recordedAt",
  "schemaVersion",
  "unsendWebhookEventId",
  "unsentAt",
] as const;

export interface DeletionJournalAppendInput {
  readonly ledgerId: string;
  readonly lineMessageId: string;
  readonly unsendWebhookEventId: string;
  readonly unsentAt: string;
}

export interface DeletionJournalEntry extends DeletionJournalAppendInput {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly recordedAt: string;
}

export type DeletionJournalErrorCode =
  | "invalid_directory"
  | "invalid_entry"
  | "corrupt_journal"
  | "journal_io_failed";

/**
 * Deliberately carries no entry values or underlying parser/IO messages. The
 * journal contains deletion identifiers, so callers can safely log this code.
 */
export class DeletionJournalError extends Error {
  readonly code: DeletionJournalErrorCode;

  constructor(code: DeletionJournalErrorCode) {
    super(`deletion_journal:${code}`);
    this.name = "DeletionJournalError";
    this.code = code;
  }
}

export interface FileDeletionJournalOptions {
  readonly now?: () => Date;
}

/**
 * An append-only deletion journal kept outside the application's database.
 *
 * Every ledger/message pair maps to one SHA-256-named JSON file. Creation uses
 * an atomic no-replace install, so an already recorded deletion is never
 * overwritten and a crash cannot strand a partial final record.
 */
export class FileDeletionJournal {
  readonly #requestedDirectory: string;
  readonly #now: () => Date;
  #initializedDirectory: Promise<string> | undefined;

  constructor(directory: string, options: FileDeletionJournalOptions = {}) {
    if (typeof directory !== "string" || !isAbsolute(directory)) {
      throw new DeletionJournalError("invalid_directory");
    }

    const normalized = resolve(directory);
    if (normalized === parse(normalized).root) {
      throw new DeletionJournalError("invalid_directory");
    }

    this.#requestedDirectory = normalized;
    this.#now = options.now ?? (() => new Date());
  }

  async append(
    input: DeletionJournalAppendInput,
  ): Promise<DeletionJournalEntry> {
    const validatedInput = validateAppendInput(input);
    const recordedAt = this.#now();
    if (!(recordedAt instanceof Date) || Number.isNaN(recordedAt.valueOf())) {
      throw new DeletionJournalError("journal_io_failed");
    }

    const entry: DeletionJournalEntry = {
      schemaVersion: SCHEMA_VERSION,
      ledgerId: validatedInput.ledgerId,
      lineMessageId: validatedInput.lineMessageId,
      unsendWebhookEventId: validatedInput.unsendWebhookEventId,
      unsentAt: validatedInput.unsentAt,
      recordedAt: recordedAt.toISOString(),
    };
    const key = entryKey(entry.ledgerId, entry.lineMessageId);
    const directory = await this.#ensureDirectory();
    const filePath = journalFilePath(directory, key);
    const temporaryPath = join(directory, `.${key}.${randomUUID()}.tmp`);
    const serialized = serializeEntry(entry);

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(temporaryPath, "wx", FILE_MODE);
    } catch {
      throw new DeletionJournalError("journal_io_failed");
    }

    try {
      // Ensure exact permissions even under an unusual process umask.
      await handle.chmod(FILE_MODE);
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new DeletionJournalError("journal_io_failed");
    } finally {
      await handle.close().catch(() => undefined);
    }

    try {
      // Node exposes no portable rename-no-replace. A hard link atomically
      // installs the already-fsynced inode and fails with EEXIST if another
      // process won.
      await link(temporaryPath, filePath);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        const existing = await readEntryFile(filePath, key);
        // This also durably commits a concurrent winner's link before our
        // private temporary name is removed.
        await syncDirectory(directory);
        await cleanTemporaryFile(temporaryPath, directory);
        return existing;
      }

      await cleanTemporaryFile(temporaryPath, directory);
      throw new DeletionJournalError("journal_io_failed");
    }

    // Persist the final name *before* unlinking the temporary name. If this
    // sync fails, leave the complete temp inode in place for inspection and
    // let an idempotent retry commit/verify the visible final record.
    await syncDirectory(directory);
    // Once the final name is durable, cleanup is non-critical. A crash or
    // cleanup error may leave a private temp name, which entries() ignores.
    await cleanTemporaryFile(temporaryPath, directory);
    return freezeEntry(entry);
  }

  /** Returns every durable instruction in deterministic replay order. */
  async entries(): Promise<readonly DeletionJournalEntry[]> {
    const directory = await this.#ensureDirectory();
    let directoryEntries: Dirent<string>[];

    try {
      directoryEntries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new DeletionJournalError("journal_io_failed");
    }

    const loaded: Array<{ key: string; entry: DeletionJournalEntry }> = [];
    for (const directoryEntry of directoryEntries) {
      if (TEMPORARY_FILE_PATTERN.test(directoryEntry.name)) {
        // An interrupted append may leave only a private temporary inode; it
        // was never committed to the journal and is safe to ignore. A symlink
        // or directory with a temp-shaped name is still corruption.
        if (!directoryEntry.isFile()) {
          throw new DeletionJournalError("corrupt_journal");
        }
        continue;
      }
      const match = JOURNAL_FILE_PATTERN.exec(directoryEntry.name);
      const key = match?.groups?.key;
      if (!directoryEntry.isFile() || key === undefined) {
        throw new DeletionJournalError("corrupt_journal");
      }

      const filePath = journalFilePath(directory, key);
      loaded.push({ key, entry: await readEntryFile(filePath, key) });
    }

    loaded.sort(
      (left, right) =>
        left.entry.recordedAt.localeCompare(right.entry.recordedAt) ||
        left.key.localeCompare(right.key),
    );
    return Object.freeze(loaded.map(({ entry }) => entry));
  }

  #ensureDirectory(): Promise<string> {
    this.#initializedDirectory ??= this.#initializeDirectory();
    return this.#initializedDirectory;
  }

  async #initializeDirectory(): Promise<string> {
    try {
      const created = await mkdir(this.#requestedDirectory, {
        recursive: true,
        mode: DIRECTORY_MODE,
      });
      const requestedStats = await lstat(this.#requestedDirectory);

      // Never follow a caller-controlled final symlink. Ancestor symlinks are
      // canonicalized by realpath before record paths are constructed.
      if (requestedStats.isSymbolicLink() || !requestedStats.isDirectory()) {
        throw new DeletionJournalError("invalid_directory");
      }

      if (created !== undefined) {
        await chmod(this.#requestedDirectory, DIRECTORY_MODE);
      }

      const mode = requestedStats.mode & 0o777;
      if (created === undefined && mode !== DIRECTORY_MODE) {
        // Changing permissions on a pre-existing caller directory is an
        // unsafe surprise. Require the caller to provision it securely.
        throw new DeletionJournalError("invalid_directory");
      }

      const canonicalDirectory = await realpath(this.#requestedDirectory);
      const canonicalStats = await lstat(canonicalDirectory);
      if (
        canonicalStats.isSymbolicLink() ||
        !canonicalStats.isDirectory() ||
        (canonicalStats.mode & 0o777) !== DIRECTORY_MODE
      ) {
        throw new DeletionJournalError("invalid_directory");
      }

      return canonicalDirectory;
    } catch (error) {
      if (error instanceof DeletionJournalError) {
        throw error;
      }
      throw new DeletionJournalError("journal_io_failed");
    }
  }
}

function validateAppendInput(value: unknown): DeletionJournalAppendInput {
  if (!hasExactKeys(value, APPEND_INPUT_KEYS)) {
    throw new DeletionJournalError("invalid_entry");
  }

  const input = value as Record<(typeof APPEND_INPUT_KEYS)[number], unknown>;
  if (
    !isIdentifier(input.ledgerId) ||
    !isIdentifier(input.lineMessageId) ||
    !isIdentifier(input.unsendWebhookEventId) ||
    !isIsoUtcTimestamp(input.unsentAt)
  ) {
    throw new DeletionJournalError("invalid_entry");
  }

  return {
    ledgerId: input.ledgerId,
    lineMessageId: input.lineMessageId,
    unsendWebhookEventId: input.unsendWebhookEventId,
    unsentAt: input.unsentAt,
  };
}

function validateStoredEntry(value: unknown): DeletionJournalEntry {
  if (!hasExactKeys(value, STORED_ENTRY_KEYS)) {
    throw new DeletionJournalError("corrupt_journal");
  }

  const stored = value as Record<(typeof STORED_ENTRY_KEYS)[number], unknown>;
  if (
    stored.schemaVersion !== SCHEMA_VERSION ||
    !isIdentifier(stored.ledgerId) ||
    !isIdentifier(stored.lineMessageId) ||
    !isIdentifier(stored.unsendWebhookEventId) ||
    !isIsoUtcTimestamp(stored.unsentAt) ||
    !isIsoUtcTimestamp(stored.recordedAt)
  ) {
    throw new DeletionJournalError("corrupt_journal");
  }

  return freezeEntry({
    schemaVersion: SCHEMA_VERSION,
    ledgerId: stored.ledgerId,
    lineMessageId: stored.lineMessageId,
    unsendWebhookEventId: stored.unsendWebhookEventId,
    unsentAt: stored.unsentAt,
    recordedAt: stored.recordedAt,
  });
}

async function readEntryFile(
  filePath: string,
  expectedKey: string,
): Promise<DeletionJournalEntry> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new DeletionJournalError("corrupt_journal");
  }

  let raw: string;
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.size <= 0 ||
      stats.size > MAX_RECORD_BYTES ||
      (stats.mode & 0o777) !== FILE_MODE
    ) {
      throw new DeletionJournalError("corrupt_journal");
    }
    raw = await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (error instanceof DeletionJournalError) {
      throw error;
    }
    throw new DeletionJournalError("corrupt_journal");
  } finally {
    await handle.close().catch(() => undefined);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DeletionJournalError("corrupt_journal");
  }

  const entry = validateStoredEntry(parsed);
  if (
    entryKey(entry.ledgerId, entry.lineMessageId) !== expectedKey ||
    serializeEntry(entry) !== raw
  ) {
    throw new DeletionJournalError("corrupt_journal");
  }
  return entry;
}

function entryKey(ledgerId: string, lineMessageId: string): string {
  // JSON preserves tuple boundaries, avoiding concatenation ambiguity.
  return createHash("sha256")
    .update(JSON.stringify([ledgerId, lineMessageId]), "utf8")
    .digest("hex");
}

function journalFilePath(directory: string, key: string): string {
  if (!/^[a-f0-9]{64}$/u.test(key)) {
    throw new DeletionJournalError("corrupt_journal");
  }
  const filePath = join(directory, `${key}.json`);
  if (dirname(filePath) !== directory) {
    throw new DeletionJournalError("corrupt_journal");
  }
  return filePath;
}

function serializeEntry(entry: DeletionJournalEntry): string {
  return `${JSON.stringify({
    schemaVersion: entry.schemaVersion,
    ledgerId: entry.ledgerId,
    lineMessageId: entry.lineMessageId,
    unsendWebhookEventId: entry.unsendWebhookEventId,
    unsentAt: entry.unsentAt,
    recordedAt: entry.recordedAt,
  })}\n`;
}

function freezeEntry(entry: DeletionJournalEntry): DeletionJournalEntry {
  return Object.freeze({ ...entry });
}

function hasExactKeys<const T extends readonly string[]>(
  value: unknown,
  expectedKeys: T,
): value is Record<T[number], unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return false;
  }

  const actualKeys = Reflect.ownKeys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key) => typeof key === "string" && expectedKeys.includes(key),
    )
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= MAX_IDENTIFIER_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isIsoUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) {
    return false;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new DeletionJournalError("journal_io_failed");
  }

  try {
    await handle.sync();
  } catch {
    throw new DeletionJournalError("journal_io_failed");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function cleanTemporaryFile(
  temporaryPath: string,
  directory: string,
): Promise<void> {
  try {
    await rm(temporaryPath);
    await syncDirectory(directory);
  } catch {
    // Every success/EEXIST caller makes the final name durable first. A
    // stranded uncommitted temp name is safe and must not block DB purging.
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
