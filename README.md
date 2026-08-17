# 兩人記帳 LINE Bot

這個專案採 Specification-Driven Development（SDD）：先定義帳務語意、對話格式、資料約束與驗收案例，再開始實作。目前已完成可執行的交易 CRUD、LINE 原生編輯提示、join onboarding 與 unsend 隱私清除流程。

## 目前功能

- 個人使用者可直接私訊記帳，不必配對；第一則文字訊息會自動建立隔離的個人帳本。
- 每個 LINE 群組可自助建立一個資料隔離的兩人帳本；第一位輸入 `建立配對`，第二位輸入 `配對`。
- 兩人可自行解除配對，但必須一人提出 `解除配對`、另一人明確 `同意解除`；單方無法直接拆除帳本。
- 預設是個人模式，`牛肉麵 150` 會建立傳送者的個人支出；約會時可切換共同模式。
- `個人 咖啡 80` 建立傳送者的個人支出；它跟著 LINE 使用者，無論從私訊或群組查詢都是同一份個人歷史，配對對方無法用自己的指令取得或修改。
- 一筆帳可以同時有多種標籤：一個大分類、最多一個餐別，以及多個自訂標籤。
- `牛肉麵 150 #約會` 可得到 `食物・午餐（自動）・約會`。
- 只有正餐型食物自動判定早餐／午餐／晚餐；咖啡、飲料與點心不自動套餐別。
- `昨天 牛肉麵 150` 只保存昨天、時間未知；`昨天 19:30 牛肉麵 150` 才能依時間自動判定晚餐。
- 支援帳目新增、查詢、修改、取消與還原，不計算誰欠誰。
- `本月`只顯示指令發送者的個人帳；`共同月報`只顯示目前配對的共同帳；`本月 全部`才會合併自己的個人帳與目前共同帳。

## 文件

- [完整使用說明](docs/USER_GUIDE.md)
- [產品規格](specs/001-line-expense-bot/spec.md)
- [資料模型](specs/001-line-expense-bot/data-model.md)
- [驗收案例](specs/001-line-expense-bot/acceptance.md)
- [對話範例](specs/001-line-expense-bot/examples.md)
- [實作計畫](specs/001-line-expense-bot/plan.md)

## 可執行的交易流程

```text
LINE 私訊：「牛肉麵 150」
  → 不需配對，自動建立只屬於使用者的個人帳

LINE：「牛肉麵 150 #約會」
  → 驗證 webhook、群組與成員
  → 依目前模式解析個人／共同支出、項目與金額
  → 標記食物、午餐（自動）、約會
  → 寫入 PostgreSQL 並可靠去重
  → LINE 回覆實際保存結果

LINE：「最近 5」／「本月 #約會」／「查 #K7M2Q9TX」
  → 個人查詢以 LINE user 為邊界，不受私訊／群組視窗影響
  → 只能查自己的個人交易與目前配對的共同交易

LINE：「改 #K7M2Q9TX 金額 180」
  → 檢查共同／個人所有人權限
  → 原子修改並保存 before／after 稽核

LINE：「取消 #K7M2Q9TX」／「還原 #K7M2Q9TX」
  → 可還原的 soft void，重複操作不重複寫稽核

LINE：直接編輯原始記帳訊息
  → 不修改帳務，也不保存編輯後文字
  → 回覆應使用的「改 #編號 欄位 新值」格式

LINE：Bot 加入新的記帳群組
  → 自動建立獨立帳本
  → 第一位「建立配對」，第二位「配對」
  → 群組與私訊的默認查詢都是發送者同一份個人帳
  → 只有明確「共同」或「全部」才會取用目前配對的共同帳
  → 「配對狀態」可查看身份；解除配對採雙方確認
```

規格目前標記為 Draft v2，預期會在兩人實際試用後繼續調整。

## 本機先看解析成效

不需要 LINE token 或 PostgreSQL，也不會真的寫入資料：

```bash
npm install
DEMO_EVENT_TIMESTAMP='2026-08-13T04:10:00.123Z' \
  npm run demo:parse -- '牛肉麵 150 #約會'
```

輸出會顯示共同／個人、金額、分類、餐別、自訂標籤和消費時間。
`npm run demo:parse -- '最近 5'` 也會證明保留指令不會誤入帳。

## PWA 前端原型

目前提供 mobile-first 的可安裝 PWA 原型，包含本月總覽、共同／個人切換、分類摘要、最近支出與快速新增互動。這一版使用 mock data，用來先驗證產品介面；後續再接交易 API 與 LINE Login／LIFF。

```bash
npm run web:dev
```

開啟 `http://127.0.0.1:4173`。production build 使用：

```bash
npm run web:build
```

## 啟動 CRUD 垂直切片

需求：Node.js 24+、PostgreSQL 16，以及一個 LINE Messaging API channel。

1. 依 [.env.example](.env.example) 建立環境變數；`OUTBOX_CREDENTIAL_KEY_BASE64` 可用 `openssl rand -base64 32` 產生。
2. `npm run db:migrate` 建 schema。
3. 單一測試帳本可依 [db/README.md](db/README.md) seed；若設定 `LINE_PUBLIC_SIGNUP_ENABLED=true`，新群組會自動建立獨立帳本，不需逐組 seed。
4. `npm run dev` 啟動服務，把 LINE webhook 指向 HTTPS 的 `/webhooks/line`。

服務會驗證 raw webhook 簽章，以 transactional inbox 去重，背景執行新增、查詢、修改、取消、還原與 audit，再透過 outbox 回覆 LINE。`/healthz` 是程序存活，`/readyz` 會檢查 PostgreSQL。

`DELETION_JOURNAL_DIRECTORY` 必須放在與 PostgreSQL 不同 recovery unit 的持久儲存；這是防止舊備份還原後讓已收回訊息復活。開放實際流量前也必須用 production HTTPS、DB TLS、加密備份與監控。

## 驗證

```bash
npm run typecheck
npm test
npm run build
```

若要執行 PostgreSQL integration tests，另設定 `TEST_DATABASE_URL` 指向專用空測試資料庫；測試會在隨機 schema 中執行並清除。
