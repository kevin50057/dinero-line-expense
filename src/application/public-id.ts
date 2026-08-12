import { randomBytes } from "node:crypto";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generatePublicId(
  length = 8,
  bytes: (size: number) => Uint8Array = randomBytes,
): string {
  if (!Number.isSafeInteger(length) || length < 8) {
    throw new Error("Public ID length must be an integer of at least 8 characters");
  }

  const entropy = bytes(length);
  if (entropy.length < length) {
    throw new Error("The random byte source returned insufficient entropy");
  }

  let id = "";
  for (let index = 0; index < length; index += 1) {
    const value = entropy[index];
    if (value === undefined) {
      throw new Error("The random byte source returned insufficient entropy");
    }
    id += CROCKFORD_BASE32[value & 31];
  }

  return id;
}
