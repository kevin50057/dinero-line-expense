-- Initial PostgreSQL schema for the LINE expense bot.
--
-- The migration runner owns the surrounding transaction. Do not add a top-level
-- BEGIN/COMMIT here.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE expense_scope AS ENUM ('shared', 'personal');
CREATE TYPE tag_type AS ENUM ('category', 'meal', 'custom');
CREATE TYPE assignment_source AS ENUM ('explicit', 'inferred');
CREATE TYPE transaction_status AS ENUM ('active', 'voided');
CREATE TYPE void_reason AS ENUM ('user_cancel');
CREATE TYPE occurred_date_source AS ENUM (
  'line_event',
  'relative_input',
  'absolute_input',
  'manual_update'
);
CREATE TYPE occurred_time_source AS ENUM (
  'line_event',
  'explicit_input',
  'manual_update'
);
CREATE TYPE time_precision AS ENUM ('unknown', 'minute', 'millisecond');
CREATE TYPE transaction_event_type AS ENUM (
  'created',
  'updated',
  'voided',
  'restored'
);
CREATE TYPE inbox_status AS ENUM (
  'pending',
  'processing',
  'succeeded',
  'dead_letter'
);
CREATE TYPE outbox_status AS ENUM (
  'pending',
  'sending',
  'sent',
  'dead_letter'
);

CREATE TABLE ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  line_group_id text NOT NULL UNIQUE,
  default_scope expense_scope NOT NULL DEFAULT 'shared',
  allow_bare_entry boolean NOT NULL DEFAULT true,
  timezone text NOT NULL DEFAULT 'Asia/Taipei',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ledger_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT ledger_line_group_id_not_blank CHECK (btrim(line_group_id) <> ''),
  CONSTRAINT ledger_timezone_not_blank CHECK (btrim(timezone) <> '')
);

CREATE TABLE member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger (id) ON DELETE CASCADE,
  line_user_id text NOT NULL,
  display_name text NOT NULL,
  command_alias text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT member_ledger_id_id_unique UNIQUE (ledger_id, id),
  CONSTRAINT member_ledger_line_user_id_unique UNIQUE (ledger_id, line_user_id),
  CONSTRAINT member_line_user_id_not_blank CHECK (btrim(line_user_id) <> ''),
  CONSTRAINT member_display_name_not_blank CHECK (btrim(display_name) <> ''),
  CONSTRAINT member_command_alias_not_blank CHECK (
    command_alias IS NULL OR btrim(command_alias) <> ''
  )
);

CREATE UNIQUE INDEX member_active_command_alias_unique
  ON member (ledger_id, lower(btrim(command_alias)))
  WHERE is_active AND command_alias IS NOT NULL;

CREATE INDEX member_active_by_ledger_idx
  ON member (ledger_id, is_active);

CREATE TABLE tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger (id) ON DELETE CASCADE,
  type tag_type NOT NULL,
  code text NOT NULL,
  display_name text NOT NULL,
  normalized_name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tag_ledger_id_id_type_unique UNIQUE (ledger_id, id, type),
  CONSTRAINT tag_ledger_type_code_unique UNIQUE (ledger_id, type, code),
  CONSTRAINT tag_code_format CHECK (code ~ '^[a-z0-9][a-z0-9._-]*$'),
  CONSTRAINT tag_display_name_not_blank CHECK (btrim(display_name) <> ''),
  CONSTRAINT tag_normalized_name_canonical CHECK (
    normalized_name = lower(btrim(normalized_name))
    AND normalized_name <> ''
  ),
  CONSTRAINT tag_mvp_type_policy CHECK (
    (
      type = 'category'
      AND is_system
      AND is_active
      AND code IN (
        'food',
        'transport',
        'entertainment',
        'household',
        'shopping',
        'health',
        'travel',
        'uncategorized'
      )
    )
    OR
    (
      type = 'meal'
      AND is_system
      AND is_active
      AND code IN (
        'breakfast',
        'lunch',
        'afternoon_tea',
        'dinner',
        'late_night'
      )
    )
    OR
    (type = 'custom' AND NOT is_system)
  ),
  CONSTRAINT tag_custom_name_policy CHECK (
    type <> 'custom'
    OR (
      char_length(display_name) BETWEEN 1 AND 20
      AND display_name !~ '[[:space:]#]'
      AND char_length(normalized_name) BETWEEN 1 AND 20
      AND normalized_name !~ '[[:space:]#]'
    )
  )
);

