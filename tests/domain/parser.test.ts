import { describe, expect, it } from "vitest";

import {
  parseExpenseMessage,
  type ExpenseParseErrorCode,
  type ParsedExpense,
} from "../../src/domain/index.js";

const NOON_EVENT = "2026-08-13T04:10:00.000Z"; // 12:10 Asia/Taipei

function parseOk(
  input: string,
  eventTimestamp: Date | string | number = NOON_EVENT,
): ParsedExpense {
  const result = parseExpenseMessage(input, { eventTimestamp });
  if (!result.ok) {
    throw new Error(
      `Expected parse success for ${JSON.stringify(input)}, got ${result.error.code}`,
    );
  }
  return result.value;
}

function expectError(
  input: string,
  code: ExpenseParseErrorCode,
  eventTimestamp: Date | string | number = NOON_EVENT,
): void {
  const result = parseExpenseMessage(input, { eventTimestamp });
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected ${code}, got success`);
  }
  expect(result.error.code).toBe(code);
}

describe("parseExpenseMessage create semantics", () => {
  it("parses a bare expense as shared and derives event date, food, and lunch", () => {
    const expense = parseOk("牛肉麵 150");

    expect(expense).toMatchObject({
      description: "牛肉麵",
      amountMinor: 150,
      currency: "TWD",
      scope: "shared",
      occurredOn: "2026-08-13",
      occurredAt: "2026-08-13T04:10:00.000Z",
      occurredTime: "12:10",
      occurredDateSource: "line_event",
      occurredTimeSource: "line_event",
      occurredTimePrecision: "millisecond",
      category: { code: "food", source: "inferred" },
      meal: { code: "lunch", source: "inferred" },
    });
  });

  it.each([
    ["個人 電影 320", "personal"],
    ["共同 電影 320", "shared"],
  ] as const)("parses an explicit %s scope", (input, scope) => {
    const expense = parseOk(input);
    expect(expense.scope).toBe(scope);
    expect(expense.category.code).toBe("entertainment");
  });

  it("honors a non-shared ledger default while explicit scope still wins", () => {
    const bare = parseExpenseMessage("電影 320", {
      eventTimestamp: NOON_EVENT,
      defaultScope: "personal",
    });
    expect(bare.ok && bare.value.scope).toBe("personal");

    const explicit = parseExpenseMessage("共同 電影 320", {
      eventTimestamp: NOON_EVENT,
      defaultScope: "personal",
    });
    expect(explicit.ok && explicit.value.scope).toBe("shared");
  });

  it.each([
    ["牛肉麵 150", 150],
    ["牛肉麵 150元", 150],
    ["牛肉麵 $150", 150],
    ["牛肉麵 NT$150", 150],
    ["飯店 1,200", 1_200],
    ["牛肉麵150", 150],
    ["牛肉麵$150", 150],
    ["飯店1,200", 1_200],
  ] as const)("accepts supported amount form in %s", (input, expected) => {
    expect(parseOk(input).amountMinor).toBe(expected);
  });

  it("parses system hashtags into typed tags and deduplicates custom tags", () => {
    const expense = parseOk(
      "牛肉麵 150 #食物 #午餐 #約會 #ＡＢＣ #abc #約會",
    );

    expect(expense.category).toMatchObject({
      code: "food",
      source: "explicit",
    });
    expect(expense.meal).toMatchObject({
      code: "lunch",
      source: "explicit",
    });
    expect(expense.customTags.map((tag) => tag.displayName)).toEqual([
      "約會",
      "ABC",
    ]);
    expect(expense.customTags.map((tag) => tag.normalizedName)).toEqual([
      "約會",
      "abc",
    ]);
    expect(expense.tags.map((tag) => tag.type)).toEqual([
      "category",
      "meal",
      "custom",
      "custom",
    ]);
  });

  it("allows ten distinct custom tags and atomically rejects the eleventh", () => {
    const ten = Array.from({ length: 10 }, (_, index) => `#t${index}`).join(" ");
    const eleven = `${ten} #t10`;

    expect(parseOk(`牛肉麵 150 ${ten}`).customTags).toHaveLength(10);
    expectError(`牛肉麵 150 ${eleven}`, "TOO_MANY_CUSTOM_TAGS");
  });

  it("rejects malformed and oversized hashtags", () => {
    expectError("牛肉麵 150 #", "INVALID_TAG");
    expectError("牛肉麵 150 #a#b", "INVALID_TAG");
    expectError(`牛肉麵 150 #${"標".repeat(21)}`, "INVALID_TAG");
  });

  it("rejects conflicting system tags", () => {
    expectError(
      "牛肉麵 150 #食物 #娛樂",
      "CONFLICTING_CATEGORY",
    );
    expectError(
      "牛肉麵 150 #午餐 #晚餐",
      "CONFLICTING_MEAL",
    );
    expectError(
      "電影 320 #娛樂 #晚餐",
      "MEAL_CATEGORY_CONFLICT",
    );
  });

  it("lets an explicit category override classification and meal inference", () => {
    const expense = parseOk("牛肉麵 150 #娛樂");
    expect(expense.category).toMatchObject({
      code: "entertainment",
      source: "explicit",
    });
    expect(expense.meal).toBeNull();
  });

  it("uses uncategorized for an unknown item without dropping custom tags", () => {
    const expense = parseOk("神秘盒子 99 #紀念日");
    expect(expense.category.code).toBe("uncategorized");
    expect(expense.customTags[0]?.displayName).toBe("紀念日");
  });

  it("adds and deduplicates the inferred 原生家庭 context tag", () => {
    const inferred = parseOk("爸爸醫藥費 1200");
    expect(inferred.category.code).toBe("health");
    expect(inferred.customTags).toEqual([
      expect.objectContaining({ displayName: "原生家庭", source: "inferred", code: "native_family" }),
    ]);

    const explicit = parseOk("孝親費 5000 #原生家庭");
    expect(explicit.category.code).toBe("household");
    expect(explicit.customTags).toHaveLength(1);
    expect(explicit.customTags[0]).toMatchObject({ displayName: "原生家庭", source: "explicit" });
  });

  it("treats an explicit meal as food and preserves a meal-only description", () => {
    const mealOnly = parseOk("晚餐 200", "2026-08-13T12:00:00.000Z");
    expect(mealOnly).toMatchObject({
      description: "晚餐",
      category: { code: "food", source: "explicit" },
      meal: { code: "dinner", source: "explicit" },
    });

    const drink = parseOk("咖啡 80 #下午茶");
    expect(drink.category).toMatchObject({ code: "food", source: "explicit" });
    expect(drink.meal).toMatchObject({
      code: "afternoon_tea",
      source: "explicit",
    });
  });
});

