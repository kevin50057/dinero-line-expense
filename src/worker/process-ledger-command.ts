import type { PoolClient } from "pg";

import {
  CATEGORY_DISPLAY_NAMES,
  MEAL_DISPLAY_NAMES,
  classifyDescription,
  inferMeal,
  inferContextTags,
  parseAbsoluteDateToken,
  shiftCalendarDate,
  toZonedMinute,
  zonedLocalMinuteToInstant,
} from "../domain/index.js";
import type {
  CategoryCode,
  CommandFilter,
  LedgerCommand,
  MealCode,
  PeriodSelection,
  UpdateChange,
} from "../domain/index.js";
import { helpCards, infoCard } from "../application/line-cards.js";
import type { LineReplyMessage } from "../outbox/payload.js";
import { learnCategoryCorrection, resolveCategoryKnowledge } from "./category-knowledge.js";

export interface CommandActor {
  readonly ledgerId: string;
  readonly memberId: string;
  readonly displayName: string;
  readonly timezone: string;
}

export interface CommandEvent {
  readonly webhookEventId: string;
  readonly eventAt: Date;
}

export interface LedgerCommandResult {
  readonly outcome: "applied" | "rejected" | "noop";
  readonly reply: string;
  readonly message?: LineReplyMessage;
  readonly publicId?: string;
}

interface ExpenseRow {
  id: string;
  public_id: string;
  status: "active" | "voided";
  scope: "shared" | "personal";
  amount_minor: string;
  description: string;
  occurred_on: string;
  occurred_at: Date | null;
  occurred_time_precision: "unknown" | "minute" | "millisecond";
  payer_member_id: string;
  payer_name: string;
  personal_owner_member_id: string | null;
  owner_name: string | null;
  category_code: CategoryCode;
  category_name: string;
  category_source: "explicit" | "inferred";
  meal_code: MealCode | null;
  meal_name: string | null;
  meal_source: "explicit" | "inferred" | null;
}

interface ListRow {
  public_id: string;
  amount_minor: string;
  description: string;
  scope: "shared" | "personal";
  occurred_on: string;
  occurred_at: Date | null;
}

export async function processLedgerCommand(
  client: PoolClient,
  actor: CommandActor,
  event: CommandEvent,
  command: LedgerCommand,
): Promise<LedgerCommandResult> {
  switch (command.kind) {
    case "help":
      {
      const reply = [
        "配對：第一位輸入建立配對，第二位輸入配對",
        "狀態：配對狀態",
        "解除：一人輸入解除配對，另一人輸入同意解除",
        "記帳：牛肉麵 150 #工作（初始為個人模式）",
        "日期時間：昨天早上 早餐 80、前天 22:00 宵夜 200",
        "預訂支出：作弊 2026/9/25 香港機+酒 30141",
        "個人：個人 咖啡 80",
        "模式：切換共同模式、切換個人模式、目前模式",
        "暱稱：設定暱稱 小美、我的暱稱",
        "付款人：共同交易卡片可切換，或輸入改 #編號 付款人 對方",
        "查詢：最近 5、共同 最近 10、昨天紀錄、查月報、查 6月月報、找 關鍵字、分類排行",
        "修改：最近 5 → 點每筆右側的編輯",
        "標籤：改 #編號 標籤 #約會 #台南",
        "取消／還原：取消 #編號、還原 #編號",
      ].join("\n");
      return applied(reply, undefined, helpCards(reply));
      }
    case "categories":
      {
        const reply = "分類：食物、交通、娛樂、居家、購物、醫療健康、旅遊、未分類\n餐別：早餐、午餐、下午茶、晚餐、宵夜";
        return applied(reply, undefined, infoCard({ altText: reply, kicker: "DINERO 標籤系統", title: "分類與餐別", rows: [
          { label: "支出分類", value: "食物・交通・娛樂・居家・購物・醫療健康・旅遊・未分類" },
          { label: "食物餐別", value: "早餐・午餐・下午茶・晚餐・宵夜" },
        ], note: "你也可以加 #約會、#台南 等自訂標籤。", actions: [{ label: "分類知識表", text: "分類規則" }, { label: "標籤說明", text: "標籤" }] }));
      }
    case "category_rules":
      return queryCategoryRules(client, actor);
    case "tags_help":
      {
        const reply = "每筆會有 1 個分類、最多 1 個餐別，另可加最多 10 個情境標籤。孝親費等項目會自動加入「原生家庭」。\n範例：牛肉麵 150 #約會";
        return applied(reply, undefined, infoCard({ altText: reply, kicker: "DINERO 自訂整理", title: "用標籤留下情境", rows: [
          { label: "新增時", value: "牛肉麵 150 #約會 #台北" },
          { label: "事後加入", value: "加 #編號 標籤 #約會" },
          { label: "整組修改", value: "改 #編號 標籤 #約會 #台北；輸入無可清空" },
          { label: "依標籤查詢", value: "本月 #約會" },
          { label: "自動情境", value: "孝親費、爸媽紅包等 → 原生家庭" },
        ], note: "每筆最多 10 個自訂標籤。", actions: [{ label: "看分類", text: "分類" }] }));
      }
    case "detail":
      return queryDetail(client, actor, command.publicId);
    case "recent":
      return queryRecent(client, actor, command.limit, command.filter);
    case "period":
      return queryPeriod(client, actor, event, command);
    case "search":
      return querySearch(client, actor, command.keyword);
    case "ranking":
      return queryRanking(client, actor, event, command.filter);
    case "mode":
      return changeLedgerMode(client, actor, command.scope);
    case "nickname":
      return changeNickname(client, actor, command.value);
    case "bulk_payer":
      return changePeriodPayer(client, actor, event, command.period, command.target);
    case "void":
    case "restore":
      return withRefreshedDetail(client, actor, await changeStatus(client, actor, event, command.publicId, command.kind));
    case "tags":
      return withRefreshedDetail(client, actor, await changeCustomTags(client, actor, event, command.publicId, command.operation, command.tags));
    case "update":
      return withRefreshedDetail(client, actor, await updateExpense(client, actor, event, command.publicId, command.change));
  }
}

async function changePeriodPayer(
  client: PoolClient,
  actor: CommandActor,
  event: CommandEvent,
  period: "today" | "yesterday" | "day_before_yesterday",
  target: "self" | "partner",
): Promise<LedgerCommandResult> {
  const pair = await loadPaymentPair(client, actor);
  if (pair === null) return rejected("這個功能只適用於剛好兩位已配對成員的帳本。");
  const local = toZonedMinute(event.eventAt, actor.timezone);
  if (local === null) return rejected("無法判定帳本日期，請稍後再試。");
  const { start, end, title } = periodRange(local.date, period);
  const payer = target === "self" ? pair.self : pair.partner;
  const expenses = await client.query<{
    id: string; public_id: string; description: string; amount_minor: string;
    payer_member_id: string; payer_name: string;
  }>(
    `SELECT e.id::text,e.public_id,e.description,e.amount_minor::text,
            e.payer_member_id::text,p.display_name AS payer_name
       FROM expense_transaction e
       JOIN member p ON p.id=e.payer_member_id AND p.ledger_id=e.ledger_id
      WHERE e.ledger_id=$1 AND e.status='active' AND e.scope='shared'
        AND e.occurred_on >= $2::date AND e.occurred_on < $3::date
      ORDER BY e.occurred_on,e.occurred_at NULLS LAST,e.created_at,e.id
      FOR UPDATE OF e`,
    [actor.ledgerId, start, end],
  );
  const changed = expenses.rows.filter((row) => row.payer_member_id !== payer.id);
  for (const row of changed) {
    await client.query(
      "UPDATE expense_transaction SET payer_member_id=$3,row_version=row_version+1 WHERE ledger_id=$1 AND id=$2",
      [actor.ledgerId, row.id, payer.id],
    );
    await insertAudit(client, actor, event, row.id, "updated", ["payer"],
      { payer: row.payer_name }, { payer: payer.name });
  }
  const unchanged = expenses.rows.length - changed.length;
  const reply = changed.length === 0
    ? `${title}沒有需要修改的共同支出；${expenses.rows.length} 筆付款人原本就已是${payer.name}。`
    : [
        `${title}共同支出付款人已改為${payer.name}：${changed.length} 筆`,
        ...changed.map((row) => `#${row.public_id}｜${row.description}｜${money(row.amount_minor)}｜${row.payer_name} → ${payer.name}`),
        ...(unchanged === 0 ? [] : [`另有 ${unchanged} 筆原本就是${payer.name}，未變更。`]),
      ].join("\n");
  return applied(reply, undefined, infoCard({
    altText: reply,
    kicker: "DINERO 批次付款人",
    title: `${title}・${payer.name}付款`,
    summary: `已修改 ${changed.length} 筆`,
    rows: changed.slice(0, 20).map((row) => ({
      label: `#${row.public_id}・${row.description}`,
      value: money(row.amount_minor),
      meta: `${row.payer_name} → ${payer.name}`,
    })),
    note: changed.length > 20
      ? `另有 ${changed.length - 20} 筆已完成修改；可按下方按鈕查看當日共同紀錄。`
      : unchanged > 0
        ? `${unchanged} 筆原本就是${payer.name}，未變更。`
        : "僅修改共同支出；個人支出完全不受影響。",
    actions: [{ label: "查看共同紀錄", text: period === "today" ? "今天 共同" : period === "yesterday" ? "昨天 共同" : "前天 共同" }],
  }));
}

