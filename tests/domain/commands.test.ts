import { describe, expect, it } from "vitest";

import { parseLedgerCommand } from "../../src/domain/index.js";

describe("parseLedgerCommand", () => {
  it.each([
    ["查 #K7M2Q9TX", { kind: "detail", publicId: "K7M2Q9TX" }],
    ["最近", { kind: "recent", limit: 10 }],
    ["最近 5", { kind: "recent", limit: 5 }],
    ["本月 共同", { kind: "period", period: "month", filter: { kind: "shared" } }],
    ["本月 #約會", { kind: "period", period: "month", filter: { kind: "tag", name: "約會" } }],
    ["取消 #K7M2Q9TX", { kind: "void", publicId: "K7M2Q9TX" }],
    ["還原 #K7M2Q9TX", { kind: "restore", publicId: "K7M2Q9TX" }],
    ["改 #K7M2Q9TX 金額 180", { kind: "update", publicId: "K7M2Q9TX", change: { field: "amount", value: 180 } }],
    ["改 #K7M2Q9TX 分類 自動", { kind: "update", publicId: "K7M2Q9TX", change: { field: "category", value: "auto" } }],
    ["改 #K7M2Q9TX 時間 未知", { kind: "update", publicId: "K7M2Q9TX", change: { field: "time", value: null } }],
    ["加 #K7M2Q9TX 標籤 #約會 #台南", { kind: "tags", operation: "add", publicId: "K7M2Q9TX", tags: ["約會", "台南"] }],
  ])("parses %s", (input, expected) => {
    expect(parseLedgerCommand(input)).toEqual({ kind: "command", command: expected });
  });

  it.each(["最近 0", "最近 21", "最近 五", "改 #K7M2Q9TX 金額 -1", "本月 不知道", "取消 150"])(
    "keeps malformed reserved input out of create: %s",
    (input) => expect(parseLedgerCommand(input).kind).toBe("invalid"),
  );

  it("returns not_command for an expense", () => {
    expect(parseLedgerCommand("牛肉麵 150")).toEqual({ kind: "not_command" });
    expect(parseLedgerCommand("昨天 牛肉麵 150")).toEqual({ kind: "not_command" });
  });
});
