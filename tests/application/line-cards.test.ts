import { describe, expect, it } from "vitest";

import { helpCards, infoCard } from "../../src/application/line-cards.js";
import { parseLineReplyPayload } from "../../src/outbox/index.js";

describe("LINE Flex card builders", () => {
  it("builds help carousel accepted by the outbound allowlist", () => {
    const card = helpCards("記帳與查詢說明");
    const parsed = parseLineReplyPayload({ messages: [card] });
    expect(parsed).toMatchObject({
      messages: [{ type: "flex", contents: { type: "carousel" } }],
    });
    expect(JSON.stringify(parsed)).toContain('"style":"primary"');
    expect(JSON.stringify(parsed)).not.toContain('"style":"secondary"');
  });

  it("builds a detail/report bubble accepted by the outbound allowlist", () => {
    const card = infoCard({
      altText: "本月合計 1,280 元",
      kicker: "DINERO 支出報表",
      title: "2026/08",
      summary: "1,280 元",
      rows: [{ label: "食物", value: "800 元", meta: "63%" }],
      note: "分類占比以本月有效支出計算。",
      actions: [{ label: "最近紀錄", text: "最近 5" }],
    });
    expect(parseLineReplyPayload({ messages: [card] })).toEqual({ messages: [card] });
  });

  it("builds list-row and keyboard-prefill edit actions", () => {
    const card = infoCard({
      altText: "最近 1 筆",
      title: "最近紀錄",
      rows: [{
        label: "2026/08/13・個人",
        value: "牛肉麵　150 元",
        meta: "#K7M2Q9TX",
        action: { label: "編輯", text: "查 #K7M2Q9TX" },
      }],
      actions: [{
        label: "改金額",
        data: "ui=edit_amount&id=K7M2Q9TX",
        fillInText: "改 #K7M2Q9TX 金額 150",
      }],
    });
    const parsed = parseLineReplyPayload({ messages: [card] });
    expect(JSON.stringify(parsed)).toContain('"label":"編輯"');
    expect(JSON.stringify(parsed)).toContain('"type":"postback"');
    expect(JSON.stringify(parsed)).toContain('"inputOption":"openKeyboard"');
    expect(JSON.stringify(parsed)).toContain('"fillInText":"改 #K7M2Q9TX 金額 150"');
  });
});