CREATE UNIQUE INDEX tag_active_normalized_name_unique
  ON tag (ledger_id, normalized_name)
  WHERE is_active;

CREATE INDEX tag_lookup_idx
  ON tag (ledger_id, type, is_active);

CREATE TABLE inbound_event (
  webhook_event_id text PRIMARY KEY,
  ledger_id uuid NOT NULL REFERENCES ledger (id) ON DELETE CASCADE,
  event_type text NOT NULL,
  line_message_id text,
  line_event_at timestamptz NOT NULL,
  payload_json jsonb,
  status inbox_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  processed_at timestamptz,
  payload_redacted_at timestamptz,
  outcome_code text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT inbound_event_ledger_event_unique UNIQUE (ledger_id, webhook_event_id),
  CONSTRAINT inbound_event_id_not_blank CHECK (btrim(webhook_event_id) <> ''),
  CONSTRAINT inbound_event_type_not_blank CHECK (btrim(event_type) <> ''),
  CONSTRAINT inbound_event_line_message_id_not_blank CHECK (
    line_message_id IS NULL OR btrim(line_message_id) <> ''
  ),
  CONSTRAINT inbound_event_attempt_count_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT inbound_event_payload_is_object CHECK (
    payload_json IS NULL OR jsonb_typeof(payload_json) = 'object'
  ),
  CONSTRAINT inbound_event_redaction_consistent CHECK (
    payload_redacted_at IS NULL OR payload_json IS NULL
  ),
  CONSTRAINT inbound_event_processing_lock_consistent CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND processed_at IS NULL)
    OR
    (status <> 'processing' AND locked_at IS NULL)
  ),
  CONSTRAINT inbound_event_completion_consistent CHECK (
    (
      status IN ('pending', 'processing')
      AND processed_at IS NULL
      AND outcome_code IS NULL
    )
    OR
    (
      status = 'succeeded'
      AND processed_at IS NOT NULL
      AND btrim(outcome_code) <> ''
    )
    OR
    (
      status = 'dead_letter'
      AND processed_at IS NOT NULL
      AND outcome_code IS NULL
    )
  ),
  CONSTRAINT inbound_event_error_code_not_blank CHECK (
    last_error_code IS NULL OR btrim(last_error_code) <> ''
  )
);

CREATE INDEX inbound_event_claim_idx
  ON inbound_event (available_at, created_at)
  WHERE status = 'pending';

CREATE INDEX inbound_event_processing_lease_idx
  ON inbound_event (locked_at)
  WHERE status = 'processing';

CREATE INDEX inbound_event_line_message_idx
  ON inbound_event (ledger_id, line_message_id)
  WHERE line_message_id IS NOT NULL;

CREATE TABLE message_tombstone (
  ledger_id uuid NOT NULL REFERENCES ledger (id) ON DELETE CASCADE,
  line_message_id text NOT NULL,
  unsend_webhook_event_id text NOT NULL,
  unsent_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT message_tombstone_pk PRIMARY KEY (ledger_id, line_message_id),
  CONSTRAINT message_tombstone_unsend_event_unique
    UNIQUE (ledger_id, unsend_webhook_event_id),
  CONSTRAINT message_tombstone_line_message_id_not_blank
    CHECK (btrim(line_message_id) <> ''),
  CONSTRAINT message_tombstone_unsend_event_fk
    FOREIGN KEY (ledger_id, unsend_webhook_event_id)
    REFERENCES inbound_event (ledger_id, webhook_event_id)
);

