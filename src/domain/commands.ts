import {
  CATEGORY_BY_DISPLAY_NAME,
  MEAL_BY_DISPLAY_NAME,
} from "./rules.js";
import type { CategoryCode, MealCode } from "./types.js";

export type LedgerCommand =
  | { readonly kind: "detail"; readonly publicId: string }
  | { readonly kind: "recent"; readonly limit: number }
  | { readonly kind: "period"; readonly period: "today" | "yesterday" | "week" | "last_week" | "month" | "last_month"; readonly filter: CommandFilter }
  | { readonly kind: "search"; readonly keyword: string }
  | { readonly kind: "ranking" }
  | { readonly kind: "mode"; readonly scope: "shared" | "personal" | null }
  | { readonly kind: "update"; readonly publicId: string; readonly change: UpdateChange }
  | { readonly kind: "tags"; readonly operation: "add" | "remove"; readonly publicId: string; readonly tags: readonly string[] }
  | { readonly kind: "void" | "restore"; readonly publicId: string }
  | { readonly kind: "help" | "categories" | "tags_help" };

export type CommandFilter =
  | { readonly kind: "all" }
  | { readonly kind: "shared" }
  | { readonly kind: "personal" }
  | { readonly kind: "tag"; readonly name: string };

export type UpdateChange =
  | { readonly field: "description"; readonly value: string }
  | { readonly field: "amount"; readonly value: number }
  | { readonly field: "category"; readonly value: CategoryCode | "auto" }
  | { readonly field: "meal"; readonly value: MealCode | "auto" | "none" }
  | { readonly field: "scope"; readonly value: "shared" | "personal" }
  | { readonly field: "payer" | "owner"; readonly value: string }
  | { readonly field: "date"; readonly value: string }
  | { readonly field: "time"; readonly value: string | null };

export type ParseLedgerCommandResult =
  | { readonly kind: "command"; readonly command: LedgerCommand }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "not_command" };

const PUBLIC_ID = "([0-9A-HJKMNP-TV-Z]{8,})";
const MAX_DESCRIPTION_LENGTH = 50;
const MAX_TAGS = 10;

/** Parses the reserved command language before create-expense parsing. */
export function parseLedgerCommand(input: string): ParseLedgerCommandResult {
  const text = input.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (text === "說明" || text === "幫助" || text === "help") return command({ kind: "help" });
  if (text === "分類") return command({ kind: "categories" });
  if (text === "標籤") return command({ kind: "tags_help" });

  let match = new RegExp(`^查 #${PUBLIC_ID}$`, "iu").exec(text);
  if (match) return command({ kind: "detail", publicId: match[1]!.toUpperCase() });

  match = /^最近(?: (\S+))?$/u.exec(text);
  if (match) {
    const raw = match[1];
    const limit = raw === undefined ? 10 : Number(raw);
    if (!/^\d+$/u.test(raw ?? "10") || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      return invalid("最近筆數必須是 1 到 20。範例：最近 5");
    }
    return command({ kind: "recent", limit });
  }

  match = /^(找|搜尋)(?: (.+))?$/u.exec(text);
  if (match) {
    const keyword = match[2]?.trim() ?? "";
    if (keyword.length === 0 || [...keyword].length > 30) return invalid("搜尋關鍵字必須是 1 到 30 個字。範例：找 牛肉麵");
    return command({ kind: "search", keyword });
  }

  if (text === "排行" || text === "分類排行") return command({ kind: "ranking" });
  if (text === "目前模式") return command({ kind: "mode", scope: null });
  if (text === "切換共同模式" || text === "共同模式") return command({ kind: "mode", scope: "shared" });
  if (text === "切換個人模式" || text === "個人模式") return command({ kind: "mode", scope: "personal" });

  match = /^(今天|今日|昨天|週報|這週|本週|上週|本月|月報|上月)(?: (\S+))?$/u.exec(text);
  if (match) {
    const filter = parseFilter(match[2]);
    if (filter === null) return invalid("查詢篩選可用：共同、個人或 #標籤。");
    const periodByLabel = {
      今天: "today", 今日: "today", 昨天: "yesterday",
      週報: "week", 這週: "week", 本週: "week", 上週: "last_week",
      本月: "month", 月報: "month", 上月: "last_month",
    } as const;
    return command({
      kind: "period",
      period: periodByLabel[match[1] as keyof typeof periodByLabel],
      filter,
    });
  }

  match = new RegExp(`^(取消|還原) #${PUBLIC_ID}$`, "iu").exec(text);
  if (match) return command({ kind: match[1] === "取消" ? "void" : "restore", publicId: match[2]!.toUpperCase() });

  match = new RegExp(`^(加|移除) #${PUBLIC_ID} 標籤(?: (.+))?$`, "iu").exec(text);
  if (match) {
    const tags = parseCustomTags(match[3] ?? "");
    if (typeof tags === "string") return invalid(tags);
    return command({ kind: "tags", operation: match[1] === "加" ? "add" : "remove", publicId: match[2]!.toUpperCase(), tags });
  }

  match = new RegExp(`^改 #${PUBLIC_ID} (項目|金額|分類|餐別|範圍|付款人|所有人|日期|時間)(?: (.*))?$`, "iu").exec(text);
  if (match) {
    const change = parseChange(match[2]!, match[3]?.trim() ?? "");
    if (typeof change === "string") return invalid(change);
    return command({ kind: "update", publicId: match[1]!.toUpperCase(), change });
  }

  // 今天／昨天 are also valid create prefixes (for example
  // 「昨天 牛肉麵 150」), so only their fully matched query forms above are
  // commands. Other reserved verbs must never fall through to create.
  if (/^(?:查|最近|找|搜尋|排行|分類排行|目前模式|切換共同模式|切換個人模式|共同模式|個人模式|切換|今日|週報|這週|本週|上週|本月|月報|上月|改|加|移除|取消|還原|說明|幫助|help|分類|標籤|新增分類|刪除分類)(?:\s|$)/iu.test(text)) {
    if (/^(?:新增分類|刪除分類)(?:\s|$)/u.test(text)) {
      return invalid("目前分類是固定清單，不支援新增或刪除分類。");
    }
    return invalid("指令格式不正確。傳送「說明」查看範例。");
  }
  return { kind: "not_command" };
}

