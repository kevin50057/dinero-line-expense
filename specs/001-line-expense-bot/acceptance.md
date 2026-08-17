# 驗收案例

下列案例是 MVP 開發完成與否的判斷依據，每個案例都應成為自動化測試。未特別指定時，帳本時區為 `Asia/Taipei`、幣別為 `TWD`，小明與小美都是同一帳本的已授權成員。

## 驗收詞彙

- 每筆交易必須有且只有 1 個消費分類；分類失敗時使用 `uncategorized`。
- 每筆交易可有 0 或 1 個餐別，並可有 0–10 個自訂標籤。
- `#食物`這類系統分類名會解析成分類；`#午餐`這類餐別名會解析成餐別；`#約會`、`#台南`這類其他名稱會解析成自訂標籤。
- 稽核事件的 `event_type` 全案只使用 `created`、`updated`、`voided`、`restored`。分類、金額或標籤等欄位修改都是 `updated`；不使用 `category_changed`、`void`、`unsent` 或其他同義值。
- LINE 收回原始新增訊息是隱私刪除：實體刪除交易、標籤與業務稽核事件，只保留不含業務內容的 message tombstone；不建立 `unsent` 稽核事件。

## 新增、分類與多標籤

### A01 — 裸格式依初始個人模式新增個人支出

```gherkin
Given 帳本 default scope 為 personal
And LINE 事件時間是台北時間 2026-08-13 12:10
When 小明傳送「牛肉麵 150」
Then 系統只建立 1 筆金額 150 TWD 的 active 交易
And description 為「牛肉麵」
And scope 為 personal
And payer 為小明
And personal owner 為小明
And 分類有且只有 food
And 餐別有且只有 lunch
And meal source 為 inferred
And 系統產生且只產生 1 筆 created 事件
And 回覆包含公開交易編號、個人、牛肉麵、150 元、食物、午餐與自動標記
```

### A02 — 明確新增個人或共同支出

```gherkin
When 小美傳送「個人 電影 320」
Then scope 為 personal
And payer 與 personal owner 都是小美
And 分類為 entertainment

When 小美傳送「共同 電影 320」
Then scope 為 shared
And payer 為小美
And personal owner 為 null
```

### A03 — 一筆交易可同時有分類、餐別與多個自訂標籤

```gherkin
Given LINE 事件時間是台北時間 2026-08-13 12:10
When 小明傳送「牛肉麵 150 #約會 #台南」
Then 分類有且只有 food
And 餐別有且只有 lunch
And 自訂標籤集合恰為「約會」與「台南」
And 回覆同時顯示食物、午餐（自動）、約會與台南
And 交易總額仍只計算 150 一次
```

### A04 — 系統保留標籤類型

```gherkin
When 小明傳送「牛肉麵 150 #食物 #午餐 #約會」
Then #食物被儲存為唯一分類而不是自訂標籤
And #午餐被儲存為唯一餐別而不是自訂標籤
And #約會被儲存為自訂標籤
And category source 與 meal source 都是 explicit
```

### A05 — 未知分類仍可記帳

```gherkin
When 小明傳送「神秘盒子 99 #紀念日」
Then 系統建立交易
And 分類有且只有 uncategorized
And 自訂標籤包含「紀念日」
And 回覆顯示「未分類」
```

### A06 — 使用者指定的分類優先

```gherkin
Given 「牛肉麵」的自動分類為 food
When 小明傳送「牛肉麵 150 #娛樂」
Then 分類有且只有 entertainment
And category source 為 explicit
And 自動分類不得覆蓋使用者指定值
And 餐別與 meal source 都為 null
```

### A07 — 多個分類衝突時整筆拒絕

```gherkin
When 小明傳送「牛肉麵 150 #食物 #娛樂」
Then 不建立交易
And 不產生 transaction event
And 回覆指出「一筆只能有一個分類」
```

### A08 — 多個餐別衝突時整筆拒絕

```gherkin
When 小明傳送「牛肉麵 150 #午餐 #晚餐」
Then 不建立交易
And 不產生 transaction event
And 回覆指出「一筆只能有一個餐別」
```

### A09 — 非食物分類與餐別不得共存

```gherkin
When 小明傳送「電影 320 #娛樂 #晚餐」
Then 不建立交易
And 不產生 transaction event
And 回覆說明餐別只能用於食物分類
```

### A10 — 只有正餐類項目自動推定餐別

```gherkin
Given LINE 事件時間是台北時間 2026-08-13 20:45
When 小美傳送「炒麵 80」
Then 分類為 food
And 餐別為 dinner
And meal source 為 inferred
And 回覆顯示「食物・晚餐（自動）」
```

### A11 — 咖啡與飲料不自動推定餐別

```gherkin
Given LINE 事件時間是台北時間 2026-08-13 12:10
When 小明傳送「咖啡 80」
Then 分類為 food
And 餐別與 meal source 都為 null

When 小明傳送「珍珠奶茶 65」
Then 分類為 food
And 餐別與 meal source 都為 null
```

### A12 — 飲料可由使用者明確指定餐別

```gherkin
Given LINE 事件時間是台北時間 2026-08-13 15:30
When 小明傳送「咖啡 80 #下午茶」
Then 分類為 food
And 餐別為 afternoon_tea
And meal source 為 explicit
```

### A13 — 非食物不產生餐別且分類規則不可只看單字