CREATE TABLE expense_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger (id) ON DELETE CASCADE,
  public_id text NOT NULL,
  created_by_member_id uuid NOT NULL,
  payer_member_id uuid NOT NULL,
  personal_owner_member_id uuid,
  scope expense_scope NOT NULL,
  status transaction_status NOT NULL DEFAULT 'active',
  void_reason void_reason,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'TWD',
  description text NOT NULL,
  occurred_on date NOT NULL,
  occurred_date_source occurred_date_source NOT NULL,
  occurred_at timestamptz,
  occurred_time_source occurred_time_source,
  occurred_time_precision time_precision NOT NULL DEFAULT 'unknown',
  source_webhook_event_id text NOT NULL,
  source_message_id text NOT NULL,
  source_text text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  voided_at timestamptz,
  CONSTRAINT expense_transaction_ledger_id_id_unique UNIQUE (ledger_id, id),
  CONSTRAINT expense_transaction_public_id_unique UNIQUE (ledger_id, public_id),
  CONSTRAINT expense_transaction_source_event_unique
    UNIQUE (ledger_id, source_webhook_event_id),
  CONSTRAINT expense_transaction_source_message_unique
    UNIQUE (ledger_id, source_message_id),
  CONSTRAINT expense_transaction_creator_fk
    FOREIGN KEY (ledger_id, created_by_member_id)
    REFERENCES member (ledger_id, id),
  CONSTRAINT expense_transaction_payer_fk
    FOREIGN KEY (ledger_id, payer_member_id)
    REFERENCES member (ledger_id, id),
  CONSTRAINT expense_transaction_personal_owner_fk
    FOREIGN KEY (ledger_id, personal_owner_member_id)
    REFERENCES member (ledger_id, id),
  CONSTRAINT expense_transaction_source_event_fk
    FOREIGN KEY (ledger_id, source_webhook_event_id)
    REFERENCES inbound_event (ledger_id, webhook_event_id),
  CONSTRAINT expense_transaction_public_id_format CHECK (
    public_id ~ '^[0-9A-HJKMNP-TV-Z]{8,}$'
  ),
  CONSTRAINT expense_transaction_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT expense_transaction_currency_mvp CHECK (currency = 'TWD'),
  CONSTRAINT expense_transaction_description_not_blank CHECK (
    btrim(description) <> ''
  ),
  CONSTRAINT expense_transaction_source_message_not_blank CHECK (
    btrim(source_message_id) <> ''
  ),
  CONSTRAINT expense_transaction_scope_owner_consistent CHECK (
    (scope = 'shared' AND personal_owner_member_id IS NULL)
    OR
    (scope = 'personal' AND personal_owner_member_id IS NOT NULL)
  ),
  CONSTRAINT expense_transaction_status_consistent CHECK (
    (
      status = 'active'
      AND void_reason IS NULL
      AND voided_at IS NULL
    )
    OR
    (
      status = 'voided'
      AND void_reason = 'user_cancel'
      AND voided_at IS NOT NULL
    )
  ),
  CONSTRAINT expense_transaction_occurrence_time_consistent CHECK (
    (
      occurred_at IS NULL
      AND occurred_time_source IS NULL
      AND occurred_time_precision = 'unknown'
    )
    OR
    (
      occurred_at IS NOT NULL
      AND occurred_time_source IS NOT NULL
      AND occurred_time_precision IN ('minute', 'millisecond')
    )
  ),
  CONSTRAINT expense_transaction_row_version_positive CHECK (row_version > 0)
);

CREATE FUNCTION validate_expense_source_event_message()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM inbound_event ie
    WHERE ie.ledger_id = NEW.ledger_id
      AND ie.webhook_event_id = NEW.source_webhook_event_id
      AND ie.event_type = 'message'
      AND ie.line_message_id = NEW.source_message_id
  ) THEN
    RAISE EXCEPTION
      'expense source message does not match its inbound event'
      USING ERRCODE = '23514',
            CONSTRAINT = 'expense_transaction_source_message_matches_event';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER expense_transaction_validate_source_event_message
BEFORE INSERT OR UPDATE OF ledger_id, source_webhook_event_id, source_message_id
ON expense_transaction
FOR EACH ROW
EXECUTE FUNCTION validate_expense_source_event_message();

CREATE INDEX expense_transaction_active_date_idx
  ON expense_transaction (ledger_id, occurred_on DESC, created_at DESC)
  WHERE status = 'active';