function parseFilter(raw: string | undefined): CommandFilter | null {
  if (raw === undefined) return { kind: "all" };
  if (raw === "共同") return { kind: "shared" };
  if (raw === "個人") return { kind: "personal" };
  if (/^#[^#\s]{1,20}$/u.test(raw)) return { kind: "tag", name: raw.slice(1).normalize("NFKC").toLocaleLowerCase("zh-TW") };
  return null;
}

function parseCustomTags(raw: string): readonly string[] | string {
  if (raw.length === 0) return "請提供至少一個 #標籤。";
  const tokens = raw.split(" ");
  if (tokens.length > MAX_TAGS || tokens.some((token) => !/^#[^#\s]{1,20}$/u.test(token))) {
    return "自訂標籤需以 # 開頭、不可含空白、每個最多 20 字，每次最多 10 個。";
  }
  return [...new Set(tokens.map((token) => token.slice(1).normalize("NFKC").toLocaleLowerCase("zh-TW")))];
}

function parseChange(field: string, raw: string): UpdateChange | string {
  if (field === "項目") {
    if (raw.length === 0 || [...raw].length > MAX_DESCRIPTION_LENGTH) return "項目必須是 1 到 50 個字。";
    return { field: "description", value: raw };
  }
  if (field === "金額") {
    if (!/^\d+$/u.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) return "金額必須是大於 0 的整數。";
    return { field: "amount", value: Number(raw) };
  }
  if (field === "分類") {
    if (raw === "自動") return { field: "category", value: "auto" };
    const value = CATEGORY_BY_DISPLAY_NAME[raw];
    if (value === undefined) return "可用分類：食物、交通、娛樂、居家、購物、醫療健康、旅遊、未分類，或自動。";
    return { field: "category", value };
  }
  if (field === "餐別") {
    if (raw === "自動") return { field: "meal", value: "auto" };
    if (raw === "無") return { field: "meal", value: "none" };
    const value = MEAL_BY_DISPLAY_NAME[raw];
    if (value === undefined) return "可用餐別：早餐、午餐、下午茶、晚餐、宵夜、自動或無。";
    return { field: "meal", value };
  }
  if (field === "範圍") {
    if (raw !== "共同" && raw !== "個人") return "範圍只能是共同或個人。";
    return { field: "scope", value: raw === "共同" ? "shared" : "personal" };
  }
  if (field === "付款人" || field === "所有人") {
    if (raw.length === 0 || [...raw].length > 50) return `${field}必須使用帳本成員名稱。`;
    return { field: field === "付款人" ? "payer" : "owner", value: raw };
  }
  if (field === "日期") {
    if (raw !== "今天" && raw !== "昨天" && !/^\d{4}([/-])\d{1,2}\1\d{1,2}$/u.test(raw)) return "日期請使用今天、昨天或 YYYY-MM-DD。";
    return { field: "date", value: raw };
  }
  if (field === "時間") {
    if (raw === "未知") return { field: "time", value: null };
    if (!/^\d{2}:\d{2}$/u.test(raw)) return "時間請使用 HH:mm，或輸入未知。";
    const hour = Number(raw.slice(0, 2));
    const minute = Number(raw.slice(3));
    if (hour > 23 || minute > 59) return "時間請使用 00:00 到 23:59。";
    return { field: "time", value: raw };
  }
  return "不支援的修改欄位。";
}

function command(commandValue: LedgerCommand): ParseLedgerCommandResult {
  return { kind: "command", command: commandValue };
}

function invalid(message: string): ParseLedgerCommandResult {
  return { kind: "invalid", message };
}
