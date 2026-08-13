-- Development / initial provisioning seed.
-- Execute with psql so the variables below can be overridden with -v.

\if :{?ledger_name}
\else
  \set ledger_name '共同記帳'
\endif

\if :{?line_group_id}
\else
  \set line_group_id 'DEV_LINE_GROUP_ID'
\endif

\if :{?member_1_line_user_id}
\else
  \set member_1_line_user_id 'DEV_LINE_USER_ID_1'
\endif

\if :{?member_1_display_name}
\else
  \set member_1_display_name '小明'
\endif

\if :{?member_2_line_user_id}
\else
  \set member_2_line_user_id 'DEV_LINE_USER_ID_2'
\endif

\if :{?member_2_display_name}
\else
  \set member_2_display_name '小美'
\endif

BEGIN;

INSERT INTO ledger (
  name,
  line_group_id,
  default_scope,
  allow_bare_entry,
  timezone
)
VALUES (
  :'ledger_name',
  :'line_group_id',
  'personal',
  true,
  'Asia/Taipei'
)
ON CONFLICT (line_group_id) DO NOTHING;

INSERT INTO member (
  ledger_id,
  line_user_id,
  display_name,
  command_alias,
  is_active
)
SELECT
  l.id,
  seed_member.line_user_id,
  seed_member.display_name,
  seed_member.display_name,
  true
FROM ledger l
CROSS JOIN (
  VALUES
    (:'member_1_line_user_id'::text, :'member_1_display_name'::text),
    (:'member_2_line_user_id'::text, :'member_2_display_name'::text)
) AS seed_member(line_user_id, display_name)
WHERE l.line_group_id = :'line_group_id'
ON CONFLICT (ledger_id, line_user_id) DO NOTHING;

INSERT INTO tag (
  ledger_id,
  type,
  code,
  display_name,
  normalized_name,
  is_system,
  is_active
)
SELECT
  l.id,
  seed_tag.type::tag_type,
  seed_tag.code,
  seed_tag.display_name,
  seed_tag.normalized_name,
  true,
  true
FROM ledger l
CROSS JOIN (
  VALUES
    ('category', 'food', '食物', '食物'),
    ('category', 'transport', '交通', '交通'),
    ('category', 'entertainment', '娛樂', '娛樂'),
    ('category', 'household', '居家', '居家'),
    ('category', 'shopping', '購物', '購物'),
    ('category', 'health', '醫療健康', '醫療健康'),
    ('category', 'travel', '旅遊', '旅遊'),
    ('category', 'uncategorized', '未分類', '未分類'),
    ('meal', 'breakfast', '早餐', '早餐'),
    ('meal', 'lunch', '午餐', '午餐'),
    ('meal', 'afternoon_tea', '下午茶', '下午茶'),
    ('meal', 'dinner', '晚餐', '晚餐'),
    ('meal', 'late_night', '宵夜', '宵夜'),
    ('custom', 'native_family', '原生家庭', '原生家庭')
) AS seed_tag(type, code, display_name, normalized_name)
WHERE l.line_group_id = :'line_group_id'
ON CONFLICT (ledger_id, type, code) DO NOTHING;

COMMIT;
