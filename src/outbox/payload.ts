const MAX_REPLY_MESSAGES = 5;
const MAX_TEXT_CHARACTERS = 5_000;

export interface LineReplyTextMessage {
  readonly type: "text";
  readonly text: string;
}

export interface LineReplyPayload {
  readonly messages: readonly LineReplyTextMessage[];
}

/** A deliberately content-free error so invalid payloads are never logged by accident. */
export class InvalidLineReplyPayloadError extends Error {
  constructor() {
    super("invalid LINE reply payload");
    this.name = "InvalidLineReplyPayloadError";
  }
}

/**
 * Validates the small, allow-listed subset of LINE messages this outbox may send.
 * Returning a fresh object also strips prototypes and prevents extra JSON fields
 * from reaching the provider.
 */
export function parseLineReplyPayload(value: unknown): LineReplyPayload {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["messages"])) {
    throw new InvalidLineReplyPayloadError();
  }

  const messages = value["messages"];
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > MAX_REPLY_MESSAGES
  ) {
    throw new InvalidLineReplyPayloadError();
  }

  return {
    messages: messages.map((message) => {
      const textCharacterCount =
        isPlainRecord(message) && typeof message["text"] === "string"
          ? countUnicodeCharacters(message["text"])
          : 0;
      if (
        !isPlainRecord(message) ||
        !hasOnlyKeys(message, ["type", "text"]) ||
        message["type"] !== "text" ||
        typeof message["text"] !== "string" ||
        textCharacterCount === 0 ||
        textCharacterCount > MAX_TEXT_CHARACTERS
      ) {
        throw new InvalidLineReplyPayloadError();
      }

      return { type: "text" as const, text: message["text"] };
    }),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === allowedKeys.length &&
    keys.every((key) => allowedKeys.includes(key))
  );
}

function countUnicodeCharacters(value: string): number {
  return Array.from(value).length;
}