CREATE INDEX expense_transaction_recent_idx
  ON expense_transaction (ledger_id, created_at DESC)
  WHERE status = 'active';

CREATE INDEX expense_transaction_personal_owner_idx
  ON expense_transaction (ledger_id, personal_owner_member_id, occurred_on DESC)
  WHERE status = 'active' AND scope = 'personal';

CREATE TABLE transaction_tag (
  ledger_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  tag_type tag_type NOT NULL,
  source assignment_source NOT NULL,
  rule_key text NOT NULL,
  rule_version text NOT NULL,
  assigned_by_member_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT transaction_tag_pk PRIMARY KEY (ledger_id, transaction_id, tag_id),
  CONSTRAINT transaction_tag_transaction_fk
    FOREIGN KEY (ledger_id, transaction_id)
    REFERENCES expense_transaction (ledger_id, id)
    ON DELETE CASCADE,
  CONSTRAINT transaction_tag_typed_tag_fk
    FOREIGN KEY (ledger_id, tag_id, tag_type)
    REFERENCES tag (ledger_id, id, type),
  CONSTRAINT transaction_tag_assigned_by_fk
    FOREIGN KEY (ledger_id, assigned_by_member_id)
    REFERENCES member (ledger_id, id),
  CONSTRAINT transaction_tag_rule_key_not_blank CHECK (btrim(rule_key) <> ''),
  CONSTRAINT transaction_tag_rule_version_not_blank CHECK (
    btrim(rule_version) <> ''
  ),
  CONSTRAINT transaction_tag_assignment_actor_consistent CHECK (
    (source = 'explicit' AND assigned_by_member_id IS NOT NULL)
    OR
    (source = 'inferred' AND assigned_by_member_id IS NULL)
  ),
  CONSTRAINT transaction_tag_custom_source_explicit CHECK (
    tag_type <> 'custom' OR source = 'explicit'
  )
);

CREATE UNIQUE INDEX transaction_tag_one_category_idx
  ON transaction_tag (ledger_id, transaction_id, tag_type)
  WHERE tag_type = 'category';

CREATE UNIQUE INDEX transaction_tag_one_meal_idx
  ON transaction_tag (ledger_id, transaction_id, tag_type)
  WHERE tag_type = 'meal';

CREATE INDEX transaction_tag_tag_lookup_idx
  ON transaction_tag (ledger_id, tag_id, transaction_id);

CREATE FUNCTION prevent_transaction_tag_reparenting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.ledger_id <> OLD.ledger_id
     OR NEW.transaction_id <> OLD.transaction_id THEN
    RAISE EXCEPTION 'a tag assignment cannot be moved to another expense'
      USING ERRCODE = '23514',
            CONSTRAINT = 'transaction_tag_parent_immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER transaction_tag_prevent_reparenting
BEFORE UPDATE ON transaction_tag
FOR EACH ROW
EXECUTE FUNCTION prevent_transaction_tag_reparenting();

CREATE TABLE transaction_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  actor_member_id uuid,
  source_webhook_event_id text,
  event_type transaction_event_type NOT NULL,
  reason text,
  changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  before_data jsonb,
  after_data jsonb,
  schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT transaction_event_transaction_fk
    FOREIGN KEY (ledger_id, transaction_id)
    REFERENCES expense_transaction (ledger_id, id)
    ON DELETE CASCADE,
  CONSTRAINT transaction_event_actor_fk
    FOREIGN KEY (ledger_id, actor_member_id)
    REFERENCES member (ledger_id, id),
  CONSTRAINT transaction_event_source_event_fk
    FOREIGN KEY (ledger_id, source_webhook_event_id)
    REFERENCES inbound_event (ledger_id, webhook_event_id),
  CONSTRAINT transaction_event_source_unique
    UNIQUE (ledger_id, source_webhook_event_id),
  CONSTRAINT transaction_event_changed_fields_array CHECK (
    jsonb_typeof(changed_fields) = 'array'
  ),
  CONSTRAINT transaction_event_before_data_object CHECK (
    before_data IS NULL OR jsonb_typeof(before_data) = 'object'
  ),
  CONSTRAINT transaction_event_after_data_object CHECK (
    after_data IS NULL OR jsonb_typeof(after_data) = 'object'
  ),
  CONSTRAINT transaction_event_schema_version_positive CHECK (schema_version > 0),
  CONSTRAINT transaction_event_actor_source_consistent CHECK (
    (
      actor_member_id IS NOT NULL
      AND source_webhook_event_id IS NOT NULL
    )
    OR
    (
      actor_member_id IS NULL
      AND reason IS NOT NULL
      AND btrim(reason) <> ''
    )
  )
);