async function changeNickname(
  client: PoolClient,
  actor: CommandActor,
  nickname: string | null,
): Promise<LedgerCommandResult> {
  if (nickname === null) {
    return applied(`你目前的暱稱是「${actor.displayName}」。`, undefined, infoCard({
      altText: `你目前的暱稱是「${actor.displayName}」。`,
      kicker: "DINERO 帳本身份",
      title: actor.displayName,
      note: "要修改請輸入：設定暱稱 新名字",
    }));
  }
  if (nickname.normalize("NFKC").trim().toLocaleLowerCase("zh-TW") ===
      actor.displayName.normalize("NFKC").trim().toLocaleLowerCase("zh-TW")) {
    return { outcome: "noop", reply: `你的暱稱已經是「${actor.displayName}」。` };
  }
  const duplicate = await client.query(
    `SELECT 1 FROM member
      WHERE ledger_id=$1 AND is_active AND id<>$2
        AND (lower(btrim(display_name))=lower(btrim($3))
          OR lower(btrim(command_alias))=lower(btrim($3)))`,
    [actor.ledgerId, actor.memberId, nickname],
  );
  if (duplicate.rowCount !== 0) return rejected("這個暱稱已被另一位成員使用，請換一個。");
  const updated = await client.query(
    `UPDATE member SET display_name=$3,command_alias=$3,updated_at=clock_timestamp()
      WHERE ledger_id=$1 AND id=$2 AND is_active`,
    [actor.ledgerId, actor.memberId, nickname],
  );
  if (updated.rowCount !== 1) throw new Error("member_nickname_update_failed");
  const reply = `暱稱已從「${actor.displayName}」改成「${nickname}」。之後的記帳卡片與報表都會使用新暱稱。`;
  return applied(reply, undefined, infoCard({
    altText: reply,
    kicker: "DINERO 暱稱已更新",
    title: nickname,
    note: "你過去的交易也會顯示這個新暱稱。",
  }));
}

async function queryCategoryRules(client: PoolClient, actor: CommandActor): Promise<LedgerCommandResult> {
  const system = await client.query<{ category_code: CategoryCode; count: string; examples: string[] }>(
    `SELECT category_code, count(*)::text AS count,
            (array_agg(normalized_pattern ORDER BY priority DESC, char_length(normalized_pattern) DESC))[1:5] AS examples
       FROM category_knowledge_rule
      WHERE ledger_id IS NULL AND is_active
      GROUP BY category_code
      ORDER BY category_code`,
  );
  const learned = await client.query<{ count: string; examples: string[] | null }>(
    `SELECT count(*)::text AS count,
            (array_agg(normalized_pattern ORDER BY updated_at DESC))[1:5] AS examples
       FROM category_knowledge_rule
      WHERE ledger_id=$1 AND is_active AND source='member_correction'`,
    [actor.ledgerId],
  );
  const catalog = await client.query<{ total: string; classified: string }>(
    `SELECT count(*) FILTER (WHERE is_active)::text AS total,
            count(*) FILTER (WHERE is_active AND category_code <> 'uncategorized')::text AS classified
       FROM product_catalog_item`,
  );
  const systemCount = system.rows.reduce((sum, row) => sum + Number(row.count), 0);
  const learnedCount = Number(learned.rows[0]?.count ?? 0);
  const catalogTotal = Number(catalog.rows[0]?.total ?? 0);
  const catalogClassified = Number(catalog.rows[0]?.classified ?? 0);
  const reply = `分類知識表：規則 ${systemCount} 條、商品 ${catalogTotal} 件（已分類 ${catalogClassified}）、你們專屬 ${learnedCount} 條。`;
  return applied(reply, undefined, infoCard({
    altText: reply,
    kicker: "DINERO 分類知識表",
    title: "消費分類總表",
    summary: `商品 ${catalogTotal}・規則 ${systemCount + learnedCount}`,
    rows: [
      {
        label: "商品主檔",
        value: `${catalogTotal} 件・${catalogClassified} 件可直接分類`,
        meta: "來源：官方公開商品索引；無把握的商品保留未分類",
      },
      ...system.rows.map((row) => ({
        label: CATEGORY_DISPLAY_NAMES[row.category_code],
        value: `${row.count} 個常見詞`,
        meta: row.examples.join("・"),
      })),
      ...(learnedCount === 0 ? [] : [{
        label: "你們教會我的",
        value: `${learnedCount} 條專屬規則`,
        meta: learned.rows[0]?.examples?.join("・") ?? "",
      }]),
    ],
    note: "分類順序：帳本專屬精確規則 → 常見消費詞 → 商品主檔 → 內建保守規則。",
    actions: [{ label: "最近紀錄", text: "最近 5" }, { label: "分類說明", text: "分類" }],
  }));
}

async function changeLedgerMode(
  client: PoolClient,
  actor: CommandActor,
  requestedScope: "shared" | "personal" | null,
): Promise<LedgerCommandResult> {
  const current = await client.query<{ default_scope: "shared" | "personal" }>(
    "SELECT default_scope::text FROM ledger WHERE id=$1 FOR UPDATE",
    [actor.ledgerId],
  );
  const currentScope = current.rows[0]?.default_scope;
  if (currentScope === undefined) return rejected("找不到這個帳本，請稍後再試。");

  const scope = requestedScope ?? currentScope;
  const label = scope === "shared" ? "共同模式" : "個人模式";
  const explanation = scope === "shared"
    ? "接下來你們兩人的裸記帳會算共同支出；明確寫「個人」仍可只記自己。"
    : "接下來你們兩人的裸記帳會各自算個人支出；約會時可再切換共同模式。";
  const reply = `目前是${label}。\n${explanation}`;
  const message = infoCard({
    altText: reply,
    kicker: "DINERO 記帳模式",
    title: label,
    summary: scope === "shared" ? "兩人共同記帳" : "各自記在個人帳下",
    note: explanation,
    actions: [{
      label: scope === "shared" ? "切回個人模式" : "切換共同模式",
      text: scope === "shared" ? "切換個人模式" : "切換共同模式",
    }],
  });

  if (requestedScope === null || requestedScope === currentScope) {
    return { outcome: "noop", reply, message };
  }
  const updated = await client.query(
    "UPDATE ledger SET default_scope=$2::expense_scope,updated_at=clock_timestamp() WHERE id=$1",
    [actor.ledgerId, requestedScope],
  );
  if (updated.rowCount !== 1) throw new Error("ledger_mode_update_failed");
  return applied(`已切換為${label}。\n${explanation}`, undefined, infoCard({
    altText: `已切換為${label}。${explanation}`,
    kicker: "DINERO 模式已切換",
    title: label,
    summary: scope === "shared" ? "約會一起記 💚" : "回到各自記帳",
    note: explanation,
    actions: [{ label: "查看目前模式", text: "目前模式" }],
  }));
}

