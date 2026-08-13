ALTER TABLE tag DROP CONSTRAINT tag_mvp_type_policy;

ALTER TABLE tag ADD CONSTRAINT tag_mvp_type_policy CHECK (
  (
    type = 'category'
    AND is_system
    AND is_active
    AND code IN (
      'food', 'transport', 'entertainment', 'household', 'shopping',
      'health', 'travel', 'uncategorized'
    )
  )
  OR
  (
    type = 'meal'
    AND is_system
    AND is_active
    AND code IN ('breakfast', 'lunch', 'afternoon_tea', 'dinner', 'late_night')
  )
  OR
  (
    type = 'custom'
    AND (
      NOT is_system
      OR (is_system AND is_active AND code = 'native_family')
    )
  )
);

ALTER TABLE transaction_tag
  DROP CONSTRAINT transaction_tag_custom_source_explicit;

CREATE FUNCTION assert_inferred_custom_tag_is_system()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tag_type = 'custom' AND NEW.source = 'inferred' AND NOT EXISTS (
    SELECT 1
      FROM tag t
     WHERE t.ledger_id = NEW.ledger_id
       AND t.id = NEW.tag_id
       AND t.type = 'custom'
       AND t.is_system
       AND t.is_active
  ) THEN
    RAISE EXCEPTION 'inferred custom tag must reference an active system tag'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transaction_tag_inferred_custom_system_guard
BEFORE INSERT OR UPDATE OF tag_id, tag_type, source ON transaction_tag
FOR EACH ROW EXECUTE FUNCTION assert_inferred_custom_tag_is_system();

INSERT INTO tag (
  ledger_id, type, code, display_name, normalized_name, is_system, is_active
)
SELECT id, 'custom', 'native_family', '原生家庭', '原生家庭', true, true
  FROM ledger
ON CONFLICT (ledger_id, type, code) DO NOTHING;

COMMENT ON FUNCTION assert_inferred_custom_tag_is_system() IS
  'Allows inferred context tags only when backed by an active system-owned custom tag.';