```gherkin
Given LINE 事件時間是台北時間 2026-08-13 12:10
When 小明傳送「計程車 200」
Then 分類為 transport
And 餐別與 meal source 都為 null

When 小明傳送「飯店 3000」
Then 分類為 travel
And 不得因「飯」字而分為 food
And 餐別與 meal source 都為 null
```

### A14 — 正餐自動餐別的時間窗邊界

```gherkin
Given 項目都是可自動推定餐別的正餐食物
Then 台北時間 04:59 的餐別為 null
And 台北時間 05:00 的餐別為 breakfast
And 台北時間 10:59 的餐別為 breakfast
And 台北時間 11:00 的餐別為 lunch
And 台北時間 14:59 的餐別為 lunch
And 台北時間 15:00 的餐別為 null
And 台北時間 16:59 的餐別為 null
And 台北時間 17:00 的餐別為 dinner
And 台北時間 21:59 的餐別為 dinner
And 台北時間 22:00 的餐別為 null
```

## 日期、時間與餐別

### A15 — 只補登日期時不虛構時間或餐別

```gherkin
Given LINE 事件時間是台北時間 2026-08-13 12:10
When 小明傳送「昨天 牛肉麵 150」
Then occurred date 是 2026-08-12
And occurred time 為 null
And category 為 food
And meal type 與 meal source 都為 null
And 回覆顯示「時間：2026/08/12（時間未指定）」
```

### A16 — 只補登日期但可明確指定餐別

```gherkin
Given LINE 事件時間是台北時間 2026-08-13 12:10
When 小明傳送「昨天 晚餐 炒麵 80」
Then occurred date 是 2026-08-12
And occurred time 為 null
And meal type 為 dinner
And meal source 為 explicit
And 回覆不得虛構 12:10 或其他精確時間
```

### A17 — 補登明確日期與時間時依該時間推定

```gherkin
Given LINE 事件時間是台北時間 2026-08-13 10:00
When 小明傳送「2026/8/12 19:30 炒麵 80」
Then occurred date 是 2026-08-12
And occurred time 是 19:30
And category 為 food
And meal type 為 dinner
And meal source 為 inferred
```

### A18 — 沒有日期前綴時使用 LINE 事件時間

```gherkin
Given LINE 事件時間是台北時間 2026-08-13 12:10
And webhook 到台北時間 2026-08-14 00:05 才開始處理
When 小明傳送「牛肉麵 150」
Then occurred date 是 2026-08-13
And occurred time 是 12:10
And meal type 為 lunch
And 不使用伺服器開始處理的時間
```

### A19 — 相對日期可正確跨年

```gherkin
Given LINE 事件時間是台北時間 2027-01-01 12:10
When 小明傳送「昨天 牛肉麵 150」
Then occurred date 是 2026-12-31
And occurred time 為 null
```

### A20 — 無效或未來日期不入帳

```gherkin
Given LINE 事件日期是台北日期 2026-08-13
When 小明傳送「明天 牛肉麵 150」
Then 不建立交易
And 回覆「不能記錄未來日期」

When 小明傳送「2026-02-30 牛肉麵 150」
Then 不建立交易
And 回覆「日期格式或日期無效」
```

### A21 — 前綴可交換順序但不可重複或衝突

```gherkin
Given LINE 事件時間是台北時間 2026-08-13 12:10
When 小明傳送「個人 昨天 晚餐 炒麵 80」
Then scope 為 personal
And personal owner 為小明
And occurred date 是 2026-08-12
And occurred time 為 null
And meal type 為 dinner

When 小明傳送「個人 共同 牛肉麵 150」
Then 不建立交易
And 回覆範圍前綴衝突的格式錯誤

When 小明傳送「昨天 2026/8/12 牛肉麵 150」
Then 不建立交易
And 回覆日期前綴重複的格式錯誤
```

## 解析優先序與輸入驗證

### A22 — 指令優先於新增支出

```gherkin
When 小明傳送「改 #K7M2Q9TX 金額 180」
Then 系統先以修改指令解析
And 不建立項目為「改 #K7M2Q9TX 金額」且金額為 180 的新交易

When 小明傳送「最近 5」
Then 系統先以查詢指令解析
And 不建立項目為「最近」且金額為 5 的新交易
```

### A23 — 文字解析使用單一明確順序

```gherkin
Given 系統收到一則文字訊息
When 開始解析
Then 依序完整匹配說明或分類等系統指令、查詢、修改或標籤、取消或還原、新增支出
And 第一個完整匹配成功後立即停止
And 一則訊息最多造成一個指令效果
And 以保留指令詞開頭但格式無效時不得 fallback 成新增支出
```

### A24 — 無法解析的文字與錯誤指令都不得漏記

```gherkin
When 小明傳送「牛肉麵」
Then 不建立交易
And 機器人回覆一行簡短的格式提示

When 小明傳送「改 #K7M2Q9TX 180」
Then 不建立交易
And 不修改任何交易
And 回覆修改指令的正確用法

When 小明傳送圖片、貼圖或其他非文字訊息
Then 不建立交易
And 機器人不回覆
```

### A25 — 金額必須是大於零的 TWD 整數

```gherkin
When 小明傳送「晚餐 -100」
Then 不建立交易
And 回覆「金額必須是大於 0 的整數」

When 小明傳送「晚餐 0」
Then 不建立交易

When 小明傳送「晚餐 100.5」
Then 不建立交易

When 小明傳送「飯店 1,200」
Then 建立一筆金額 1200 TWD 的交易

When 小明分別使用「牛肉麵 150元」、「牛肉麵 $150」或「牛肉麵 NT$150」
Then 每種格式都可解析為金額 150 TWD
And 回覆統一顯示「150 元」
```