async function queryDetail(client: PoolClient, actor: CommandActor, publicId: string): Promise<LedgerCommandResult> {
  const expense = await loadExpense(client, actor.ledgerId, publicId, false);
  if (expense === null) return notFound();
  const tags = await loadTagNames(client, actor.ledgerId, expense.id);
  const occurred = expense.occurred_at === null
    ? `${slashDate(expense.occurred_on)}（時間未指定）`
    : `${slashDate(expense.occurred_on)} ${toZonedMinute(expense.occurred_at, actor.timezone)?.time ?? "--:--"}`;
  const reply = [
    `#${expense.public_id}｜${expense.status === "active" ? "有效" : "已取消"}`,
    `${expense.scope === "shared" ? "共同" : "個人"}｜${expense.description}｜${money(expense.amount_minor)}`,
    `標籤：${tags.join("・")}`,
    `時間：${occurred}`,
    `付款：${expense.payer_name}`,
    ...(expense.owner_name === null ? [] : [`所有人：${expense.owner_name}`]),
  ].join("\n");
  const canMutate = expense.scope === "shared" || expense.personal_owner_member_id === actor.memberId;
  const editActions = expense.status === "active" && canMutate
      ? [
        { label: "改名稱", data: `ui=edit_name&id=${expense.public_id}`, fillInText: `改 #${expense.public_id} 項目 ${expense.description}` },
        { label: "改金額", data: `ui=edit_amount&id=${expense.public_id}`, fillInText: `改 #${expense.public_id} 金額 ${expense.amount_minor}` },
        { label: "改分類", data: `ui=edit_category&id=${expense.public_id}`, fillInText: `改 #${expense.public_id} 分類 ${expense.category_name}` },
        { label: "改標籤", data: `ui=edit_tags&id=${expense.public_id}`, fillInText: `改 #${expense.public_id} 標籤 ${tags.map((name) => `#${name}`).join(" ")}` },
        ...(expense.scope === "shared" ? [{
          label: expense.payer_member_id === actor.memberId ? "對方付款" : "我付款",
          text: `改 #${expense.public_id} 付款人 ${expense.payer_member_id === actor.memberId ? "對方" : "我"}`,
        }] : []),
        { label: "取消這筆", text: `取消 #${expense.public_id}` },
      ]
    : expense.status === "voided" && canMutate
      ? [{ label: "還原這筆", text: `還原 #${expense.public_id}` }]
      : [];
  return applied(reply, publicId, infoCard({
    altText: reply,
    kicker: `交易 #${expense.public_id}`,
    title: expense.description,
    summary: money(expense.amount_minor),
    rows: [
      { label: "狀態與範圍", value: `${expense.status === "active" ? "有效" : "已取消"}・${expense.scope === "shared" ? "共同" : "個人"}` },
      { label: "分類與標籤", value: tags.join("・") },
      { label: "消費時間", value: occurred },
      { label: "付款人", value: expense.payer_name, ...(expense.owner_name === null ? {} : { meta: `所有人：${expense.owner_name}` }) },
    ],
    actions: editActions,
  }));
}

async function queryRecent(
  client: PoolClient,
  actor: CommandActor,
  limit: number,
  filter: Extract<LedgerCommand, { kind: "recent" }>["filter"],
): Promise<LedgerCommandResult> {
  const params: unknown[] = [actor.ledgerId, limit];
  let filterSql = "";
  if (filter.kind === "personal") {
    params.push(actor.memberId);
    filterSql = ` AND et.scope='personal' AND et.personal_owner_member_id=$${params.length}`;
  } else if (filter.kind === "shared") {
    filterSql = " AND et.scope='shared'";
  }
  const result = await client.query<ListRow>(
    `SELECT public_id, amount_minor::text, description, scope::text,
            occurred_on::text, occurred_at
       FROM expense_transaction et
      WHERE ledger_id = $1 AND status = 'active'${filterSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    params,
  );
  const scopeLabel = filter.kind === "personal" ? `${actor.displayName}個人` : filter.kind === "shared" ? "共同" : "全部";
  if (result.rows.length === 0) {
    const reply = `${scopeLabel}目前沒有有效的記帳紀錄。`;
    return applied(reply, undefined, infoCard({ altText: reply, kicker: "DINERO 記帳列表", title: `${scopeLabel}最近紀錄`, note: reply, actions: [{ label: "查看共同", text: "最近 5 共同" }, { label: "查看全部", text: "最近 5 全部" }] }));
  }
  const reply = [
    `${scopeLabel}最近 ${result.rows.length} 筆`,
    ...result.rows.map(formatListRow),
    `合計：${money(sumRows(result.rows))}`,
  ].join("\n");
  return applied(reply, undefined, listCard(`${scopeLabel}最近 ${result.rows.length} 筆`, result.rows, reply, "按輸入時間排序", [
    { label: "我的月報", text: "本月" }, { label: "共同最近", text: "最近 5 共同" },
  ]));
}

async function queryPeriod(
  client: PoolClient,
  actor: CommandActor,
  event: CommandEvent,
  command: Extract<LedgerCommand, { kind: "period" }>,
): Promise<LedgerCommandResult> {
  const local = toZonedMinute(event.eventAt, actor.timezone);
  if (local === null) return rejected("無法判定帳本日期，請稍後再試。");
  const { start, end, title } = periodRange(local.date, command.period);
  const params: unknown[] = [actor.ledgerId, start, end];
  let filterSql = "";
  if (command.filter.kind === "shared") filterSql = " AND et.scope = 'shared'";
  if (command.filter.kind === "personal") {
    params.push(actor.memberId);
    filterSql = ` AND et.scope = 'personal' AND et.personal_owner_member_id = $${params.length}`;
  }
  if (command.filter.kind === "tag") {
    params.push(command.filter.name);
    filterSql = ` AND EXISTS (
      SELECT 1 FROM transaction_tag tt JOIN tag t ON t.id = tt.tag_id AND t.ledger_id = tt.ledger_id
       WHERE tt.ledger_id = et.ledger_id AND tt.transaction_id = et.id AND t.normalized_name = $${params.length}
    )`;
  }
  const rows = await client.query<ListRow>(
    `SELECT et.public_id, et.amount_minor::text, et.description, et.scope::text,
            et.occurred_on::text, et.occurred_at
       FROM expense_transaction et
      WHERE et.ledger_id = $1 AND et.status = 'active'
        AND et.occurred_on >= $2::date AND et.occurred_on < $3::date${filterSql}
      ORDER BY et.occurred_on DESC, et.occurred_at DESC NULLS LAST, et.created_at DESC`,
    params,
  );
  const suffix = command.filter.kind === "all" ? " 全部" : command.filter.kind === "tag" ? ` #${command.filter.name}` : command.filter.kind === "shared" ? " 共同" : ` ${actor.displayName}個人`;
  if (rows.rows.length === 0) {
    const reply = `${title}${suffix}：0 筆，合計 0 元`;
    return applied(reply, undefined, infoCard({ altText: reply, kicker: "DINERO 支出報表", title: `${title}${suffix}`, summary: "0 元", note: "這個期間目前沒有符合條件的支出。", actions: [{ label: "最近紀錄", text: "最近 5" }] }));
  }

  const scopeTotals = await periodScopeTotals(client, actor.ledgerId, start, end, filterSql, params.slice(3));
  const memberTotals = await periodMemberTotals(client, actor.ledgerId, start, end, filterSql, params.slice(3));
  const sharedCreatorTotals = await periodSharedCreatorTotals(client, actor.ledgerId, start, end, filterSql, params.slice(3));
  const sharedPayerTotals = await periodSharedPayerTotals(client, actor.ledgerId, start, end, filterSql, params.slice(3));
  const categoryTotals = await periodCategoryTotals(client, actor.ledgerId, start, end, filterSql, params.slice(3));
  const showShared = command.filter.kind !== "personal";
  const showPersonal = command.filter.kind !== "shared";
  const reply = [
    `${title}${suffix}：${rows.rows.length} 筆，合計 ${money(sumRows(rows.rows))}`,
    ...(showShared ? [`共同：${money(scopeTotals.shared)}`] : []),
    ...(showShared && sharedCreatorTotals.length > 0
      ? [`共同記帳人：${sharedCreatorTotals.map((row) => `${row.name} ${money(row.total)}`).join("・")}`]
      : []),
    ...(showShared && sharedPayerTotals.length > 0
      ? [`共同付款人：${sharedPayerTotals.map((row) => `${row.name} ${money(row.total)}`).join("・")}`]
      : []),
    ...(showPersonal ? memberTotals.map((row) => `${row.name}個人：${money(row.total)}`) : []),
    `分類：${categoryTotals.length === 0 ? "無" : categoryTotals.map((row) => `${row.name} ${money(row.total)}`).join("・")}`,
    ...(isMonthPeriod(command.period) ? [] : rows.rows.map(formatListRow)),
  ].join("\n");
  if (isDayPeriod(command.period)) {
    return applied(reply, undefined, listCard(
      `${title}${suffix}・${rows.rows.length} 筆`,
      rows.rows,
      reply,
      "依消費時間排序",
      [{ label: "最近紀錄", text: command.filter.kind === "shared" ? "共同 最近 10筆" : "最近 10筆" }],
    ));
  }
  return applied(reply, undefined, infoCard({
    altText: reply,
    kicker: "DINERO 支出報表",
    title: `${title}${suffix}`,
    summary: money(sumRows(rows.rows)),
    rows: [
      { label: "筆數", value: `${rows.rows.length} 筆` },
      ...(showShared ? [{ label: "共同支出", value: money(scopeTotals.shared) }] : []),
      ...(showShared && sharedCreatorTotals.length > 0 ? [{
        label: "共同支出・依記帳人",
        value: sharedCreatorTotals.map((row) => `${row.name} ${money(row.total)}`).join("・"),
      }] : []),
      ...(showShared && sharedPayerTotals.length > 0 ? [{
        label: "共同支出・依付款人",
        value: sharedPayerTotals.map((row) => `${row.name} ${money(row.total)}`).join("・"),
      }] : []),
      ...(showPersonal ? memberTotals.map((row) => ({ label: `${row.name}的個人支出`, value: money(row.total) })) : []),
      { label: "分類分布", value: categoryTotals.length === 0 ? "無" : categoryTotals.map((row) => `${row.name} ${money(row.total)}`).join("・") },
    ],
    ...(rows.rows.length > 10 ? { note: `另有 ${rows.rows.length - 10} 筆未在卡片逐筆顯示，可用期間篩選或「最近 20」查看。` } : {}),
    actions: isMonthPeriod(command.period)
      ? [monthlyScopeAction(command.period, command.filter.kind, local.date), { label: "最近紀錄", text: "最近 5" }]
      : [{ label: "分類排行", text: "分類排行" }, { label: "最近紀錄", text: "最近 5" }],
  }));
}

async function querySearch(client: PoolClient, actor: CommandActor, keyword: string): Promise<LedgerCommandResult> {
  const pattern = `%${keyword.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const result = await client.query<ListRow>(
    `SELECT public_id, amount_minor::text, description, scope::text,
            occurred_on::text, occurred_at
       FROM expense_transaction
      WHERE ledger_id=$1 AND status='active' AND description ILIKE $2 ESCAPE '\\'
      ORDER BY occurred_on DESC, occurred_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT 20`,
    [actor.ledgerId, pattern],
  );
  const reply = result.rows.length === 0
    ? `找不到包含「${keyword}」的有效記帳紀錄。`
    : [`搜尋「${keyword}」：${result.rows.length} 筆`, ...result.rows.map(formatListRow), `合計：${money(sumRows(result.rows))}`].join("\n");
  if (result.rows.length === 0) return applied(reply, undefined, infoCard({ altText: reply, kicker: "DINERO 搜尋", title: `「${keyword}」`, note: "沒有找到符合的有效支出。", actions: [{ label: "最近紀錄", text: "最近 5" }] }));
  return applied(reply, undefined, listCard(`搜尋「${keyword}」`, result.rows, reply, `找到 ${result.rows.length} 筆`, [{ label: "本月報表", text: "本月" }]));
}

async function queryRanking(
  client: PoolClient,
  actor: CommandActor,
  event: CommandEvent,
  filter: Extract<LedgerCommand, { kind: "ranking" }>["filter"],
): Promise<LedgerCommandResult> {
  const local = toZonedMinute(event.eventAt, actor.timezone);
  if (local === null) return rejected("無法判定帳本日期，請稍後再試。");
  const { start, end, title } = periodRange(local.date, "month");
  let filterSql = "";
  const extra: unknown[] = [];
  if (filter.kind === "personal") {
    extra.push(actor.memberId);
    filterSql = " AND et.scope='personal' AND et.personal_owner_member_id=$4";
  } else if (filter.kind === "shared") {
    filterSql = " AND et.scope='shared'";
  }
  const categories = await periodCategoryTotals(client, actor.ledgerId, start, end, filterSql, extra);
  const total = categories.reduce((sum, row) => sum + Number(row.total), 0);
  const scopeLabel = filter.kind === "personal" ? `${actor.displayName}個人` : filter.kind === "shared" ? "共同" : "全部";
  const reply = categories.length === 0
    ? `${title}${scopeLabel}分類排行：目前沒有有效支出。`
    : [`${title}${scopeLabel}分類排行`, ...categories.map((row, index) => `${index + 1}. ${row.name} ${money(row.total)}`), `合計：${money(total)}`].join("\n");
  return applied(reply, undefined, infoCard({
    altText: reply,
    kicker: "DINERO 本月排行",
    title: `${scopeLabel}分類消費榜`,
    summary: money(total),
    rows: categories.map((row, index) => ({
      label: `#${index + 1} ${row.name}`,
      value: money(row.total),
      meta: total === 0 ? "0%" : `${Math.round(Number(row.total) / total * 100)}%`,
    })),
    note: categories.length === 0 ? "本月目前還沒有支出。" : "分類占比以本月有效支出計算。",
    actions: filter.kind === "personal"
      ? [{ label: "我的月報", text: "本月" }, { label: "共同排行", text: "分類排行 共同" }]
      : [{ label: "我的排行", text: "分類排行" }, { label: "全部排行", text: "分類排行 全部" }],
  }));
}

