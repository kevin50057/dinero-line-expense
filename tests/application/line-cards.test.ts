import { describe, expect, it } from "vitest";

import { helpCards, infoCard } from "../../src/application/line-cards.js";
import { parseLineReplyPayload } from "../../src/outbox/index.js";

describe("LINE Flex card builders", () => {
  it("builds help carousel accepted by the outbound allowlist", () => {
    const card = helpCards("記帳與查詢說明");
    expect(parseLineReplyPayload({ messages: [card] })).toMatchObject({
      messages: [{ type: "flex", contents: { type: "carousel" } }],
    });
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
});