### A26 — 「最近」筆數的錯誤格式不得落入新增

```gherkin
When 小明傳送「最近 0」、「最近 21」或「最近 五」
Then 不建立交易
And 回覆「筆數請使用 1–20 的整數」
```

## 可見性與操作權限

### A27 — 未授權成員不得讀寫帳本

```gherkin
Given 阿華不在帳本成員名單
When 阿華傳送「咖啡 80」
Then 不建立交易
And 回覆未授權提示
And 若為去重而保存 inbound event，只保存 event ID、時間與 unauthorized outcome 等非內容 metadata
And 不保存「咖啡 80」或其他訊息內容

When 阿華傳送「本月」或「查 #K7M2Q9TX」
Then 不回傳任何帳本內容
```

### A28 — 個人支出對另一位已授權成員可見

```gherkin
Given #P4V8R3NZ 是小明的 personal 支出
When 小美傳送「查 #P4V8R3NZ」
Then 回覆包含 #P4V8R3NZ 的完整業務內容
And 回覆清楚顯示 personal owner 為小明
And 個人是帳務歸屬而不是隱私隔離
```

### A29 — 個人支出只有 owner 可修改

```gherkin
Given #P4V8R3NZ 是小明的 active personal 支出且金額為 150
When 小明傳送「改 #P4V8R3NZ 金額 180」
Then 金額變成 180
And 產生 1 筆 updated 事件

When 小美傳送「改 #P4V8R3NZ 金額 200」
Then #P4V8R3NZ 所有欄位保持不變
And 不產生 transaction event
And 回覆「只有這筆個人支出的所有人可修改」
```

### A30 — 個人支出只有 owner 可取消或還原

```gherkin
Given #P4V8R3NZ 是小明的 active personal 支出
When 小美傳送「取消 #P4V8R3NZ」
Then #P4V8R3NZ 仍為 active
And 不產生 voided 事件

Given #P4V8R3NZ 是小明的 voided personal 支出
When 小美傳送「還原 #P4V8R3NZ」
Then #P4V8R3NZ 仍為 voided
And 不產生 restored 事件

When 小明傳送對應的取消或還原指令
Then 指令成功
```

### A31 — 共同支出兩人都可修改、取消與還原

```gherkin
Given #S8D5H2WY 是小明建立的 shared 支出
When 小美修改 #S8D5H2WY
Then 修改成功並產生 updated 事件

When 小美取消 #S8D5H2WY
Then 取消成功並產生 voided 事件

When 小明還原 #S8D5H2WY
Then 還原成功並產生 restored 事件
```

### A32 — 付款人與 personal owner 彼此獨立

```gherkin
Given #P4V8R3NZ 是小明所有的 personal 支出
And payer 為小明
When 小明傳送「改 #P4V8R3NZ 付款人 小美」
Then payer 變成小美
And personal owner 仍為小明
And 之後仍只有小明可修改、取消或還原 #P4V8R3NZ

Given #S8D5H2WY 是 shared 支出
When 小美傳送「改 #S8D5H2WY 範圍 個人」
Then #S8D5H2WY scope 變成 personal
And personal owner 設為操作者小美

Given #P4V8R3NZ 是小明所有的 personal 支出
When 小明傳送「改 #P4V8R3NZ 所有人 小美」
Then personal owner 變成小美
And 小美立即取得 mutation 權限
And 小明立即失去 mutation 權限

When 非目前 owner 嘗試變更 personal owner 或將 personal 改為 shared
Then 整次修改原子失敗
And 不產生 transaction event
```

## 查詢與報表

### A33 — 查詢單筆會顯示完整狀態

```gherkin
Given #K7M2Q9TX 是一筆已取消的共同食物支出
When 小明傳送「查 #K7M2Q9TX」
Then 回覆包含項目、金額、分類、餐別、自訂標籤、範圍、付款人、personal owner 與發生日期時間
And 回覆清楚顯示狀態為「已取消」
```

### A34 — 「最近」與日月列表各使用符合用途的穩定排序

```gherkin
Given 同一帳本有多筆 active 交易
And 其中有一筆剛補登但消費日期較舊的交易
When 小明傳送「最近」
Then 預設最多回傳 10 筆
And 只包含 personal owner 為小明的交易
And 依 created at 由新到舊排序
And 剛補登的舊日期交易可出現在最前方
And created at 相同時使用 public ID 作穩定 tie-breaker

When 小明查詢今天、昨天或本月的交易列表
Then 依 occurred date 由新到舊排序
And 同日交易依 occurred time 由晚到早排序
And 時間未知者排在該日精確時間已知者之後
And occurred date 與 time 都相同時依 created at 再依 public ID 作穩定排序
```

### A35 — 最近查詢可指定筆數且排除已取消資料

```gherkin
Given 小明有 8 筆 active 個人交易與 2 筆 voided 個人交易
When 小明傳送「最近 5」
Then 回傳排序後的前 5 筆 active 交易
And 不包含 voided 交易

When 小明傳送「最近 5 共同」或「最近 5 全部」
Then 才分別回傳共同支出或跨兩人成員的資料
```

### A36 — 本月摘要預設依操作者個人化並可明確查看共同或全部

