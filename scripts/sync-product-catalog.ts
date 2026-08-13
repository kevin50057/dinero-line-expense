import pg from "pg";

const { Pool } = pg;
const USER_AGENT = "DineroExpenseBot/0.1 (+https://github.com/kevin50057/dinero-line-expense)";
const PXMART_INDEX = "https://pxbox.es.pxmart.com.tw/SiteMap/product_sitemap_index.xml";
const SOURCE = "pxmart_sitemap";
const MAX_RESPONSE_BYTES = 25_000_000;

interface KnowledgeRule {
  normalized_pattern: string;
  match_kind: "exact" | "contains";
  category_code: string;
  meal_eligible: boolean;
  priority: number;
}

interface RetailRule {
  readonly pattern: string;
  readonly categoryCode: string;
  readonly mealEligible: boolean;
  readonly priority: number;
}

interface CatalogRow {
  externalId: string;
  productName: string;
  normalizedName: string;
  searchName: string;
  sourceUrl: string;
  categoryCode: string;
  mealEligible: boolean;
  classificationSource: "knowledge_rule" | "source_taxonomy" | "unclassified";
}

const RETAIL_RULES: readonly RetailRule[] = [
  retail("奶粉", "food", false, 95), retail("鮮乳", "food", false, 95),
  retail("牛奶", "food", false, 90), retail("豆奶", "food", false, 90),
  retail("豆漿", "food", false, 90), retail("優格", "food", false, 90),
  retail("優酪乳", "food", false, 90), retail("起司", "food", false, 90),
  retail("汽水", "food", false, 90), retail("可樂", "food", false, 90),
  retail("果汁", "food", false, 90), retail("茶飲", "food", false, 85),
  retail("紅茶", "food", false, 85), retail("綠茶", "food", false, 85),
  retail("烏龍茶", "food", false, 85), retail("礦泉水", "food", false, 85),
  retail("飲用水", "food", false, 80), retail("氣泡水", "food", false, 85),
  retail("雞湯", "food", true, 90), retail("泡麵", "food", true, 95),
  retail("湯麵", "food", true, 95), retail("拌麵", "food", true, 95),
  retail("乾麵", "food", true, 95), retail("米粉", "food", true, 90),
  retail("冬粉", "food", true, 90), retail("水餃", "food", true, 95),
  retail("蔥餅", "food", true, 90), retail("胡椒餅", "food", true, 90),
  retail("吐司", "food", true, 90), retail("麵包", "food", true, 90),
  retail("餅乾", "food", false, 90), retail("巧克力", "food", false, 90),
  retail("堅果", "food", false, 85), retail("果乾", "food", false, 85),
  retail("糖果", "food", false, 85), retail("零食", "food", false, 85),
  retail("雞精", "food", false, 80), retail("燕窩", "food", false, 80),
  retail("燕麥", "food", true, 85), retail("白米", "food", true, 90),
  retail("糙米", "food", true, 90), retail("調味米", "food", true, 85),
  retail("醬油", "food", false, 90), retail("蠔油", "food", false, 90),
  retail("沙拉油", "food", false, 85), retail("調合油", "food", false, 85),
  retail("橄欖油", "food", false, 85), retail("食用油", "food", false, 85),
  retail("調味料", "food", false, 80), retail("咖哩", "food", true, 80),
  retail("醋", "food", false, 75), retail("罐頭", "food", true, 80),
  retail("肉品", "food", true, 90), retail("雞肉", "food", true, 85),
  retail("豬肉", "food", true, 85), retail("牛肉", "food", true, 85),
  retail("海鮮", "food", true, 85), retail("鮭魚", "food", true, 85),
  retail("鮪魚", "food", true, 75), retail("蔬菜", "food", true, 85),
  retail("水果", "food", true, 85), retail("雞蛋", "food", true, 85),

  retail("紙尿褲", "household", false, 100), retail("尿片", "household", false, 95),
  retail("看護墊", "household", false, 95), retail("護墊", "household", false, 90),
  retail("衛生棉", "household", false, 95), retail("濕紙巾", "household", false, 90),
  retail("濕巾", "household", false, 85), retail("衛生紙", "household", false, 95),
  retail("洗衣粉", "household", false, 95), retail("洗衣精", "household", false, 95),
  retail("洗潔精", "household", false, 95), retail("洗滌液", "household", false, 90),
  retail("漂白水", "household", false, 95), retail("柔軟護衣精", "household", false, 95),
  retail("柔軟精", "household", false, 90), retail("清潔劑", "household", false, 90),
  retail("潔廁", "household", false, 90), retail("除濕", "household", false, 90),
  retail("收納盒", "household", false, 85), retail("整理箱", "household", false, 85),
  retail("收納架", "household", false, 85), retail("掛勾", "household", false, 80),
  retail("衣架", "household", false, 80), retail("曬衣", "household", false, 80),
  retail("床包", "household", false, 90), retail("枕頭", "household", false, 85),
  retail("浴巾", "household", false, 85), retail("毛巾", "household", false, 80),
  retail("餐具", "household", false, 85), retail("炒鍋", "household", false, 90),
  retail("煎鍋", "household", false, 90), retail("湯鍋", "household", false, 90),
  retail("烤盤", "household", false, 85), retail("保鮮膜", "household", false, 85),
  retail("製冰盒", "household", false, 80), retail("延長線", "household", false, 80),
  retail("燈泡", "household", false, 80), retail("吸頂燈", "household", false, 85),
  retail("電池", "household", false, 80), retail("電暖器", "household", false, 85),
  retail("電烤箱", "household", false, 85), retail("電子鍋", "household", false, 85),
  retail("微波爐", "household", false, 85), retail("吹風機", "household", false, 80),

  retail("牙膏", "health", false, 95), retail("牙刷", "health", false, 95),
  retail("漱口水", "health", false, 95), retail("牙線", "health", false, 90),
  retail("洗髮", "health", false, 90), retail("潤髮", "health", false, 85),
  retail("沐浴", "health", false, 90), retail("洗面", "health", false, 90),
  retail("化妝水", "health", false, 85), retail("乳液", "health", false, 85),
  retail("護膚", "health", false, 85), retail("保養", "health", false, 80),
  retail("染髮", "health", false, 85), retail("止汗", "health", false, 85),
  retail("防曬", "health", false, 85), retail("面膜", "health", false, 85),
  retail("葉黃素", "health", false, 90), retail("益生菌", "health", false, 85),
  retail("維他命", "health", false, 85), retail("保健食品", "health", false, 90),

  retail("狗糧", "household", false, 90), retail("狗食", "household", false, 90),
  retail("狗餐", "household", false, 90), retail("狗罐", "household", false, 90),
  retail("貓糧", "household", false, 90), retail("貓食", "household", false, 90),
  retail("貓罐", "household", false, 90), retail("寵物", "household", false, 80),

  retail("手機", "shopping", false, 90), retail("平板", "shopping", false, 85),
  retail("筆電", "shopping", false, 90), retail("耳機", "shopping", false, 90),
  retail("行動電源", "shopping", false, 90), retail("充電器", "shopping", false, 85),
  retail("充電線", "shopping", false, 85), retail("顯示器", "shopping", false, 85),
  retail("印表機", "shopping", false, 85), retail("鍵盤", "shopping", false, 80),
  retail("滑鼠", "shopping", false, 80), retail("服飾", "shopping", false, 85),
  retail("內衣", "shopping", false, 85), retail("內褲", "shopping", false, 85),
  retail("長褲", "shopping", false, 80), retail("短褲", "shopping", false, 80),
  retail("上衣", "shopping", false, 80), retail("襪", "shopping", false, 75),
  retail("鞋", "shopping", false, 70), retail("背包", "shopping", false, 80),
  retail("行李箱", "travel", false, 85), retail("旅行箱", "travel", false, 85),
  retail("遊戲軟體", "entertainment", false, 90), retail("桌遊", "entertainment", false, 90),
  retail("玩具", "entertainment", false, 80), retail("拼圖", "entertainment", false, 80),
];

