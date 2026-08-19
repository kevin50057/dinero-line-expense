import type { ExpenseParseErrorCode } from "../domain/index.js";

const LOW_SIGNAL_PARSE_ERRORS = new Set<ExpenseParseErrorCode>([
  "EMPTY_MESSAGE",
  "INVALID_FORMAT",
  "AMBIGUOUS_AMOUNT",
  "DESCRIPTION_REQUIRED",
  "DESCRIPTION_TOO_LONG",
]);

/**
 * Conversations without an Arabic digit are never treated as malformed
 * expense attempts. Valid commands are dispatched before this policy. For
 * digit-bearing text, strong syntax such as a currency marker can still get
 * useful feedback when the intended operation is malformed.
 */
export function shouldReplyToExpenseParseError(options: {
  readonly input: string;
  readonly errorCode: ExpenseParseErrorCode;
}): boolean {
  if (!/\d/u.test(options.input.normalize("NFKC"))) return false;
  if (!LOW_SIGNAL_PARSE_ERRORS.has(options.errorCode)) return true;
  return hasExplicitExpenseSyntax(options.input);
}

function hasExplicitExpenseSyntax(input: string): boolean {
  const text = input.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return /^(?:個人|共同)(?:\s|$)/u.test(text)
    || /^(?:作弊)(?:\s|$)/u.test(text)
    || /#[^\s#]*/u.test(text)
    || /(?:NT\$|\$)/u.test(text)
    || /[-+]?\d[\d,.]*\s*元(?:\s|$)/u.test(text);
}