```gherkin
Given 本月有 shared 支出 500
And 小明的 personal 支出為 120
And 小美的 personal 支出為 80
And 上述 active 支出的大分類小計為食物 550 與交通 150
And 另有一筆已取消的 shared 支出 300
When 小明傳送「本月」
Then 回覆本月總額為小明 personal 的 120
And 不包含 shared 500 或小美 personal 80
And 不計入已取消的 300

When 小明傳送「本月 個人」
Then 結果只包含小明 personal 支出 120
And 這是查詢篩選而不是隱私隔離

When 小明傳送「本月 共同」
Then 結果只包含 shared 支出 500

When 小明傳送「本月 全部」
Then 回覆不重複總額 700、shared 小計 500、小明 personal 120、小美 personal 80 與對應分類小計
```

### A37 — 多標籤統計不重複累加同一筆交易

```gherkin
Given #T6C3J9QP 金額為 150
And #T6C3J9QP 的分類為 food、餐別為 lunch、自訂標籤為約會與台南
When 小明查詢本月摘要
Then #T6C3J9QP 對本月總額只貢獻 150
And 食物、午餐、約會與台南可各自作為篩選條件
And 不得將各標籤小計相加當成總額
```

### A38 — 本月與日期界線使用帳本時區

```gherkin
Given 交易發生於 UTC 的上個月最後一天 16:30
When 使用者查詢台北時區的本月
Then 該交易被算入台北日期所屬的新月份
```

### A39 — 不存在或其他帳本編號不得洩漏資料

```gherkin
When 小明查詢不存在或不屬於目前帳本的交易編號
Then 回覆「找不到這筆紀錄」
And 不透露該編號是否存在於其他帳本
And 不透露其他帳本的任何欄位
```

## 修改（Update）

### A40 — 修改金額使用統一 updated 事件

```gherkin
Given #K7M2Q9TX 是小明有權修改的 active 交易且金額為 150
When 小明傳送「改 #K7M2Q9TX 金額 180」
Then #K7M2Q9TX 金額變成 180
And 系統產生且只產生 1 筆 updated 事件
And 事件包含修改前後金額
And 回覆顯示「150 元 → 180 元」
```

### A41 — 修改自動分類項目會重新分類並重算餐別資格

```gherkin
Given #K7M2Q9TX 的項目為「牛肉麵」
And category 為 food 且 category source 為 inferred
And meal type 為 lunch 且 meal source 為 inferred
When 有權成員傳送「改 #K7M2Q9TX 項目 計程車」
Then category 變成 transport
And category source 仍為 inferred
And meal type 與 meal source 都變成 null
And 產生 1 筆 updated 事件

Given #K7M2Q9TX 為 food 且有 inferred lunch
When 有權成員將項目改為「咖啡」
Then category 仍為 food
And meal type 與 meal source 都變成 null
```

### A42 — 修改項目不覆蓋明確分類

```gherkin
Given #K7M2Q9TX 的 category 為 entertainment
And category source 為 explicit
When 有權成員將項目改為「牛肉麵」
Then category 仍為 entertainment
And category source 仍為 explicit
And meal type 與 meal source 都為 null
```

### A43 — 為未知時間的正餐補上時間後可自動推定餐別

```gherkin
Given #K7M2Q9TX occurred date 為 2026-08-12
And occurred time、meal type 與 meal source 都為 null
And #K7M2Q9TX 是可自動推定餐別的正餐食物
When 有權成員傳送「改 #K7M2Q9TX 時間 19:30」
Then occurred time 變成 19:30
And meal type 變成 dinner
And meal source 為 inferred
And occurred date 保持 2026-08-12
```

### A44 — 明確餐別不被時間修改覆蓋

```gherkin
Given #K7M2Q9TX 的 meal type 為 dinner
And meal source 為 explicit
When 有權成員傳送「改 #K7M2Q9TX 時間 12:10」
Then meal type 仍為 dinner
And meal source 仍為 explicit
```

### A45 — 可新增、移除與去重自訂標籤

```gherkin
Given #K7M2Q9TX 的自訂標籤為「約會」
When 有權成員傳送「加 #K7M2Q9TX 標籤 #台南」
Then 自訂標籤恰為「約會」與「台南」
And 產生 1 筆 updated 事件

When 有權成員再次新增「#台南」
Then 標籤集合保持不變
And 不產生第二筆 updated 事件
And 回覆「這個標籤已存在」

When 有權成員傳送「移除 #K7M2Q9TX 標籤 #約會」
Then 自訂標籤只剩「台南」
And 產生 1 筆 updated 事件

Given #K7M2Q9TX 已有 10 個不同的自訂標籤
When 有權成員嘗試再加第 11 個自訂標籤
Then 標籤集合保持不變
And 不產生 updated 事件
And 回覆「每筆最多 10 個自訂標籤」

When 有權成員嘗試加入空白、含空白或超過 20 個 Unicode 字元的自訂標籤
Then 標籤集合保持不變
And 不產生 updated 事件
And 回覆自訂標籤格式要求
```

### A46 — 無效修改具有原子性

```gherkin
Given #K7M2Q9TX 金額為 150
When 有權成員傳送「改 #K7M2Q9TX 金額 -20」
Then #K7M2Q9TX 所有欄位都保持不變
And 不產生 transaction event
And 回覆「金額必須是大於 0 的整數」

When 有權成員傳送「改 #K7M2Q9TX 分類 不存在分類」
Then #K7M2Q9TX 所有欄位都保持不變
And 不產生 transaction event
And 回覆可用的系統分類
```

### A47 — 已取消交易必須先還原才能修改

