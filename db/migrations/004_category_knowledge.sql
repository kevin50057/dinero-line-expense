CREATE TABLE category_knowledge_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid REFERENCES ledger (id) ON DELETE CASCADE,
  normalized_pattern text NOT NULL,
  match_kind text NOT NULL,
  category_code text NOT NULL,
  meal_eligible boolean NOT NULL DEFAULT false,
  priority smallint NOT NULL DEFAULT 50,
  source text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  hit_count bigint NOT NULL DEFAULT 0,
  last_matched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT category_knowledge_pattern_valid CHECK (
    normalized_pattern = lower(btrim(normalized_pattern))
    AND normalized_pattern <> ''
    AND normalized_pattern !~ '[[:space:]]{2,}'
  ),
  CONSTRAINT category_knowledge_match_kind_valid CHECK (match_kind IN ('exact', 'contains')),
  CONSTRAINT category_knowledge_contains_length CHECK (match_kind <> 'contains' OR char_length(normalized_pattern) >= 2),
  CONSTRAINT category_knowledge_category_valid CHECK (
    category_code IN ('food','transport','entertainment','household','shopping','health','travel','uncategorized')
  ),
  CONSTRAINT category_knowledge_meal_valid CHECK (NOT meal_eligible OR category_code = 'food'),
  CONSTRAINT category_knowledge_priority_valid CHECK (priority BETWEEN 0 AND 1000),
  CONSTRAINT category_knowledge_source_valid CHECK (source IN ('system_seed', 'member_correction')),
  CONSTRAINT category_knowledge_hit_count_valid CHECK (hit_count >= 0)
);

CREATE UNIQUE INDEX category_knowledge_global_unique
  ON category_knowledge_rule (normalized_pattern, match_kind)
  WHERE ledger_id IS NULL AND is_active;

CREATE UNIQUE INDEX category_knowledge_ledger_unique
  ON category_knowledge_rule (ledger_id, normalized_pattern, match_kind)
  WHERE ledger_id IS NOT NULL AND is_active;

CREATE INDEX category_knowledge_lookup_idx
  ON category_knowledge_rule (ledger_id, is_active, match_kind, normalized_pattern);

