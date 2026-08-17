-- Public multi-ledger onboarding. A LINE identity may belong to only one
-- active couple ledger so private messages always have an unambiguous route.
CREATE UNIQUE INDEX member_active_line_user_id_unique
  ON member (line_user_id)
  WHERE is_active;

CREATE FUNCTION provision_line_group_ledger(p_line_group_id text)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_ledger_id uuid;
BEGIN
  IF p_line_group_id IS NULL OR btrim(p_line_group_id) = '' THEN
    RAISE EXCEPTION 'LINE group ID must not be blank'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO ledger (
    name, line_group_id, default_scope, allow_bare_entry, timezone
  ) VALUES (
    'DINERO 兩人帳本', p_line_group_id, 'personal', true, 'Asia/Taipei'
  )
  ON CONFLICT (line_group_id) DO UPDATE
    SET line_group_id = EXCLUDED.line_group_id
  RETURNING id INTO v_ledger_id;

  INSERT INTO tag (
    ledger_id, type, code, display_name, normalized_name, is_system, is_active
  )
  SELECT
    v_ledger_id,
    seed.type::tag_type,
    seed.code,
    seed.display_name,
    seed.normalized_name,
    true,
    true
  FROM (
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
  ) AS seed(type, code, display_name, normalized_name)
  ON CONFLICT (ledger_id, type, code) DO NOTHING;

  RETURN v_ledger_id;
END;
$$;

COMMENT ON FUNCTION provision_line_group_ledger(text) IS
  'Idempotently provisions one isolated two-person ledger and its system tags for a LINE group.';