```gherkin
Given #K7M2Q9TX 狀態為 voided
When 有權成員傳送「改 #K7M2Q9TX 金額 180」
Then #K7M2Q9TX 所有欄位都保持不變
And 不產生 updated 事件
And 回覆「請先還原這筆紀錄」
```

### A48 — 修改日期立即反映在期間統計

```gherkin
Given #K7M2Q9TX 原本發生於 2026-08-01 且計入八月統計
When 有權成員將 #K7M2Q9TX 的日期改為 2026-07-31
Then #K7M2Q9TX 不再計入八月統計
And #K7M2Q9TX 計入七月統計
And 產生 1 筆 updated 事件
```

### A49 — MVP 只做交易 CRUD，不做分類 CRUD

```gherkin
When 已授權成員傳送「新增分類 寵物」或「刪除分類 食物」
Then 不建立、修改或刪除分類
And 不將該文字當成支出
And 回覆說明 MVP 分類為固定清單
```

## 取消與還原（Delete／Restore）

### A50 — 取消是可還原的軟刪除

```gherkin
Given #K7M2Q9TX 金額為 150 且狀態為 active
When 有權成員傳送「取消 #K7M2Q9TX」
Then 交易資料列仍存在
And 狀態變成 voided
And void reason 為 user_cancel
And voided at 已設定
And 產生且只產生 1 筆 voided 事件
And 一般查詢與本月統計不包含該筆 150
```

### A51 — 重複取消具有業務冪等性

```gherkin
Given #K7M2Q9TX 已因 user_cancel 而處於 voided
And 已存在 1 筆 voided 事件
When 有權成員再次傳送「取消 #K7M2Q9TX」
Then 交易狀態仍為 voided
And voided 事件總數仍為 1
And 回覆「這筆已取消」
```

### A52 — 使用者取消的交易可還原

```gherkin
Given #K7M2Q9TX 狀態為 voided
And void reason 為 user_cancel
When 有權成員傳送「還原 #K7M2Q9TX」
Then #K7M2Q9TX 狀態變成 active
And void reason 與 voided at 被清空
And 產生且只產生 1 筆 restored 事件
And #K7M2Q9TX 再次出現在一般查詢與統計中
```

### A53 — 重複還原具有業務冪等性

```gherkin
Given #K7M2Q9TX 已是 active
When 有權成員傳送「還原 #K7M2Q9TX」
Then #K7M2Q9TX 仍為 active
And 不產生新的 restored 事件
And 回覆「這筆已是有效紀錄」
```

## LINE 編輯與收回

### A54 — LINE 原生編輯不自動同步帳務

```gherkin
Given LINE message ID M 的原文已建立交易 #K7M2Q9TX 且金額為 150
When 使用者將 LINE 原訊息編輯為「牛肉麵 180」
Then #K7M2Q9TX 金額仍為 150
And #K7M2Q9TX 的其他欄位都不變
And 不產生 updated 事件
And 機器人泛用提示使用「改 #K7M2Q9TX 欄位 新值」
And 機器人不解析編輯前後差異
And 系統不保存編輯後的「牛肉麵 180」
```

### A55 — 收回原始新增訊息會實體刪除業務內容

```gherkin
Given LINE message ID M 曾建立交易 #K7M2Q9TX
And #K7M2Q9TX、標籤關聯及稽核快照含有項目、金額、分類、餐別與自訂標籤等業務內容
And 原 message inbox 或 outbound payload 仍含有可識別的原始訊息文字
When 系統收到指向 M 的 LINE unsend event
Then #K7M2Q9TX 的交易資料列被實體刪除
And #K7M2Q9TX 的所有 transaction tag 與 transaction event 被 cascade 刪除
And 只由 #K7M2Q9TX 使用的 orphan custom tag 被刪除
And 仍被其他交易使用的同名 custom tag 保留
And #K7M2Q9TX 不再可以被查詢、統計或還原
And 原 message inbox 與待送或已送 outbox 中的可識別文字被清除
And 只保留包含 M、unsend event ID 與收回時間的 message tombstone
And tombstone 不含項目、金額、分類、餐別、自訂標籤、成員資訊或 public ID
And 不建立 unsent 或 voided transaction event
```

### A56 — 先收到收回事件時建立 tombstone

```gherkin
Given 系統先收到 message ID M 的 LINE unsend event
When 之後才收到 message ID M 的原 message event
Then 不建立交易
And 不存在由 M 建立的 active 交易
And M 的 tombstone 仍可防止之後重送
```

### A57 — 收回修改、取消或還原指令不反轉已完成動作

```gherkin
Given message ID M 已將 #K7M2Q9TX 金額從 150 改為 180
When 系統收到指向 M 的 LINE unsend event
Then #K7M2Q9TX 金額仍為 180
And 既有 updated 稽核結果仍存在
And 系統不保留 M 的指令文字

Given message ID N 已成功取消或還原 #K7M2Q9TX
When 系統收到指向 N 的 LINE unsend event
Then #K7M2Q9TX 保持該指令完成後的狀態
And 系統不保留 N 的指令文字
```

### A58 — 因 LINE 收回而刪除的交易不可還原

```gherkin
Given #K7M2Q9TX 已因原始 LINE 訊息收回而被實體刪除
When 任一已授權成員傳送「還原 #K7M2Q9TX」
Then 資料庫中仍不存在 #K7M2Q9TX
And 不產生 restored 事件
And 回覆「找不到這筆紀錄」
```

## Webhook 安全、冪等性與失敗復原

### A59 — 新增 webhook 重送不會重複入帳

