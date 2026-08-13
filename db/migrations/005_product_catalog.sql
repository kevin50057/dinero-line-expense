SELECT pg_advisory_xact_lock(1947823613);
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE product_catalog_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_id text NOT NULL,
  product_name text NOT NULL,
  normalized_name text NOT NULL,
  search_name text NOT NULL,
  source_url text NOT NULL,
  category_code text NOT NULL,
  meal_eligible boolean NOT NULL DEFAULT false,
  classification_source text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT product_catalog_source_valid CHECK (source IN ('pxmart_sitemap', 'carrefour_sitemap', 'open_food_facts')),
  CONSTRAINT product_catalog_external_id_valid CHECK (btrim(external_id) <> '' AND char_length(external_id) <= 100),
  CONSTRAINT product_catalog_name_valid CHECK (btrim(product_name) <> '' AND char_length(product_name) <= 500),
  CONSTRAINT product_catalog_normalized_valid CHECK (
    normalized_name = lower(btrim(normalized_name)) AND normalized_name <> '' AND char_length(normalized_name) <= 500
  ),
  CONSTRAINT product_catalog_search_name_valid CHECK (
    search_name = lower(btrim(search_name)) AND search_name <> '' AND char_length(search_name) <= 500
  ),
  CONSTRAINT product_catalog_url_valid CHECK (source_url ~ '^https://[^[:space:]]+$' AND char_length(source_url) <= 2000),
  CONSTRAINT product_catalog_category_valid CHECK (
    category_code IN ('food','transport','entertainment','household','shopping','health','travel','uncategorized')
  ),
  CONSTRAINT product_catalog_meal_valid CHECK (NOT meal_eligible OR category_code = 'food'),
  CONSTRAINT product_catalog_classification_valid CHECK (classification_source IN ('knowledge_rule', 'source_taxonomy', 'unclassified')),
  CONSTRAINT product_catalog_seen_valid CHECK (last_seen_at >= first_seen_at),
  CONSTRAINT product_catalog_source_external_unique UNIQUE (source, external_id)
);

CREATE INDEX product_catalog_normalized_trgm_idx
  ON product_catalog_item USING gin (normalized_name gin_trgm_ops)
  WHERE is_active AND category_code <> 'uncategorized';

CREATE INDEX product_catalog_search_trgm_idx
  ON product_catalog_item USING gin (search_name gin_trgm_ops)
  WHERE is_active AND category_code <> 'uncategorized';

CREATE INDEX product_catalog_source_active_idx
  ON product_catalog_item (source, is_active, last_seen_at);

COMMENT ON TABLE product_catalog_item IS
  'Minimal, refreshable product-name index used only for expense classification; excludes retailer prices, images and descriptions.';
