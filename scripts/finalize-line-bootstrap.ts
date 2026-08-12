import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

const { Pool } = pg;
const capturePath = resolve(".local/line-bootstrap.json");
const environmentPath = resolve(".env");
const databaseUrl = requiredEnvironment("DATABASE_URL");
const accessToken = requiredEnvironment("LINE_CHANNEL_ACCESS_TOKEN");

interface Capture {
  readonly groupId: string;
  readonly userIds: readonly string[];
}

const capture = parseCapture(await readFile(capturePath, "utf8"));
const profiles = await Promise.all(capture.userIds.map(loadProfile));
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ledger = await client.query<{ id: string }>(
      `INSERT INTO ledger (name, line_group_id, default_scope, allow_bare_entry, timezone)
       VALUES ('兩人日常帳', $1, 'shared', true, 'Asia/Taipei')
       ON CONFLICT (line_group_id) DO UPDATE SET name=EXCLUDED.name
       RETURNING id::text`,
      [capture.groupId],
    );
    const ledgerId = ledger.rows[0]!.id;
    for (const profile of profiles) {
      await client.query(
        `INSERT INTO member (ledger_id,line_user_id,display_name,command_alias,is_active)
         VALUES ($1,$2,$3,$3,true)
         ON CONFLICT (ledger_id,line_user_id) DO UPDATE
           SET display_name=EXCLUDED.display_name, command_alias=EXCLUDED.command_alias,
               is_active=true`,
        [ledgerId, profile.userId, profile.displayName],
      );
    }
    await client.query(
      `INSERT INTO tag (ledger_id,type,code,display_name,normalized_name,is_system,is_active)
       SELECT $1, x.type::tag_type, x.code, x.name, x.name, true, true
       FROM (VALUES
         ('category','food','食物'), ('category','transport','交通'),
         ('category','entertainment','娛樂'), ('category','household','居家'),
         ('category','shopping','購物'), ('category','health','醫療健康'),
         ('category','travel','旅遊'), ('category','uncategorized','未分類'),
         ('meal','breakfast','早餐'), ('meal','lunch','午餐'),
         ('meal','afternoon_tea','下午茶'), ('meal','dinner','晚餐'),
         ('meal','late_night','宵夜')
       ) AS x(type,code,name)
       ON CONFLICT (ledger_id,type,code) DO NOTHING`,
      [ledgerId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}

const currentEnvironment = await readFile(environmentPath, "utf8");
const updatedEnvironment = setEnvironmentValue(
  setEnvironmentValue(currentEnvironment, "LINE_GROUP_ID", capture.groupId),
  "LINE_MEMBER_USER_IDS",
  capture.userIds.join(","),
);
await writeFile(environmentPath, updatedEnvironment, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`line_bootstrap_finalized:members=${profiles.length}\n`);

async function loadProfile(userId: string): Promise<{ userId: string; displayName: string }> {
  const response = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`line_profile_failed:${response.status}`);
  const value = await response.json() as unknown;
  if (typeof value !== "object" || value === null ||
      typeof (value as Record<string, unknown>).displayName !== "string") {
    throw new Error("line_profile_invalid");
  }
  return { userId, displayName: (value as { displayName: string }).displayName };
}

function parseCapture(text: string): Capture {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== "object" || value === null) throw new Error("capture_invalid");
  const record = value as Record<string, unknown>;
  if (typeof record.groupId !== "string" || !Array.isArray(record.userIds) ||
      record.userIds.length < 1 || record.userIds.length > 2 ||
      record.userIds.some((item) => typeof item !== "string")) {
    throw new Error("capture_invalid");
  }
  return { groupId: record.groupId, userIds: record.userIds as string[] };
}

function setEnvironmentValue(text: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const expression = new RegExp(`^${name}=.*$`, "mu");
  return expression.test(text) ? text.replace(expression, line) : `${text.trimEnd()}\n${line}\n`;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