```gherkin
Given webhook event ID E 已成功建立交易 T
When LINE 再送一次 webhook event ID E
Then 交易筆數不增加
And T 的 created 事件總數仍為 1
And 系統回傳成功，避免 LINE 持續重試
```

### A60 — 交易變更與收回重送都具有冪等性

```gherkin
Given webhook event E 已成功完成 updated、voided 或 restored 其中一種動作
When LINE 重送 webhook event E
Then 交易的欄位與狀態不再改變
And E 對應的 transaction event 總數仍為 1
And 系統回傳成功

Given webhook event U 已完成收回原始新增訊息的實體刪除與 tombstone 建立
When LINE 重送 webhook event U
Then tombstone 仍只有 1 筆
And 已刪除的交易不會重新建立
And 不產生任何 transaction event
And 系統回傳成功
```

### A61 — 入帳成功但 LINE 回覆失敗時不重複入帳

```gherkin
Given webhook event ID E 的交易與 created 事件已提交到 DB
And 傳送 LINE 確認回覆時暫時失敗
When LINE 重送 webhook event ID E
Then 不建立第二筆交易
And 不產生第二筆 created 事件
And 系統可根據已保存的處理結果重試或補送確認回覆
```

### A62 — webhook 變更必須原子提交

```gherkin
Given 系統正在處理會建立或修改交易的 webhook event E
When DB 在完成 transaction event 前失敗
Then 交易變更、transaction event 與 E 的已完成狀態不得只提交其中一部分
And 之後重送 E 可完整處理一次
```

### A63 — 無效 webhook 簽章不得觸發任何處理

```gherkin
Given webhook 簽章無效
When 伺服器收到事件
Then 回傳拒絕結果
And 不解析訊息
And 不建立 inbound event、交易或 transaction event
```

### A64 — 公開編號衝突不得造成覆蓋或串帳

```gherkin
Given 系統為新交易產生了已存在的 public ID
When DB 唯一約束拒絕該 public ID
Then 系統使用新 public ID 安全重試
And 不覆蓋原有交易
And 不將新交易的訊息或稽核事件關聯到原有交易
And 最終成功時只新增 1 筆交易與 1 筆 created 事件
```

## 其餘規格邊界

### A65 — 只有時間前綴時代表今天且不得記錄未來

```gherkin
Given LINE 事件時間是台北時間 2026-08-13 20:00
When 小明傳送「19:30 牛肉麵 150」
Then occurred date 是 2026-08-13
And occurred time 是 19:30
And meal type 為 dinner

When 小明傳送「20:30 牛肉麵 150」
Then 不建立交易
And 回覆「不能記錄未來時間」
```

### A66 — 品項、無空白金額與省略年份日期的邊界

```gherkin
When 小明傳送「牛肉麵150」
Then 建立項目為「牛肉麵」且金額為 150 的交易

When 小明傳送項目長度為 51 個 Unicode 字元且尾端金額為 150 的訊息
Then 不建立交易
And 回覆「項目最多 50 個字元」

When 小明傳送「8/12 牛肉麵 150」
Then 不建立交易
And 回覆要求使用含年份的日期格式
```

### A67 — 可恢復自動分類並清除或恢復自動餐別

```gherkin
Given #K7M2Q9TX 的項目為「牛肉麵」且發生時間為台北時間 12:10
And category 為 entertainment 且 category source 為 explicit
And meal type 為 null
When 有權成員傳送「改 #K7M2Q9TX 分類 自動」
Then category 變成 food 且 category source 為 inferred
And meal type 變成 lunch 且 meal source 為 inferred
And 產生 1 筆 updated 事件

When 有權成員傳送「改 #K7M2Q9TX 餐別 無」
Then meal type 與 meal source 都變成 null
And 產生 1 筆 updated 事件

When 有權成員傳送「改 #K7M2Q9TX 餐別 自動」
Then meal type 變成 lunch 且 meal source 為 inferred
And 產生 1 筆 updated 事件
```

### A68 — 修改日期保留原時間精度

```gherkin
Given #K7M2Q9TX 發生於台北時間 2026-08-13 19:30
And 修改指令的 LINE 事件日期是 2026-08-20
When 有權成員傳送「改 #K7M2Q9TX 日期 昨天」
Then occurred date 變成 2026-08-19
And occurred time 仍為 19:30

Given #K7M2Q9TX 的 occurred time 為 null
When 有權成員修改 #K7M2Q9TX 的日期
Then occurred time 仍為 null

Given #K7M2Q9TX 的 occurred time 為 12:10
And meal type 為 lunch 且 meal source 為 inferred
When 有權成員傳送「改 #K7M2Q9TX 時間 未知」
Then occurred time 變成 null
And inferred meal tag 被移除
```

### A69 — 標籤篩選查詢使用唯一交易總額

```gherkin
Given 本月有兩筆帶「約會」自訂標籤的 active 交易，金額分別為 150 與 320
And 第一筆同時有 food 與 lunch 標籤
When 小明傳送「本月 #約會」
Then 回覆 2 筆與總額 470
And 第一筆不因同時有多個標籤而重複計算

When 小明傳送「本月 #午餐」
Then 只回傳帶 lunch meal tag 的交易
```

### A70 — 加入群組與說明指令可完成 onboarding

