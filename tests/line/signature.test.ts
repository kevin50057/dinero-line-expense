import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyLineWebhookSignature } from "../../src/line/signature.js";

const encoder = new TextEncoder();
const secret = "line-channel-secret";

function sign(body: Uint8Array): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

describe("verifyLineWebhookSignature", () => {
  it("accepts a signature computed from the exact raw bytes", () => {
    const body = encoder.encode('{"events":[],"destination":"U123"}');

    expect(verifyLineWebhookSignature(body, sign(body), secret)).toBe(true);
  });

  it("rejects semantically equivalent JSON whose raw bytes changed", () => {
    const signedBody = encoder.encode('{"events":[],"destination":"U123"}');
    const reformattedBody = encoder.encode(
      '{ "events": [], "destination": "U123" }',
    );

    expect(
      verifyLineWebhookSignature(reformattedBody, sign(signedBody), secret),
    ).toBe(false);
  });

  it("verifies UTF-8 bytes without normalizing their contents", () => {
    const body = encoder.encode(
      '{"events":[{"message":{"text":"牛肉麵 150"}}]}',
    );

    expect(verifyLineWebhookSignature(body, sign(body), secret)).toBe(true);
  });

  it.each([undefined, null, "", "not-base64", "A".repeat(44)])(
    "fails closed for a missing or malformed signature: %s",
    (signature) => {
      const body = encoder.encode("{}");
      expect(verifyLineWebhookSignature(body, signature, secret)).toBe(false);
    },
  );

  it("fails closed for an empty body or channel secret", () => {
    const body = encoder.encode("{}");

    expect(verifyLineWebhookSignature(new Uint8Array(), sign(body), secret)).toBe(
      false,
    );
    expect(verifyLineWebhookSignature(body, sign(body), "")).toBe(false);
  });
});
