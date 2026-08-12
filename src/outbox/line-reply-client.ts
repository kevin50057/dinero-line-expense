import type { LineReplyPayload } from "./payload.js";

export const LINE_REPLY_ENDPOINT =
  "https://api.line.me/v2/bot/message/reply" as const;

export type LineReplyDeliveryResult =
  | { readonly kind: "success" }
  | {
      readonly kind: "permanent_failure";
      readonly errorCode: string;
    }
  | {
      readonly kind: "retryable_failure";
      readonly errorCode: string;
    };

export interface LineReplyClient {
  deliver(
    replyToken: string,
    payload: LineReplyPayload,
  ): Promise<LineReplyDeliveryResult>;
}

export type LineReplyFetch = (
  input: string,
  init: RequestInit,
) => Promise<{ readonly status: number }>;

export interface LineReplyHttpClientOptions {
  readonly channelAccessToken: string;
  readonly fetchImpl?: LineReplyFetch;
  readonly requestTimeoutMs?: number;
}

/**
 * Creates the narrow HTTP client used by the reply outbox.
 *
 * The result and thrown errors never contain the access token, reply token, or
 * message body. In particular, the reply endpoint must not receive
 * X-Line-Retry-Key; that idempotency header is supported by push, not reply.
 */
export function createLineReplyHttpClient(
  options: LineReplyHttpClientOptions,
): LineReplyClient {
  if (options.channelAccessToken.trim().length === 0) {
    throw new Error("LINE channel access token must not be blank");
  }

  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("LINE request timeout must be a positive number");
  }

  const fetchImpl: LineReplyFetch =
    options.fetchImpl ??
    ((input, init) => globalThis.fetch(input, init));

  return {
    async deliver(
      replyToken: string,
      payload: LineReplyPayload,
    ): Promise<LineReplyDeliveryResult> {
      if (replyToken.length === 0) {
        return {
          kind: "permanent_failure",
          errorCode: "invalid_reply_token",
        };
      }

      let status: number;
      try {
        const response = await fetchImpl(LINE_REPLY_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.channelAccessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ replyToken, messages: payload.messages }),
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        status = response.status;
      } catch {
        return {
          kind: "retryable_failure",
          errorCode: "line_network_error",
        };
      }

      if (!Number.isInteger(status) || status < 100 || status > 599) {
        return {
          kind: "retryable_failure",
          errorCode: "line_invalid_response",
        };
      }
      if (status >= 200 && status < 300) {
        return { kind: "success" };
      }
      if (status === 429 || status >= 500) {
        return {
          kind: "retryable_failure",
          errorCode: `line_http_${String(status)}`,
        };
      }

      // 400/401/403 are the expected permanent provider failures. Other 4xx
      // responses are also non-retryable: retrying an unchanged reply request
      // cannot repair it within the reply token's short lifetime.
      return {
        kind: "permanent_failure",
        errorCode: `line_http_${String(status)}`,
      };
    },
  };
}
