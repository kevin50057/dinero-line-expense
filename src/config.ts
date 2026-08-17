import { z } from "zod";

import { decodeCredentialKey } from "./security/credential-cipher.js";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  DATABASE_URL: z.string().min(1),
  LINE_CHANNEL_SECRET: z.string().min(1),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1),
  LINE_GROUP_ID: z.string().min(1),
  LINE_MEMBER_USER_IDS: z.string().min(1),
  LINE_PUBLIC_SIGNUP_ENABLED: z.enum(["true", "false"]).default("false")
    .transform((value) => value === "true"),
  LEDGER_TIMEZONE: z.string().default("Asia/Taipei"),
  OUTBOX_CREDENTIAL_KEY_BASE64: z.string().min(1),
  DELETION_JOURNAL_DIRECTORY: z.string().min(1),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  line: {
    channelSecret: string;
    channelAccessToken: string;
    groupId: string;
    memberUserIds: ReadonlySet<string>;
    publicSignupEnabled: boolean;
  };
  ledgerTimezone: string;
  outboxCredentialKey: Buffer;
  deletionJournalDirectory: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const memberUserIds = new Set(
    parsed.LINE_MEMBER_USER_IDS.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

  if (memberUserIds.size < 1 || memberUserIds.size > 2) {
    throw new Error("LINE_MEMBER_USER_IDS must contain one or two unique user IDs");
  }

  assertIanaTimezone(parsed.LEDGER_TIMEZONE);

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    line: {
      channelSecret: parsed.LINE_CHANNEL_SECRET,
      channelAccessToken: parsed.LINE_CHANNEL_ACCESS_TOKEN,
      groupId: parsed.LINE_GROUP_ID,
      memberUserIds,
      publicSignupEnabled: parsed.LINE_PUBLIC_SIGNUP_ENABLED,
    },
    ledgerTimezone: parsed.LEDGER_TIMEZONE,
    outboxCredentialKey: decodeCredentialKey(
      parsed.OUTBOX_CREDENTIAL_KEY_BASE64,
    ),
    deletionJournalDirectory: parsed.DELETION_JOURNAL_DIRECTORY,
  };
}

function assertIanaTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`LEDGER_TIMEZONE is not a valid IANA timezone: ${timezone}`);
  }
}
