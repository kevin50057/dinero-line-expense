import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DeletionJournalError,
  FileDeletionJournal,
} from "../../src/privacy/index.js";

const cleanupDirectories: string[] = [];

async function temporaryParent(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "deletion-journal-test-"));
  cleanupDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    cleanupDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const baseInput = {
  ledgerId: "018f-ledger-id",
  lineMessageId: "line-message-123",
  unsendWebhookEventId: "webhook-unsend-456",
  unsentAt: "2026-08-13T04:05:06.789Z",
} as const;

describe("FileDeletionJournal", () => {
  it("creates a private immutable JSON record for durable replay", async () => {
    const parent = await temporaryParent();
    const directory = join(parent, "journal");
    const journal = new FileDeletionJournal(directory, {
      now: () => new Date("2026-08-13T04:06:00.123Z"),
    });

    const appended = await journal.append(baseInput);
    const fileNames = await readdir(directory);
    const expectedKey = createHash("sha256")
      .update(JSON.stringify([baseInput.ledgerId, baseInput.lineMessageId]))
      .digest("hex");

    expect(fileNames).toEqual([`${expectedKey}.json`]);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, fileNames[0]!))).mode & 0o777).toBe(
      0o600,
    );
    expect(appended).toEqual({
      schemaVersion: 1,
      ...baseInput,
      recordedAt: "2026-08-13T04:06:00.123Z",
    });

    const raw = await readFile(join(directory, fileNames[0]!), "utf8");
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual([
      "ledgerId",
      "lineMessageId",
      "recordedAt",
      "schemaVersion",
      "unsendWebhookEventId",
      "unsentAt",
    ]);
    expect(raw).not.toContain("user");
    expect(raw).not.toContain("amount");
    expect(await journal.entries()).toEqual([appended]);
  });

  it("is idempotent and preserves the first immutable record", async () => {
    const parent = await temporaryParent();
    const directory = join(parent, "journal");
    let call = 0;
    const journal = new FileDeletionJournal(directory, {
      now: () =>
        new Date(
          call++ === 0
            ? "2026-08-13T04:06:00.000Z"
            : "2026-08-13T04:07:00.000Z",
        ),
    });

    const first = await journal.append(baseInput);
    const second = await journal.append({
      ...baseInput,
      unsendWebhookEventId: "webhook-redelivery-999",
    });

    expect(second).toEqual(first);
    expect(await readdir(directory)).toHaveLength(1);
    expect(await journal.entries()).toEqual([first]);
  });

  it("stores different LINE messages in different records", async () => {
    const parent = await temporaryParent();
    const journal = new FileDeletionJournal(join(parent, "journal"));

    await journal.append(baseInput);
    await journal.append({ ...baseInput, lineMessageId: "line-message-789" });

    expect(await journal.entries()).toHaveLength(2);
  });

  it("ignores an uncommitted temporary file left by an interrupted append", async () => {
    const parent = await temporaryParent();
    const directory = join(parent, "journal");
    const journal = new FileDeletionJournal(directory);
    const committed = await journal.append(baseInput);
    await writeFile(
      join(
        directory,
        `.${"a".repeat(64)}.12345678-1234-4123-8123-123456789abc.tmp`,
      ),
      "partial",
      { mode: 0o600 },
    );

    expect(await journal.entries()).toEqual([committed]);
  });

  it("fails closed when a journal file is malformed", async () => {
    const parent = await temporaryParent();
    const directory = join(parent, "journal");
    const journal = new FileDeletionJournal(directory);
    await journal.append(baseInput);
    const [fileName] = await readdir(directory);
    await writeFile(join(directory, fileName!), "{broken-json}\n");
    await chmod(join(directory, fileName!), 0o600);

    await expect(journal.entries()).rejects.toMatchObject({
      code: "corrupt_journal",
      message: "deletion_journal:corrupt_journal",
    });
    await expect(journal.append(baseInput)).rejects.toBeInstanceOf(
      DeletionJournalError,
    );
  });

  it("rejects relative paths, insecure existing directories, and symlinks", async () => {
    expect(() => new FileDeletionJournal("relative/journal")).toThrow(
      "deletion_journal:invalid_directory",
    );

    const parent = await temporaryParent();
    const insecure = join(parent, "insecure");
    const target = join(parent, "target");
    const linked = join(parent, "linked");
    await mkdir(insecure, { mode: 0o755 });
    await chmod(insecure, 0o755);
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked);

    await expect(
      new FileDeletionJournal(insecure).entries(),
    ).rejects.toMatchObject({ code: "invalid_directory" });
    await expect(new FileDeletionJournal(linked).entries()).rejects.toMatchObject(
      { code: "invalid_directory" },
    );
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
  });

  it("strictly validates fields while hashing traversal-like identifiers", async () => {
    const parent = await temporaryParent();
    const directory = join(parent, "journal");
    const journal = new FileDeletionJournal(directory);

    await expect(
      journal.append({ ...baseInput, ledgerId: "../../ledger" }),
    ).resolves.toMatchObject({ ledgerId: "../../ledger" });
    expect(await readdir(directory)).toHaveLength(1);
    await expect(
      journal.append({ ...baseInput, unsentAt: "2026-02-30T00:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "invalid_entry" });
    await expect(
      journal.append({ ...baseInput, lineMessageId: "bad\nmessage" }),
    ).rejects.toMatchObject({ code: "invalid_entry" });
    await expect(
      journal.append({ ...baseInput, unexpected: "field" } as never),
    ).rejects.toMatchObject({ code: "invalid_entry" });
  });
});
