import { describe, expect, it } from "vitest";

import { generatePublicId } from "../../src/application/public-id.js";

describe("generatePublicId", () => {
  it("creates an eight-character unambiguous Base32 identifier", () => {
    const id = generatePublicId(8, () =>
      Uint8Array.from([0, 1, 8, 9, 10, 11, 30, 31]),
    );

    expect(id).toBe("0189ABYZ");
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it("rejects identifiers shorter than the specification", () => {
    expect(() => generatePublicId(7)).toThrow("at least 8");
  });
});
