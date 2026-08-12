import type {
  AssignmentSource,
  CategoryAssignment,
  CategoryCode,
  MealAssignment,
  MealCode,
} from "./types.js";

export const RULE_VERSION = "1";

export const CATEGORY_DISPLAY_NAMES: Readonly<Record<CategoryCode, string>> = {
  food: "食物",
  transport: "交通",
  entertainment: "娛樂",
  household: "居家",
  shopping: "購物",
  health: "醫療健康",
  travel: "旅遊",
  uncategorized: "未分類",
};

export const MEAL_DISPLAY_NAMES: Readonly<Record<MealCode, string>> = {
  breakfast: "早餐",
  lunch: "午餐",
  afternoon_tea: "下午茶",
  dinner: "晚餐",
  late_night: "宵夜",
};

export const CATEGORY_BY_DISPLAY_NAME = invertRecord(CATEGORY_DISPLAY_NAMES);
export const MEAL_BY_DISPLAY_NAME = invertRecord(MEAL_DISPLAY_NAMES);

interface CategoryRule {
  readonly key: string;
  readonly category: Exclude<CategoryCode, "uncategorized">;
  readonly keyword: string;
  readonly priority: number;
}

const CATEGORY_RULES: readonly CategoryRule[] = [
  // Specific travel terms intentionally outrank the one-character food rule
  // for 「飯」. Matching still applies longest keyword first globally.
  categoryRule("travel.hotel", "travel", "飯店", 100),
  categoryRule("travel.airfare", "travel", "機票", 90),
  categoryRule("travel.lodging", "travel", "住宿", 90),
  categoryRule("travel.hostel", "travel", "民宿", 90),
  categoryRule("travel.inn", "travel", "旅館", 90),

  categoryRule("transport.taxi", "transport", "計程車", 80),
  categoryRule("transport.metro", "transport", "捷運", 70),
  categoryRule("transport.bus", "transport", "公車", 70),
  categoryRule("transport.uber", "transport", "uber", 70),
  categoryRule("transport.fuel", "transport", "加油", 70),
  categoryRule("transport.parking", "transport", "停車", 70),
  categoryRule("transport.hsr", "transport", "高鐵", 70),
  categoryRule("transport.train", "transport", "火車", 70),

  categoryRule("entertainment.concert", "entertainment", "演唱會", 80),
  categoryRule("entertainment.movie", "entertainment", "電影", 70),
  categoryRule("entertainment.ktv", "entertainment", "ktv", 70),
  categoryRule("entertainment.game", "entertainment", "遊戲", 70),
  categoryRule("entertainment.exhibition", "entertainment", "展覽", 70),

  categoryRule("household.rent", "household", "房租", 70),
  categoryRule("household.water", "household", "水費", 70),
  categoryRule("household.electricity", "household", "電費", 70),
  categoryRule("household.internet", "household", "網路", 60),
  categoryRule("household.supplies", "household", "日用品", 70),

  categoryRule("shopping.clothes", "shopping", "衣服", 70),
  categoryRule("shopping.shoes", "shopping", "鞋", 50),
  categoryRule("shopping.bag", "shopping", "包", 40),
  categoryRule("shopping.online", "shopping", "網購", 70),

  categoryRule("health.doctor", "health", "看診", 70),
  categoryRule("health.dentist", "health", "牙醫", 70),
  categoryRule("health.fitness", "health", "健身", 70),
  categoryRule("health.medicine", "health", "藥", 50),

  categoryRule("food.beef_noodle", "food", "牛肉麵", 90),
  categoryRule("food.fried_noodle", "food", "炒麵", 80),
  categoryRule("food.lunchbox", "food", "便當", 80),
  categoryRule("food.breakfast", "food", "早餐", 70),
  categoryRule("food.lunch", "food", "午餐", 70),
  categoryRule("food.dinner", "food", "晚餐", 70),
  categoryRule("food.coffee", "food", "咖啡", 70),
  categoryRule("food.milk_tea", "food", "奶茶", 70),
  categoryRule("food.drink", "food", "飲料", 70),
  categoryRule("food.dessert", "food", "甜點", 70),
  categoryRule("food.snack", "food", "點心", 70),
  categoryRule("food.noodle", "food", "麵", 30),
  categoryRule("food.rice", "food", "飯", 20),
  categoryRule("food.tea", "food", "茶", 10),
];

