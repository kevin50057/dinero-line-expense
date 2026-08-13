import { describe, expect, it } from "vitest";

import {
  classifyDescription,
  inferMeal,
  inferContextTags,
  isMealEligibleDescription,
} from "../../src/domain/index.js";

describe("category rules", () => {
  it.each([
    ["牛肉麵", "food"],
    ["咖啡", "food"],
    ["計程車", "transport"],
    ["Uber", "transport"],
    ["電影", "entertainment"],
    ["房租", "household"],
    ["網購鞋子", "shopping"],
    ["牙醫", "health"],
    ["機票", "travel"],
    ["神秘盒子", "uncategorized"],
  ] as const)("classifies %s as %s", (description, category) => {
    expect(classifyDescription(description).code).toBe(category);
  });

  it("matches the specific hotel rule before the generic rice character", () => {
    const category = classifyDescription("飯店 3000");
    expect(category.code).toBe("travel");
    expect(category.ruleKey).toBe("category:travel.hotel");
  });
});

describe("context tag rules", () => {
  it.each(["孝親費", "給媽媽紅包", "爸爸醫藥費", "父親節禮物"])(
    "infers 原生家庭 for %s",
    (description) => {
      expect(inferContextTags(description)).toEqual([
        expect.objectContaining({ code: "native_family", displayName: "原生家庭", source: "inferred" }),
      ]);
    },
  );

  it.each(["自己看診", "朋友生日禮物", "家庭餐廳"])(
    "does not overmatch %s",
    (description) => expect(inferContextTags(description)).toEqual([]),
  );
});
describe("meal rules", () => {
  it.each(["牛肉麵", "炒麵", "排骨便當", "雞肉飯"])(
    "considers %s a full meal",
    (description) => {
      expect(isMealEligibleDescription(description)).toBe(true);
    },
  );

  it.each(["咖啡", "珍珠奶茶", "飲料", "甜點", "點心"])(
    "conservatively excludes %s from automatic meals",
    (description) => {
      expect(isMealEligibleDescription(description)).toBe(false);
    },
  );

  it.each([
    ["04:59", null],
    ["05:00", "breakfast"],
    ["10:59", "breakfast"],
    ["11:00", "lunch"],
    ["14:59", "lunch"],
    ["15:00", null],
    ["16:59", null],
    ["17:00", "dinner"],
    ["21:59", "dinner"],
    ["22:00", null],
  ] as const)("maps boundary %s to %s", (time, expected) => {
    expect(inferMeal("牛肉麵", "food", time)?.code ?? null).toBe(expected);
  });

  it("requires food category, an exact time, and eligible description", () => {
    expect(inferMeal("牛肉麵", "transport", "12:10")).toBeNull();
    expect(inferMeal("牛肉麵", "food", null)).toBeNull();
    expect(inferMeal("咖啡", "food", "12:10")).toBeNull();
  });
});