```gherkin
When Bot 加入已允許的記帳群組
Then 歡迎訊息說明初始為個人模式且「牛肉麵 150」會歸入傳送者個人支出
And 歡迎訊息說明可用「切換共同模式」與「切換個人模式」
And 歡迎訊息說明「個人 咖啡 80」的個人格式

When 已授權成員傳送「說明」、「分類」或「標籤」
Then Bot 分別回覆常用 CRUD 範例、固定系統分類或自訂 hashtag 用法
And 不把這些指令建立成支出
```

### A71 — 一個 webhook request 內的 events 各自可靠處理

```gherkin
Given 一個有效簽章的 webhook request 含兩個不同 webhook event ID
When 系統接受 request
Then 每個 event 各自建立或取得一筆 inbox 狀態
And 任一 event 的失敗不會讓另一個已可靠接收的 event 遺失

Given 一個有效簽章的 webhook request 含空 events array
When 系統接受 request
Then 回傳成功且不建立交易

Given event 來自未允許的群組
When 系統處理 event
Then 不建立或回傳任何帳務內容
And 不保存訊息文字
```

### A72 — 日誌與錯誤追蹤不洩漏敏感內容

```gherkin
Given webhook 內含訊息文字、reply token 與簽章
When 系統成功或失敗地處理該 webhook
Then application log、queue diagnostic 與 error tracker 不包含完整 webhook body
And 不包含訊息文字、reply token、access token、channel secret 或完整簽章

Given request body 超過設定的大小限制
When webhook endpoint 收到 request
Then 在進入業務解析前拒絕 request
And 不建立交易或稽核事件
```

### A73 — 一般操作回覆時間符合 SLO

```gherkin
Given 系統處於定義的正常負載範圍
When 執行新增與查詢的效能驗收
Then 從 webhook 收到至送出確認回覆的 p95 小於 5 秒
And 測試報告記錄負載條件、樣本數與 p95 結果
```

### A74 — 只有餐別詞與金額仍是合法支出

```gherkin
Given LINE 事件時間是台北時間 2026-08-13 20:00
When 小明傳送「晚餐 200」
Then 建立 description 為「晚餐」且金額為 200 的交易
And category 為 food 且 category source 為 explicit
And meal type 為 dinner 且 meal source 為 explicit

When 小明傳送「晚餐 電影 320 #娛樂」
Then 不建立交易
And 回覆說明明確餐別不能與非食物分類共存
```

### A75 — Create 的自訂標籤上限同樣原子套用

```gherkin
When 小明傳送一筆含 10 個不同合法自訂標籤的支出
Then 建立交易並保存全部 10 個自訂標籤

When 小明傳送一筆含 11 個不同自訂標籤的支出
Then 不建立交易或任何 transaction tag
And 不產生 created 事件
And 回覆「每筆最多 10 個自訂標籤」
```

### A76 — 備份還原不得讓已收回交易復活

```gherkin
Given 一份加密備份的時間點早於 message ID M 的 LINE 收回事件
And M 對應的交易已在正式環境中被清除
And 與主要 DB recovery unit 分離的 durable deletion journal 已保存 M 的最小刪除 metadata
When 系統從該備份進行災難還原
Then 在 application 重新接受流量前先重放 durable deletion journal
And 重建 M 的 tombstone 並執行 purge
And M 對應的交易、標籤與業務 audit 不存在於還原後的可用資料庫
And journal 與 tombstone 保留期不得短於最長備份保留期
```

### A77 — 修改不得把交易移到未來

```gherkin
Given 修改指令的 LINE 事件時間是台北時間 2026-08-13 20:00
And #K7M2Q9TX 發生於 2026-08-13 19:30
When 有權成員傳送「改 #K7M2Q9TX 時間 20:30」
Then #K7M2Q9TX 日期、時間與標籤全部保持不變
And 不產生 updated 事件
And 回覆「不能記錄未來時間」

When 有權成員將 #K7M2Q9TX 日期改成 2026-08-14
Then 整次修改同樣原子拒絕
```

### A78 — Join 與 unsend 不因缺少 user ID 而被拒絕

```gherkin
Given event 來自設定的 group ID
And LINE join event 沒有 source user ID
When 系統處理 join event
Then 系統仍可完成群組 onboarding

Given LINE unsend event 指向帳本內 message ID M
And event 沒有 source user ID
When 系統處理 unsend event
Then 系統仍執行 tombstone、deletion journal 與業務內容 purge

Given 文字 CRUD event 沒有 active member user ID
When 系統處理該 event
Then 不執行帳務讀寫
```

### A79 — 原 message 與 unsend 並行的最終狀態安全

```gherkin
Given 同一 `(ledger, message ID M)` 的原 message 與 unsend event 同時開始處理
When 兩條路徑競爭執行
Then 兩者取得同一個 transaction-scoped message advisory lock 並序列化
And 最終存在 M 的 tombstone
And 不存在由 M 建立的交易、標籤或業務 audit
```

### A80 — Reply token 過期不改用 push fallback

```gherkin
Given 帳務交易已成功且只提交一次
And LINE 確認回覆在 reply token 有效期內 bounded retry 後仍未成功
When reply token 過期
Then outbox job 進入 dead letter 並告警
And 系統不自動建立 push fallback
And 不重做或回滾已成功的帳務交易
And 使用者之後可用「最近」核對該筆帳
```

### A81 — 自訂標籤不得冒用系統保留名稱

