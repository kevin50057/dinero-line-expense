import type { LineReplyFlexMessage } from "../outbox/payload.js";

const BRAND = "#26322C";
const ACCENT = "#D8FF70";
const PAPER = "#FBFAF6";
const INK = "#24302A";
const MUTED = "#718078";
const RULE = "#E6E9E4";

export interface CardRow {
  readonly label: string;
  readonly value: string;
  readonly meta?: string;
  readonly action?: CardAction;
}

export interface MessageCardAction {
  readonly label: string;
  readonly text: string;
}

export interface KeyboardCardAction {
  readonly label: string;
  readonly data: string;
  readonly fillInText: string;
}

export type CardAction = MessageCardAction | KeyboardCardAction;

export function infoCard(options: {
  readonly altText: string;
  readonly kicker?: string;
  readonly title: string;
  readonly summary?: string;
  readonly rows?: readonly CardRow[];
  readonly note?: string;
  readonly actions?: readonly CardAction[];
}): LineReplyFlexMessage {
  return flex(options.altText, bubble(
    header(options.kicker ?? "DINERO", options.title),
    body([
      ...(options.summary === undefined ? [] : [text(options.summary, { size: "lg", weight: "bold", color: INK, wrap: true })]),
      ...((options.rows ?? []).flatMap((row, index) => [
        ...(index === 0 && options.summary === undefined ? [] : [separator("md")]),
        rowBox(row),
      ])),
      ...(options.note === undefined ? [] : [separator("md"), text(options.note, { size: "xs", color: MUTED, wrap: true })]),
    ]),
    footer(options.actions ?? []),
  ));
}

export function helpCards(altText: string): LineReplyFlexMessage {
  return flex(altText, {
    type: "carousel",
    contents: [
      bubble(
        header("DINERO 快速開始", "一句話就能記帳"),
        body([
          text("牛肉麵 150 #約會", { size: "lg", weight: "bold", color: INK, wrap: true }),
          text("初始為個人模式；約會時可一鍵切換共同模式。傳送時段也會協助判斷餐別。", { size: "sm", color: MUTED, wrap: true, margin: "md" }),
          separator("lg"),
          rowBox({ label: "個人支出", value: "個人 咖啡 80" }),
          rowBox({ label: "指定分類", value: "電影 320 #娛樂" }),
        ]),
        footer([{ label: "最近紀錄", text: "最近 5" }, { label: "本月報表", text: "本月" }]),
      ),
      bubble(
        header("查詢與報表", "想看什麼就直接問"),
        body([
          rowBox({ label: "期間", value: "今天・昨天・週報・上週・本月・上月" }),
          separator("md"),
          rowBox({ label: "篩選", value: "本月 共同 / 本月 個人 / 本月 #約會" }),
          separator("md"),
          rowBox({ label: "搜尋", value: "找 牛肉麵" }),
          separator("md"),
          rowBox({ label: "排行", value: "分類排行" }),
          separator("md"),
          rowBox({ label: "約會模式", value: "切換共同模式 / 切換個人模式" }),
        ]),
        footer([{ label: "目前模式", text: "目前模式" }, { label: "本週報表", text: "週報" }]),
      ),
      bubble(
        header("修改與管理", "最近列表直接點編輯"),
        body([
          rowBox({ label: "卡片操作", value: "最近 5 → 編輯 → 改名稱／金額／標籤" }),
          separator("md"),
          rowBox({ label: "修改", value: "改 #K7M2Q9TX 金額 180" }),
          separator("md"),
          rowBox({ label: "加標籤", value: "加 #K7M2Q9TX 標籤 #約會" }),
          separator("md"),
          rowBox({ label: "取消 / 還原", value: "取消 #K7M2Q9TX / 還原 #K7M2Q9TX" }),
        ]),
        footer([{ label: "分類說明", text: "分類" }, { label: "標籤說明", text: "標籤" }]),
      ),
    ],
  });
}

function flex(altText: string, contents: Readonly<Record<string, unknown>>): LineReplyFlexMessage {
  return { type: "flex", altText: truncate(altText, 400), contents };
}

function bubble(headerSection: object, bodySection: object, footerSection?: object): Readonly<Record<string, unknown>> {
  return {
    type: "bubble",
    size: "kilo",
    header: headerSection,
    body: bodySection,
    ...(footerSection === undefined ? {} : { footer: footerSection }),
  };
}

function header(kicker: string, title: string) {
  return {
    type: "box",
    layout: "vertical",
    paddingAll: "20px",
    backgroundColor: BRAND,
    spacing: "sm",
    contents: [
      text(kicker, { size: "xs", color: ACCENT, weight: "bold" }),
      text(title, { size: "xl", color: "#FFFFFF", weight: "bold", wrap: true }),
    ],
  };
}

function body(contents: readonly object[]) {
  return { type: "box", layout: "vertical", paddingAll: "20px", backgroundColor: PAPER, spacing: "md", contents };
}

function footer(actions: readonly CardAction[]) {
  if (actions.length === 0) return undefined;
  const buttons = actions.slice(0, 4).map((action) => actionButton(action));
  return {
    type: "box",
    layout: "vertical",
    paddingAll: "12px",
    backgroundColor: PAPER,
    spacing: "sm",
    contents: buttons.length <= 2
      ? [{ type: "box", layout: "horizontal", spacing: "sm", contents: buttons }]
      : [
          { type: "box", layout: "horizontal", spacing: "sm", contents: buttons.slice(0, 2) },
          { type: "box", layout: "horizontal", spacing: "sm", contents: buttons.slice(2, 4) },
        ],
  };
}

function rowBox(row: CardRow) {
  const details = [
    text(row.label, { size: "xs", color: MUTED, weight: "bold", wrap: true }),
    text(row.value, { size: "sm", color: INK, weight: "bold", wrap: true }),
    ...(row.meta === undefined ? [] : [text(row.meta, { size: "xs", color: MUTED, wrap: true })]),
  ];
  return {
    type: "box",
    layout: row.action === undefined ? "vertical" : "horizontal",
    spacing: "xs",
    contents: row.action === undefined
      ? details
      : [
          { type: "box", layout: "vertical", spacing: "xs", flex: 4, contents: details },
          actionButton(row.action, 1),
        ],
  };
}

function actionButton(action: CardAction, flexValue?: number) {
  return {
    type: "button",
    style: "primary",
    height: "sm",
    color: BRAND,
    ...(flexValue === undefined ? {} : { flex: flexValue }),
    action: "text" in action
      ? { type: "message", label: truncate(action.label, 40), text: truncate(action.text, 300) }
      : {
          type: "postback",
          label: truncate(action.label, 40),
          data: truncate(action.data, 300),
          inputOption: "openKeyboard",
          fillInText: truncate(action.fillInText, 300),
        },
  };
}

function separator(margin: string) { return { type: "separator", color: RULE, margin }; }

function text(value: string, options: Readonly<Record<string, unknown>>) {
  return { type: "text", text: truncate(value, 2_000), ...options };
}

function truncate(value: string, length: number): string {
  const characters = Array.from(value);
  return characters.length <= length ? value : `${characters.slice(0, Math.max(1, length - 1)).join("")}…`;
}
