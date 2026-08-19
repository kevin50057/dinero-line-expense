import { describe, expect, it } from "vitest";

import { shouldReplyToExpenseParseError } from "../../src/application/message-reply-policy.js";

describe("message reply policy", () => {
  it.each([
    ["完蛋", "INVALID_FORMAT"],
    ["今天好累", "INVALID_FORMAT"],
    ["共同 牛肉麵", "INVALID_FORMAT"],
    ["牛肉麵 #午餐", "INVALID_FORMAT"],
    ["牛肉麵 $abc", "INVALID_FORMAT"],
    ["iPhone15", "AMBIGUOUS_AMOUNT"],
    ["150", "DESCRIPTION_REQUIRED"],
  ] as const)("silently ignores non-numeric or low-signal chat: %s", (input, errorCode) => {
    expect(shouldReplyToExpenseParseError({ input, errorCode })).toBe(false);
  });

  it.each([
    ["150元", "DESCRIPTION_REQUIRED"],
    ["牛肉麵 0", "INVALID_AMOUNT"],
  ] as const)("replies to explicit or high-confidence group input: %s", (input, errorCode) => {
    expect(shouldReplyToExpenseParseError({ input, errorCode })).toBe(true);
  });

  it("also stays quiet for unrelated private text", () => {
    expect(shouldReplyToExpenseParseError({
      input: "完蛋",
      errorCode: "INVALID_FORMAT",
    })).toBe(false);
  });
});