INSERT INTO category_knowledge_rule (
  normalized_pattern, match_kind, category_code, meal_eligible, priority, source
)
SELECT pattern, kind, category, meal, priority, 'system_seed'
FROM (VALUES
  ('肉蛋吐司','contains','food',true,100), ('蛋餅','contains','food',true,90),
  ('早餐店','contains','food',true,90), ('三明治','contains','food',true,85),
  ('漢堡','contains','food',true,85), ('吐司','contains','food',true,80),
  ('豆漿','contains','food',false,75), ('燒餅','contains','food',true,75),
  ('油條','contains','food',true,75), ('飯糰','contains','food',true,80),
  ('便當','contains','food',true,90), ('滷肉飯','contains','food',true,95),
  ('肉燥飯','contains','food',true,95), ('雞肉飯','contains','food',true,95),
  ('排骨飯','contains','food',true,95), ('雞腿飯','contains','food',true,95),
  ('咖哩飯','contains','food',true,95), ('炒飯','contains','food',true,90),
  ('丼飯','contains','food',true,90), ('壽司','contains','food',true,90),
  ('生魚片','contains','food',true,90), ('拉麵','contains','food',true,90),
  ('牛肉麵','contains','food',true,100), ('陽春麵','contains','food',true,90),
  ('乾麵','contains','food',true,85), ('炒麵','contains','food',true,90),
  ('義大利麵','contains','food',true,95), ('水餃','contains','food',true,85),
  ('鍋貼','contains','food',true,85), ('小籠包','contains','food',true,90),
  ('湯包','contains','food',true,85), ('火鍋','contains','food',true,90),
  ('麻辣鍋','contains','food',true,95), ('燒肉','contains','food',true,90),
  ('烤肉','contains','food',true,85), ('牛排','contains','food',true,90),
  ('雞排','contains','food',true,85), ('鹽酥雞','contains','food',true,90),
  ('滷味','contains','food',true,85), ('麥當勞','contains','food',true,95),
  ('肯德基','contains','food',true,95), ('摩斯','contains','food',true,90),
  ('星巴克','contains','food',false,90), ('咖啡','contains','food',false,80),
  ('拿鐵','contains','food',false,85), ('手搖','contains','food',false,80),
  ('珍珠奶茶','contains','food',false,90), ('奶茶','contains','food',false,85),
  ('飲料','contains','food',false,80), ('果汁','contains','food',false,75),
  ('茶葉蛋','contains','food',true,80), ('甜點','contains','food',false,80),
  ('蛋糕','contains','food',false,80), ('麵包','contains','food',true,75),
  ('冰淇淋','contains','food',false,80), ('早餐','contains','food',true,80),
  ('午餐','contains','food',true,80), ('晚餐','contains','food',true,80),
  ('宵夜','contains','food',true,80),

  ('計程車','contains','transport',false,95), ('小黃','contains','transport',false,85),
  ('uber','contains','transport',false,90), ('捷運','contains','transport',false,90),
  ('公車','contains','transport',false,90), ('客運','contains','transport',false,85),
  ('高鐵','contains','transport',false,95), ('台鐵','contains','transport',false,90),
  ('火車','contains','transport',false,85), ('機捷','contains','transport',false,90),
  ('共享單車','contains','transport',false,85), ('youbike','contains','transport',false,85),
  ('停車費','contains','transport',false,90), ('停車場','contains','transport',false,85),
  ('加油','contains','transport',false,90), ('汽油','contains','transport',false,85),
  ('機油','contains','transport',false,75), ('洗車','contains','transport',false,75),
  ('過路費','contains','transport',false,85), ('etag','contains','transport',false,85),
  ('車票','contains','transport',false,75), ('月票','contains','transport',false,70),
  ('車資','contains','transport',false,80), ('租車','contains','transport',false,80),

  ('電影','contains','entertainment',false,90), ('威秀','contains','entertainment',false,90),
  ('秀泰','contains','entertainment',false,85), ('國賓影城','contains','entertainment',false,90),
  ('演唱會','contains','entertainment',false,95), ('音樂祭','contains','entertainment',false,90),
  ('ktv','contains','entertainment',false,90), ('錢櫃','contains','entertainment',false,85),
  ('好樂迪','contains','entertainment',false,85), ('遊戲','contains','entertainment',false,80),
  ('steam','contains','entertainment',false,85), ('playstation','contains','entertainment',false,85),
  ('任天堂','contains','entertainment',false,85), ('展覽','contains','entertainment',false,80),
  ('門票','contains','entertainment',false,70), ('netflix','contains','entertainment',false,90),
  ('disney+','contains','entertainment',false,90), ('spotify','contains','entertainment',false,85),
  ('youtube premium','contains','entertainment',false,85), ('桌遊','contains','entertainment',false,80),

  ('房租','contains','household',false,95), ('租金','contains','household',false,90),
  ('管理費','contains','household',false,90), ('水費','contains','household',false,90),
  ('電費','contains','household',false,90), ('瓦斯費','contains','household',false,90),
  ('天然氣','contains','household',false,85), ('網路費','contains','household',false,85),
  ('手機費','contains','household',false,85), ('電話費','contains','household',false,80),
  ('第四台','contains','household',false,80), ('日用品','contains','household',false,85),
  ('衛生紙','contains','household',false,80), ('洗衣精','contains','household',false,80),
  ('清潔劑','contains','household',false,80), ('垃圾袋','contains','household',false,75),
  ('家具','contains','household',false,80), ('家電','contains','household',false,80),
  ('修繕','contains','household',false,85), ('水電維修','contains','household',false,90),
  ('孝親費','contains','household',false,100), ('家用','exact','household',false,80),
  ('保母費','contains','household',false,85), ('托嬰','contains','household',false,85),

  ('蝦皮','contains','shopping',false,85), ('momo','contains','shopping',false,85),
  ('網購','contains','shopping',false,80), ('百貨','contains','shopping',false,80),
  ('衣服','contains','shopping',false,85), ('外套','contains','shopping',false,80),
  ('褲子','contains','shopping',false,80), ('球鞋','contains','shopping',false,85),
  ('鞋子','contains','shopping',false,80), ('包包','contains','shopping',false,80),
  ('化妝品','contains','shopping',false,85), ('保養品','contains','shopping',false,85),
  ('香水','contains','shopping',false,80), ('飾品','contains','shopping',false,75),
  ('手機殼','contains','shopping',false,80), ('耳機','contains','shopping',false,80),
  ('充電線','contains','shopping',false,75), ('書籍','contains','shopping',false,75),
  ('文具','contains','shopping',false,75), ('禮物','contains','shopping',false,70),

  ('看診','contains','health',false,95), ('掛號費','contains','health',false,95),
  ('診所','contains','health',false,90), ('醫院','contains','health',false,90),
  ('牙醫','contains','health',false,95), ('洗牙','contains','health',false,90),
  ('眼科','contains','health',false,90), ('皮膚科','contains','health',false,90),
  ('中醫','contains','health',false,90), ('復健','contains','health',false,90),
  ('物理治療','contains','health',false,90), ('醫藥費','contains','health',false,95),
  ('藥局','contains','health',false,90), ('保健食品','contains','health',false,80),
  ('健身房','contains','health',false,85), ('健身','contains','health',false,80),
  ('瑜珈','contains','health',false,80), ('按摩','contains','health',false,70),
  ('眼鏡','contains','health',false,75), ('隱形眼鏡','contains','health',false,80),

  ('機票','contains','travel',false,100), ('飯店','contains','travel',false,100),
  ('旅館','contains','travel',false,95), ('民宿','contains','travel',false,95),
  ('住宿','contains','travel',false,90), ('青旅','contains','travel',false,90),
  ('旅行社','contains','travel',false,90), ('行程','contains','travel',false,70),
  ('簽證','contains','travel',false,90), ('護照','contains','travel',false,85),
  ('旅平險','contains','travel',false,90), ('行李托運','contains','travel',false,85),
  ('機場接送','contains','travel',false,90), ('國外上網','contains','travel',false,85),
  ('esim','contains','travel',false,85), ('換匯','contains','travel',false,80)
) AS seed(pattern, kind, category, meal, priority);

COMMENT ON TABLE category_knowledge_rule IS
  'Deterministic category knowledge: global curated rules plus ledger-specific corrections; ledger rules always win.';