CREATE INDEX transaction_event_history_idx
  ON transaction_event (ledger_id, transaction_id, created_at, id);

CREATE TABLE outbox_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger (id) ON DELETE CASCADE,
  source_webhook_event_id text NOT NULL,
  purpose text NOT NULL,
  delivery_kind text NOT NULL,
  destination_ref text NOT NULL,
  delivery_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  delivery_credential_ciphertext bytea,
  payload_json jsonb,
  status outbox_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  sent_at timestamptz,
  payload_redacted_at timestamptz,
  expires_at timestamptz NOT NULL,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT outbox_message_event_purpose_unique
    UNIQUE (ledger_id, source_webhook_event_id, purpose),
  CONSTRAINT outbox_message_source_event_fk
    FOREIGN KEY (ledger_id, source_webhook_event_id)
    REFERENCES inbound_event (ledger_id, webhook_event_id),
  CONSTRAINT outbox_message_purpose_not_blank CHECK (btrim(purpose) <> ''),
  CONSTRAINT outbox_message_delivery_kind_not_blank CHECK (
    btrim(delivery_kind) <> ''
  ),
  CONSTRAINT outbox_message_destination_not_blank CHECK (
    btrim(destination_ref) <> ''
  ),
  CONSTRAINT outbox_message_attempt_count_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT outbox_message_payload_is_object CHECK (
    payload_json IS NULL OR jsonb_typeof(payload_json) = 'object'
  ),
  CONSTRAINT outbox_message_redaction_consistent CHECK (
    payload_redacted_at IS NULL OR payload_json IS NULL
  ),
  CONSTRAINT outbox_message_delivery_state_consistent CHECK (
    (
      status = 'pending'
      AND locked_at IS NULL
      AND sent_at IS NULL
      AND payload_json IS NOT NULL
    )
    OR
    (
      status = 'sending'
      AND locked_at IS NOT NULL
      AND sent_at IS NULL
      AND payload_json IS NOT NULL
    )
    OR
    (
      status = 'sent'
      AND locked_at IS NULL
      AND sent_at IS NOT NULL
    )
    OR
    (
      status = 'dead_letter'
      AND locked_at IS NULL
      AND sent_at IS NULL
    )
  ),
  CONSTRAINT outbox_message_error_code_not_blank CHECK (
    last_error_code IS NULL OR btrim(last_error_code) <> ''
  )
);

CREATE INDEX outbox_message_claim_idx
  ON outbox_message (available_at, created_at)
  WHERE status = 'pending';

CREATE INDEX outbox_message_sending_lease_idx
  ON outbox_message (locked_at)
  WHERE status = 'sending';

CREATE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_set_updated_at
BEFORE UPDATE ON ledger
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER member_set_updated_at
BEFORE UPDATE ON member
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tag_set_updated_at
BEFORE UPDATE ON tag
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION validate_ledger_timezone()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_timezone_names
    WHERE name = NEW.timezone
  ) THEN
    RAISE EXCEPTION 'unknown IANA timezone: %', NEW.timezone
      USING ERRCODE = '22023', CONSTRAINT = 'ledger_timezone_valid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_validate_timezone
BEFORE INSERT OR UPDATE OF timezone ON ledger
FOR EACH ROW
EXECUTE FUNCTION validate_ledger_timezone();

CREATE FUNCTION prevent_system_tag_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A ledger teardown owns the whole aggregate and must be allowed to cascade.
  -- A direct DELETE/UPDATE of a system tag remains forbidden.
  IF OLD.is_system
     AND EXISTS (SELECT 1 FROM ledger WHERE id = OLD.ledger_id) THEN
    RAISE EXCEPTION 'system tags cannot be updated or deleted in the MVP'
      USING ERRCODE = '23514', CONSTRAINT = 'tag_system_immutable';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER tag_prevent_system_mutation