function periodRange(date: string, period: PeriodSelection): { start: string; end: string; title: string } {
  if (typeof period === "object") {
    const year = period.year ?? Number(date.slice(0, 4));
    const start = `${year.toString().padStart(4, "0")}-${period.month.toString().padStart(2, "0")}-01`;
    return { start, end: shiftMonth(start, 1), title: `${year}/${period.month.toString().padStart(2, "0")}` };
  }
  if (period === "today" || period === "yesterday" || period === "day_before_yesterday") {
    const offset = period === "today" ? 0 : period === "yesterday" ? -1 : -2;
    const start = shiftCalendarDate(date, offset);
    return { start, end: shiftCalendarDate(start, 1), title: period === "today" ? "今天" : period === "yesterday" ? "昨天" : "前天" };
  }
  if (period === "week" || period === "last_week") {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    const mondayOffset = (day + 6) % 7;
    const thisMonday = shiftCalendarDate(date, -mondayOffset);
    const start = period === "week" ? thisMonday : shiftCalendarDate(thisMonday, -7);
    return { start, end: shiftCalendarDate(start, 7), title: period === "week" ? "本週" : "上週" };
  }
  const thisMonth = `${date.slice(0, 7)}-01`;
  const start = period === "month" ? thisMonth : shiftMonth(thisMonth, -1);
  return { start, end: shiftMonth(start, 1), title: period === "month" ? `${start.slice(0, 4)}/${start.slice(5, 7)}` : `上月 ${start.slice(0, 4)}/${start.slice(5, 7)}` };
}

function isMonthPeriod(period: PeriodSelection): boolean {
  return typeof period === "object" || period === "month" || period === "last_month";
}

function isDayPeriod(period: PeriodSelection): boolean {
  return period === "today" || period === "yesterday" || period === "day_before_yesterday";
}

function monthlyScopeAction(
  period: PeriodSelection,
  filterKind: CommandFilter["kind"],
  eventDate: string,
): { label: string; text: string } {
  const target = filterKind === "shared" ? "個人" : "共同";
  if (typeof period !== "object") {
    return { label: `${target}月報`, text: `${target}月報` };
  }
  const year = period.year ?? Number(eventDate.slice(0, 4));
  const month = period.month;
  return {
    label: `${target}月報`,
    text: `${target}${year}年${month}月月報`,
  };
}

