const MAX_REPLY_MESSAGES = 5;
const MAX_TEXT_CHARACTERS = 5_000;
const MAX_ALT_TEXT_CHARACTERS = 400;
const MAX_FLEX_JSON_BYTES = 50_000;
const MAX_FLEX_COMPONENTS = 200;
const MAX_FLEX_DEPTH = 12;

export interface LineReplyTextMessage {
  readonly type: "text";
  readonly text: string;
}

export interface LineReplyFlexMessage {
  readonly type: "flex";
  readonly altText: string;
  readonly contents: Readonly<Record<string, unknown>>;
}

export type LineReplyMessage = LineReplyTextMessage | LineReplyFlexMessage;

export interface LineReplyPayload {
  readonly messages: readonly LineReplyMessage[];
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
  if (!isPlainRecord(value) || !hasExactKeys(value, ["messages"])) fail();
  const messages = value["messages"];
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_REPLY_MESSAGES) fail();
  return { messages: messages.map(parseMessage) };
}

function parseMessage(message: unknown): LineReplyMessage {
  if (!isPlainRecord(message) || typeof message["type"] !== "string") fail();
  if (message["type"] === "text") {
    if (!hasExactKeys(message, ["type", "text"]) || !validText(message["text"], 1, MAX_TEXT_CHARACTERS)) fail();
    return { type: "text", text: message["text"] as string };
  }
  if (message["type"] === "flex") {
    if (!hasExactKeys(message, ["type", "altText", "contents"]) || !validText(message["altText"], 1, MAX_ALT_TEXT_CHARACTERS)) fail();
    if (new TextEncoder().encode(JSON.stringify(message)).length > MAX_FLEX_JSON_BYTES) fail();
    const state = { components: 0 };
    const contents = parseFlexContainer(message["contents"], 0, state);
    return { type: "flex", altText: message["altText"] as string, contents };
  }
  fail();
}

function parseFlexContainer(value: unknown, depth: number, state: { components: number }): Readonly<Record<string, unknown>> {
  countComponent(depth, state);
  if (!isPlainRecord(value) || typeof value["type"] !== "string") fail();
  if (value["type"] === "bubble") {
    if (!hasAllowedKeys(value, ["type", "size", "header", "body", "footer"])) fail();
    if (value["size"] !== undefined && !["nano", "micro", "kilo", "mega", "giga"].includes(String(value["size"]))) fail();
    const result: Record<string, unknown> = { type: "bubble" };
    if (value["size"] !== undefined) result["size"] = value["size"];
    for (const section of ["header", "body", "footer"] as const) {
      if (value[section] !== undefined) {
        const parsed = parseFlexComponent(value[section], depth + 1, state);
        if (parsed["type"] !== "box") fail();
        result[section] = parsed;
      }
    }
    if (result["body"] === undefined && result["header"] === undefined && result["footer"] === undefined) fail();
    return result;
  }
  if (value["type"] === "carousel") {
    if (!hasExactKeys(value, ["type", "contents"]) || !Array.isArray(value["contents"]) || value["contents"].length < 1 || value["contents"].length > 12) fail();
    return {
      type: "carousel",
      contents: value["contents"].map((item) => {
        const parsed = parseFlexContainer(item, depth + 1, state);
        if (parsed["type"] !== "bubble") fail();
        return parsed;
      }),
    };
  }
  fail();
}