BEFORE UPDATE OR DELETE ON tag
FOR EACH ROW
EXECUTE FUNCTION prevent_system_tag_mutation();

CREATE FUNCTION line_message_lock_key(p_ledger_id uuid, p_line_message_id text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT hashtextextended(p_ledger_id::text || ':' || p_line_message_id, 0);
$$;

CREATE FUNCTION lock_line_message(p_ledger_id uuid, p_line_message_id text)
RETURNS void
LANGUAGE sql
VOLATILE
STRICT
PARALLEL UNSAFE
AS $$
  SELECT pg_advisory_xact_lock(line_message_lock_key(p_ledger_id, p_line_message_id));
$$;

CREATE FUNCTION guard_expense_source_message()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.ledger_id = OLD.ledger_id
     AND NEW.source_message_id = OLD.source_message_id THEN
    RETURN NEW;
  END IF;

  PERFORM lock_line_message(NEW.ledger_id, NEW.source_message_id);

  IF EXISTS (
    SELECT 1
    FROM message_tombstone mt
    WHERE mt.ledger_id = NEW.ledger_id
      AND mt.line_message_id = NEW.source_message_id
  ) THEN
    RAISE EXCEPTION 'source LINE message has already been unsent'
      USING ERRCODE = '23514', CONSTRAINT = 'expense_source_message_not_unsent';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER expense_transaction_guard_source_message
BEFORE INSERT OR UPDATE OF ledger_id, source_message_id ON expense_transaction
FOR EACH ROW
EXECUTE FUNCTION guard_expense_source_message();

CREATE FUNCTION enforce_expense_update_contract()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.ledger_id <> OLD.ledger_id
     OR NEW.source_webhook_event_id <> OLD.source_webhook_event_id
     OR NEW.source_message_id <> OLD.source_message_id
     OR NEW.created_by_member_id <> OLD.created_by_member_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'expense identity and source fields are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'expense_transaction_identity_immutable';
  END IF;

  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'expense row_version must advance by exactly one'
      USING ERRCODE = '23514', CONSTRAINT = 'expense_transaction_row_version_step';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER expense_transaction_enforce_update_contract
BEFORE UPDATE ON expense_transaction
FOR EACH ROW
EXECUTE FUNCTION enforce_expense_update_contract();

CREATE FUNCTION validate_expense_occurrence_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_timezone text;
BEGIN
  IF NEW.occurred_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT l.timezone
  INTO STRICT v_timezone
  FROM ledger l
  WHERE l.id = NEW.ledger_id;

  IF NEW.occurred_on <> (NEW.occurred_at AT TIME ZONE v_timezone)::date THEN
    RAISE EXCEPTION
      'occurred_on (%) does not match occurred_at in ledger timezone (%)',
      NEW.occurred_on,
      v_timezone
      USING ERRCODE = '23514',
            CONSTRAINT = 'expense_transaction_occurred_local_date';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER expense_transaction_validate_occurrence_date
AFTER INSERT OR UPDATE ON expense_transaction
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_expense_occurrence_date();

CREATE FUNCTION validate_ledger_occurrence_dates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.timezone = OLD.timezone THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM expense_transaction et
    WHERE et.ledger_id = NEW.id
      AND et.occurred_at IS NOT NULL
      AND et.occurred_on <> (et.occurred_at AT TIME ZONE NEW.timezone)::date
  ) THEN
    RAISE EXCEPTION
      'timezone change would make an expense occurred_on inconsistent'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ledger_timezone_preserves_occurrence_dates';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_validate_occurrence_dates
AFTER UPDATE ON ledger
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_ledger_occurrence_dates();

CREATE FUNCTION validate_transaction_tag_set()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_ledger_id uuid;
  v_transaction_id uuid;
  v_category_count integer;
  v_meal_count integer;
  v_custom_count integer;
  v_has_food_category boolean;