function shiftMonth(firstOfMonth: string, amount: number): string {
  const date = new Date(`${firstOfMonth}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 10);
}

async function periodMemberTotals(client: PoolClient, ledgerId: string, start: string, end: string, filterSql: string, extra: readonly unknown[]) {
  const result = await client.query<{ name: string; total: string }>(
    `SELECT m.display_name AS name, COALESCE(sum(et.amount_minor),0)::text AS total
       FROM member m
       LEFT JOIN expense_transaction et ON et.ledger_id=m.ledger_id
        AND et.personal_owner_member_id=m.id AND et.scope='personal' AND et.status='active'
        AND et.occurred_on >= $2::date AND et.occurred_on < $3::date${filterSql}
      WHERE m.ledger_id=$1 AND m.is_active
      GROUP BY m.id, m.display_name ORDER BY m.created_at, m.id`,
    [ledgerId, start, end, ...extra],
  );
  return result.rows;
}

async function periodSharedCreatorTotals(client: PoolClient, ledgerId: string, start: string, end: string, filterSql: string, extra: readonly unknown[]) {
  const result = await client.query<{ name: string; total: string }>(
    `SELECT m.display_name AS name, sum(et.amount_minor)::text AS total
       FROM expense_transaction et
       JOIN member m ON m.ledger_id=et.ledger_id AND m.id=et.created_by_member_id
      WHERE et.ledger_id=$1 AND et.status='active' AND et.scope='shared'
        AND et.occurred_on >= $2::date AND et.occurred_on < $3::date${filterSql}
      GROUP BY m.id,m.display_name,m.created_at
      ORDER BY sum(et.amount_minor) DESC,m.created_at,m.id`,
    [ledgerId, start, end, ...extra],
  );
  return result.rows;
}

async function periodSharedPayerTotals(client: PoolClient, ledgerId: string, start: string, end: string, filterSql: string, extra: readonly unknown[]) {
  const result = await client.query<{ name: string; total: string }>(
    `SELECT m.display_name AS name, sum(et.amount_minor)::text AS total
       FROM expense_transaction et
       JOIN member m ON m.ledger_id=et.ledger_id AND m.id=et.payer_member_id
      WHERE et.ledger_id=$1 AND et.status='active' AND et.scope='shared'
        AND et.occurred_on >= $2::date AND et.occurred_on < $3::date${filterSql}
      GROUP BY m.id,m.display_name,m.created_at
      ORDER BY sum(et.amount_minor) DESC,m.created_at,m.id`,
    [ledgerId, start, end, ...extra],
  );
  return result.rows;
}

async function periodScopeTotals(client: PoolClient, ledgerId: string, start: string, end: string, filterSql: string, extra: readonly unknown[]) {
  const result = await client.query<{ shared: string; personal: string }>(
    `SELECT COALESCE(sum(et.amount_minor) FILTER (WHERE et.scope='shared'),0)::text AS shared,
            COALESCE(sum(et.amount_minor) FILTER (WHERE et.scope='personal'),0)::text AS personal
       FROM expense_transaction et WHERE et.ledger_id=$1 AND et.status='active'
        AND et.occurred_on >= $2::date AND et.occurred_on < $3::date${filterSql}`,
    [ledgerId, start, end, ...extra],
  );
  return result.rows[0] ?? { shared: "0", personal: "0" };
}

async function periodCategoryTotals(client: PoolClient, ledgerId: string, start: string, end: string, filterSql: string, extra: readonly unknown[]) {
  const result = await client.query<{ name: string; total: string }>(
    `SELECT t.display_name AS name, sum(et.amount_minor)::text AS total
       FROM expense_transaction et
       JOIN transaction_tag tt ON tt.ledger_id=et.ledger_id AND tt.transaction_id=et.id AND tt.tag_type='category'
       JOIN tag t ON t.ledger_id=tt.ledger_id AND t.id=tt.tag_id
      WHERE et.ledger_id=$1 AND et.status='active'
        AND et.occurred_on >= $2::date AND et.occurred_on < $3::date${filterSql}
      GROUP BY t.display_name ORDER BY sum(et.amount_minor) DESC, t.display_name`,
    [ledgerId, start, end, ...extra],
  );
  return result.rows;
}

async function changeStatus(
  client: PoolClient,
  actor: CommandActor,
  event: CommandEvent,
  publicId: string,
  operation: "void" | "restore",
): Promise<LedgerCommandResult> {
  const expense = await loadExpense(client, actor.ledgerId, publicId, true);
  if (expense === null) return notFound();
  const denied = authorizeMutation(expense, actor.memberId);
  if (denied !== null) return denied;
  const desired = operation === "void" ? "voided" : "active";
  if (expense.status === desired) return noop(operation === "void" ? "這筆已取消。" : "這筆目前已是有效狀態。", publicId);
  const before = statusSnapshot(expense);
  const result = await client.query<ExpenseRow>(
    `UPDATE expense_transaction
        SET status=$3::transaction_status,
            void_reason=CASE WHEN $3='voided' THEN 'user_cancel'::void_reason ELSE NULL END,
            voided_at=CASE WHEN $3='voided' THEN clock_timestamp() ELSE NULL END,
            row_version=row_version+1
      WHERE ledger_id=$1 AND id=$2
      RETURNING status::text`,
    [actor.ledgerId, expense.id, desired],
  );
  if (result.rowCount !== 1) throw new Error("expense_status_update_failed");
  const after = { ...before, status: desired, voidReason: desired === "voided" ? "user_cancel" : null };
  await insertAudit(client, actor, event, expense.id, operation === "void" ? "voided" : "restored", ["status", "voidReason"], before, after);
  return applied(`${operation === "void" ? "已取消" : "已還原"} #${publicId}`, publicId);
}

async function changeCustomTags(
  client: PoolClient,
  actor: CommandActor,
  event: CommandEvent,
  publicId: string,
  operation: "add" | "remove",
  names: readonly string[],
): Promise<LedgerCommandResult> {
  const expense = await loadExpense(client, actor.ledgerId, publicId, true);
  if (expense === null) return notFound();
  const denied = validateMutable(expense, actor.memberId);
  if (denied !== null) return denied;
  const current = await loadCustomTags(client, actor.ledgerId, expense.id);
  const currentSet = new Set(current);
  if (operation === "add" && new Set([...current, ...names]).size > 10) return rejected("每筆最多 10 個自訂標籤。", publicId);
  const changed = operation === "add" ? names.filter((name) => !currentSet.has(name)) : names.filter((name) => currentSet.has(name));
  if (changed.length === 0) return noop(operation === "add" ? "這個標籤已存在。" : "這筆沒有指定的標籤。", publicId);
  if (operation === "add") {
    for (const name of changed) {
      const tagId = await upsertCustomTag(client, actor.ledgerId, name);
      await client.query(
        `INSERT INTO transaction_tag (ledger_id,transaction_id,tag_id,tag_type,source,rule_key,rule_version,assigned_by_member_id)
         VALUES ($1,$2,$3,'custom','explicit','parser:user_hashtag','1',$4) ON CONFLICT DO NOTHING`,
        [actor.ledgerId, expense.id, tagId, actor.memberId],
      );
    }
  } else {
    await client.query(
      `DELETE FROM transaction_tag tt USING tag t
        WHERE tt.ledger_id=$1 AND tt.transaction_id=$2 AND tt.tag_type='custom'
          AND t.id=tt.tag_id AND t.ledger_id=tt.ledger_id AND t.normalized_name = ANY($3::text[])`,
      [actor.ledgerId, expense.id, changed],
    );
  }
  await bumpVersion(client, actor.ledgerId, expense.id);
  const after = operation === "add" ? [...current, ...changed] : current.filter((name) => !changed.includes(name));
  await insertAudit(client, actor, event, expense.id, "updated", ["customTags"], { customTags: current }, { customTags: after });
  return applied(`已${operation === "add" ? "加入" : "移除"} #${publicId} 標籤：${changed.map((name) => `#${name}`).join(" ")}`, publicId);
}

async function updateExpense(
  client: PoolClient,
  actor: CommandActor,
  event: CommandEvent,
  publicId: string,
  change: UpdateChange,
): Promise<LedgerCommandResult> {
  const expense = await loadExpense(client, actor.ledgerId, publicId, true);
  if (expense === null) return notFound();
  const denied = validateMutable(expense, actor.memberId);
  if (denied !== null) return denied;

  if (change.field === "amount") {
    if (Number(expense.amount_minor) === change.value) return noop("金額沒有變更。", publicId);
    await updateColumn(client, actor.ledgerId, expense.id, "amount_minor", change.value);
    await insertAudit(client, actor, event, expense.id, "updated", ["amountMinor"], { amountMinor: Number(expense.amount_minor) }, { amountMinor: change.value });
    return applied(`已修改 #${publicId}\n金額：${money(expense.amount_minor)} → ${money(change.value)}`, publicId);
  }
  if (change.field === "tags") return replaceExplicitCustomTags(client, actor, event, expense, change.value);
  if (change.field === "description") return updateDescription(client, actor, event, expense, change.value);
  if (change.field === "category") return updateCategory(client, actor, event, expense, change.value);
  if (change.field === "meal") return updateMeal(client, actor, event, expense, change.value);
  if (change.field === "scope") return updateScope(client, actor, event, expense, change.value);
  if (change.field === "payer" || change.field === "owner") return updateMemberField(client, actor, event, expense, change.field, change.value);
  if (change.field === "date" || change.field === "time") return updateOccurrence(client, actor, event, expense, change);
  return rejected("不支援的修改。", publicId);
}

async function updateDescription(client: PoolClient, actor: CommandActor, event: CommandEvent, expense: ExpenseRow, value: string) {
  if (expense.description === value) return noop("項目沒有變更。", expense.public_id);
  const knowledge = expense.category_source === "inferred"
    ? await resolveCategoryKnowledge(client, actor.ledgerId, value)
    : null;
  const inferredCategory = expense.category_source === "inferred"
    ? knowledge?.category ?? classifyDescription(value)
    : null;
  if (inferredCategory !== null && inferredCategory.code !== "food" && expense.meal_source === "explicit") {
    return rejected("修改後會讓明確餐別與非食物分類衝突，請先將餐別改為無。", expense.public_id);
  }
  await updateColumn(client, actor.ledgerId, expense.id, "description", value);
  if (inferredCategory !== null) {
    await replaceSystemTag(client, actor, expense.id, "category", inferredCategory.code, "inferred", inferredCategory.ruleKey);
    expense.category_code = inferredCategory.code;
  }
  if (expense.meal_source === "inferred") {
    const localTime = expense.occurred_at === null ? null : toZonedMinute(expense.occurred_at, actor.timezone)?.time ?? null;
    const meal = inferMeal(value, expense.category_code, localTime, knowledge?.mealEligible ?? false);
    await setInferredMeal(client, actor, expense.id, meal?.code ?? null, meal?.ruleKey ?? null);
  }
  await syncInferredContextTags(client, actor, expense.id, value);
  await insertAudit(client, actor, event, expense.id, "updated", ["description"], { description: expense.description }, { description: value });
  return applied(`已修改 #${expense.public_id}\n項目：${expense.description} → ${value}`, expense.public_id);
}

async function updateCategory(client: PoolClient, actor: CommandActor, event: CommandEvent, expense: ExpenseRow, value: CategoryCode | "auto") {
  const knowledge = value === "auto"
    ? await resolveCategoryKnowledge(client, actor.ledgerId, expense.description)
    : null;
  const assignment = value === "auto"
    ? knowledge?.category ?? classifyDescription(expense.description)
    : { code: value, ruleKey: "manual:category" };
  if (assignment.code !== "food" && expense.meal_source === "explicit") return rejected("非食物分類不能保留明確餐別，請先將餐別改為無。", expense.public_id);
  const source = value === "auto" ? "inferred" : "explicit";
  if (expense.category_code === assignment.code && expense.category_source === source) return noop("分類沒有變更。", expense.public_id);
  await replaceSystemTag(client, actor, expense.id, "category", assignment.code, source, assignment.ruleKey);
  if (assignment.code !== "food") await deleteMealTag(client, actor.ledgerId, expense.id);
  else if (expense.meal_source !== "explicit") {
    const time = expense.occurred_at === null ? null : toZonedMinute(expense.occurred_at, actor.timezone)?.time ?? null;
    const meal = inferMeal(expense.description, assignment.code, time, knowledge?.mealEligible ?? false);
    await setInferredMeal(client, actor, expense.id, meal?.code ?? null, meal?.ruleKey ?? null);
  }
  await bumpVersion(client, actor.ledgerId, expense.id);
  if (value !== "auto") {
    await learnCategoryCorrection(client, actor.ledgerId, expense.description, value);
  }
  await insertAudit(client, actor, event, expense.id, "updated", ["category"], { category: expense.category_name }, { category: CATEGORY_DISPLAY_NAMES[assignment.code] });
  return applied(`已修改 #${expense.public_id}\n分類：${expense.category_name} → ${CATEGORY_DISPLAY_NAMES[assignment.code]}`, expense.public_id);
}

async function updateMeal(client: PoolClient, actor: CommandActor, event: CommandEvent, expense: ExpenseRow, value: MealCode | "auto" | "none") {
  if (value !== "none" && expense.category_code !== "food") return rejected("只有食物分類可以設定餐別。", expense.public_id);
  let code: MealCode | null;
  let source: "explicit" | "inferred" | null;
  let ruleKey: string | null;
  if (value === "none") [code, source, ruleKey] = [null, null, null];
  else if (value === "auto") {
    const time = expense.occurred_at === null ? null : toZonedMinute(expense.occurred_at, actor.timezone)?.time ?? null;
    const inferred = inferMeal(expense.description, expense.category_code, time);
    [code, source, ruleKey] = [inferred?.code ?? null, inferred === null ? null : "inferred", inferred?.ruleKey ?? null];
  } else [code, source, ruleKey] = [value, "explicit", "manual:meal"];
  if (expense.meal_code === code && expense.meal_source === source) return noop("餐別沒有變更。", expense.public_id);
  await deleteMealTag(client, actor.ledgerId, expense.id);
  if (code !== null && source !== null) await insertSystemTag(client, actor, expense.id, "meal", code, source, ruleKey!);
  await bumpVersion(client, actor.ledgerId, expense.id);
  await insertAudit(client, actor, event, expense.id, "updated", ["meal"], { meal: expense.meal_name }, { meal: code === null ? null : MEAL_DISPLAY_NAMES[code] });
  return applied(`已修改 #${expense.public_id}\n餐別：${expense.meal_name ?? "無"} → ${code === null ? "無" : MEAL_DISPLAY_NAMES[code]}`, expense.public_id);
}

async function updateScope(client: PoolClient, actor: CommandActor, event: CommandEvent, expense: ExpenseRow, value: "shared" | "personal") {
  if (expense.scope === value) return noop("範圍沒有變更。", expense.public_id);
  await client.query(
    `UPDATE expense_transaction SET scope=$3::expense_scope,
       personal_owner_member_id=CASE WHEN $3='personal' THEN $4::uuid ELSE NULL END,
       row_version=row_version+1 WHERE ledger_id=$1 AND id=$2`,
    [actor.ledgerId, expense.id, value, actor.memberId],
  );
  await insertAudit(client, actor, event, expense.id, "updated", ["scope", "owner"], { scope: expense.scope, owner: expense.owner_name }, { scope: value, owner: value === "personal" ? actor.displayName : null });
  return applied(`已修改 #${expense.public_id}\n範圍：${expense.scope === "shared" ? "共同" : "個人"} → ${value === "shared" ? "共同" : "個人"}`, expense.public_id);
}

async function updateMemberField(client: PoolClient, actor: CommandActor, event: CommandEvent, expense: ExpenseRow, field: "payer" | "owner", name: string) {
  if (field === "owner" && expense.scope !== "personal") return rejected("只有個人支出可以設定所有人。", expense.public_id);
  if (field === "payer" && expense.scope !== "shared") return rejected("只有共同支出可以修改付款人。", expense.public_id);
  let member: { id: string; name: string } | null;
  if (field === "payer") {
    const pair = await loadPaymentPair(client, actor);
    if (pair === null) return rejected("修改付款人只適用於剛好兩位已配對成員的帳本。", expense.public_id);
    const normalized = name.normalize("NFKC").trim();
    if (["我", "自己", "本人"].includes(normalized)) member = pair.self;
    else if (["對方", "另一位", "另一半"].includes(normalized)) member = pair.partner;
    else return rejected("付款人只能改成「我」或「對方」。", expense.public_id);
  } else {
    member = await resolveMemberReference(client, actor, name);
  }
  if (member === null) return rejected("找不到唯一符合的帳本成員。", expense.public_id);
  const oldId = field === "payer" ? expense.payer_member_id : expense.personal_owner_member_id;
  const oldName = field === "payer" ? expense.payer_name : expense.owner_name;
  if (oldId === member.id) return noop(`${field === "payer" ? "付款人" : "所有人"}沒有變更。`, expense.public_id);
  await updateColumn(client, actor.ledgerId, expense.id, field === "payer" ? "payer_member_id" : "personal_owner_member_id", member.id);
  await insertAudit(client, actor, event, expense.id, "updated", [field], { [field]: oldName }, { [field]: member.name });
  return applied(`已修改 #${expense.public_id}\n${field === "payer" ? "付款人" : "所有人"}：${oldName} → ${member.name}`, expense.public_id);
}

async function updateOccurrence(client: PoolClient, actor: CommandActor, event: CommandEvent, expense: ExpenseRow, change: Extract<UpdateChange, { field: "date" | "time" }>) {
  const eventLocal = toZonedMinute(event.eventAt, actor.timezone);
  if (eventLocal === null) return rejected("無法判定修改時間。", expense.public_id);
  const oldLocalTime = expense.occurred_at === null ? null : toZonedMinute(expense.occurred_at, actor.timezone)?.time ?? null;
  let date = expense.occurred_on;
  let time = oldLocalTime;
  if (change.field === "date") {
    date = change.value === "今天" ? eventLocal.date : change.value === "昨天" ? shiftCalendarDate(eventLocal.date, -1) : parseAbsoluteDateToken(change.value) ?? "";
    if (date.length === 0) return rejected("日期不存在，請使用有效的 YYYY-MM-DD。", expense.public_id);
  } else time = change.value;
  const minuteInstant = time === null ? null : zonedLocalMinuteToInstant(date, time, actor.timezone);
  const preservedSubMinute = change.field === "date" && expense.occurred_at !== null
    ? expense.occurred_at.getTime() % 60_000
    : 0;
  const instant = minuteInstant === null
    ? null
    : new Date(new Date(minuteInstant).getTime() + preservedSubMinute).toISOString();
  if (time !== null && instant === null) return rejected("這個日期時間在帳本時區不存在。", expense.public_id);
  if (instant !== null && new Date(instant).getTime() > event.eventAt.getTime()) return rejected("不能把交易修改到未來。", expense.public_id);
  if (date > eventLocal.date) return rejected("不能把交易修改到未來。", expense.public_id);
  if (date === expense.occurred_on && time === oldLocalTime) return noop("日期時間沒有變更。", expense.public_id);
  await client.query(
    `UPDATE expense_transaction SET occurred_on=$3::date, occurred_date_source='manual_update',
       occurred_at=$4::timestamptz, occurred_time_source=CASE WHEN $4::timestamptz IS NULL THEN NULL ELSE 'manual_update'::occurred_time_source END,
       occurred_time_precision=$5::time_precision,
       row_version=row_version+1 WHERE ledger_id=$1 AND id=$2`,
    [actor.ledgerId, expense.id, date, instant,
      instant === null ? "unknown" : change.field === "date" ? expense.occurred_time_precision : "minute"],
  );
  if (expense.meal_source === "inferred") {
    const meal = inferMeal(expense.description, expense.category_code, time);
    await setInferredMeal(client, actor, expense.id, meal?.code ?? null, meal?.ruleKey ?? null);
  }
  await insertAudit(client, actor, event, expense.id, "updated", [change.field], { occurredOn: expense.occurred_on, occurredTime: oldLocalTime }, { occurredOn: date, occurredTime: time });
  return applied(`已修改 #${expense.public_id}\n時間：${slashDate(expense.occurred_on)} ${oldLocalTime ?? "未知"} → ${slashDate(date)} ${time ?? "未知"}`, expense.public_id);
}

async function loadExpense(client: PoolClient, ledgerId: string, publicId: string, lock: boolean): Promise<ExpenseRow | null> {
  const result = await client.query<ExpenseRow>(
    `SELECT et.id::text, et.public_id, et.status::text, et.scope::text, et.amount_minor::text,
            et.description, et.occurred_on::text, et.occurred_at, et.occurred_time_precision::text,
            et.payer_member_id::text, payer.display_name AS payer_name,
            et.personal_owner_member_id::text, owner.display_name AS owner_name,
            category.code AS category_code, category.display_name AS category_name, ctt.source::text AS category_source,
            meal.code AS meal_code, meal.display_name AS meal_name, mtt.source::text AS meal_source
       FROM expense_transaction et
       JOIN member payer ON payer.ledger_id=et.ledger_id AND payer.id=et.payer_member_id
       LEFT JOIN member owner ON owner.ledger_id=et.ledger_id AND owner.id=et.personal_owner_member_id
       JOIN transaction_tag ctt ON ctt.ledger_id=et.ledger_id AND ctt.transaction_id=et.id AND ctt.tag_type='category'
       JOIN tag category ON category.ledger_id=ctt.ledger_id AND category.id=ctt.tag_id
       LEFT JOIN transaction_tag mtt ON mtt.ledger_id=et.ledger_id AND mtt.transaction_id=et.id AND mtt.tag_type='meal'
       LEFT JOIN tag meal ON meal.ledger_id=mtt.ledger_id AND meal.id=mtt.tag_id
      WHERE et.ledger_id=$1 AND et.public_id=$2${lock ? " FOR UPDATE OF et" : ""}`,
    [ledgerId, publicId],
  );
  return result.rows[0] ?? null;
}

async function loadTagNames(client: PoolClient, ledgerId: string, transactionId: string): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `SELECT t.display_name AS name FROM transaction_tag tt JOIN tag t ON t.ledger_id=tt.ledger_id AND t.id=tt.tag_id
      WHERE tt.ledger_id=$1 AND tt.transaction_id=$2 ORDER BY tt.tag_type, tt.created_at, t.display_name`,
    [ledgerId, transactionId],
  );
  return result.rows.map((row) => row.name);
}