// Product-type words beat flavor, scent and marketing words. For example,
// 「綠茶豆腐貓砂」 is household even though it contains 綠茶 and 豆腐.
const RETAIL_OVERRIDE_RULES: readonly RetailRule[] = [
  retail("貓砂", "household", false, 1000), retail("寵物", "household", false, 1000),
  retail("狗飼料", "household", false, 1000), retail("貓飼料", "household", false, 1000),
  retail("犬飼料", "household", false, 1000), retail("犬糧", "household", false, 1000),
  retail("貓糧", "household", false, 1000), retail("狗糧", "household", false, 1000),
  retail("狗乾糧", "household", false, 1000), retail("犬用", "household", false, 1000),
  retail("貓乾糧", "household", false, 1000), retail("犬乾糧", "household", false, 1000),
  retail("貓用", "household", false, 1000), retail("犬食", "household", false, 1000),
  retail("貓食", "household", false, 1000), retail("狗食", "household", false, 1000),
  retail("愛貓", "household", false, 1000), retail("愛犬", "household", false, 1000),
  retail("全齡犬", "household", false, 1000), retail("全齡貓", "household", false, 1000),
  retail("成犬", "household", false, 1000), retail("幼犬", "household", false, 1000),
  retail("成貓", "household", false, 1000), retail("幼貓", "household", false, 1000),
  retail("狗零食", "household", false, 1000), retail("貓零食", "household", false, 1000),
  retail("狗狗", "household", false, 1000), retail("貓咪", "household", false, 1000),
  retail("犬罐", "household", false, 1000), retail("貓罐", "household", false, 1000),
  retail("犬餐", "household", false, 1000), retail("貓餐", "household", false, 1000),
  retail("主食罐", "household", false, 1000), retail("副食罐", "household", false, 1000),
  retail("寵糧", "household", false, 1000), retail("潔牙骨", "household", false, 1000),
  retail("體態犬", "household", false, 1000),
  retail("犬凍乾", "household", false, 1000), retail("貓凍乾", "household", false, 1000),
  retail("犬貓", "household", false, 1000), retail("兔料", "household", false, 1000),
  retail("倉鼠", "household", false, 1000), retail("小動物點心", "household", false, 1000),
  retail("飼料", "household", false, 1000),

  retail("機殼", "shopping", false, 1000), retail("電腦機箱", "shopping", false, 1000),
  retail("鍵盤", "shopping", false, 1000), retail("滑鼠", "shopping", false, 1000),
  retail("筆電", "shopping", false, 1000), retail("平板電腦", "shopping", false, 1000),
  retail("顯示器", "shopping", false, 1000), retail("行動電源", "shopping", false, 1000),
  retail("化妝包", "shopping", false, 1000), retail("旅行箱", "travel", false, 1000),
  retail("行李箱", "travel", false, 1000), retail("壺鈴", "health", false, 1000),

  retail("沐浴", "health", false, 1000), retail("洗髮", "health", false, 1000),
  retail("洗面", "health", false, 1000), retail("潔面", "health", false, 1000),
  retail("護膚", "health", false, 1000), retail("化妝水", "health", false, 1000),
  retail("香氛噴霧", "health", false, 1000), retail("馬賽皂", "health", false, 1000),
  retail("饅頭皂", "health", false, 1000),

  retail("炒鍋", "household", false, 1000), retail("煎鍋", "household", false, 1000),
  retail("湯鍋", "household", false, 1000), retail("琺瑯鍋", "household", false, 1000),
  retail("餐盤", "household", false, 1000), retail("餐具", "household", false, 1000),
  retail("水果刀", "household", false, 1000), retail("牛奶鍋", "household", false, 1000),
  retail("雞蛋架", "household", false, 1000), retail("餅乾盒", "household", false, 1000),
  retail("零食櫃", "household", false, 1000), retail("點心盒", "household", false, 1000),
  retail("保鮮盒", "household", false, 1000), retail("調味料瓶", "household", false, 1000),
  retail("醬油罐", "household", false, 1000), retail("醬油瓶", "household", false, 1000),
  retail("榨汁機", "household", false, 1000), retail("製冰機", "household", false, 1000),
  retail("飲水機", "household", false, 1000), retail("氣泡水機", "household", false, 1000),
  retail("吸塵器", "household", false, 1000), retail("冰箱", "household", false, 1000),
  retail("蔬菜種子", "household", false, 1000), retail("有機肥料", "household", false, 1000),
];

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error("DATABASE_URL is required");
const maximumSitemaps = parseMaximum(process.env.CATALOG_MAX_SITEMAPS);
const pool = new Pool({ connectionString: databaseUrl, max: 3, application_name: "catalog-sync" });

