-- Standalone users can keep one private ledger and optionally join one couple
-- ledger. Private routing prefers the personal membership, so pairing never
-- exposes or strands the user's pre-existing personal history.
ALTER TABLE member
  ADD COLUMN membership_kind text NOT NULL DEFAULT 'couple';

ALTER TABLE member
  ADD CONSTRAINT member_membership_kind_check
  CHECK (membership_kind IN ('personal', 'couple'));

DROP INDEX member_active_line_user_id_unique;

CREATE UNIQUE INDEX member_active_personal_line_user_id_unique
  ON member (line_user_id)
  WHERE is_active AND membership_kind = 'personal';

CREATE UNIQUE INDEX member_active_couple_line_user_id_unique
  ON member (line_user_id)
  WHERE is_active AND membership_kind = 'couple';

CREATE FUNCTION provision_line_user_ledger(p_line_user_id text)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_ledger_id uuid;
  v_route_id text;
BEGIN
  IF p_line_user_id IS NULL OR btrim(p_line_user_id) = '' THEN
    RAISE EXCEPTION 'LINE user ID must not be blank'
      USING ERRCODE = '23514';
  END IF;

  v_route_id := 'user:' || p_line_user_id;
  v_ledger_id := provision_line_group_ledger(v_route_id);

  UPDATE ledger
     SET name = 'DINERO 個人帳本', default_scope = 'personal',
         allow_bare_entry = true
   WHERE id = v_ledger_id;

  INSERT INTO member (
    ledger_id, line_user_id, display_name, command_alias, membership_kind
  ) VALUES (
    v_ledger_id, p_line_user_id, '我', NULL, 'personal'
  )
  ON CONFLICT (ledger_id, line_user_id) DO UPDATE
    SET is_active = true, membership_kind = 'personal',
        updated_at = clock_timestamp();

  RETURN v_ledger_id;
END;
$$;

COMMENT ON FUNCTION provision_line_user_ledger(text) IS
  'Idempotently provisions one isolated private ledger, system tags and personal member identity for a LINE user.';
