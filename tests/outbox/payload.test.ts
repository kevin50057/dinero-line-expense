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

  it("accepts the allow-listed Flex Message card subset", () => {
    const input = {
      messages: [{
        type: "flex",
        altText: "本月支出 1,280 元",
        contents: {
          type: "bubble",
          size: "kilo",
          body: {
            type: "box",
            layout: "vertical",
            paddingAll: "20px",
            contents: [
              { type: "text", text: "本月支出", weight: "bold", wrap: true },
              { type: "separator", margin: "md", color: "#EEEEEE" },
              { type: "button", style: "secondary", height: "sm", action: { type: "message", label: "最近紀錄", text: "最近 5" } },
            ],
          },
        },
      }],
    };
    expect(parseLineReplyPayload(input)).toEqual(input);
  });

  it.each([
    { messages: [{ type: "flex", altText: "", contents: { type: "bubble", body: { type: "box", layout: "vertical", contents: [] } } }] },
    { messages: [{ type: "flex", altText: "ok", contents: { type: "bubble", body: { type: "box", layout: "vertical", contents: [], secret: "no" } } }] },
    { messages: [{ type: "flex", altText: "ok", contents: { type: "carousel", contents: [] } }] },
    { messages: [{ type: "flex", altText: "ok", contents: { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "button", action: { type: "uri", label: "no", uri: "https://example.com" } }] } } }] },
  ])("rejects expanded or malformed Flex payloads: %j", (input) => {
    expect(() => parseLineReplyPayload(input)).toThrow(InvalidLineReplyPayloadError);
  });
});
