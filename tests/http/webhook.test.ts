import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { LineEventInbox } from "../../src/http/webhook.js";
import { handleLineWebhook } from "../../src/http/webhook.js";

const encoder = new TextEncoder();
const channelSecret = "secret";

function signedBody(events: unknown[]) {
  const rawBody = encoder.encode(JSON.stringify({ destination: "U-bot", events }));
  const signature = createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return { rawBody, signature };
}

function messageEvent(userId = "U-ming") {
  return {
    type: "message",
    webhookEventId: "event-1",
    timestamp: 1_723_520_200_000,
    source: { type: "group", groupId: "C-ledger", userId },
    message: { id: "message-1", type: "text", text: "牛肉麵 150" },
    replyToken: "reply-token",
  };
}

describe("handleLineWebhook", () => {
  it("verifies before normalizing and sends authorized events to the inbox", async () => {
    const acceptBatch = vi.fn<LineEventInbox["acceptBatch"]>().mockResolvedValue();
    const body = signedBody([messageEvent()]);

    const result = await handleLineWebhook(body.rawBody, body.signature, {
      channelSecret,
      allowedGroupId: "C-ledger",
      allowedMemberUserIds: new Set(["U-ming", "U-mei"]),
      inbox: { acceptBatch },
    });

    expect(result).toEqual({ status: 200, code: "accepted" });
    expect(acceptBatch).toHaveBeenCalledWith(
      "U-bot",
      expect.arrayContaining([
        expect.objectContaining({ authorization: { authorized: true } }),
      ]),
    );
  });

  it("authorizes a configured member in a one-to-one chat", async () => {
    const acceptBatch = vi.fn<LineEventInbox["acceptBatch"]>().mockResolvedValue();
    const privateEvent = {
      ...messageEvent(),
      source: { type: "user", userId: "U-ming" },
    };
    const body = signedBody([privateEvent]);

    const result = await handleLineWebhook(body.rawBody, body.signature, {
      channelSecret,
      allowedGroupId: "C-ledger",
      allowedMemberUserIds: new Set(["U-ming", "U-mei"]),
      inbox: { acceptBatch },
    });

    expect(result).toEqual({ status: 200, code: "accepted" });
    expect(acceptBatch).toHaveBeenCalledWith("U-bot", [
      expect.objectContaining({ authorization: { authorized: true } }),
    ]);
  });

  it("fails closed before calling the inbox when the signature is invalid", async () => {
    const acceptBatch = vi.fn<LineEventInbox["acceptBatch"]>();
    const body = signedBody([messageEvent()]);

    const result = await handleLineWebhook(body.rawBody, "invalid", {
      channelSecret,
      allowedGroupId: "C-ledger",
      allowedMemberUserIds: new Set(["U-ming", "U-mei"]),
      inbox: { acceptBatch },
    });

    expect(result).toEqual({ status: 401, code: "invalid_signature" });
    expect(acceptBatch).not.toHaveBeenCalled();
  });

  it("marks an unknown member unauthorized without persisting policy decisions here", async () => {
    const acceptBatch = vi.fn<LineEventInbox["acceptBatch"]>().mockResolvedValue();
    const body = signedBody([messageEvent("U-stranger")]);

    await handleLineWebhook(body.rawBody, body.signature, {
      channelSecret,
      allowedGroupId: "C-ledger",
      allowedMemberUserIds: new Set(["U-ming", "U-mei"]),
      inbox: { acceptBatch },
    });

    expect(acceptBatch).toHaveBeenCalledWith(
      "U-bot",
      expect.arrayContaining([
        expect.objectContaining({
          authorization: { authorized: false, reason: "member_not_allowed" },
        }),
      ]),
    );
  });

  it("returns a retryable result if the durable inbox is unavailable", async () => {
    const body = signedBody([messageEvent()]);

    const result = await handleLineWebhook(body.rawBody, body.signature, {
      channelSecret,
      allowedGroupId: "C-ledger",
      allowedMemberUserIds: new Set(["U-ming", "U-mei"]),
      inbox: {
        acceptBatch: vi.fn().mockRejectedValue(new Error("database unavailable")),
      },
    });

    expect(result).toEqual({ status: 503, code: "inbox_unavailable" });
  });
});
