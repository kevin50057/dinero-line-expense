import { describe, expect, it } from "vitest";

import { parseLedgerCommand } from "../../src/domain/index.js";

describe("parseLedgerCommand", () => {
  it.each([
    ["查 #K7M2Q9TX", { kind: "detail", publicId: "K7M2Q9TX" }],
    ["最近", { kind: "recent", limit: 10, filter: { kind: "personal" } }],
    ["最近 5", { kind: "recent", limit: 5, filter: { kind: "personal" } }],
    ["最近 5 共同", { kind: "recent", limit: 5, filter: { kind: "shared" } }],
    ["最近 全部", { kind: "recent", limit: 10, filter: { kind: "all" } }],
    ["本月 共同", { kind: "period", period: "month", filter: { kind: "shared" } }],
    ["本月 全部", { kind: "period", period: "month", filter: { kind: "all" } }],
    ["本月 #約會", { kind: "period", period: "month", filter: { kind: "tag", name: "約會" } }],
    ["週報", { kind: "period", period: "week", filter: { kind: "personal" } }],
    ["本週 共同", { kind: "period", period: "week", filter: { kind: "shared" } }],
    ["上週", { kind: "period", period: "last_week", filter: { kind: "personal" } }],
    ["月報", { kind: "period", period: "month", filter: { kind: "personal" } }],
    ["共同月報", { kind: "period", period: "month", filter: { kind: "shared" } }],
    ["個人月報", { kind: "period", period: "month", filter: { kind: "personal" } }],
    ["7月月報", { kind: "period", period: { kind: "calendar_month", year: null, month: 7 }, filter: { kind: "personal" } }],
    ["共同7月月報", { kind: "period", period: { kind: "calendar_month", year: null, month: 7 }, filter: { kind: "shared" } }],
    ["7月共同月報", { kind: "period", period: { kind: "calendar_month", year: null, month: 7 }, filter: { kind: "shared" } }],
    ["2025年7月月報", { kind: "period", period: { kind: "calendar_month", year: 2025, month: 7 }, filter: { kind: "personal" } }],
    ["2025年7月月報 共同", { kind: "period", period: { kind: "calendar_month", year: 2025, month: 7 }, filter: { kind: "shared" } }],
    ["上月", { kind: "period", period: "last_month", filter: { kind: "personal" } }],
    ["找 牛肉麵", { kind: "search", keyword: "牛肉麵" }],
    ["搜尋 約會 晚餐", { kind: "search", keyword: "約會 晚餐" }],
    ["分類排行", { kind: "ranking", filter: { kind: "personal" } }],
    ["分類排行 共同", { kind: "ranking", filter: { kind: "shared" } }],
    ["目前模式", { kind: "mode", scope: null }],
    ["切換共同模式", { kind: "mode", scope: "shared" }],
    ["切換個人模式", { kind: "mode", scope: "personal" }],
    ["共同模式", { kind: "mode", scope: "shared" }],
    ["我的暱稱", { kind: "nickname", value: null }],
    ["設定暱稱 小美", { kind: "nickname", value: "小美" }],
    ["修改暱稱 Mei Lin", { kind: "nickname", value: "Mei Lin" }],
    ["幫助", { kind: "help" }],
    ["取消 #K7M2Q9TX", { kind: "void", publicId: "K7M2Q9TX" }],
    ["還原 #K7M2Q9TX", { kind: "restore", publicId: "K7M2Q9TX" }],
    ["改 #K7M2Q9TX 金額 180", { kind: "update", publicId: "K7M2Q9TX", change: { field: "amount", value: 180 } }],
    ["改 #K7M2Q9TX 標籤 #約會 #台南", { kind: "update", publicId: "K7M2Q9TX", change: { field: "tags", value: ["約會", "台南"] } }],
    ["改 #K7M2Q9TX 標籤 無", { kind: "update", publicId: "K7M2Q9TX", change: { field: "tags", value: [] } }],
    ["分類規則", { kind: "category_rules" }],
    ["改 #K7M2Q9TX 分類 自動", { kind: "update", publicId: "K7M2Q9TX", change: { field: "category", value: "auto" } }],
    ["改 #K7M2Q9TX 時間 未知", { kind: "update", publicId: "K7M2Q9TX", change: { field: "time", value: null } }],
    ["加 #K7M2Q9TX 標籤 #約會 #台南", { kind: "tags", operation: "add", publicId: "K7M2Q9TX", tags: ["約會", "台南"] }],
  ])("parses %s", (input, expected) => {
    expect(parseLedgerCommand(input)).toEqual({ kind: "command", command: expected });
  });

  it.each(["最近 0", "最近 21", "最近 五", "找", "搜尋 ", "設定暱稱", "設定暱稱 #小美", "切換 共同模式", "改 #K7M2Q9TX 金額 -1", "本月 不知道", "13月月報", "取消 150"])(
    "keeps malformed reserved input out of create: %s",
    (input) => expect(parseLedgerCommand(input).kind).toBe("invalid"),
  );

  it("returns not_command for an expense", () => {
    expect(parseLedgerCommand("牛肉麵 150")).toEqual({ kind: "not_command" });
    expect(parseLedgerCommand("昨天 牛肉麵 150")).toEqual({ kind: "not_command" });
  });
});
