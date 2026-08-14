import {
  compareCalendarMinute,
  isValidTimeToken,
  parseAbsoluteDateToken,
  shiftCalendarDate,
  toInstantIso,
  toZonedMinute,
  zonedLocalMinuteToInstant,
} from "./date-time.js";
import {
  CATEGORY_BY_DISPLAY_NAME,
  MEAL_BY_DISPLAY_NAME,
  MEAL_DISPLAY_NAMES,
  RULE_VERSION,
  classifyDescription,
  inferContextTags,
  inferMeal,
  makeCategoryAssignment,
  makeMealAssignment,
} from "./rules.js";
import type {
  CategoryCode,
  CustomTagAssignment,
  ExpenseParseError,
  ExpenseParseErrorCode,
  ExpenseScope,
  MealCode,
  OccurredDateSource,
  ParseExpenseOptions,
  ParseExpenseResult,
} from "./types.js";

const DEFAULT_TIMEZONE = "Asia/Taipei";
const DEFAULT_SCOPE: ExpenseScope = "shared";
const MAX_DESCRIPTION_LENGTH = 50;
const MAX_CUSTOM_TAGS = 10;
const MAX_CUSTOM_TAG_LENGTH = 20;

const ALWAYS_RESERVED_COMMANDS = new Set([
  "說明",
  "分類",
  "標籤",
  "查",
  "最近",
  "本月",
  "改",
  "加",
  "移除",
  "取消",
  "還原",
  "新增分類",
  "刪除分類",
]);

interface AmountAndBody {
  readonly amountMinor: number;
  readonly body: string;
}

interface ExtractedHashtags {
  readonly body: string;
  readonly hashtags: readonly string[];
}

interface ParsedHashtags {
  readonly category: CategoryCode | null;
  readonly meal: MealCode | null;
  readonly customTags: readonly CustomTagAssignment[];
}

interface PrefixState {
  readonly description: string;
  readonly scope: ExpenseScope;
  readonly occurredOn: string;
  readonly occurredAt: string | null;
  readonly occurredTime: string | null;
  readonly occurredDateSource: OccurredDateSource;
  readonly occurredTimeSource: "line_event" | "explicit_input" | null;
  readonly occurredTimePrecision: "unknown" | "minute" | "millisecond";
  readonly explicitMeal: MealCode | null;
  readonly explicitMealDisplay: string | null;
  readonly allowFuture: boolean;
}

type LocalResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExpenseParseError };

/**
 * Parses one create-expense message without I/O or database state.
 *
 * The caller must dispatch system/query/update/delete commands before using
 * this function. As a safety net, reserved command prefixes return
 * RESERVED_COMMAND and can never fall through into a new expense.
 */