```gherkin
Given 「食物」是 category 保留名稱且「午餐」是 meal 保留名稱
When 系統嘗試建立 normalized name 為「食物」或「午餐」的 custom tag
Then DB 跨 tag type 排他約束拒絕建立
And 使用者輸入的 #食物 或 #午餐 只會解析成對應系統 tag
And `本月 #午餐` 的語意唯一
```

### A82 — 週與上月報表使用帳本時區的曆日界線

```gherkin
Given 帳本時區為 Asia/Taipei
And LINE 事件時間是 2026-08-13（星期四）中午
When 小明傳送「週報」、「本週」或「這週」
Then 查詢區間為 2026-08-10 00:00 到 2026-08-17 00:00 的半開日期區間

When 小明傳送「上週」
Then 查詢區間為前一個星期一到本星期一

When 小明傳送「上月」
Then 查詢區間為 2026-07-01 到 2026-08-01
```

### A83 — 搜尋與分類排行是保留指令且不會誤入帳

```gherkin
When 小明傳送「找 牛肉麵」或「搜尋 牛肉麵」
Then 回傳 description 包含「牛肉麵」的最近 20 筆 active 交易
And `%`、`_`與反斜線只視為搜尋文字而非 SQL wildcard
And 不建立項目為「找」或「搜尋」的新交易

When 小明傳送「分類排行」或「排行」
Then 回傳本月 active 交易依 category 金額降冪排列及占比
And 每筆多標籤交易在總額中只計算一次
```

### A84 — 查詢使用安全且可降級的 LINE Flex Message

```gherkin
When 已授權成員傳送「說明」
Then LINE 回覆為最多五張 bubble 的 carousel Flex Message
And 卡片包含可點擊的 message action 常用指令

When 已授權成員查詢單筆、最近、期間、搜尋或排行
Then LINE 回覆為 Flex bubble 且 altText 包含等價純文字摘要
And outbound validator 拒絕未知元件、未知欄位、任意 URI action、超過 12 張 bubble 或超過 50 KB 的 Flex JSON
```

### A85 — 新群組可自助建立隔離帳本並安全配對

```gherkin
Given public signup 已開啟且 Bot 加入一個尚無 ledger 的 LINE 群組
When 收到 join 或 onboarding 指令
Then 系統 idempotently 建立該群組專屬 ledger 與完整 system tags
And 不使用其他群組的 member、交易或自訂標籤

Given 新 ledger 尚無 active member
When 第一位傳送「建立配對」或「開始配對」
Then worker 鎖定 ledger 並建立第一位 member
And 回覆請第二位在同一群組傳送「配對」

Given ledger 已有且只有一位 active member
When 第二位傳送完全等於「配對」的文字訊息
Then admission boundary 暫存該事件的 user ID、加密 reply token 與固定 onboarding 文字
And worker 鎖定 ledger、再次確認 active member 數為一後建立第二位 member
And 回覆配對成功並立即清除 inbound payload
And 她下一則一般記帳訊息可由 DB active member 身份通過授權
And 她的私訊依全域唯一 active member 身份路由回同一 ledger

When 已完成配對的成員再次傳送「配對」
Then 不新增 member 且只回覆已完成配對

Given 帳本已有兩位 active member
When 第三位群組成員傳送「配對」
Then 不建立 member 且回覆帳本無法接受新成員

Given 某 LINE 帳號已在另一個 ledger 有 active member 身份
When 該帳號嘗試加入新配對
Then 不建立第二個 active 身份且回覆必須先解除原配對

When 未授權成員傳送任何不是配對或說明 allowlist 的訊息
Then 不保存 user ID、訊息文字或 reply token
```

### A86 — 群組初始個人模式並可在約會時持久切換共同

```gherkin
Given 帳本初始 default scope 為 personal
When 小明傳送「牛肉麵 150」
Then 新交易 scope 為 personal 且 personal owner 為小明

When 任一 active member 傳送「切換共同模式」或「共同模式」
Then ledger default scope 原子更新為 shared
And 回覆 Flex 卡片清楚顯示共同模式
And 之後小明或小美的裸格式新交易 scope 都為 shared

When 個人模式下小明傳送「共同 晚餐 800」
Then 該筆 scope 仍為 shared 且帳本模式保持 personal

When 共同模式下小美傳送「個人 咖啡 80」
Then 該筆 scope 仍為 personal、owner 為小美且帳本模式保持 shared

When 任一人傳送「目前模式」
Then 回覆 DB 中目前模式且不修改 ledger

When 任一人傳送「切換個人模式」或「個人模式」
Then ledger default scope 更新為 personal
And 已存在交易的 scope 與 owner 全部保持不變
```

### A87 — 原生家庭是可自動推定且跨分類的系統情境標籤

```gherkin
When 小明傳送「孝親費 5000」
Then category 為 household
And custom/context tag 有且只有一個「原生家庭」
And tag source 為 inferred、assigned actor 為 null、rule key 可追溯
And 回覆顯示「原生家庭（自動）」

When 小明傳送「爸爸醫藥費 1200」
Then category 為 health
And 同時具有 inferred 原生家庭標籤

When 小明傳送「朋友生日禮物 1000」或「自己看診 500」
Then 不自動加入原生家庭

When 小明傳送「孝親費 5000 #原生家庭」
Then 原生家庭只保存一次且 source 為 explicit

Given #FAM2XY88 的原生家庭標籤是 inferred
When 小明傳送「改 #FAM2XY88 項目 自己房租」
Then 自動原生家庭標籤被移除但 category 依規則更新

When 小明傳送「本月 #原生家庭」
Then 回傳跨 category 的 active 原生家庭支出總額

When DB 嘗試建立 source=inferred 的一般使用者 custom tag assignment
Then trigger 原子拒絕，只有 active system context tag 可由規則推定
```
