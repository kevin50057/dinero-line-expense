import type { PoolClient } from "pg";

import {
  CATEGORY_DISPLAY_NAMES,
  MEAL_DISPLAY_NAMES,
  classifyDescription,
  inferMeal,
  parseAbsoluteDateToken,
  shiftCalendarDate,
  toZonedMinute,
  zonedLocalMinuteToInstant,
} from "../domain/index.js";
import type {
  CategoryCode,
  LedgerCommand,
  MealCode,
  UpdateChange,
} from "../domain/index.js";
import { helpCards, infoCard } from "../application/line-cards.js";
import type { LineReplyMessage } from "../outbox/payload.js";

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
        "記帳：牛肉麵 150 #工作（初始為個人模式）",
        "個人：個人 咖啡 80",
        "模式：切換共同模式、切換個人模式、目前模式",
        "查詢：最近、今天、週報、本月、找 關鍵字、分類排行",
        "修改：改 #編號 金額 180",
        "標籤：加 #編號 標籤 #約會",
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
        ], note: "你也可以加 #約會、#台南 等自訂標籤。", actions: [{ label: "標籤說明", text: "標籤" }] }));
      }
    case "tags_help":
      {
        const reply = "每筆會有 1 個分類、最多 1 個餐別，另可加最多 10 個自訂標籤。\n範例：牛肉麵 150 #約會";
        return applied(reply, undefined, infoCard({ altText: reply, kicker: "DINERO 自訂整理", title: "用標籤留下情境", rows: [
          { label: "新增時", value: "牛肉麵 150 #約會 #台北" },
          { label: "事後加入", value: "加 #編號 標籤 #約會" },
          { label: "依標籤查詢", value: "本月 #約會" },
        ], note: "每筆最多 10 個自訂標籤。", actions: [{ label: "看分類", text: "分類" }] }));
      }
    case "detail":
      return queryDetail(client, actor, command.publicId);
    case "recent":
      return queryRecent(client, actor, command.limit);
    case "period":
      return queryPeriod(client, actor, event, command);
    case "search":
      return querySearch(client, actor, command.keyword);
    case "ranking":
      return queryRanking(client, actor, event);
    case "mode":
      return changeLedgerMode(client, actor, command.scope);
    case "void":
    case "restore":
      return changeStatus(client, actor, event, command.publicId, command.kind);
    case "tags":
      return changeCustomTags(client, actor, event, command.publicId, command.operation, command.tags);
    case "update":
      return updateExpense(client, actor, event, command.publicId, command.change);
  }
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
    actions: expense.status === "active"
      ? [{ label: "取消這筆", text: `取消 #${expense.public_id}` }]
      : [{ label: "還原這筆", text: `還原 #${expense.public_id}` }],
  }));
}