BEGIN
  IF TG_TABLE_NAME = 'expense_transaction' THEN
    v_ledger_id := NEW.ledger_id;
    v_transaction_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_ledger_id := OLD.ledger_id;
    v_transaction_id := OLD.transaction_id;
  ELSE
    v_ledger_id := NEW.ledger_id;
    v_transaction_id := NEW.transaction_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM expense_transaction et
    WHERE et.ledger_id = v_ledger_id
      AND et.id = v_transaction_id
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT
    count(*) FILTER (WHERE tt.tag_type = 'category'),
    count(*) FILTER (WHERE tt.tag_type = 'meal'),
    count(*) FILTER (WHERE tt.tag_type = 'custom'),
    coalesce(bool_or(tt.tag_type = 'category' AND t.code = 'food'), false)
  INTO
    v_category_count,
    v_meal_count,
    v_custom_count,
    v_has_food_category
  FROM transaction_tag tt
  JOIN tag t
    ON t.ledger_id = tt.ledger_id
   AND t.id = tt.tag_id
   AND t.type = tt.tag_type
  WHERE tt.ledger_id = v_ledger_id
    AND tt.transaction_id = v_transaction_id;

  IF v_category_count <> 1 THEN
    RAISE EXCEPTION 'each expense must have exactly one category tag'
      USING ERRCODE = '23514', CONSTRAINT = 'transaction_tag_exactly_one_category';
  END IF;

  IF v_meal_count > 0 AND NOT v_has_food_category THEN
    RAISE EXCEPTION 'meal tags require the food category'
      USING ERRCODE = '23514', CONSTRAINT = 'transaction_tag_meal_requires_food';
  END IF;

  IF v_custom_count > 10 THEN
    RAISE EXCEPTION 'an expense may have at most ten custom tags'
      USING ERRCODE = '23514', CONSTRAINT = 'transaction_tag_custom_limit';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER transaction_tag_validate_set
AFTER INSERT OR UPDATE OR DELETE ON transaction_tag
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_transaction_tag_set();

-- An expense-row trigger is also required: otherwise an expense with zero tags
-- would never enqueue the transaction_tag constraint trigger.
CREATE CONSTRAINT TRIGGER expense_transaction_validate_tag_set
AFTER INSERT OR UPDATE ON expense_transaction
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_transaction_tag_set();

CREATE FUNCTION expense_actor_can_mutate(
  p_ledger_id uuid,
  p_transaction_id uuid,
  p_actor_member_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM expense_transaction et
    JOIN member m
      ON m.ledger_id = et.ledger_id
     AND m.id = p_actor_member_id
     AND m.is_active
    WHERE et.ledger_id = p_ledger_id
      AND et.id = p_transaction_id
      AND (
        et.scope = 'shared'
        OR et.personal_owner_member_id = p_actor_member_id
      )
  );
$$;

CREATE FUNCTION assert_expense_actor_can_mutate(
  p_ledger_id uuid,
  p_transaction_id uuid,
  p_actor_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
STRICT
PARALLEL UNSAFE
AS $$
DECLARE
  v_scope expense_scope;
  v_owner uuid;
BEGIN
  SELECT et.scope, et.personal_owner_member_id
  INTO v_scope, v_owner
  FROM expense_transaction et
  WHERE et.ledger_id = p_ledger_id
    AND et.id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'expense not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM member m
    WHERE m.ledger_id = p_ledger_id
      AND m.id = p_actor_member_id
      AND m.is_active
  ) OR (v_scope = 'personal' AND v_owner <> p_actor_member_id) THEN
    RAISE EXCEPTION 'actor is not allowed to mutate this expense'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Call only after the out-of-database durable deletion journal has accepted the
