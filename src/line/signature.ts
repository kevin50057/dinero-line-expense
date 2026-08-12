import { createHmac, timingSafeEqual } from "node:crypto";

const SHA256_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Verifies LINE's x-line-signature against the exact, unparsed request bytes.
 *
 * Callers must not JSON-parse, normalize, or re-encode the request body before
 * passing it here. Buffer is accepted because it is a Uint8Array subclass.
 */
export function verifyLineWebhookSignature(
  rawBody: Uint8Array,
  signature: string | null | undefined,
  channelSecret: string,
): boolean {
  if (
    rawBody.byteLength === 0 ||
    channelSecret.length === 0 ||
    typeof signature !== "string" ||
    !SHA256_SIGNATURE_PATTERN.test(signature)
  ) {
    return false;
  }

  const expected = createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest();
  const received = Buffer.from(signature, "base64");

  return (
    received.byteLength === expected.byteLength &&
    timingSafeEqual(received, expected)
  );
}
