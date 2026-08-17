# PostgreSQL migration 與 seed

此目錄是 Phase 0 的 PostgreSQL schema。`migrations/001_initial.up.sql` 建立 enum、資料表、索引、跨帳本複合外鍵、typed tag deferred constraints、inbox／outbox，以及 LINE unsend tombstone 與主資料庫內的清除函式。

## 套用 migration

需要 PostgreSQL 16（schema 沒有刻意依賴 16 才有的語法，但本地驗證版本為 16）以及可建立 `pgcrypto` extension 的資料庫角色。

```bash
createdb line_expense_bot
psql -X -v ON_ERROR_STOP=1 \
  -d line_expense_bot \
  -f db/migrations/001_initial.up.sql
```

應用程式的 migration runner 會替每個 migration 包 transaction，因此 migration 檔本身沒有頂層 `BEGIN`／`COMMIT`。
一般開發建議直接設定 `DATABASE_URL` 後執行 `npm run db:migrate`，它也會記錄 migration checksum。

## 寫入初始帳本、兩位成員與系統標籤

`seed.sql` 使用 `psql` variables，需獨立執行，不會由 migration runner 自動套用：

```bash
psql -X -v ON_ERROR_STOP=1 \
  -v ledger_name='共同記帳' \
  -v line_group_id='Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' \
  -v member_1_line_user_id='Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' \
  -v member_1_display_name='小明' \
  -v member_2_line_user_id='Uyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' \
  -v member_2_display_name='小美' \
  -d line_expense_bot \
  -f db/seed.sql
```

省略變數時會建立 `DEV_LINE_GROUP_ID`、`DEV_LINE_USER_ID_1` 與 `DEV_LINE_USER_ID_2`，只適合本機開發。seed 可在相同設定下重跑；既有 ledger、member 與 tag 會保留。

Seed 會明確設定：

- 裸格式初始為 `personal`，並允許透過 LINE 指令切換群組共用模式。
- 帳本時區為 `Asia/Taipei`。
- 8 個 category：食物、交通、娛樂、居家、購物、醫療健康、旅遊、未分類。
- 5 個 meal：早餐、午餐、下午茶、晚餐、宵夜。
- 1 個 system context tag：原生家庭；只有規則引擎可建立 inferred assignment。

## 公開配對與多帳本

`008_public_pairing_provisioning.sql` 提供公開 onboarding 所需的資料約束與 provisioning function：

- 每個 LINE 群組以 `line_group_id` 對應一個獨立 ledger。
- `provision_line_group_ledger(group_id)` 會以 idempotent 方式建立 ledger 與 14 個系統標籤。
- 同一個 `line_user_id` 同時只能有一個 active member 身份，讓一對一私訊可安全路由到唯一帳本。
- 設定 `LINE_PUBLIC_SIGNUP_ENABLED=true` 後，未列在啟動白名單的新群組也能進入資料庫 onboarding；未配對使用者的任意訊息不會保存，只有配對與說明指令會進入 inbox。

公開模式不需要為每組使用者執行 seed；seed 保留給單帳本開發、測試或既有資料初始化。

## 分類知識表

`004_category_knowledge.sql` 建立 `category_knowledge_rule`，並載入台灣常見消費的系統規則。分類時依序採用帳本專屬精確規則、系統 exact／contains 規則，再回退到程式內的保守分類器。每次命中會更新 `hit_count` 與 `last_matched_at`。

使用者手動修改分類時，worker 會以 `member_correction` 寫入該帳本的 exact 規則；它不會影響其他帳本，也永遠不會覆蓋訊息裡明確指定的分類。

`005_product_catalog.sql` 建立可更新的最小商品主檔。同步器只保存商品 ID、名稱、搜尋別名、推定分類、來源網址與同步時間，不複製價格、圖片或商品文案：

```bash
npm run catalog:sync
```

目前 `pxmart_sitemap` 來源使用全聯官方 `robots.txt` 宣告的商品 sitemap。可用 `CATALOG_MAX_SITEMAPS=1 npm run catalog:sync` 做小批驗證；完整同步結束才會停用本次已不存在的舊商品。無法可靠分類的商品仍保留於主檔，但不參與自動判斷。

## 實作必須遵守的 DB workflow

- 每筆 `expense_transaction` 和它恰好一個 category tag 必須在同一個 transaction 寫入；deferred constraint 會在 commit 時驗證。meal 至多一個且只能和 `category:food` 共存，自訂標籤至多十個。
- 只有日期的補登寫 `occurred_at = NULL`、`occurred_time_source = NULL`、`occurred_time_precision = 'unknown'`。有精確時間時，`occurred_on` 必須等於該時間在 ledger timezone 下的日期。
- 更新交易前，在同一個 DB transaction 呼叫 `assert_expense_actor_can_mutate(ledger_id, transaction_id, actor_member_id)`；它會鎖列並驗證 active member 與 shared／personal owner 權限。更新時 `row_version` 必須剛好加一。
- 處理新增訊息與 unsend 時都要使用 `lock_line_message(ledger_id, line_message_id)` 所採用的同一把 transaction-scoped advisory lock。交易 insert 另有 trigger 防止 tombstone 已存在時復活。
- `inbound_event` 的業務 mutation、audit、outbox enqueue 與 inbox succeeded 必須在同一個 DB transaction commit。
- worker 用 `FOR UPDATE SKIP LOCKED` claim `pending` inbox／outbox，並同步維護 `status`、`locked_at`、`processed_at`／`sent_at`。

## LINE unsend 與 deletion journal

`purge_line_message_after_unsend(ledger_id, line_message_id, unsend_webhook_event_id, unsent_at)` 會在主資料庫的一個 transaction 內：

1. 取得 message advisory lock 並建立 content-free tombstone。
2. hard-delete 原始新增訊息建立的交易；tag 關聯與 audit 由 FK cascade 清除。
3. 刪除因此成為 orphan 的 custom tag。
4. 清除該 LINE message 對應的 inbox／outbox payload 與 delivery credential，並停止尚未送出的回覆。

規格要求 production 在主要 DB recovery unit **之外**保存 append-only durable deletion journal。因此應用程式只能在 journal append 成功後呼叫此函式；journal 失敗時不可把 unsend inbox 標成 `succeeded`。從備份還原後，必須先重放 journal、建立 tombstone 並再次執行 purge，才可接受流量。這個外部 journal 刻意不由本 migration 建表。

Tombstone 的保留期不得短於最長資料庫備份保留期。

## Schema smoke test

先用測試 ID 執行 seed，再執行 smoke test：

```bash
psql -X -v ON_ERROR_STOP=1 \
  -v line_group_id='C_TEST_GROUP' \
  -v member_1_line_user_id='U_TEST_1' \
  -v member_2_line_user_id='U_TEST_2' \
  -d line_expense_bot \
  -f db/seed.sql

psql -X -v ON_ERROR_STOP=1 \
  -d line_expense_bot \
  -f db/tests/001_initial_smoke.sql
```

Smoke test 會驗證一筆含 category／meal／custom tags 的完整寫入、date-only 的未知時間表示，以及 tombstone、交易 hard purge、orphan custom tag 與 inbox／outbox payload redaction。所有測試資料最後都會 rollback。
