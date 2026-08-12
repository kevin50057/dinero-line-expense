\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  v_ledger_id uuid;
  v_member_id uuid;
  v_food_tag_id uuid;
  v_lunch_tag_id uuid;
  v_custom_tag_id uuid;
  v_expense_id uuid;
  v_unsend_event_id text := 'smoke-unsend-event';
  v_deleted integer;
BEGIN
  SELECT id INTO STRICT v_ledger_id
  FROM ledger
  WHERE line_group_id = 'C_TEST_GROUP';

  SELECT id INTO STRICT v_member_id
  FROM member
  WHERE ledger_id = v_ledger_id
    AND line_user_id = 'U_TEST_1';

  SELECT id INTO STRICT v_food_tag_id
  FROM tag
  WHERE ledger_id = v_ledger_id
    AND type = 'category'
    AND code = 'food';

  SELECT id INTO STRICT v_lunch_tag_id
  FROM tag
  WHERE ledger_id = v_ledger_id
    AND type = 'meal'
    AND code = 'lunch';

  INSERT INTO inbound_event (
    webhook_event_id,
    ledger_id,
    event_type,
    line_message_id,
    line_event_at,
    payload_json
  )
  VALUES (
    'smoke-create-event',
    v_ledger_id,
    'message',
    'smoke-source-message',
    '2026-08-13 04:10:00+00',
    '{"text":"牛肉麵 150 #約會"}'::jsonb
  );

  INSERT INTO expense_transaction (
    ledger_id,
    public_id,
    created_by_member_id,
    payer_member_id,
    scope,
    amount_minor,
    description,
    occurred_on,
    occurred_date_source,
    occurred_at,
    occurred_time_source,
    occurred_time_precision,
    source_webhook_event_id,
    source_message_id,
    source_text
  )
  VALUES (
    v_ledger_id,
    'K7M2Q9TX',
    v_member_id,
    v_member_id,
    'shared',
    150,
    '牛肉麵',
    DATE '2026-08-13',
    'line_event',
    '2026-08-13 04:10:00+00',
    'line_event',
    'millisecond',
    'smoke-create-event',
    'smoke-source-message',
    '牛肉麵 150 #約會'
  )
  RETURNING id INTO v_expense_id;

  INSERT INTO transaction_tag (
    ledger_id,
    transaction_id,
    tag_id,
    tag_type,
    source,
    rule_key,
    rule_version
  )
  VALUES (
    v_ledger_id,
    v_expense_id,
    v_food_tag_id,
    'category',
    'inferred',
    'category:food.noodle',
    'v1'
  );

  INSERT INTO transaction_tag (
    ledger_id,
    transaction_id,
    tag_id,
    tag_type,
    source,
    rule_key,
    rule_version
  )
  VALUES (
    v_ledger_id,
    v_expense_id,
    v_lunch_tag_id,
    'meal',
    'inferred',
    'meal:lunch.window',
    'v1'
  );

  INSERT INTO tag (
    ledger_id,
    type,
    code,
    display_name,
    normalized_name,
    is_system
  )
  VALUES (
    v_ledger_id,
    'custom',
    'custom-smoke-date-night',
    '約會',
    '約會',
    false
  )
  RETURNING id INTO v_custom_tag_id;

  INSERT INTO transaction_tag (
    ledger_id,
    transaction_id,
    tag_id,
    tag_type,
    source,
    rule_key,
    rule_version,
    assigned_by_member_id
  )
  VALUES (
    v_ledger_id,
    v_expense_id,
    v_custom_tag_id,
    'custom',
    'explicit',
    'parser:user_hashtag',
    'v1',
    v_member_id
  );

  INSERT INTO transaction_event (
    ledger_id,
    transaction_id,
    actor_member_id,
    source_webhook_event_id,
    event_type,
    changed_fields,
    after_data,
    schema_version
  )
  VALUES (
    v_ledger_id,
    v_expense_id,
    v_member_id,
    'smoke-create-event',
    'created',
    '["amount_minor","description","tags"]'::jsonb,
    '{"amount_minor":150,"description":"牛肉麵"}'::jsonb,
    1
  );

  INSERT INTO outbox_message (
    ledger_id,
    source_webhook_event_id,
    purpose,
    delivery_kind,
    destination_ref,
    delivery_credential_ciphertext,
    payload_json,
    expires_at
  )
  VALUES (
    v_ledger_id,
    'smoke-create-event',
    'expense_confirmation',
    'reply',
    'smoke-source-message',
    decode('010203', 'hex'),
    '{"messages":[{"type":"text","text":"已記帳"}]}'::jsonb,
    clock_timestamp() + interval '55 seconds'
  );

  -- A date-only backfill must remain valid with unknown time.
  INSERT INTO inbound_event (
    webhook_event_id,
    ledger_id,
    event_type,
    line_message_id,
    line_event_at,
    payload_json
  )
  VALUES (
    'smoke-date-only-event',
    v_ledger_id,
    'message',
    'smoke-date-only-message',
    '2026-08-13 04:15:00+00',
    '{"text":"昨天 牛肉麵 150"}'::jsonb
  );

  INSERT INTO expense_transaction (
    ledger_id,
    public_id,
    created_by_member_id,
    payer_member_id,
    scope,
    amount_minor,
    description,
    occurred_on,
    occurred_date_source,
    occurred_at,
    occurred_time_source,
    occurred_time_precision,
    source_webhook_event_id,
    source_message_id
  )
  VALUES (
    v_ledger_id,
    'R4V8N3ZP',
    v_member_id,
    v_member_id,
    'shared',
    150,
    '牛肉麵',
    DATE '2026-08-12',
    'relative_input',
    NULL,
    NULL,
    'unknown',
    'smoke-date-only-event',
    'smoke-date-only-message'
  )
  RETURNING id INTO v_expense_id;

  INSERT INTO transaction_tag (
    ledger_id,
    transaction_id,
    tag_id,
    tag_type,
    source,
    rule_key,
    rule_version
  )
  VALUES (
    v_ledger_id,
    v_expense_id,
    v_food_tag_id,
    'category',
    'inferred',
    'category:food.noodle',
    'v1'
  );

  -- Exercise the privacy purge against the first transaction. In production the
  -- independent deletion journal is appended before this call.
  INSERT INTO inbound_event (
    webhook_event_id,
    ledger_id,
    event_type,
    line_message_id,
    line_event_at,
    payload_json
  )
  VALUES (
    v_unsend_event_id,
    v_ledger_id,
    'unsend',
    'smoke-source-message',
    '2026-08-13 04:20:00+00',
    '{}'::jsonb
  );

  v_deleted := purge_line_message_after_unsend(
    v_ledger_id,
    'smoke-source-message',
    v_unsend_event_id,
    '2026-08-13 04:20:00+00'
  );

  IF v_deleted <> 1 THEN
    RAISE EXCEPTION 'expected one purged expense, got %', v_deleted;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM expense_transaction
    WHERE ledger_id = v_ledger_id
      AND source_message_id = 'smoke-source-message'
  ) THEN
    RAISE EXCEPTION 'unsent expense was not purged';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM message_tombstone
    WHERE ledger_id = v_ledger_id
      AND line_message_id = 'smoke-source-message'
  ) THEN
    RAISE EXCEPTION 'unsend tombstone was not created';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM inbound_event
    WHERE ledger_id = v_ledger_id
      AND line_message_id = 'smoke-source-message'
      AND payload_json IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'inbox content was not redacted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM outbox_message
    WHERE ledger_id = v_ledger_id
      AND source_webhook_event_id = 'smoke-create-event'
      AND (
        payload_json IS NOT NULL
        OR delivery_credential_ciphertext IS NOT NULL
        OR status <> 'dead_letter'
      )
  ) THEN
    RAISE EXCEPTION 'outbox content was not redacted or delivery not stopped';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM tag
    WHERE ledger_id = v_ledger_id
      AND id = v_custom_tag_id
  ) THEN
    RAISE EXCEPTION 'orphan custom tag was not removed';
  END IF;
END;
$$;

SET CONSTRAINTS ALL IMMEDIATE;

ROLLBACK;