try {
  const knowledge = await pool.query<KnowledgeRule>(
    `SELECT normalized_pattern, match_kind, category_code, meal_eligible, priority
       FROM category_knowledge_rule
      WHERE ledger_id IS NULL AND is_active
      ORDER BY char_length(normalized_pattern) DESC, priority DESC`,
  );
  const indexXml = await fetchText(PXMART_INDEX);
  const allSitemapUrls = extractLocations(indexXml)
    .filter((url) => /^https:\/\/pxbox\.es\.pxmart\.com\.tw\/SiteMap\/product_sitemap_\d+\.xml$/u.test(url));
  const sitemapUrls = allSitemapUrls.slice(0, maximumSitemaps);
  if (sitemapUrls.length === 0) throw new Error("catalog sitemap index is empty");

  const syncStartedAt = new Date();
  let imported = 0;
  let classified = 0;
  for (const [index, sitemapUrl] of sitemapUrls.entries()) {
    const xml = await fetchText(sitemapUrl);
    const rows = parsePxmartProducts(xml, knowledge.rows);
    await upsertRows(rows, syncStartedAt);
    imported += rows.length;
    classified += rows.filter((row) => row.categoryCode !== "uncategorized").length;
    process.stdout.write(`catalog_sitemap:${index + 1}/${sitemapUrls.length}:items=${rows.length}\n`);
  }
  if (sitemapUrls.length === allSitemapUrls.length) {
    await pool.query(
      `UPDATE product_catalog_item
          SET is_active=false, updated_at=clock_timestamp()
        WHERE source=$1 AND is_active AND last_seen_at < $2`,
      [SOURCE, syncStartedAt],
    );
  }
  process.stdout.write(`catalog_sync_complete:items=${imported}:classified=${classified}\n`);
} finally {
  await pool.end();
}

