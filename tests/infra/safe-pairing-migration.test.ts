import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Client } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithPostgres("safe pairing migration", () => {
  const schemaName = `pairing_migration_${randomBytes(8).toString("hex")}`;
  let client: InstanceType<typeof Client>;

  beforeAll(async () => {
    client = new Client({ connectionString: testDatabaseUrl });
    await client.connect();
    await client.query("SELECT pg_advisory_lock(1947823612)");
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await client.query("SELECT pg_advisory_unlock(1947823612)");
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);

    const migrationDirectory = resolve(process.cwd(), "db/migrations");
    const migrations = (await readdir(migrationDirectory))
      .filter((name) => name.endsWith(".sql") && name < "012_safe_pairing_invitations.sql")
      .sort();
    for (const name of migrations) {
      const migration = await readFile(resolve(migrationDirectory, name), "utf8");
      await client.query(migration.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""));
    }
  }, 20_000);

  afterAll(async () => {
    if (client !== undefined) {
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await client.end();
    }
  });

  it("converts only legacy one-member setup and preserves complete pairs", async () => {
    const incomplete = await client.query<{ id: string }>(
      "SELECT provision_line_group_ledger('C-legacy-incomplete')::text AS id",
    );
    const complete = await client.query<{ id: string }>(
      "SELECT provision_line_group_ledger('C-legacy-complete')::text AS id",
    );
    await client.query(
      `INSERT INTO member (ledger_id,line_user_id,display_name,membership_kind)
       VALUES ($1,'U-legacy-one','舊版第一人','couple')`,
      [incomplete.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO member (ledger_id,line_user_id,display_name,membership_kind)
       VALUES ($1,'U-legacy-a','甲','couple'),($1,'U-legacy-b','乙','couple')`,
      [complete.rows[0]!.id],
    );

    const migration = await readFile(
      resolve("db/migrations/012_safe_pairing_invitations.sql"),
      "utf8",
    );
    await client.query(migration);

    const result = await client.query<{
      route: string; active_count: string; pending_count: string; inviter: string | null;
    }>(
      `SELECT ledger.line_group_id AS route,
              count(member.id) FILTER (WHERE member.is_active)::text AS active_count,
              count(invitation.id) FILTER (WHERE invitation.status='pending')::text AS pending_count,
              max(invitation.invited_by_line_user_id) AS inviter
         FROM ledger
         LEFT JOIN member ON member.ledger_id=ledger.id
         LEFT JOIN pairing_invitation invitation ON invitation.ledger_id=ledger.id
        WHERE ledger.id=ANY($1::uuid[])
        GROUP BY ledger.id
        ORDER BY ledger.line_group_id`,
      [[complete.rows[0]!.id, incomplete.rows[0]!.id]],
    );
    expect(result.rows).toEqual([
      { route: "C-legacy-complete", active_count: "2", pending_count: "0", inviter: null },
      { route: "C-legacy-incomplete", active_count: "0", pending_count: "1", inviter: "U-legacy-one" },
    ]);
  });
});