async function loadCustomTags(client: PoolClient, ledgerId: string, transactionId: string): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `SELECT t.normalized_name AS name FROM transaction_tag tt JOIN tag t ON t.ledger_id=tt.ledger_id AND t.id=tt.tag_id
      WHERE tt.ledger_id=$1 AND tt.transaction_id=$2 AND tt.tag_type='custom' ORDER BY t.normalized_name`,
    [ledgerId, transactionId],
  );
  return result.rows.map((row) => row.name);
}

async function loadExplicitCustomTags(client: PoolClient, ledgerId: string, transactionId: string): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `SELECT t.normalized_name AS name FROM transaction_tag tt JOIN tag t ON t.ledger_id=tt.ledger_id AND t.id=tt.tag_id
      WHERE tt.ledger_id=$1 AND tt.transaction_id=$2 AND tt.tag_type='custom' AND tt.source='explicit'
      ORDER BY t.normalized_name`,
    [ledgerId, transactionId],
  );
  return result.rows.map((row) => row.name);
}

async function replaceExplicitCustomTags(
  client: PoolClient,
  actor: CommandActor,
  event: CommandEvent,
  expense: ExpenseRow,
  names: readonly string[],
): Promise<LedgerCommandResult> {
  const current = await loadExplicitCustomTags(client, actor.ledgerId, expense.id);
  const before = [...current].sort();
  const categoryCodes = names.flatMap((name) => {
    const entry = Object.entries(CATEGORY_DISPLAY_NAMES).find(([, displayName]) => displayName === name);
    return entry === undefined ? [] : [entry[0] as CategoryCode];
  });
  const mealCodes = names.flatMap((name) => {
    const entry = Object.entries(MEAL_DISPLAY_NAMES).find(([, displayName]) => displayName === name);
    return entry === undefined ? [] : [entry[0] as MealCode];
  });
  if (new Set(categoryCodes).size > 1) return rejected("一次只能設定一個分類標籤。", expense.public_id);
  if (new Set(mealCodes).size > 1) return rejected("一次只能設定一個餐別標籤。", expense.public_id);
  const requestedCategory = categoryCodes[0] ?? null;
  const requestedMeal = mealCodes[0] ?? null;
  const effectiveCategory = requestedCategory ?? expense.category_code;
  if (requestedMeal !== null && effectiveCategory !== "food") {
    return rejected("早餐、午餐等餐別必須搭配 #食物。", expense.public_id);
  }
  const systemNames = new Set<string>([
    ...Object.values(CATEGORY_DISPLAY_NAMES),
    ...Object.values(MEAL_DISPLAY_NAMES),
  ]);
  const after = [...new Set(names.filter((name) => !systemNames.has(name)))].sort();
  const customUnchanged = before.length === after.length && before.every((name, index) => name === after[index]);
  const categoryUnchanged = requestedCategory === null ||
    (expense.category_code === requestedCategory && expense.category_source === "explicit");
  const mealUnchanged = requestedMeal === null ||
    (expense.meal_code === requestedMeal && expense.meal_source === "explicit");
  if (customUnchanged && categoryUnchanged && mealUnchanged) {
    return noop("標籤沒有變更。", expense.public_id);
  }
  if (requestedCategory !== null && !categoryUnchanged) {
    await replaceSystemTag(client, actor, expense.id, "category", requestedCategory, "explicit", "manual:card_tags");
    await learnCategoryCorrection(client, actor.ledgerId, expense.description, requestedCategory);
    if (requestedCategory !== "food") await deleteMealTag(client, actor.ledgerId, expense.id);
  }
  if (requestedMeal !== null && !mealUnchanged) {
    await replaceSystemTag(client, actor, expense.id, "meal", requestedMeal, "explicit", "manual:card_tags");
  }
  if (!customUnchanged) {
    await client.query(
      "DELETE FROM transaction_tag WHERE ledger_id=$1 AND transaction_id=$2 AND tag_type='custom' AND source='explicit'",
      [actor.ledgerId, expense.id],
    );
    for (const name of after) {
      const tagId = await upsertCustomTag(client, actor.ledgerId, name);
      await client.query(
        `INSERT INTO transaction_tag (ledger_id,transaction_id,tag_id,tag_type,source,rule_key,rule_version,assigned_by_member_id)
         VALUES ($1,$2,$3,'custom','explicit','manual:replace_tags','1',$4)`,
        [actor.ledgerId, expense.id, tagId, actor.memberId],
      );
    }
  }
  await bumpVersion(client, actor.ledgerId, expense.id);
  const changedFields = [
    ...(!categoryUnchanged ? ["category"] : []),
    ...(!mealUnchanged ? ["meal"] : []),
    ...(!customUnchanged ? ["customTags"] : []),
  ];
  await insertAudit(client, actor, event, expense.id, "updated", changedFields,
    { category: expense.category_name, meal: expense.meal_name, customTags: before },
    {
      category: requestedCategory === null ? expense.category_name : CATEGORY_DISPLAY_NAMES[requestedCategory],
      meal: requestedMeal === null ? expense.meal_name : MEAL_DISPLAY_NAMES[requestedMeal],
      customTags: after,
    });
  return applied(
    `已修改 #${expense.public_id}\n標籤：${names.length === 0 ? "無" : names.map((name) => `#${name}`).join(" ")}`,
    expense.public_id,
  );
}

