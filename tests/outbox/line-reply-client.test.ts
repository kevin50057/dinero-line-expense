import { describe, expect, it, vi } from "vitest";

import {
  LINE_REPLY_ENDPOINT,
  createLineReplyHttpClient,
  type LineReplyFetch,
} from "../../src/outbox/index.js";

const payload = {
  messages: [{ type: "text" as const, text: "已記帳" }],
};

describe("LINE reply HTTP client", () => {
  it("posts only to the official reply endpoint without a retry key", async () => {
    const fetchImpl = vi.fn<LineReplyFetch>().mockResolvedValue({ status: 200 });
    const client = createLineReplyHttpClient({
      channelAccessToken: "channel-secret-token",
      fetchImpl,
    });

    const result = await client.deliver("one-time-reply-token", payload);

    expect(result).toEqual({ kind: "success" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(LINE_REPLY_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: "Bearer channel-secret-token",
      "Content-Type": "application/json",
    });
    expect(
      Object.keys(init?.headers as Record<string, string>).some(
        (name) => name.toLowerCase() === "x-line-retry-key",
      ),
    ).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      replyToken: "one-time-reply-token",
      messages: payload.messages,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([400, 401, 403, 404])(
    "classifies HTTP %i as permanent",
    async (status) => {
      const client = createLineReplyHttpClient({
        channelAccessToken: "access",
        fetchImpl: async () => ({ status }),
      });

      await expect(client.deliver("reply", payload)).resolves.toEqual({
        kind: "permanent_failure",
        errorCode: `line_http_${String(status)}`,
      });
    },
  );

  it.each([429, 500, 502, 599])(
    "classifies HTTP %i as retryable",
    async (status) => {
      const client = createLineReplyHttpClient({
        channelAccessToken: "access",
        fetchImpl: async () => ({ status }),
      });

      await expect(client.deliver("reply", payload)).resolves.toEqual({
        kind: "retryable_failure",
        errorCode: `line_http_${String(status)}`,
      });
    },
  );

  it("turns network exceptions into a content-free retryable result", async () => {
    const client = createLineReplyHttpClient({
      channelAccessToken: "private-access-token",
      fetchImpl: async () => {
        throw new Error("private-access-token reply-secret 已記帳");
      },
    });

    const result = await client.deliver("reply-secret", payload);
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      kind: "retryable_failure",
      errorCode: "line_network_error",
    });
    expect(serialized).not.toContain("private-access-token");
    expect(serialized).not.toContain("reply-secret");
    expect(serialized).not.toContain("已記帳");
  });

  it("rejects blank configuration without echoing it", () => {
    expect(() =>
      createLineReplyHttpClient({ channelAccessToken: "  " }),
    ).toThrow("LINE channel access token must not be blank");
  });
});
