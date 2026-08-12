import { describe, expect, it } from "vitest";

import {
  InvalidLineReplyPayloadError,
  parseLineReplyPayload,
} from "../../src/outbox/index.js";

describe("parseLineReplyPayload", () => {
  it("accepts the allow-listed text message shape", () => {
    const input = {
      messages: [
        { type: "text", text: "已記帳 #ABC12345" },
        { type: "text", text: "🍜" },
      ],
    };

    expect(parseLineReplyPayload(input)).toEqual(input);
  });

  it.each([
    null,
    {},
    { messages: [] },
    { messages: [{ type: "image", text: "no" }] },
    { messages: [{ type: "text", text: "" }] },
    { messages: [{ type: "text", text: "ok", secret: "no" }] },
    { messages: [{ type: "text", text: "ok" }], replyToken: "no" },
    {
      messages: Array.from({ length: 6 }, () => ({
        type: "text",
        text: "too many",
      })),
    },
    { messages: [{ type: "text", text: "x".repeat(5_001) }] },
  ])("rejects an invalid or expanded payload: %j", (input) => {
    expect(() => parseLineReplyPayload(input)).toThrow(
      InvalidLineReplyPayloadError,
    );
  });

  it("counts Unicode code points instead of UTF-16 units", () => {
    const text = "🍜".repeat(5_000);
    expect(
      parseLineReplyPayload({ messages: [{ type: "text", text }] }),
    ).toEqual({ messages: [{ type: "text", text }] });
  });
});