async function replaceSystemTag(client: PoolClient, actor: CommandActor, transactionId: string, type: "category" | "meal", code: string, source: "explicit" | "inferred", ruleKey: string) {
  await client.query("DELETE FROM transaction_tag WHERE ledger_id=$1 AND transaction_id=$2 AND tag_type=$3", [actor.ledgerId, transactionId, type]);
  await insertSystemTag(client, actor, transactionId, type, code, source, ruleKey);
}

async function insertSystemTag(client: PoolClient, actor: CommandActor, transactionId: string, type: "category" | "meal", code: string, source: "explicit" | "inferred", ruleKey: string) {
  await client.query(
    `INSERT INTO transaction_tag (ledger_id,transaction_id,tag_id,tag_type,source,rule_key,rule_version,assigned_by_member_id)
     SELECT $1,$2,t.id,$3::tag_type,$5::assignment_source,$6,'1',CASE WHEN $5='explicit' THEN $7::uuid ELSE NULL END
       FROM tag t WHERE t.ledger_id=$1 AND t.type=$3 AND t.code=$4 AND t.is_active`,
    [actor.ledgerId, transactionId, type, code, source, ruleKey, actor.memberId],
  );
}

async function setInferredMeal(client: PoolClient, actor: CommandActor, transactionId: string, code: MealCode | null, ruleKey: string | null) {
  await deleteMealTag(client, actor.ledgerId, transactionId);
  if (code !== null) await insertSystemTag(client, actor, transactionId, "meal", code, "inferred", ruleKey!);
}

