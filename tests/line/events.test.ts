import { describe, expect, it } from "vitest";

import {
  LineWebhookParseError,
  parseLineWebhookBody,
} from "../../src/line/events.js";

const encoder = new TextEncoder();

function encode(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    webhookEventId: "01EVENT",
    timestamp: 1_723_520_200_000,
    source: {
      type: "group",
      groupId: "C-allowed",
      userId: "U-ming",
    },
    deliveryContext: { isRedelivery: false },
    mode: "active",
    replyToken: "reply-token",
    message: {
      id: "M-message",
      type: "text",
      text: "牛肉麵 150",
    },
    ...overrides,
  };
}

describe("parseLineWebhookBody", () => {
  it("normalizes a text message without retaining the original envelope", () => {
    const result = parseLineWebhookBody(
      encode({ destination: "U-bot", events: [baseEvent()] }),
    );

    expect(result).toEqual({
      destination: "U-bot",
      events: [
        {
          webhookEventId: "01EVENT",
          kind: "message",
          rawType: "message",
          lineEventAtMs: 1_723_520_200_000,
          source: {
            type: "group",
            groupId: "C-allowed",
            roomId: undefined,
            userId: "U-ming",
          },
          lineMessageId: "M-message",
          message: {
            id: "M-message",
            type: "text",
            text: "牛肉麵 150",
          },
          replyToken: "reply-token",
          isRedelivery: false,
          mode: "active",
        },
      ],
    });
  });

  it("normalizes edit, unsend, and join events without requiring userId", () => {
    const edit = baseEvent({
      type: "messageEdited",
      webhookEventId: "01EDIT",
      source: { type: "group", groupId: "C-allowed", userId: "U-ming" },
      message: { id: "M-message", type: "text", text: "牛肉麵 180" },
      deliveryContext: { isRedelivery: true },
    });
    const unsend = baseEvent({
      type: "unsend",
      webhookEventId: "01UNSEND",
      source: { type: "group", groupId: "C-allowed" },
      message: undefined,
      unsend: { messageId: "M-message" },
      replyToken: undefined,
    });
    const join = baseEvent({
      type: "join",
      webhookEventId: "01JOIN",
      source: { type: "group", groupId: "C-allowed" },
      message: undefined,
    });

    const result = parseLineWebhookBody(
      encode({ destination: "U-bot", events: [edit, unsend, join] }),
    );

    expect(result.events.map((event) => event.kind)).toEqual([
      "edit",
      "unsend",
      "join",
    ]);
    expect(result.events[0]).toMatchObject({
      lineMessageId: "M-message",
      isRedelivery: true,
      message: { text: "牛肉麵 180" },
    });
    expect(result.events[1]).toMatchObject({
      lineMessageId: "M-message",
      source: { groupId: "C-allowed", userId: undefined },
    });
    expect(result.events[2]).toMatchObject({
      kind: "join",
      source: { groupId: "C-allowed", userId: undefined },
    });
  });

  it("supports an empty events array and unknown future event types", () => {
    expect(
      parseLineWebhookBody(encode({ destination: "U-bot", events: [] })),
    ).toEqual({ destination: "U-bot", events: [] });

    const result = parseLineWebhookBody(
      encode({
        destination: "U-bot",
        events: [
          baseEvent({
            type: "memberJoined",
            webhookEventId: "01OTHER",
            message: undefined,
            source: { type: "group", groupId: "C-allowed" },
          }),
        ],
      }),
    );
    expect(result.events[0]?.kind).toBe("other");
    expect(result.events[0]?.rawType).toBe("memberJoined");
  });

  it("normalizes non-text messages without inventing text", () => {
    const result = parseLineWebhookBody(
      encode({
        destination: "U-bot",
        events: [
          baseEvent({
            message: { id: "M-image", type: "image" },
          }),
        ],
      }),
    );

    expect(result.events[0]?.message).toEqual({
      id: "M-image",
      type: "image",
      text: undefined,
    });
  });

  it.each([
    [encoder.encode("not json"), "invalid_json", undefined],
    [encode({ destination: "U-bot" }), "invalid_envelope", undefined],
    [
      encode({ destination: "U-bot", events: [baseEvent({ timestamp: "bad" })] }),
      "invalid_event",
      0,
    ],
    [
      encode({
        destination: "U-bot",
        events: [baseEvent({ type: "unsend", message: undefined })],
      }),
      "invalid_event",
      0,
    ],
  ] as const)(
    "rejects malformed input without putting raw content in the error",
    (body, code, eventIndex) => {
      try {
        parseLineWebhookBody(body);
        throw new Error("expected parser to reject input");
      } catch (error) {
        expect(error).toBeInstanceOf(LineWebhookParseError);
        expect(error).toMatchObject({ code, eventIndex });
        expect(String(error)).not.toContain("牛肉麵");
      }
    },
  );

  it("rejects invalid UTF-8 before JSON parsing", () => {
    expect(() => parseLineWebhookBody(Uint8Array.from([0xff]))).toThrowError(
      expect.objectContaining({ code: "invalid_utf8" }),
    );
  });
});