const MEAL_ELIGIBLE_TERMS = [
  "牛肉麵",
  "炒麵",
  "便當",
  "早餐",
  "午餐",
  "晚餐",
  "麵",
  "飯",
] as const;

const MEAL_INELIGIBLE_TERMS = [
  "咖啡",
  "奶茶",
  "茶",
  "飲料",
  "甜點",
  "點心",
] as const;

export function makeCategoryAssignment(
  code: CategoryCode,
  source: AssignmentSource,
  ruleKey: string,
): CategoryAssignment {
  return {
    type: "category",
    code,
    displayName: CATEGORY_DISPLAY_NAMES[code],
    source,
    ruleKey,
    ruleVersion: RULE_VERSION,
  };
}

export function makeMealAssignment(
  code: MealCode,
  source: AssignmentSource,
  ruleKey: string,
): MealAssignment {
  return {
    type: "meal",
    code,
    displayName: MEAL_DISPLAY_NAMES[code],
    source,
    ruleKey,
    ruleVersion: RULE_VERSION,
  };
}

/** Deterministic category classifier: longest match, then explicit priority. */
export function classifyDescription(description: string): CategoryAssignment {
  const normalized = description.normalize("NFKC").toLocaleLowerCase("en-US");
  const matches = CATEGORY_RULES.filter((rule) =>
    normalized.includes(rule.keyword.toLocaleLowerCase("en-US")),
  );

  if (matches.length === 0) {
    return makeCategoryAssignment(
      "uncategorized",
      "inferred",
      "category:uncategorized",
    );
  }

  const longest = Math.max(...matches.map((rule) => codePointLength(rule.keyword)));
  const longestMatches = matches.filter(
    (rule) => codePointLength(rule.keyword) === longest,
  );
  const highestPriority = Math.max(
    ...longestMatches.map((rule) => rule.priority),
  );
  const winners = longestMatches.filter(
    (rule) => rule.priority === highestPriority,
  );
  const winningCategories = new Set(winners.map((rule) => rule.category));

  if (winningCategories.size !== 1) {
    return makeCategoryAssignment(
      "uncategorized",
      "inferred",
      "category:ambiguous",
    );
  }

  const winner = winners[0]!;
  return makeCategoryAssignment(
    winner.category,
    "inferred",
    `category:${winner.key}`,
  );
}

export function isMealEligibleDescription(description: string): boolean {
  const normalized = description.normalize("NFKC").toLocaleLowerCase("en-US");

  if (MEAL_INELIGIBLE_TERMS.some((term) => normalized.includes(term))) {
    return false;
  }

  return MEAL_ELIGIBLE_TERMS.some((term) => normalized.includes(term));
}

/**
 * Infers only the three MVP automatic meal windows. Afternoon tea and late
 * night remain explicit-only labels.
 */
export function inferMeal(
  description: string,
  category: CategoryCode,
  occurredTime: string | null,
): MealAssignment | null {
  if (
    category !== "food" ||
    occurredTime === null ||
    !isMealEligibleDescription(description)
  ) {
    return null;
  }

  const minuteOfDay = timeToMinute(occurredTime);
  if (minuteOfDay === null) {
    return null;
  }

  if (minuteOfDay >= 5 * 60 && minuteOfDay <= 10 * 60 + 59) {
    return makeMealAssignment(
      "breakfast",
      "inferred",
      "meal:breakfast.window",
    );
  }

  if (minuteOfDay >= 11 * 60 && minuteOfDay <= 14 * 60 + 59) {
    return makeMealAssignment("lunch", "inferred", "meal:lunch.window");
  }

  if (minuteOfDay >= 17 * 60 && minuteOfDay <= 21 * 60 + 59) {
    return makeMealAssignment("dinner", "inferred", "meal:dinner.window");
  }

  return null;
}

function categoryRule(
  key: string,
  category: Exclude<CategoryCode, "uncategorized">,
  keyword: string,
  priority: number,
): CategoryRule {
  return { key, category, keyword, priority };
}

function invertRecord<T extends string>(
  record: Readonly<Record<T, string>>,
): Readonly<Record<string, T>> {
  return Object.fromEntries(
    Object.entries(record).map(([code, displayName]) => [displayName, code]),
  ) as Record<string, T>;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function timeToMinute(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(time);
  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }

  return hour * 60 + minute;
}