export function parseExpenseMessage(
  input: string,
  options: ParseExpenseOptions,
): ParseExpenseResult {
  const text = normalizeMessage(input);
  if (text.length === 0) {
    return failure("EMPTY_MESSAGE", "請輸入項目與金額。");
  }

  if (isReservedCommandCandidate(text)) {
    return failure(
      "RESERVED_COMMAND",
      "這是保留指令，不會當作新支出。",
    );
  }

  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const eventInstant = toInstantIso(options.eventTimestamp);
  const eventMinute =
    eventInstant === null ? null : toZonedMinute(eventInstant, timezone);
  if (eventMinute === null || eventInstant === null) {
    return failure(
      "INVALID_EVENT_TIMESTAMP",
      "LINE 事件時間或帳本時區無效。",
    );
  }

  const extractedTags = extractHashtags(text);
  if (!extractedTags.ok) {
    return extractedTags;
  }

  const parsedTags = parseHashtags(extractedTags.value.hashtags);
  if (!parsedTags.ok) {
    return parsedTags;
  }

  const amountAndBody = parseAmountAndBody(extractedTags.value.body);
  if (!amountAndBody.ok) {
    return amountAndBody;
  }

  const prefixState = parsePrefixes(
    amountAndBody.value.body,
    eventMinute.date,
    eventMinute.time,
    eventInstant,
    timezone,
    options.defaultScope ?? DEFAULT_SCOPE,
  );
  if (!prefixState.ok) {
    return prefixState;
  }

  const state = prefixState.value;
  const description = normalizeDescription(state.description);
  if (description.length === 0) {
    return failure("DESCRIPTION_REQUIRED", "請提供支出項目。");
  }

  if (codePointLength(description) > MAX_DESCRIPTION_LENGTH) {
    return failure(
      "DESCRIPTION_TOO_LONG",
      `項目最多 ${MAX_DESCRIPTION_LENGTH} 個字元。`,
    );
  }

  if (state.occurredOn > eventMinute.date && !state.allowFuture) {
    return failure("FUTURE_DATE", "不能記錄未來日期；若是預訂或預付支出，請在最前面加「作弊」。");
  }

  if (
    state.occurredTime !== null &&
    compareCalendarMinute(
      state.occurredOn,
      state.occurredTime,
      eventMinute.date,
      eventMinute.time,
    ) > 0 && !state.allowFuture
  ) {
    return failure("FUTURE_TIME", "不能記錄未來時間。");
  }

  const tagMeal = parsedTags.value.meal;
  if (
    state.explicitMeal !== null &&
    tagMeal !== null &&
    state.explicitMeal !== tagMeal
  ) {
    return failure(
      "CONFLICTING_MEAL",
      "一筆支出只能有一個餐別。",
    );
  }

  const explicitMeal = state.explicitMeal ?? tagMeal;
  const explicitCategory = parsedTags.value.category;
  if (
    explicitMeal !== null &&
    explicitCategory !== null &&
    explicitCategory !== "food"
  ) {
    return failure(
      "MEAL_CATEGORY_CONFLICT",
      "餐別只能用於食物分類。",
    );
  }

  const category =
    explicitCategory !== null
      ? makeCategoryAssignment(
          explicitCategory,
          "explicit",
          "parser:reserved_hashtag",
        )
      : explicitMeal !== null
        ? makeCategoryAssignment(
            "food",
            "explicit",
            "parser:explicit_meal_implies_food",
          )
        : classifyDescription(description);

  const meal =
    explicitMeal !== null
      ? makeMealAssignment(
          explicitMeal,
          "explicit",
          state.explicitMeal !== null
            ? "parser:meal_prefix"
            : "parser:reserved_hashtag",
        )
      : inferMeal(description, category.code, state.occurredTime);

  const customTagsByName = new Map(
    parsedTags.value.customTags.map((tag) => [tag.normalizedName, tag] as const),
  );
  for (const inferredTag of inferContextTags(description)) {
    if (!customTagsByName.has(inferredTag.normalizedName) && customTagsByName.size < MAX_CUSTOM_TAGS) {
      customTagsByName.set(inferredTag.normalizedName, inferredTag);
    }
  }
  const customTags = [...customTagsByName.values()];

  const tags = [
    category,
    ...(meal === null ? [] : [meal]),
    ...customTags,
  ];

  return {
    ok: true,
    value: {
      description,
      amountMinor: amountAndBody.value.amountMinor,
      currency: "TWD",
      scope: state.scope,
      occurredOn: state.occurredOn,
      occurredAt: state.occurredAt,
      occurredTime: state.occurredTime,
      occurredDateSource: state.occurredDateSource,
      occurredTimeSource: state.occurredTimeSource,
      occurredTimePrecision: state.occurredTimePrecision,
      category,
      meal,
      customTags,
      tags,
    },
  };
}

export function isReservedCommandCandidate(input: string): boolean {
  const text = normalizeMessage(input);
  const firstToken = text.split(/\s/u)[0] ?? "";

  if (ALWAYS_RESERVED_COMMANDS.has(firstToken)) {
    return true;
  }

  // 今天 and 昨天 are both exact read commands and valid create prefixes.
  return (text === "今天" || text === "昨天");
}

function extractHashtags(text: string): LocalResult<ExtractedHashtags> {
  const bodyTokens: string[] = [];
  const hashtags: string[] = [];

  for (const token of text.split(/\s+/u)) {
    if (token.startsWith("#")) {
      const value = token.slice(1);
      if (value.length === 0 || value.includes("#")) {
        return failure(
          "INVALID_TAG",
          "自訂標籤需為 1–20 個字元，且不能含空白或 #。",
        );
      }
      hashtags.push(value);
      continue;
    }

    if (token.includes("#")) {
      return failure(
        "INVALID_TAG",
        "#標籤前請留一個空格，標籤內不能含 #。",
      );
    }

    bodyTokens.push(token);
  }

  return {
    ok: true,
    value: { body: bodyTokens.join(" "), hashtags },
  };
}

