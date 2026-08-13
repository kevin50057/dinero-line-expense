import type { PoolClient } from "pg";

import { makeCategoryAssignment } from "../domain/index.js";
import type { CategoryAssignment, CategoryCode } from "../domain/index.js";

export interface CategoryKnowledgeMatch {
  readonly category: CategoryAssignment;
  readonly mealEligible: boolean;
}

interface KnowledgeRow {
  id: string;
  category_code: CategoryCode;
  meal_eligible: boolean;
  source: "system_seed" | "member_correction";
}

export async function resolveCategoryKnowledge(
  client: PoolClient,
  ledgerId: string,
  description: string,
): Promise<CategoryKnowledgeMatch | null> {
  const normalized = normalizeKnowledgePattern(description);
  if (normalized.length === 0) return null;
  const result = await client.query<KnowledgeRow>(
    `WITH candidate AS (
       SELECT id
         FROM category_knowledge_rule
        WHERE is_active
          AND (ledger_id = $1 OR ledger_id IS NULL)
          AND (
            (match_kind = 'exact' AND normalized_pattern = $2)
            OR
            (match_kind = 'contains' AND position(normalized_pattern IN $2) > 0)
          )
        ORDER BY (ledger_id IS NOT NULL) DESC,
                 (match_kind = 'exact') DESC,
                 char_length(normalized_pattern) DESC,
                 priority DESC,
                 id
        LIMIT 1
     )
     UPDATE category_knowledge_rule rule
        SET hit_count = rule.hit_count + 1,
            last_matched_at = clock_timestamp()
       FROM candidate
      WHERE rule.id = candidate.id
      RETURNING rule.id::text, rule.category_code, rule.meal_eligible, rule.source`,
    [ledgerId, normalized],
  );
  const row = result.rows[0];
  if (row === undefined) return resolveProductCatalog(client, normalized);
  return {
    category: makeCategoryAssignment(
      row.category_code,
      "inferred",
      `knowledge:${row.source}:${row.id}`,
    ),
    mealEligible: row.meal_eligible,
  };
}

interface CatalogMatchRow {
  external_id: string;
  source: string;
  category_code: CategoryCode;
  meal_eligible: boolean;
  exact_match: boolean;
  score: number;
}

async function resolveProductCatalog(
  client: PoolClient,
  normalized: string,
): Promise<CategoryKnowledgeMatch | null> {
  if ([...normalized].length < 2) return null;
  const result = await client.query<CatalogMatchRow>(
    `SELECT external_id, source, category_code, meal_eligible,
            (normalized_name=$1 OR search_name=$1) AS exact_match,
            greatest(similarity(normalized_name,$1), similarity(search_name,$1))::float8 AS score
       FROM product_catalog_item
      WHERE is_active AND category_code <> 'uncategorized'
        AND (
          normalized_name=$1 OR search_name=$1
          OR normalized_name LIKE '%' || $1 || '%'
          OR search_name LIKE '%' || $1 || '%'
          OR (char_length($1) >= 3 AND (normalized_name % $1 OR search_name % $1))
        )
      ORDER BY (normalized_name=$1 OR search_name=$1) DESC,
               greatest(similarity(normalized_name,$1), similarity(search_name,$1)) DESC,
               char_length(search_name), id
      LIMIT 20`,
    [normalized],
  );
  const first = result.rows[0];
  if (first === undefined) return null;
  const contenders = first.exact_match
    ? result.rows.filter((row) => row.exact_match)
    : result.rows.filter((row) => row.score >= first.score - 0.05);
  if (new Set(contenders.map((row) => row.category_code)).size !== 1) return null;
  return {
    category: makeCategoryAssignment(
      first.category_code,
      "inferred",
      `catalog:${first.source}:${first.external_id}`,
    ),
    mealEligible: first.meal_eligible,
  };
}

export async function learnCategoryCorrection(
  client: PoolClient,
  ledgerId: string,
  description: string,
  category: CategoryCode,
): Promise<void> {
  const normalized = normalizeKnowledgePattern(description);
  if (normalized.length === 0) return;
  await client.query(
    `INSERT INTO category_knowledge_rule (
       ledger_id, normalized_pattern, match_kind, category_code,
       meal_eligible, priority, source
     )
     VALUES (
       $1, $2, 'exact', $3,
       coalesce((
         SELECT meal_eligible
           FROM category_knowledge_rule
          WHERE ledger_id IS NULL AND is_active AND category_code = $3
            AND (
              (match_kind = 'exact' AND normalized_pattern = $2)
              OR (match_kind = 'contains' AND position(normalized_pattern IN $2) > 0)
            )
          ORDER BY (match_kind = 'exact') DESC,
                   char_length(normalized_pattern) DESC,
                   priority DESC
          LIMIT 1
       ), false),
       1000, 'member_correction'
     )
     ON CONFLICT (ledger_id, normalized_pattern, match_kind)
       WHERE ledger_id IS NOT NULL AND is_active
     DO UPDATE SET category_code = excluded.category_code,
                   meal_eligible = excluded.meal_eligible,
                   priority = excluded.priority,
                   source = excluded.source,
                   updated_at = clock_timestamp()`,
    [ledgerId, normalized, category],
  );
}

export function normalizeKnowledgePattern(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-TW").trim().replace(/\s+/gu, " ");
}
