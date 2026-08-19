import type { ExpenseParseError, ParsedExpense } from "../domain/index.js";

export interface SavedExpenseReplyData {
  readonly publicId: string;
  readonly expense: ParsedExpense;
  readonly payerDisplayName: string;
}

export interface LineTextReplyPayload {
  readonly messages: readonly [{ readonly type: "text"; readonly text: string }];
}

/** Formats the value that was actually committed, rather than echoing input. */
export function formatSavedExpenseReply(data: SavedExpenseReplyData): string {
  const { expense } = data;
  const scope = expense.scope === "shared" ? "共同" : "個人";
  const labels = [
    expense.category.displayName,
    ...(expense.meal === null
      ? []
      : [
          expense.meal.source === "inferred"
            ? `${expense.meal.displayName}（自動）`
            : expense.meal.displayName,
        ]),
    ...expense.customTags.map((tag) => tag.source === "inferred" ? `${tag.displayName}（自動）` : tag.displayName),
  ];
  const date = expense.occurredOn.replaceAll("-", "/");
  const occurred =
    expense.occurredTime === null
      ? `${date}（時間未指定）`
      : `${date} ${expense.occurredTime}`;

  return [
    `已記帳 #${data.publicId}`,
    `${scope}｜${expense.description}｜${formatTwd(expense.amountMinor)}`,
    `標籤：${labels.join("・")}`,
    `時間：${occurred}`,
    `付款：${data.payerDisplayName}`,
  ].join("\n");
}

export function formatExpenseParseErrorReply(error: ExpenseParseError): string {
  return [
    error.message,
    "基本格式：牛肉麵 150",
    "可選補充：昨天、22:00、午餐、共同、對方付、#約會",
  ].join("\n");
}

export function lineTextReply(text: string): LineTextReplyPayload {
  return { messages: [{ type: "text", text }] };
}

function formatTwd(amountMinor: number): string {
  return `${new Intl.NumberFormat("zh-TW").format(amountMinor)} 元`;
}
