import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + AUTH_TAG_BYTES;
const MAX_CREDENTIAL_BYTES = 4_096;

export interface CredentialCipher {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Uint8Array): string;
}

/**
 * Encrypts short-lived provider credentials with AES-256-GCM.
 *
 * Binary format: version (1 byte), random IV (12), auth tag (16), ciphertext.
 * A version byte makes a future key/format migration explicit.
 */
export function createCredentialCipher(key: Uint8Array): CredentialCipher {
  if (key.byteLength !== 32) {
    throw new Error("credential encryption key must contain exactly 32 bytes");
  }
  const ownedKey = Buffer.from(key);

  return {
    encrypt(plaintext: string): Buffer {
      const input = Buffer.from(plaintext, "utf8");
      if (input.byteLength === 0 || input.byteLength > MAX_CREDENTIAL_BYTES) {
        throw new Error("credential must contain 1 to 4096 UTF-8 bytes");
      }

      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", ownedKey, iv);
      const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
      const authenticationTag = cipher.getAuthTag();

      return Buffer.concat([
        Buffer.from([FORMAT_VERSION]),
        iv,
        authenticationTag,
        encrypted,
      ]);
    },

    decrypt(ciphertext: Uint8Array): string {
      const envelope = Buffer.from(ciphertext);
      if (
        envelope.byteLength <= HEADER_BYTES ||
        envelope[0] !== FORMAT_VERSION
      ) {
        throw new Error("invalid credential ciphertext");
      }

      try {
        const iv = envelope.subarray(1, 1 + IV_BYTES);
        const authenticationTag = envelope.subarray(
          1 + IV_BYTES,
          HEADER_BYTES,
        );
        const encrypted = envelope.subarray(HEADER_BYTES);
        const decipher = createDecipheriv("aes-256-gcm", ownedKey, iv);
        decipher.setAuthTag(authenticationTag);
        const plaintext = Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]);
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      } catch {
        throw new Error("invalid credential ciphertext");
      }
    },
  };
}

export function decodeCredentialKey(encoded: string): Buffer {
  const normalized = encoded.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) {
    throw new Error("OUTBOX_CREDENTIAL_KEY_BASE64 must be valid base64");
  }

  const key = Buffer.from(normalized, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== normalized) {
    throw new Error(
      "OUTBOX_CREDENTIAL_KEY_BASE64 must encode exactly 32 bytes",
    );
  }
  return key;
}