function parseHashtags(hashtags: readonly string[]): LocalResult<ParsedHashtags> {
  let category: CategoryCode | null = null;
  let meal: MealCode | null = null;
  const customByNormalizedName = new Map<string, CustomTagAssignment>();

  for (const rawName of hashtags) {
    const displayName = rawName.normalize("NFKC");
    if (
      codePointLength(displayName) < 1 ||
      codePointLength(displayName) > MAX_CUSTOM_TAG_LENGTH ||
      /[\s#]/u.test(displayName)
    ) {
      return failure(
        "INVALID_TAG",
        "自訂標籤需為 1–20 個字元，且不能含空白或 #。",
      );
    }

    const reservedCategory = CATEGORY_BY_DISPLAY_NAME[displayName];
    if (reservedCategory !== undefined) {
      if (category !== null && category !== reservedCategory) {
        return failure(
          "CONFLICTING_CATEGORY",
          "一筆支出只能有一個分類。",
        );
      }
      category = reservedCategory;
      continue;
    }

    const reservedMeal = MEAL_BY_DISPLAY_NAME[displayName];
    if (reservedMeal !== undefined) {
      if (meal !== null && meal !== reservedMeal) {
        return failure(
          "CONFLICTING_MEAL",
          "一筆支出只能有一個餐別。",
        );
      }
      meal = reservedMeal;
      continue;
    }

    const normalizedName = normalizeTagName(displayName);
    if (!customByNormalizedName.has(normalizedName)) {
      customByNormalizedName.set(normalizedName, {
        type: "custom",
        displayName,
        normalizedName,
        source: "explicit",
        ruleKey: "parser:user_hashtag",
        ruleVersion: RULE_VERSION,
      });
    }
  }

  if (customByNormalizedName.size > MAX_CUSTOM_TAGS) {
    return failure(
      "TOO_MANY_CUSTOM_TAGS",
      `每筆最多 ${MAX_CUSTOM_TAGS} 個自訂標籤。`,
    );
  }

  return {
    ok: true,
    value: {
      category,
      meal,
      customTags: [...customByNormalizedName.values()],
    },
  };
}

function parseAmountAndBody(text: string): LocalResult<AmountAndBody> {
  const value = text.trim();
  if (value.length === 0) {
    return failure(
      "INVALID_FORMAT",
      "格式範例：牛肉麵 150 #約會。",
    );
  }

  const separated = /^(.*\S)\s+(\S+)$/u.exec(value);
  if (separated) {
    const parsedAmount = parseAmountToken(separated[2]!);
    if (parsedAmount !== null) {
      return parsedAmountResult(parsedAmount, separated[1]!);
    }

    if (looksLikeAmountToken(separated[2]!)) {
      return invalidAmount();
    }

    return failure(
      "INVALID_FORMAT",
      "金額必須位於訊息主體最後。",
    );
  }

  const amountOnly = parseAmountToken(value);
  if (amountOnly !== null) {
    return parsedAmountResult(amountOnly, "");
  }

  if (/[-+](?:NT\$|\$)?\d[\d,.]*(?:元)?$/u.test(value)) {
    return invalidAmount();
  }

  const numericTail = /([\d,.]+)(?:元)?$/u.exec(value)?.[1];
  if (numericTail && !isValidGroupedDigits(numericTail)) {
    return invalidAmount();
  }

  const currencyJoined = /^(.+?)((?:NT\$|\$)(?:\d{1,3}(?:,\d{3})+|\d+)(?:元)?)$/u.exec(
    value,
  );
  if (currencyJoined) {
    const amount = parseAmountToken(currencyJoined[2]!);
    if (amount !== null) {
      return parsedAmountResult(amount, currencyJoined[1]!);
    }
  }

  const joined = /^(.+?\D)((?:\d{1,3}(?:,\d{3})+|\d+)(?:元)?)$/u.exec(
    value,
  );
  if (joined) {
    const descriptionCandidate = joined[1]!;
    // Joined bare digits are useful for common Chinese expense names, but a
    // Latin/model suffix such as iPhone15 is ambiguous. Require a separating
    // space in that case; explicit $/NT$ remains unambiguous above.
    if (!/[㐀-鿿豈-﫿]$/u.test(descriptionCandidate)) {
      return failure(
        "AMBIGUOUS_AMOUNT",
        "尾端數字無法確定是項目或金額，請在金額前留空格。",
      );
    }
    const amount = parseAmountToken(joined[2]!);
    if (amount !== null) {
      return parsedAmountResult(amount, joined[1]!);
    }
  }

  if (/\d$/u.test(value)) {
    return failure(
      "AMBIGUOUS_AMOUNT",
      "尾端數字無法確定是項目或金額，請在金額前留空格。",
    );
  }

  return failure(
    "INVALID_FORMAT",
    "格式範例：牛肉麵 150 #約會。",
  );
}

function parsedAmountResult(
  amountMinor: number,
  body: string,
): LocalResult<AmountAndBody> {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0
  ) {
    return invalidAmount();
  }

  return { ok: true, value: { amountMinor, body: body.trim() } };
}

