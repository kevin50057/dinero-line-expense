import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnvironment = {
  NODE_ENV: "test",
  PORT: "4321",
  DATABASE_URL: "postgresql://localhost/test",
  LINE_CHANNEL_SECRET: "secret",
  LINE_CHANNEL_ACCESS_TOKEN: "token",
  LINE_GROUP_ID: "group",
  LINE_MEMBER_USER_IDS: "user-a,user-b",
  LINE_PUBLIC_SIGNUP_ENABLED: "false",
  LEDGER_TIMEZONE: "Asia/Taipei",
  OUTBOX_CREDENTIAL_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
  DELETION_JOURNAL_DIRECTORY: "/tmp/line-expense-deletion-journal",
};

describe("loadConfig", () => {
  it("normalizes the allowed LINE member IDs", () => {
    const config = loadConfig({
      ...validEnvironment,
      LINE_MEMBER_USER_IDS: " user-a, user-b ",
    });

    expect(config.port).toBe(4321);
    expect([...config.line.memberUserIds]).toEqual(["user-a", "user-b"]);
    expect(config.line.publicSignupEnabled).toBe(false);
    expect(config.outboxCredentialKey).toHaveLength(32);
  });

  it("enables database-backed public group onboarding explicitly", () => {
    const config = loadConfig({
      ...validEnvironment,
      LINE_PUBLIC_SIGNUP_ENABLED: "true",
    });
    expect(config.line.publicSignupEnabled).toBe(true);
  });

  it("allows one member during a staged couple onboarding", () => {
    const config = loadConfig({
      ...validEnvironment,
      LINE_MEMBER_USER_IDS: "user-a",
    });
    expect([...config.line.memberUserIds]).toEqual(["user-a"]);
  });

  it("rejects empty or more than two unique member IDs", () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        LINE_MEMBER_USER_IDS: " , ",
      }),
    ).toThrow("one or two unique user IDs");
    expect(() =>
      loadConfig({
        ...validEnvironment,
        LINE_MEMBER_USER_IDS: "user-a,user-b,user-c",
      }),
    ).toThrow("one or two unique user IDs");
  });

  it("rejects an invalid IANA timezone", () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        LEDGER_TIMEZONE: "Taipei-ish",
      }),
    ).toThrow("not a valid IANA timezone");
  });

  it("rejects an encryption key that is not exactly 32 bytes", () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        OUTBOX_CREDENTIAL_KEY_BASE64: Buffer.alloc(16).toString("base64"),
      }),
    ).toThrow("exactly 32 bytes");
  });
});