function parsePxmartProducts(xml: string, rules: readonly KnowledgeRule[]): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const match of xml.matchAll(/<url>([\s\S]*?)<\/url>/gu)) {
    const block = match[1] ?? "";
    const url = decodeXml(firstMatch(block, /<loc>([\s\S]*?)<\/loc>/u));
    const externalId = /\/product\/(\d+)(?:\?|$)/u.exec(url)?.[1];
    const productName = decodeXml(firstMatch(block, /<image:(?:caption|title)>([\s\S]*?)<\/image:(?:caption|title)>/u)).trim();
    if (externalId === undefined || productName.length === 0 || [...productName].length > 500) continue;
    const normalizedName = normalize(productName);
    const searchName = simplifyProductName(productName);
    if (normalizedName.length === 0 || searchName.length === 0) continue;
    const override = classifyRetailOverride(normalizedName);
    const knowledge = override === null ? classify(normalizedName, rules) : null;
    const retailClassification = override ?? (knowledge === null ? classifyRetail(normalizedName) : null);
    const categoryCode = retailClassification?.categoryCode ?? knowledge?.category_code ?? "uncategorized";
    const mealEligible = retailClassification?.mealEligible ?? knowledge?.meal_eligible ?? false;
    rows.push({
      externalId,
      productName,
      normalizedName,
      searchName,
      sourceUrl: url,
      categoryCode,
      mealEligible,
      classificationSource: categoryCode === "uncategorized"
        ? "unclassified"
        : knowledge === null ? "source_taxonomy" : "knowledge_rule",
    });
  }
  return rows;
}

function classifyRetail(normalizedName: string): RetailRule | null {
  const matches = RETAIL_RULES.filter((rule) => normalizedName.includes(rule.pattern));
  return [...matches].sort((left, right) => {
    const length = [...right.pattern].length - [...left.pattern].length;
    return length !== 0 ? length : right.priority - left.priority;
  })[0] ?? null;
}

