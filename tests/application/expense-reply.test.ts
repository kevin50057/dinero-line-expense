import { describe, expect, it } from "vitest";

import {
  formatExpenseParseErrorReply,
  formatSavedExpenseReply,
  lineTextReply,
} from "../../src/application/expense-reply.js";
import { parseExpenseMessage } from "../../src/domain/index.js";

describe("expense replies", () => {
  it("shows the committed scope, typed tags and inferred meal", () => {
    const parsed = parseExpenseMessage("牛肉麵 1,200 #約會", {
      eventTimestamp: "2026-08-13T04:10:00.123Z",
      timezone: "Asia/Taipei",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(
      formatSavedExpenseReply({
        publicId: "K7M2Q9TX",
        expense: parsed.value,
        payerDisplayName: "小明",
      }),
    ).toBe(
      [
        "已記帳 #K7M2Q9TX",
        "共同｜牛肉麵｜1,200 元",
        "標籤：食物・午餐（自動）・約會",
        "時間：2026/08/13 12:10",
        "付款：小明",
      ].join("\n"),
    );
  });

  it("marks a date-only backfill as having unknown time", () => {
    const parsed = parseExpenseMessage("昨天 牛肉麵 150", {
      eventTimestamp: "2026-08-13T04:10:00.000Z",
      timezone: "Asia/Taipei",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(
      formatSavedExpenseReply({
        publicId: "ABCDEFGH",
        expense: parsed.value,
        payerDisplayName: "小美",
      }),
    ).toContain("時間：2026/08/12（時間未指定）");
  });

  it("marks an inferred 原生家庭 tag as automatic", () => {
    const parsed = parseExpenseMessage("孝親費 5000", {
      eventTimestamp: "2026-08-13T04:10:00.000Z",
      timezone: "Asia/Taipei",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(formatSavedExpenseReply({ publicId: "FAM2LY88", expense: parsed.value, payerDisplayName: "小明" }))
      .toContain("原生家庭（自動）");
  });

  it("wraps actionable parse errors in a LINE text payload", () => {
    const payload = lineTextReply(
      formatExpenseParseErrorReply({
        code: "INVALID_AMOUNT",
        message: "金額必須是大於 0 的整數。",
      }),
    );

    expect(payload.messages[0].type).toBe("text");
    expect(payload.messages[0].text).toContain("基本格式：牛肉麵 150");
    expect(payload.messages[0].text).toContain("可選補充：昨天、22:00、午餐、共同、對方付、#約會");
  });
});