function parseAmountToken(token: string): number | null {
  const match = /^(?:NT\$|\$)?((?:\d{1,3}(?:,\d{3})+|\d+))(?:元)?$/u.exec(
    token,
  );
  if (!match) {
    return null;
  }

  return Number(match[1]!.replaceAll(",", ""));
}

function looksLikeAmountToken(token: string): boolean {
  return /^[+-]?(?:NT\$|\$)?[\d,.]+(?:元)?$/u.test(token);
}

function isValidGroupedDigits(value: string): boolean {
  return /^(?:\d{1,3}(?:,\d{3})+|\d+)$/u.test(value);
}

function parsePrefixes(
  body: string,
  eventDate: string,
  eventTime: string,
  eventInstant: string,
  timezone: string,
  defaultScope: ExpenseScope,
): LocalResult<PrefixState> {
  const tokens = body.length === 0 ? [] : body.split(/\s+/u).flatMap(expandCompoundTimePrefix);
  let cursor = 0;
  let scope: ExpenseScope = defaultScope;
  let scopeSeen = false;
  let dateSeen = false;
  let occurredOn = eventDate;
  let occurredDateSource: OccurredDateSource = "line_event";
  let timeSeen = false;
  let occurredTime: string | null = null;
  let explicitMeal: MealCode | null = null;
  let explicitMealDisplay: string | null = null;
  let mealPrefixSeen = false;
  let allowFuture = false;

  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token === undefined) {
      break;
    }

    if (token === "作弊") {
      if (allowFuture) {
        return failure("INVALID_FORMAT", "「作弊」前綴只能出現一次。");
      }
      allowFuture = true;
      cursor += 1;
      continue;
    }

    const parsedScope = parseScope(token);
    if (parsedScope !== null) {
      if (scopeSeen) {
        return parsedScope === scope
          ? failure("DUPLICATE_SCOPE", "範圍前綴只能出現一次。")
          : failure(
              "CONFLICTING_SCOPE",
              "不能同時指定共同與個人範圍。",
            );
      }
      scope = parsedScope;
      scopeSeen = true;
      cursor += 1;
      continue;
    }

    const relativeDayDelta = parseRelativeDate(token);
    if (relativeDayDelta !== null) {
      if (dateSeen) {
        return failure("DUPLICATE_DATE", "日期前綴只能出現一次。");
      }
      occurredOn = shiftCalendarDate(eventDate, relativeDayDelta);
      occurredDateSource = "relative_input";
      dateSeen = true;
      cursor += 1;
      continue;
    }

    if (/^\d{1,2}\/\d{1,2}$/u.test(token)) {
      return failure(
        "YEAR_REQUIRED",
        "日期請使用含年份的 YYYY/M/D 或 YYYY-MM-DD。",
      );
    }

    if (/^\d{4}[/-]/u.test(token)) {
      if (dateSeen) {
        return failure("DUPLICATE_DATE", "日期前綴只能出現一次。");
      }
      const parsedDate = parseAbsoluteDateToken(token);
      if (parsedDate === null) {
        return failure("INVALID_DATE", "日期格式或日期無效。");
      }
      occurredOn = parsedDate;
      occurredDateSource = "absolute_input";
      dateSeen = true;
      cursor += 1;
      continue;
    }

    if (/^\d{1,2}:\d{1,2}$/u.test(token)) {
      if (timeSeen) {
        return failure("DUPLICATE_TIME", "時間前綴只能出現一次。");
      }
      if (!isValidTimeToken(token)) {
        return failure(
          "INVALID_TIME",
          "時間請使用 24 小時制 HH:mm。",
        );
      }
      occurredTime = token;
      timeSeen = true;
      cursor += 1;
      continue;
    }

    const mealCode = parseMealPrefix(token);
    if (mealCode !== null) {
      if (mealPrefixSeen) {
        return mealCode === explicitMeal
          ? failure("DUPLICATE_MEAL", "餐別前綴只能出現一次。")
          : failure(
              "CONFLICTING_MEAL",
              "一筆支出只能有一個餐別。",
            );
      }
      explicitMeal = mealCode;
      explicitMealDisplay = MEAL_DISPLAY_NAMES[mealCode];
      mealPrefixSeen = true;
      cursor += 1;
      continue;
    }

    break;
  }

  // A date prefix deliberately removes precision unless an explicit time was
  // supplied. Without a date prefix, the LINE event minute is authoritative.
  if (!timeSeen) {
    occurredTime = dateSeen ? null : eventTime;
  }

  const occurredAt = timeSeen
    ? zonedLocalMinuteToInstant(occurredOn, occurredTime!, timezone)
    : dateSeen
      ? null
      : eventInstant;
  if (timeSeen && occurredAt === null) {
    return failure(
      "INVALID_TIME",
      "這個當地時間不存在，請換一個時間。",
    );
  }

  const remaining = tokens.slice(cursor).join(" ");
  const description =
    remaining.length === 0 && explicitMealDisplay !== null
      ? explicitMealDisplay
      : remaining;

  return {
    ok: true,
    value: {
      description,
      scope,
      occurredOn,
      occurredAt,
      occurredTime,
      occurredDateSource,
      occurredTimeSource: timeSeen
        ? "explicit_input"
        : dateSeen
          ? null
          : "line_event",
      occurredTimePrecision: timeSeen
        ? "minute"
        : dateSeen
          ? "unknown"
          : "millisecond",
      explicitMeal,
      explicitMealDisplay,
      allowFuture,
    },
  };
}