function classifyRetailOverride(normalizedName: string): RetailRule | null {
  return RETAIL_OVERRIDE_RULES.find((rule) => normalizedName.includes(rule.pattern)) ?? null;
}

function retail(pattern: string, categoryCode: string, mealEligible: boolean, priority: number): RetailRule {
  return { pattern, categoryCode, mealEligible, priority };
}

async function upsertRows(rows: readonly CatalogRow[], seenAt: Date): Promise<void> {
  if (rows.length === 0) return;
  for (let offset = 0; offset < rows.length; offset += 1_000) {
    const batch = rows.slice(offset, offset + 1_000).map((row) => ({
      external_id: row.externalId, product_name: row.productName,
      normalized_name: row.normalizedName, search_name: row.searchName,
      source_url: row.sourceUrl, category_code: row.categoryCode,
      meal_eligible: row.mealEligible, classification_source: row.classificationSource,
    }));
    await pool.query(
      `INSERT INTO product_catalog_item (
         source, external_id, product_name, normalized_name, search_name,
         source_url, category_code, meal_eligible, classification_source,
         first_seen_at, last_seen_at
       )
       SELECT $1, x.external_id, x.product_name, x.normalized_name, x.search_name,
              x.source_url, x.category_code, x.meal_eligible, x.classification_source, $3, $3
         FROM jsonb_to_recordset($2::jsonb) AS x(
           external_id text, product_name text, normalized_name text, search_name text,
           source_url text, category_code text, meal_eligible boolean, classification_source text
         )
       ON CONFLICT (source, external_id) DO UPDATE
         SET product_name=excluded.product_name, normalized_name=excluded.normalized_name,
             search_name=excluded.search_name, source_url=excluded.source_url,
             category_code=excluded.category_code, meal_eligible=excluded.meal_eligible,
             classification_source=excluded.classification_source, is_active=true,
             last_seen_at=excluded.last_seen_at, updated_at=clock_timestamp()`,
      [SOURCE, JSON.stringify(batch), seenAt],
    );
  }
}

function classify(normalizedName: string, rules: readonly KnowledgeRule[]): KnowledgeRule | null {
  const matches = rules.filter((rule) => rule.match_kind === "exact"
    ? normalizedName === rule.normalized_pattern
    : normalizedName.includes(rule.normalized_pattern));
  if (matches.length === 0) return null;
  return [...matches].sort((left, right) => {
    const exact = Number(right.match_kind === "exact") - Number(left.match_kind === "exact");
    if (exact !== 0) return exact;
    const length = [...right.normalized_pattern].length - [...left.normalized_pattern].length;
    return length !== 0 ? length : right.priority - left.priority;
  })[0] ?? null;
}

function simplifyProductName(value: string): string {
  const withoutBrand = value.normalize("NFKC")
    .replace(/^[【〖\[][^】〗\]]+[】〗\]]\s*/u, "")
    .replace(/\([^)]*(?:任選|規格|顏色|效期)[^)]*\)/giu, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:kg|g|mg|ml|l|公克|公斤|毫升|公升|入|包|盒|瓶|罐|組|件|抽|張|顆|枚|台)\b/giu, " ")
    .replace(/[x×*]\s*\d+\s*(?:入|包|盒|瓶|罐|組|件)?/giu, " ")
    .replace(/[()（）【】〖〗\[\]{}／/_,，。:：;；+＋-]+/gu, " ");
  return normalize(withoutBrand);
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-TW").trim().replace(/\s+/gu, " ");
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/xml,text/xml;q=0.9,*/*;q=0.1" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`catalog fetch failed:${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_RESPONSE_BYTES) throw new Error("catalog response too large");
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error("catalog response too large");
  return text;
}

function extractLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gu)].map((match) => decodeXml(match[1] ?? "").trim());
}

function firstMatch(value: string, pattern: RegExp): string {
  return pattern.exec(value)?.[1] ?? "";
}

function decodeXml(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}

function parseMaximum(value: string | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("CATALOG_MAX_SITEMAPS must be a positive integer");
  return parsed;
}