describe("parseExpenseMessage date and time semantics", () => {
  it("makes a date-only backfill time-unknown and does not infer a meal", () => {
    const expense = parseOk("昨天 牛肉麵 150");
    expect(expense).toMatchObject({
      occurredOn: "2026-08-12",
      occurredAt: null,
      occurredTime: null,
      occurredDateSource: "relative_input",
      occurredTimeSource: null,
      occurredTimePrecision: "unknown",
      meal: null,
    });
  });

  it("also treats an explicit today date without a time as date-only", () => {
    const expense = parseOk("今天 牛肉麵 150");
    expect(expense.occurredOn).toBe("2026-08-13");
    expect(expense.occurredTime).toBeNull();
    expect(expense.meal).toBeNull();
  });

  it("supports relative dates across year boundaries", () => {
    const event = "2027-01-01T04:10:00.000Z";
    expect(parseOk("昨天 牛肉麵 150", event).occurredOn).toBe(
      "2026-12-31",
    );
    expect(parseOk("前天 牛肉麵 150", event).occurredOn).toBe(
      "2026-12-30",
    );
  });

  it.each([
    ["2026/8/12 19:30 炒麵 80", "2026-08-12"],
    ["2026-08-12 19:30 炒麵 80", "2026-08-12"],
  ] as const)("supports absolute date syntax in %s", (input, expectedDate) => {
    const expense = parseOk(input);
    expect(expense).toMatchObject({
      occurredOn: expectedDate,
      occurredAt: "2026-08-12T11:30:00.000Z",
      occurredTime: "19:30",
      occurredDateSource: "absolute_input",
      occurredTimeSource: "explicit_input",
      occurredTimePrecision: "minute",
      meal: { code: "dinner", source: "inferred" },
    });
  });

  it("allows date, time, meal, and scope prefixes in any order", () => {
    const expense = parseOk("個人 19:30 昨天 晚餐 炒麵 80");
    expect(expense).toMatchObject({
      scope: "personal",
      occurredOn: "2026-08-12",
      occurredAt: "2026-08-12T11:30:00.000Z",
      occurredTime: "19:30",
      meal: { code: "dinner", source: "explicit" },
    });
  });

  it("rejects duplicate and conflicting prefixes", () => {
    expectError("個人 共同 牛肉麵 150", "CONFLICTING_SCOPE");
    expectError("共同 共同 牛肉麵 150", "DUPLICATE_SCOPE");
    expectError("昨天 2026/8/12 牛肉麵 150", "DUPLICATE_DATE");
    expectError("10:00 10:00 牛肉麵 150", "DUPLICATE_TIME");
    expectError("午餐 晚餐 牛肉麵 150", "CONFLICTING_MEAL");
    expectError("午餐 午餐 牛肉麵 150", "DUPLICATE_MEAL");
  });

  it("rejects invalid, omitted-year, and future dates", () => {
    expectError("2026-02-30 牛肉麵 150", "INVALID_DATE");
    expectError("2026/8-12 牛肉麵 150", "INVALID_DATE");
    expectError("8/12 牛肉麵 150", "YEAR_REQUIRED");
    expectError("明天 牛肉麵 150", "FUTURE_DATE");
    expectError("2026-08-14 牛肉麵 150", "FUTURE_DATE");
  });

  it("accepts a real leap day and rejects a false one", () => {
    const event = "2028-03-01T04:10:00.000Z";
    expect(parseOk("2028-02-29 牛肉麵 150", event).occurredOn).toBe(
      "2028-02-29",
    );
    expectError("2027-02-29 牛肉麵 150", "INVALID_DATE", event);
  });

  it("treats a time-only prefix as today and rejects a future minute", () => {
    const event = "2026-08-13T12:00:00.000Z"; // 20:00 Taipei
    expect(parseOk("19:30 牛肉麵 150", event)).toMatchObject({
      occurredOn: "2026-08-13",
      occurredTime: "19:30",
      meal: { code: "dinner" },
    });
    expectError("20:30 牛肉麵 150", "FUTURE_TIME", event);
  });

  it("strictly validates HH:mm", () => {
    expectError("24:00 牛肉麵 150", "INVALID_TIME");
    expectError("9:30 牛肉麵 150", "INVALID_TIME");
  });

  it("uses the LINE instant in the configured ledger timezone", () => {
    const result = parseExpenseMessage("牛肉麵 150", {
      eventTimestamp: "2026-08-13T16:05:00.000Z",
      timezone: "Asia/Taipei",
    });
    expect(result.ok && result.value).toMatchObject({
      occurredOn: "2026-08-14",
      occurredAt: "2026-08-13T16:05:00.000Z",
      occurredTime: "00:05",
      occurredDateSource: "line_event",
      occurredTimeSource: "line_event",
      occurredTimePrecision: "millisecond",
    });
  });

  it("preserves the exact LINE event milliseconds for direct DB storage", () => {
    const event = "2026-08-13T04:10:27.456Z";
    const expense = parseOk("牛肉麵 150", event);

    expect(expense).toMatchObject({
      occurredOn: "2026-08-13",
      occurredAt: event,
      occurredTime: "12:10",
      occurredDateSource: "line_event",
      occurredTimeSource: "line_event",
      occurredTimePrecision: "millisecond",
    });
  });
});

