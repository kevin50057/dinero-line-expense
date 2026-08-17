export const CATEGORY_CODES = [
  "food",
  "transport",
  "entertainment",
  "household",
  "shopping",
  "health",
  "travel",
  "uncategorized",
] as const;

export type CategoryCode = (typeof CATEGORY_CODES)[number];

export const MEAL_CODES = [
  "breakfast",
  "lunch",
  "afternoon_tea",
  "dinner",
  "late_night",
] as const;

export type MealCode = (typeof MEAL_CODES)[number];
export type ExpenseScope = "shared" | "personal";
export type AssignmentSource = "explicit" | "inferred";

export interface CategoryAssignment {
  readonly type: "category";
  readonly code: CategoryCode;
  readonly displayName: string;
  readonly source: AssignmentSource;
  readonly ruleKey: string;
  readonly ruleVersion: string;
}

export interface MealAssignment {
  readonly type: "meal";
  readonly code: MealCode;
  readonly displayName: string;
  readonly source: AssignmentSource;
  readonly ruleKey: string;
  readonly ruleVersion: string;
}

export interface ExplicitCustomTagAssignment {
  readonly type: "custom";
  readonly displayName: string;
  readonly normalizedName: string;
  readonly source: "explicit";
  readonly ruleKey: "parser:user_hashtag";
  readonly ruleVersion: string;
}

export interface InferredCustomTagAssignment {
  readonly type: "custom";
  readonly code: "native_family";
  readonly displayName: "原生家庭";
  readonly normalizedName: "原生家庭";
  readonly source: "inferred";
  readonly ruleKey: string;
  readonly ruleVersion: string;
}

export type CustomTagAssignment =
  | ExplicitCustomTagAssignment
  | InferredCustomTagAssignment;

export type TypedTag =
  | CategoryAssignment
  | MealAssignment
  | CustomTagAssignment;

export type OccurredDateSource =
  | "line_event"
  | "relative_input"
  | "absolute_input";
export type OccurredTimeSource = "line_event" | "explicit_input" | null;

export interface ParsedExpense {
  readonly description: string;
  readonly amountMinor: number;
  readonly currency: "TWD";
  readonly scope: ExpenseScope;
  readonly payer: "self" | "partner";
  /** Calendar date in the ledger timezone, formatted as YYYY-MM-DD. */
  readonly occurredOn: string;
  /** Exact UTC instant for DB timestamptz, or null when only a date is known. */
  readonly occurredAt: string | null;
  /** Wall-clock minute in the ledger timezone, formatted as HH:mm. */
  readonly occurredTime: string | null;
  readonly occurredDateSource: OccurredDateSource;
  readonly occurredTimeSource: OccurredTimeSource;
  readonly occurredTimePrecision: "unknown" | "minute" | "millisecond";
  readonly category: CategoryAssignment;
  readonly meal: MealAssignment | null;
  readonly customTags: readonly CustomTagAssignment[];
  readonly tags: readonly TypedTag[];
}

export const EXPENSE_PARSE_ERROR_CODES = [
  "EMPTY_MESSAGE",
  "RESERVED_COMMAND",
  "INVALID_FORMAT",
  "AMBIGUOUS_AMOUNT",
  "INVALID_AMOUNT",
  "DESCRIPTION_REQUIRED",
  "DESCRIPTION_TOO_LONG",
  "INVALID_DATE",
  "FUTURE_DATE",
  "YEAR_REQUIRED",
  "INVALID_TIME",
  "FUTURE_TIME",
  "DUPLICATE_DATE",
  "DUPLICATE_TIME",
  "DUPLICATE_SCOPE",
  "CONFLICTING_SCOPE",
  "DUPLICATE_MEAL",
  "CONFLICTING_MEAL",
  "CONFLICTING_CATEGORY",
  "MEAL_CATEGORY_CONFLICT",
  "PAYER_REQUIRES_SHARED",
  "INVALID_TAG",
  "TOO_MANY_CUSTOM_TAGS",
  "INVALID_EVENT_TIMESTAMP",
] as const;

export type ExpenseParseErrorCode =
  (typeof EXPENSE_PARSE_ERROR_CODES)[number];

export interface ExpenseParseError {
  readonly code: ExpenseParseErrorCode;
  readonly message: string;
}

export type ParseExpenseResult =
  | { readonly ok: true; readonly value: ParsedExpense }
  | { readonly ok: false; readonly error: ExpenseParseError };

export interface ParseExpenseOptions {
  /** LINE event timestamp. A number is interpreted as Unix milliseconds. */
  readonly eventTimestamp: Date | string | number;
  readonly timezone?: string;
  readonly defaultScope?: ExpenseScope;
}