async function queryRecent(client: PoolClient, actor: CommandActor, limit: number): Promise<LedgerCommandResult> {
  const result = await client.query<ListRow>(
    `SELECT public_id, amount_minor::text, description, scope::text,
            occurred_on::text, occurred_at
       FROM expense_transaction
      WHERE ledger_id = $1 AND status = 'active'
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [actor.ledgerId, limit],
  );
  if (result.rows.length === 0) return applied("目前沒有有效的記帳紀錄。");
  const reply = [
    `最近 ${result.rows.length} 筆`,
    ...result.rows.map(formatListRow),
    `合計：${money(sumRows(result.rows))}`,
  ].join("\n");
  return applied(reply, undefined, listCard(`最近 ${result.rows.length} 筆`, result.rows, reply, "按輸入時間排序", [
    { label: "本月報表", text: "本月" }, { label: "找一筆", text: "說明" },
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
  const suffix = command.filter.kind === "all" ? "" : command.filter.kind === "tag" ? ` #${command.filter.name}` : command.filter.kind === "shared" ? " 共同" : " 個人";
  if (rows.rows.length === 0) {
    const reply = `${title}${suffix}：0 筆，合計 0 元`;
    return applied(reply, undefined, infoCard({ altText: reply, kicker: "DINERO 支出報表", title: `${title}${suffix}`, summary: "0 元", note: "這個期間目前沒有符合條件的支出。", actions: [{ label: "最近紀錄", text: "最近 5" }] }));
  }

  const scopeTotals = await periodScopeTotals(client, actor.ledgerId, start, end, filterSql, params.slice(3));
  const memberTotals = await periodMemberTotals(client, actor.ledgerId, start, end, filterSql, params.slice(3));
  const categoryTotals = await periodCategoryTotals(client, actor.ledgerId, start, end, filterSql, params.slice(3));
  const reply = [
    `${title}${suffix}：${rows.rows.length} 筆，合計 ${money(sumRows(rows.rows))}`,
    `共同：${money(scopeTotals.shared)}`,
    ...memberTotals.map((row) => `${row.name}個人：${money(row.total)}`),
    `分類：${categoryTotals.length === 0 ? "無" : categoryTotals.map((row) => `${row.name} ${money(row.total)}`).join("・")}`,
    ...(command.period === "month" || command.period === "last_month" ? [] : rows.rows.map(formatListRow)),
  ].join("\n");
  return applied(reply, undefined, infoCard({
    altText: reply,
    kicker: "DINERO 支出報表",
    title: `${title}${suffix}`,
    summary: money(sumRows(rows.rows)),
    rows: [
      { label: "筆數", value: `${rows.rows.length} 筆` },
      { label: "共同支出", value: money(scopeTotals.shared) },
      ...memberTotals.map((row) => ({ label: `${row.name}的個人支出`, value: money(row.total) })),
      { label: "分類分布", value: categoryTotals.length === 0 ? "無" : categoryTotals.map((row) => `${row.name} ${money(row.total)}`).join("・") },
    ],
    ...(rows.rows.length > 10 ? { note: `另有 ${rows.rows.length - 10} 筆未在卡片逐筆顯示，可用期間篩選或「最近 20」查看。` } : {}),
    actions: [{ label: "分類排行", text: "分類排行" }, { label: "最近紀錄", text: "最近 5" }],
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

async function queryRanking(client: PoolClient, actor: CommandActor, event: CommandEvent): Promise<LedgerCommandResult> {
  const local = toZonedMinute(event.eventAt, actor.timezone);
  if (local === null) return rejected("無法判定帳本日期，請稍後再試。");
  const { start, end, title } = periodRange(local.date, "month");
  const categories = await periodCategoryTotals(client, actor.ledgerId, start, end, "", []);
  const total = categories.reduce((sum, row) => sum + Number(row.total), 0);
  const reply = categories.length === 0
    ? `${title}分類排行：目前沒有有效支出。`
    : [`${title}分類排行`, ...categories.map((row, index) => `${index + 1}. ${row.name} ${money(row.total)}`), `合計：${money(total)}`].join("\n");
  return applied(reply, undefined, infoCard({
    altText: reply,
    kicker: "DINERO 本月排行",
    title: "分類消費榜",
    summary: money(total),
    rows: categories.map((row, index) => ({
      label: `#${index + 1} ${row.name}`,
      value: money(row.total),
      meta: total === 0 ? "0%" : `${Math.round(Number(row.total) / total * 100)}%`,
    })),
    note: categories.length === 0 ? "本月目前還沒有支出。" : "分類占比以本月有效支出計算。",
    actions: [{ label: "本月明細", text: "本月" }, { label: "上月報表", text: "上月" }],
  }));
}

function periodRange(date: string, period: Extract<LedgerCommand, { kind: "period" }>["period"]): { start: string; end: string; title: string } {
  if (period === "today" || period === "yesterday") {
    const start = period === "today" ? date : shiftCalendarDate(date, -1);
    return { start, end: shiftCalendarDate(start, 1), title: period === "today" ? "今天" : "昨天" };
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
  const inferredCategory = expense.category_source === "inferred" ? classifyDescription(value) : null;
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
    const meal = inferMeal(value, expense.category_code, localTime);
    await setInferredMeal(client, actor, expense.id, meal?.code ?? null, meal?.ruleKey ?? null);
  }
  await insertAudit(client, actor, event, expense.id, "updated", ["description"], { description: expense.description }, { description: value });
  return applied(`已修改 #${expense.public_id}\n項目：${expense.description} → ${value}`, expense.public_id);
}

async function updateCategory(client: PoolClient, actor: CommandActor, event: CommandEvent, expense: ExpenseRow, value: CategoryCode | "auto") {
  const assignment = value === "auto" ? classifyDescription(expense.description) : { code: value, ruleKey: "manual:category" };
  if (assignment.code !== "food" && expense.meal_source === "explicit") return rejected("非食物分類不能保留明確餐別，請先將餐別改為無。", expense.public_id);
  const source = value === "auto" ? "inferred" : "explicit";
  if (expense.category_code === assignment.code && expense.category_source === source) return noop("分類沒有變更。", expense.public_id);
  await replaceSystemTag(client, actor, expense.id, "category", assignment.code, source, assignment.ruleKey);
  if (assignment.code !== "food") await deleteMealTag(client, actor.ledgerId, expense.id);
  else if (expense.meal_source !== "explicit") {
    const time = expense.occurred_at === null ? null : toZonedMinute(expense.occurred_at, actor.timezone)?.time ?? null;
    const meal = inferMeal(expense.description, assignment.code, time);
    await setInferredMeal(client, actor, expense.id, meal?.code ?? null, meal?.ruleKey ?? null);
  }
  await bumpVersion(client, actor.ledgerId, expense.id);
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
  const member = await resolveMember(client, actor.ledgerId, name);
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

async function deleteMealTag(client: PoolClient, ledgerId: string, transactionId: string) {
  await client.query("DELETE FROM transaction_tag WHERE ledger_id=$1 AND transaction_id=$2 AND tag_type='meal'", [ledgerId, transactionId]);
}

async function upsertCustomTag(client: PoolClient, ledgerId: string, name: string): Promise<string> {
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
  const visible = rows.slice(0, 8);
  return infoCard({
    altText,
    kicker: "DINERO 記帳列表",
    title,
    summary: money(sumRows(rows)),
    rows: visible.map((row) => ({
      label: `${slashDate(row.occurred_on)}・${row.scope === "shared" ? "共同" : "個人"}`,
      value: `${row.description}　${money(row.amount_minor)}`,
      meta: `#${row.public_id}`,
    })),
    note: rows.length > visible.length ? `${note}；卡片顯示前 ${visible.length} 筆，共 ${rows.length} 筆。` : note,
    actions,
  });
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
