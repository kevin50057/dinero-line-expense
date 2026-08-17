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
        header("DINERO 配對開始", "兩個人，一本帳"),
        body([
          rowBox({ label: "第 1 步", value: "建立兩人 LINE 群組並加入機器人" }),
          separator("md"),
          rowBox({ label: "第 2 步", value: "第一人傳送「建立配對」" }),
          separator("md"),
          rowBox({ label: "第 3 步", value: "第二人傳送「配對」" }),
          separator("md"),
          rowBox({ label: "設定名字", value: "設定暱稱 小美" }),
        ]),
        footer([{ label: "建立配對", text: "建立配對" }, { label: "配對狀態", text: "配對" }]),
      ),
      bubble(
        header("DINERO 快速開始", "一句話就能記帳"),
        body([
          text("牛肉麵 150 #約會", { size: "lg", weight: "bold", color: INK, wrap: true }),
          text("預設記在傳送者個人帳；日期、時段和標籤都可以直接寫在同一句。", { size: "sm", color: MUTED, wrap: true, margin: "md" }),
          separator("lg"),
          rowBox({ label: "補登日期", value: "昨天早上 早餐 80" }),
          rowBox({ label: "指定時間", value: "前天 22:00 宵夜 200" }),
          rowBox({ label: "指定分類", value: "電影 320 #娛樂" }),
        ]),
        footer([{ label: "最近紀錄", text: "最近 5" }, { label: "本月報表", text: "本月" }]),
      ),
      bubble(
        header("個人與共同", "約會才切共同模式"),
        body([
          rowBox({ label: "查看模式", value: "目前模式" }),
          separator("md"),
          rowBox({ label: "開始約會", value: "切換共同模式" }),
          separator("md"),
          rowBox({ label: "回到個人", value: "切換個人模式" }),
          separator("md"),
          rowBox({ label: "單筆指定", value: "共同 晚餐 800 對方付" }),
          separator("md"),
          rowBox({ label: "共同付款人", value: "交易卡片可切換我／對方付款" }),
        ]),
        footer([{ label: "目前模式", text: "目前模式" }, { label: "共同最近", text: "共同 最近 5" }]),
      ),
      bubble(
        header("查詢與報表", "想看什麼就直接問"),
        body([
          rowBox({ label: "最近筆數", value: "最近 5 / 共同 最近 10" }),
          separator("md"),
          rowBox({ label: "指定日期", value: "昨天紀錄 / 共同昨天紀錄" }),
          separator("md"),
          rowBox({ label: "月報", value: "查月報 / 查 6月月報 / 共同月報" }),
          separator("md"),
          rowBox({ label: "搜尋", value: "找 牛肉麵" }),
          separator("md"),
          rowBox({ label: "排行", value: "分類排行" }),
        ]),
        footer([{ label: "查月報", text: "查月報" }, { label: "本週報表", text: "週報" }]),
      ),
      bubble(
        header("修改與管理", "最近列表直接點編輯"),
        body([
          rowBox({ label: "卡片操作", value: "最近 5 → 編輯 → 改名稱／金額／分類／標籤" }),
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

export function pairingGuideCard(altText: string): LineReplyFlexMessage {
  return infoCard({
    altText,
    kicker: "DINERO 配對模式",
    title: "先完成兩人配對",
    rows: [
      { label: "第一位", value: "傳送「建立配對」建立帳本身份" },
      { label: "第二位", value: "在同一群組傳送「配對」加入" },
      { label: "完成後", value: "兩人各自傳送「設定暱稱 名字」" },
    ],
    note: "每個 LINE 帳號一次只會連到一組配對，私訊記帳才不會跑錯帳本。",
    actions: [{ label: "建立配對", text: "建立配對" }, { label: "完整說明", text: "使用說明" }],
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
  const buttons = actions.slice(0, 6).map((action) => actionButton(action));
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push({ type: "box", layout: "horizontal", spacing: "sm", contents: buttons.slice(index, index + 2) });
  }
  return {
    type: "box",
    layout: "vertical",
    paddingAll: "12px",
    backgroundColor: PAPER,
    spacing: "sm",
    contents: rows,
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
          { type: "box", layout: "vertical", spacing: "xs", flex: 5, contents: details },
          rowActionBox(row.action),
        ],
  };
}

function rowActionBox(action: CardAction) {
  const actionPayload = "text" in action
    ? { type: "message", label: truncate(action.label, 40), text: truncate(action.text, 300) }
    : {
        type: "postback",
        label: truncate(action.label, 40),
        data: truncate(action.data, 300),
        inputOption: "openKeyboard",
        fillInText: truncate(action.fillInText, 300),
      };
  return {
    type: "box",
    layout: "vertical",
    flex: 2,
    backgroundColor: BRAND,
    cornerRadius: "md",
    paddingAll: "8px",
    justifyContent: "center",
    contents: [text(action.label, {
      size: "sm",
      color: "#FFFFFF",
      weight: "bold",
      align: "center",
      wrap: false,
      flex: 0,
    })],
    action: actionPayload,
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
