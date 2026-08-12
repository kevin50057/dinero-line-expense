import { describe, expect, it } from "vitest";

import {
  createCredentialCipher,
  decodeCredentialKey,
} from "../../src/security/credential-cipher.js";

const key = Buffer.alloc(32, 7);

describe("credential cipher", () => {
  it("round-trips a LINE reply token without deterministic ciphertext", () => {
    const cipher = createCredentialCipher(key);
    const first = cipher.encrypt("reply-token");
    const second = cipher.encrypt("reply-token");

    expect(first.equals(second)).toBe(false);
    expect(cipher.decrypt(first)).toBe("reply-token");
    expect(cipher.decrypt(second)).toBe("reply-token");
    expect(first.includes(Buffer.from("reply-token"))).toBe(false);
  });

  it("rejects tampering and a different key", () => {
    const cipher = createCredentialCipher(key);
    const encrypted = cipher.encrypt("reply-token");
    encrypted[encrypted.length - 1]! ^= 1;

    expect(() => cipher.decrypt(encrypted)).toThrow(
      "invalid credential ciphertext",
    );
    expect(() =>
      createCredentialCipher(Buffer.alloc(32, 8)).decrypt(
        createCredentialCipher(key).encrypt("reply-token"),
      ),
    ).toThrow("invalid credential ciphertext");
  });

  it("strictly decodes one 32-byte base64 key", () => {
    const encoded = key.toString("base64");
    expect(decodeCredentialKey(encoded)).toEqual(key);
    expect(() => decodeCredentialKey("not base64"))
      .toThrow("must be valid base64");
    expect(() => decodeCredentialKey(Buffer.alloc(31).toString("base64")))
      .toThrow("exactly 32 bytes");
  });
});