function parseFlexComponent(value: unknown, depth: number, state: { components: number }): Readonly<Record<string, unknown>> {
  countComponent(depth, state);
  if (!isPlainRecord(value) || typeof value["type"] !== "string") fail();
  if (value["type"] === "box") {
    if (!hasAllowedKeys(value, ["type", "layout", "contents", "spacing", "margin", "paddingAll", "backgroundColor", "cornerRadius", "flex"])) fail();
    if (!isOneOf(value["layout"], ["vertical", "horizontal", "baseline"]) || !Array.isArray(value["contents"]) || value["contents"].length > 40) fail();
    const result: Record<string, unknown> = { type: "box", layout: value["layout"], contents: value["contents"].map((item) => parseFlexComponent(item, depth + 1, state)) };
    copyOptionalStrings(value, result, ["spacing", "margin", "paddingAll", "backgroundColor", "cornerRadius"]);
    copyOptionalFlex(value, result);
    return result;
  }
  if (value["type"] === "text") {
    if (!hasAllowedKeys(value, ["type", "text", "size", "color", "weight", "wrap", "align", "flex", "margin"]) || !validText(value["text"], 1, 2_000)) fail();
    if (value["wrap"] !== undefined && typeof value["wrap"] !== "boolean") fail();
    if (value["flex"] !== undefined && (!Number.isInteger(value["flex"]) || Number(value["flex"]) < 0 || Number(value["flex"]) > 10)) fail();
    if (value["weight"] !== undefined && !isOneOf(value["weight"], ["regular", "bold"])) fail();
    if (value["align"] !== undefined && !isOneOf(value["align"], ["start", "center", "end"])) fail();
    const result: Record<string, unknown> = { type: "text", text: value["text"] };
    copyOptionalStrings(value, result, ["size", "color", "weight", "align", "margin"]);
    if (value["wrap"] !== undefined) result["wrap"] = value["wrap"];
    if (value["flex"] !== undefined) result["flex"] = value["flex"];
    return result;
  }
  if (value["type"] === "separator") {
    if (!hasAllowedKeys(value, ["type", "margin", "color"])) fail();
    const result: Record<string, unknown> = { type: "separator" };
    copyOptionalStrings(value, result, ["margin", "color"]);
    return result;
  }
  if (value["type"] === "button") {
    if (!hasAllowedKeys(value, ["type", "style", "color", "height", "margin", "flex", "action"]) || !isPlainRecord(value["action"])) fail();
    if (value["style"] !== undefined && !isOneOf(value["style"], ["link", "primary", "secondary"])) fail();
    if (value["height"] !== undefined && !isOneOf(value["height"], ["sm", "md"])) fail();
    const action = value["action"];
    let parsedAction: Record<string, unknown>;
    if (action["type"] === "message") {
      if (!hasExactKeys(action, ["type", "label", "text"]) || !validText(action["label"], 1, 40) || !validText(action["text"], 1, 300)) fail();
      parsedAction = { type: "message", label: action["label"], text: action["text"] };
    } else if (action["type"] === "postback") {
      if (!hasExactKeys(action, ["type", "label", "data", "inputOption", "fillInText"]) ||
          !validText(action["label"], 1, 40) || !validText(action["data"], 1, 300) ||
          action["inputOption"] !== "openKeyboard" || !validText(action["fillInText"], 1, 300)) fail();
      parsedAction = {
        type: "postback", label: action["label"], data: action["data"],
        inputOption: "openKeyboard", fillInText: action["fillInText"],
      };
    } else fail();
    const result: Record<string, unknown> = { type: "button", action: parsedAction };
    copyOptionalStrings(value, result, ["style", "color", "height", "margin"]);
    copyOptionalFlex(value, result);
    return result;
  }
  fail();
}

function copyOptionalStrings(source: Readonly<Record<string, unknown>>, target: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    if (source[key] === undefined) continue;
    if (!validText(source[key], 1, 50)) fail();
    target[key] = source[key];
  }
}

function copyOptionalFlex(source: Readonly<Record<string, unknown>>, target: Record<string, unknown>) {
  if (source["flex"] === undefined) return;
  if (!Number.isInteger(source["flex"]) || Number(source["flex"]) < 0 || Number(source["flex"]) > 10) fail();
  target["flex"] = source["flex"];
}

function countComponent(depth: number, state: { components: number }) {
  state.components += 1;
  if (depth > MAX_FLEX_DEPTH || state.components > MAX_FLEX_COMPONENTS) fail();
}

function validText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && countUnicodeCharacters(value) >= min && countUnicodeCharacters(value) <= max;
}

function isOneOf(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === "string" && allowed.includes(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function hasAllowedKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function countUnicodeCharacters(value: string): number { return Array.from(value).length; }

function fail(): never { throw new InvalidLineReplyPayloadError(); }