function parseScope(token: string): ExpenseScope | null {
  if (token === "共同") {
    return "shared";
  }
  if (token === "個人") {
    return "personal";
  }
  return null;
}

function parseRelativeDate(token: string): number | null {
  if (token === "今天" || token === "今日") {
    return 0;
  }
  if (token === "昨天" || token === "昨日") {
    return -1;
  }
  if (token === "前天") {
    return -2;
  }
  if (token === "明天") {
    return 1;
  }
  if (token === "後天") {
    return 2;
  }
  return null;
}

function parseMealPrefix(token: string): MealCode | null {
  const canonical = MEAL_BY_DISPLAY_NAME[token];
  if (canonical !== undefined) return canonical;
  if (["早", "早上", "早晨", "上午"].includes(token)) return "breakfast";
  if (["中", "中午", "午", "正午"].includes(token)) return "lunch";
  if (["晚", "晚上", "晚間", "傍晚"].includes(token)) return "dinner";
  return null;
}

function expandCompoundTimePrefix(token: string): readonly string[] {
  const dateAndPeriod = /^(今天|今日|昨天|昨日|前天)(早上|早晨|上午|中午|正午|晚上|晚間|傍晚|早|中|午|晚)$/u.exec(token);
  if (dateAndPeriod) return [dateAndPeriod[1]!, dateAndPeriod[2]!];
  const dateAndTime = /^(今天|今日|昨天|昨日|前天)(\d{1,2}:\d{2})$/u.exec(token);
  if (dateAndTime) return [dateAndTime[1]!, dateAndTime[2]!];
  const short = /^(今早|今午|今晚|昨早|昨午|昨晚)$/u.exec(token)?.[1];
  if (short !== undefined) {
    return [short.startsWith("今") ? "今天" : "昨天", short.endsWith("早") ? "早" : short.endsWith("午") ? "中" : "晚"];
  }
  return [token];
}

function normalizeMessage(input: string): string {
  return input.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function normalizeDescription(input: string): string {
  return input.trim().replace(/\s+/gu, " ");
}

function normalizeTagName(input: string): string {
  return input.normalize("NFKC").toLocaleLowerCase("en-US");
}

function codePointLength(input: string): number {
  return Array.from(input).length;
}

function invalidAmount(): LocalResult<never> {
  return failure(
    "INVALID_AMOUNT",
    "金額必須是大於 0 的整數。",
  );
}

function failure(
  code: ExpenseParseErrorCode,
  message: string,
): LocalResult<never> {
  return { ok: false, error: { code, message } };
}
