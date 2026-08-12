export type NormalizedLineEventKind =
  | "message"
  | "edit"
  | "unsend"
  | "join"
  | "other";

export interface NormalizedLineSource {
  type: string;
  groupId?: string | undefined;
  roomId?: string | undefined;
  userId?: string | undefined;
}

export interface NormalizedLineMessage {
  id: string;
  type: string;
  text?: string | undefined;
}

export interface NormalizedLineEvent {
  webhookEventId: string;
  kind: NormalizedLineEventKind;
  rawType: string;
  lineEventAtMs: number;
  source: NormalizedLineSource;
  lineMessageId?: string | undefined;
  message?: NormalizedLineMessage | undefined;
  replyToken?: string | undefined;
  isRedelivery: boolean;
  mode?: string | undefined;
}

export interface NormalizedLineWebhook {
  destination: string;
  events: NormalizedLineEvent[];
}

export type LineWebhookParseErrorCode =
  | "invalid_utf8"
  | "invalid_json"
  | "invalid_envelope"
  | "invalid_event";

export class LineWebhookParseError extends Error {
  readonly code: LineWebhookParseErrorCode;
  readonly eventIndex: number | undefined;

  constructor(code: LineWebhookParseErrorCode, eventIndex?: number) {
    super(eventIndex === undefined ? code : `${code}:${eventIndex}`);
    this.name = "LineWebhookParseError";
    this.code = code;
    this.eventIndex = eventIndex;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeKind(type: string): NormalizedLineEventKind {
  switch (type) {
    case "message":
      return "message";
    case "messageEdited":
      return "edit";
    case "unsend":
      return "unsend";
    case "join":
      return "join";
    default:
      return "other";
  }
}

function normalizeSource(value: unknown, eventIndex: number): NormalizedLineSource {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new LineWebhookParseError("invalid_event", eventIndex);
  }

  return {
    type: value.type,
    groupId: optionalString(value.groupId),
    roomId: optionalString(value.roomId),
    userId: optionalString(value.userId),
  };
}

function normalizeMessage(
  value: unknown,
  eventIndex: number,
): NormalizedLineMessage {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.type !== "string"
  ) {
    throw new LineWebhookParseError("invalid_event", eventIndex);
  }

  return {
    id: value.id,
    type: value.type,
    text: value.type === "text" ? optionalString(value.text) : undefined,
  };
}

function normalizeEvent(value: unknown, eventIndex: number): NormalizedLineEvent {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    typeof value.webhookEventId !== "string" ||
    typeof value.timestamp !== "number" ||
    !Number.isSafeInteger(value.timestamp) ||
    value.timestamp < 0
  ) {
    throw new LineWebhookParseError("invalid_event", eventIndex);
  }

  const kind = normalizeKind(value.type);
  const source = normalizeSource(value.source, eventIndex);
  let message: NormalizedLineMessage | undefined;
  let lineMessageId: string | undefined;

  if (kind === "message" || kind === "edit") {
    message = normalizeMessage(value.message, eventIndex);
    lineMessageId = message.id;
  } else if (kind === "unsend") {
    if (!isRecord(value.unsend) || typeof value.unsend.messageId !== "string") {
      throw new LineWebhookParseError("invalid_event", eventIndex);
    }
    lineMessageId = value.unsend.messageId;
  }

  const deliveryContext = isRecord(value.deliveryContext)
    ? value.deliveryContext
    : undefined;

  return {
    webhookEventId: value.webhookEventId,
    kind,
    rawType: value.type,
    lineEventAtMs: value.timestamp,
    source,
    lineMessageId,
    message,
    replyToken: optionalString(value.replyToken),
    isRedelivery: deliveryContext?.isRedelivery === true,
    mode: optionalString(value.mode),
  };
}

/**
 * Parses a webhook after its signature has been verified.
 *
 * Errors deliberately contain only a stable code and event index so malformed
 * requests cannot leak message text into logs or error trackers.
 */
export function parseLineWebhookBody(rawBody: Uint8Array): NormalizedLineWebhook {
  let bodyText: string;
  try {
    bodyText = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    throw new LineWebhookParseError("invalid_utf8");
  }

  let value: unknown;
  try {
    value = JSON.parse(bodyText) as unknown;
  } catch {
    throw new LineWebhookParseError("invalid_json");
  }

  if (
    !isRecord(value) ||
    typeof value.destination !== "string" ||
    !Array.isArray(value.events)
  ) {
    throw new LineWebhookParseError("invalid_envelope");
  }

  return {
    destination: value.destination,
    events: value.events.map(normalizeEvent),
  };
}