async function syncInferredContextTags(
  client: PoolClient,
  actor: CommandActor,
  transactionId: string,
  description: string,
) {
  await client.query(
    "DELETE FROM transaction_tag WHERE ledger_id=$1 AND transaction_id=$2 AND tag_type='custom' AND source='inferred'",
    [actor.ledgerId, transactionId],
  );
  for (const assignment of inferContextTags(description)) {
    await client.query(
      `INSERT INTO transaction_tag (
         ledger_id,transaction_id,tag_id,tag_type,source,rule_key,rule_version,assigned_by_member_id
       )
       SELECT $1,$2,t.id,'custom','inferred',$4,$5,NULL
         FROM tag t
        WHERE t.ledger_id=$1 AND t.type='custom' AND t.code=$3 AND t.is_system AND t.is_active
       ON CONFLICT DO NOTHING`,
      [actor.ledgerId, transactionId, assignment.code, assignment.ruleKey, assignment.ruleVersion],
    );
  }
}

async function deleteMealTag(client: PoolClient, ledgerId: string, transactionId: string) {
  await client.query("DELETE FROM transaction_tag WHERE ledger_id=$1 AND transaction_id=$2 AND tag_type='meal'", [ledgerId, transactionId]);
}

async function upsertCustomTag(client: PoolClient, ledgerId: string, name: string): Promise<string> {
  const existing = await client.query<{ id: string; type: string }>(
    "SELECT id::text, type::text FROM tag WHERE ledger_id=$1 AND normalized_name=$2 AND is_active",
    [ledgerId, name],
  );
  if (existing.rows[0]?.type === "custom") return existing.rows[0].id;
  if (existing.rowCount !== 0) throw new Error("reserved_system_tag_name");
  const result = await client.query<{ id: string }>(
    `INSERT INTO tag (ledger_id,type,code,display_name,normalized_name,is_system,is_active)
     VALUES ($1,'custom',encode(digest($2::text,'sha256'::text),'hex'),$2,$2,false,true)
     ON CONFLICT (ledger_id,normalized_name) WHERE is_active DO UPDATE SET updated_at=tag.updated_at
     RETURNING id::text`,
    [ledgerId, name],
  );
  return result.rows[0]!.id;
}

async function resolveMember(client: PoolClient, ledgerId: string, name: string): Promise<{ id: string; name: string } | null> {
  const result = await client.query<{ id: string; name: string }>(
    `SELECT id::text, display_name AS name FROM member WHERE ledger_id=$1 AND is_active
      AND (lower(btrim(display_name))=lower(btrim($2)) OR lower(btrim(command_alias))=lower(btrim($2))) LIMIT 2`,
    [ledgerId, name],
  );
  return result.rows.length === 1 ? result.rows[0]! : null;
}

async function resolveMemberReference(
  client: PoolClient,
  actor: CommandActor,
  reference: string,
): Promise<{ id: string; name: string } | null> {
  const normalized = reference.normalize("NFKC").trim();
  if (["我", "自己", "本人"].includes(normalized)) {
    const result = await client.query<{ id: string; name: string }>(
      "SELECT id::text,display_name AS name FROM member WHERE ledger_id=$1 AND id=$2 AND is_active",
      [actor.ledgerId, actor.memberId],
    );
    return result.rows[0] ?? null;
  }
  if (["對方", "另一位", "另一半"].includes(normalized)) {
    const result = await client.query<{ id: string; name: string }>(
      `SELECT id::text,display_name AS name FROM member
        WHERE ledger_id=$1 AND id<>$2 AND is_active ORDER BY created_at,id LIMIT 2`,
      [actor.ledgerId, actor.memberId],
    );
    return result.rows.length === 1 ? result.rows[0]! : null;
  }
  return resolveMember(client, actor.ledgerId, normalized);
}

async function loadPaymentPair(
  client: PoolClient,
  actor: CommandActor,
): Promise<{ self: { id: string; name: string }; partner: { id: string; name: string } } | null> {
  const result = await client.query<{ id: string; name: string }>(
    `SELECT id::text,display_name AS name FROM member
      WHERE ledger_id=$1 AND is_active ORDER BY created_at,id`,
    [actor.ledgerId],
  );
  if (result.rows.length !== 2) return null;
  const self = result.rows.find((row) => row.id === actor.memberId);
  const partner = result.rows.find((row) => row.id !== actor.memberId);
  return self === undefined || partner === undefined ? null : { self, partner };
}

async function updateColumn(client: PoolClient, ledgerId: string, transactionId: string, column: "amount_minor" | "description" | "payer_member_id" | "personal_owner_member_id", value: string | number) {
  await client.query(`UPDATE expense_transaction SET ${column}=$3, row_version=row_version+1 WHERE ledger_id=$1 AND id=$2`, [ledgerId, transactionId, value]);
}

async function bumpVersion(client: PoolClient, ledgerId: string, transactionId: string) {
  await client.query("UPDATE expense_transaction SET row_version=row_version+1 WHERE ledger_id=$1 AND id=$2", [ledgerId, transactionId]);
}

async function insertAudit(client: PoolClient, actor: CommandActor, event: CommandEvent, transactionId: string, type: "updated" | "voided" | "restored", fields: readonly string[], before: object, after: object) {
  await client.query(
    `INSERT INTO transaction_event (ledger_id,transaction_id,actor_member_id,source_webhook_event_id,event_type,changed_fields,before_data,after_data,schema_version)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,1)`,
    [actor.ledgerId, transactionId, actor.memberId, event.webhookEventId, type, JSON.stringify(fields), JSON.stringify(before), JSON.stringify(after)],
  );
}

function validateMutable(expense: ExpenseRow, memberId: string): LedgerCommandResult | null {
  const denied = authorizeMutation(expense, memberId);
  if (denied !== null) return denied;
  return expense.status === "voided" ? rejected("請先還原這筆紀錄。", expense.public_id) : null;
}

function authorizeMutation(expense: ExpenseRow, memberId: string): LedgerCommandResult | null {
  return expense.scope === "personal" && expense.personal_owner_member_id !== memberId
    ? rejected("只有這筆個人支出的所有人可修改、取消或還原。", expense.public_id)
    : null;
}

function listCard(title: string, rows: readonly ListRow[], altText: string, note: string, actions: readonly { label: string; text: string }[]): LineReplyMessage {
  const visible = rows.slice(0, 20);
  return infoCard({
    altText,
    kicker: "DINERO 記帳列表",
    title,
    summary: money(sumRows(rows)),
    rows: visible.map((row) => ({
      label: `${slashDate(row.occurred_on)}・${row.scope === "shared" ? "共同" : "個人"}`,
      value: `${row.description}　${money(row.amount_minor)}`,
      meta: `#${row.public_id}`,
      action: { label: "編輯", text: `查 #${row.public_id}` },
    })),
    note: rows.length > visible.length ? `${note}；卡片顯示前 ${visible.length} 筆，共 ${rows.length} 筆。` : note,
    actions,
  });
}

async function withRefreshedDetail(
  client: PoolClient,
  actor: CommandActor,
  result: LedgerCommandResult,
): Promise<LedgerCommandResult> {
  if (result.outcome === "rejected" || result.publicId === undefined) return result;
  const detail = await queryDetail(client, actor, result.publicId);
  return detail.message === undefined ? result : { ...result, message: detail.message };
}

function statusSnapshot(expense: ExpenseRow) { return { status: expense.status, voidReason: expense.status === "voided" ? "user_cancel" : null }; }
function formatListRow(row: ListRow) { return `#${row.public_id}｜${slashDate(row.occurred_on)}｜${row.scope === "shared" ? "共同" : "個人"}｜${row.description}｜${money(row.amount_minor)}`; }
function slashDate(value: string) { return value.replaceAll("-", "/"); }
function sumRows(rows: readonly ListRow[]) { return rows.reduce((sum, row) => sum + Number(row.amount_minor), 0); }
function money(value: string | number) { return `${new Intl.NumberFormat("zh-TW").format(Number(value))} 元`; }
function applied(reply: string, publicId?: string, message?: LineReplyMessage): LedgerCommandResult { return { outcome: "applied", reply, ...(message === undefined ? {} : { message }), ...(publicId === undefined ? {} : { publicId }) }; }
function rejected(reply: string, publicId?: string): LedgerCommandResult { return { outcome: "rejected", reply, ...(publicId === undefined ? {} : { publicId }) }; }
function noop(reply: string, publicId?: string): LedgerCommandResult { return { outcome: "noop", reply, ...(publicId === undefined ? {} : { publicId }) }; }
function notFound() { return rejected("找不到這筆交易。請確認編號是否正確。"); }