-- unsend record. This function deliberately handles only the atomic main-DB half.
CREATE FUNCTION purge_line_message_after_unsend(
  p_ledger_id uuid,
  p_line_message_id text,
  p_unsend_webhook_event_id text,
  p_unsent_at timestamptz
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
STRICT
PARALLEL UNSAFE
AS $$
DECLARE
  v_custom_tag_ids uuid[];
  v_deleted_count integer := 0;
BEGIN
  IF btrim(p_line_message_id) = '' THEN
    RAISE EXCEPTION 'LINE message ID must not be blank'
      USING ERRCODE = '22023';
  END IF;

  PERFORM lock_line_message(p_ledger_id, p_line_message_id);

  IF NOT EXISTS (
    SELECT 1
    FROM inbound_event ie
    WHERE ie.ledger_id = p_ledger_id
      AND ie.webhook_event_id = p_unsend_webhook_event_id
      AND ie.event_type = 'unsend'
      AND ie.line_message_id = p_line_message_id
  ) THEN
    RAISE EXCEPTION 'unsend event does not match the target LINE message'
      USING ERRCODE = '23514',
            CONSTRAINT = 'message_tombstone_unsend_matches_event';
  END IF;

  INSERT INTO message_tombstone (
    ledger_id,
    line_message_id,
    unsend_webhook_event_id,
    unsent_at
  )
  VALUES (
    p_ledger_id,
    p_line_message_id,
    p_unsend_webhook_event_id,
    p_unsent_at
  )
  ON CONFLICT (ledger_id, line_message_id) DO NOTHING;

  SELECT array_agg(DISTINCT tt.tag_id)
  INTO v_custom_tag_ids
  FROM expense_transaction et
  JOIN transaction_tag tt
    ON tt.ledger_id = et.ledger_id
   AND tt.transaction_id = et.id
   AND tt.tag_type = 'custom'
  WHERE et.ledger_id = p_ledger_id
    AND et.source_message_id = p_line_message_id;

  DELETE FROM expense_transaction et
  WHERE et.ledger_id = p_ledger_id
    AND et.source_message_id = p_line_message_id;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  IF v_custom_tag_ids IS NOT NULL THEN
    DELETE FROM tag t
    WHERE t.ledger_id = p_ledger_id
      AND t.type = 'custom'
      AND t.id = ANY (v_custom_tag_ids)
      AND NOT EXISTS (
        SELECT 1
        FROM transaction_tag tt
        WHERE tt.ledger_id = t.ledger_id
          AND tt.tag_id = t.id
      );
  END IF;

  -- Cancel an unsent source message's not-yet-delivered confirmations and scrub
  -- both queued and retained copies. Delivery credentials are short-lived data
  -- and are cleared as well.
  UPDATE outbox_message o
  SET
    payload_json = NULL,
    payload_redacted_at = COALESCE(o.payload_redacted_at, clock_timestamp()),
    delivery_credential_ciphertext = NULL,
    status = CASE
      WHEN o.status IN ('pending', 'sending') THEN 'dead_letter'::outbox_status
      ELSE o.status
    END,
    locked_at = NULL,
    last_error_code = CASE
      WHEN o.status IN ('pending', 'sending') THEN 'source_message_unsent'
      ELSE o.last_error_code
    END
  WHERE o.ledger_id = p_ledger_id
    AND o.source_webhook_event_id IN (
      SELECT ie.webhook_event_id
      FROM inbound_event ie
      WHERE ie.ledger_id = p_ledger_id
        AND ie.line_message_id = p_line_message_id
    );

  UPDATE inbound_event ie
  SET
    payload_json = NULL,
    payload_redacted_at = COALESCE(ie.payload_redacted_at, clock_timestamp())
  WHERE ie.ledger_id = p_ledger_id
    AND ie.line_message_id = p_line_message_id;

  RETURN v_deleted_count;
END;
$$;

COMMENT ON FUNCTION assert_expense_actor_can_mutate(uuid, uuid, uuid) IS
  'Lock and authorize a mutation: active members may mutate shared expenses; only the owner may mutate personal expenses.';

COMMENT ON FUNCTION purge_line_message_after_unsend(uuid, text, text, timestamptz) IS
  'Atomic main-DB unsend purge. The caller must append the independent durable deletion journal before invoking it.';

COMMENT ON TABLE message_tombstone IS
  'Content-free LINE unsend marker. Retain at least as long as the longest database backup.';

COMMENT ON COLUMN expense_transaction.occurred_at IS
  'Nullable absolute occurrence time. NULL means the date is known but the time is unknown.';

COMMENT ON COLUMN transaction_tag.rule_key IS
  'Stable parser/classifier/meal-rule identifier used to reproduce this assignment.';