describe("parseExpenseMessage validation and dispatch safety", () => {
  it.each([
    ["晚餐 -100", "INVALID_AMOUNT"],
    ["晚餐 0", "INVALID_AMOUNT"],
    ["晚餐 100.5", "INVALID_AMOUNT"],
    ["晚餐 12,00", "INVALID_AMOUNT"],
    ["牛肉麵90.5", "INVALID_AMOUNT"],
  ] as const)("rejects invalid amount in %s", (input, code) => {
    expectError(input, code);
  });

  it("rejects amounts outside JavaScript's exactly representable integer range", () => {
    expectError("晚餐 9007199254740992", "INVALID_AMOUNT");
  });

  it("requires an item and limits it by Unicode code points", () => {
    expectError("150", "DESCRIPTION_REQUIRED");
    expectError("個人 150", "DESCRIPTION_REQUIRED");
    expectError(`${"🍜".repeat(51)} 150`, "DESCRIPTION_TOO_LONG");
    expect(parseOk(`${"🍜".repeat(50)} 150`).description).toHaveLength(100);
  });

  it.each([
    "改 #K7M2Q9TX 金額 180",
    "最近 5",
    "最近 0",
    "查 #K7M2Q9TX",
    "本月 共同",
    "取消 #K7M2Q9TX",
    "分類 100",
    "今天",
    "昨天",
  ])("never falls a reserved command through to create: %s", (input) => {
    expectError(input, "RESERVED_COMMAND");
  });

  it("returns a format error for text without an amount", () => {
    expectError("牛肉麵", "INVALID_FORMAT");
  });

  it("does not guess that a Latin product model suffix is an amount", () => {
    expectError("iPhone15", "AMBIGUOUS_AMOUNT");
    expect(parseOk("iPhone 15")).toMatchObject({
      description: "iPhone",
      amountMinor: 15,
    });
  });

  it("rejects an invalid event timestamp or timezone without throwing", () => {
    expectError("牛肉麵 150", "INVALID_EVENT_TIMESTAMP", "not-a-date");
    const result = parseExpenseMessage("牛肉麵 150", {
      eventTimestamp: NOON_EVENT,
      timezone: "Mars/Olympus",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_EVENT_TIMESTAMP" },
    });
  });
});
