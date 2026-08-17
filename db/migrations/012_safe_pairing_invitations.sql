-- Pairing is a two-step invitation/approval workflow. Pending setup is kept
-- outside member so it cannot masquerade as a completed pair or prevent a
-- LINE identity from accepting a different invitation.
CREATE TABLE pairing_invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger (id) ON DELETE CASCADE,
  invited_by_line_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
  paired_line_user_id text,
  resolved_at timestamptz,
  CONSTRAINT pairing_invitation_inviter_not_blank
    CHECK (btrim(invited_by_line_user_id) <> ''),
  CONSTRAINT pairing_invitation_status_check
    CHECK (status IN ('pending', 'completed', 'cancelled', 'expired')),
  CONSTRAINT pairing_invitation_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT pairing_invitation_people_distinct
    CHECK (paired_line_user_id IS NULL OR paired_line_user_id <> invited_by_line_user_id),
  CONSTRAINT pairing_invitation_resolution_check CHECK (
    (status = 'pending' AND paired_line_user_id IS NULL AND resolved_at IS NULL)
    OR
    (status = 'completed' AND paired_line_user_id IS NOT NULL AND resolved_at IS NOT NULL)
    OR
    (status IN ('cancelled', 'expired') AND paired_line_user_id IS NULL AND resolved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX pairing_invitation_one_pending_per_ledger
  ON pairing_invitation (ledger_id)
  WHERE status = 'pending';

CREATE INDEX pairing_invitation_pending_inviter_idx
  ON pairing_invitation (invited_by_line_user_id, expires_at)
  WHERE status = 'pending';

CREATE INDEX pairing_invitation_pending_expiry_idx
  ON pairing_invitation (expires_at)
  WHERE status = 'pending';

CREATE TABLE pairing_join_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL REFERENCES pairing_invitation (id) ON DELETE CASCADE,
  candidate_line_user_id text NOT NULL,
  request_code text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  CONSTRAINT pairing_join_request_candidate_not_blank
    CHECK (btrim(candidate_line_user_id) <> ''),
  CONSTRAINT pairing_join_request_code_format
    CHECK (request_code ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
  CONSTRAINT pairing_join_request_status_check
    CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled', 'expired')),
  CONSTRAINT pairing_join_request_expiry_check
    CHECK (expires_at > requested_at),
  CONSTRAINT pairing_join_request_resolution_check CHECK (
    (status = 'pending' AND responded_at IS NULL)
    OR
    (status <> 'pending' AND responded_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX pairing_join_request_code_unique
  ON pairing_join_request (request_code);

CREATE UNIQUE INDEX pairing_join_request_one_pending_per_candidate
  ON pairing_join_request (invitation_id, candidate_line_user_id)
  WHERE status = 'pending';

CREATE INDEX pairing_join_request_pending_invitation_idx
  ON pairing_join_request (invitation_id, requested_at)
  WHERE status = 'pending';

CREATE FUNCTION enforce_pairing_join_request_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_inviter text;
  v_invitation_expires_at timestamptz;
BEGIN
  SELECT invited_by_line_user_id, expires_at
    INTO STRICT v_inviter, v_invitation_expires_at
    FROM pairing_invitation
   WHERE id = NEW.invitation_id
   FOR UPDATE;

  IF NEW.candidate_line_user_id = v_inviter THEN
    RAISE EXCEPTION 'an invitation creator cannot join their own pairing invitation'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.expires_at > v_invitation_expires_at THEN
    RAISE EXCEPTION 'a join request cannot outlive its pairing invitation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pairing_join_request_boundary_guard
BEFORE INSERT OR UPDATE OF invitation_id, candidate_line_user_id, expires_at
ON pairing_join_request
FOR EACH ROW EXECUTE FUNCTION enforce_pairing_join_request_boundary();

COMMENT ON TABLE pairing_invitation IS
  'A cancellable, expiring pairing setup. The inviter is not an active couple member until a specific join request is confirmed.';

COMMENT ON TABLE pairing_join_request IS
  'Candidate-specific requests; only the invitation creator may confirm a request code, preventing self-pairing and first-click slot hijacking.';

-- App code also serializes on ledger, but the database must independently
-- reject a third active couple member, including direct writes and races.
CREATE FUNCTION enforce_active_couple_member_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_other_count integer;
BEGIN
  IF NEW.is_active AND NEW.membership_kind = 'couple' THEN
    PERFORM 1 FROM ledger WHERE id = NEW.ledger_id FOR UPDATE;
    SELECT count(*)::integer
      INTO v_other_count
      FROM member
     WHERE ledger_id = NEW.ledger_id
       AND is_active
       AND membership_kind = 'couple'
       AND id <> NEW.id;

    IF v_other_count >= 2 THEN
      RAISE EXCEPTION 'a couple ledger may have at most two active members'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER member_active_couple_limit_guard
BEFORE INSERT OR UPDATE OF ledger_id, is_active, membership_kind ON member
FOR EACH ROW EXECUTE FUNCTION enforce_active_couple_member_limit();

-- Convert the old one-member onboarding representation into a pending
-- invitation. Historical rows remain available as inactive ownership records,
-- while the LINE identity is immediately free to pair elsewhere.
WITH incomplete AS (
  SELECT ledger.id AS ledger_id,
         min(member.line_user_id) AS inviter_line_user_id,
         min(member.created_at) AS created_at
    FROM ledger
    JOIN member ON member.ledger_id = ledger.id
   WHERE member.is_active AND member.membership_kind = 'couple'
   GROUP BY ledger.id
  HAVING count(*) = 1
), created AS (
  INSERT INTO pairing_invitation (
    ledger_id, invited_by_line_user_id, created_at, expires_at
  )
  SELECT ledger_id, inviter_line_user_id, clock_timestamp(),
         clock_timestamp() + interval '24 hours'
    FROM incomplete
  RETURNING ledger_id, invited_by_line_user_id
)
UPDATE member
   SET is_active = false,
       updated_at = clock_timestamp()
  FROM created
 WHERE member.ledger_id = created.ledger_id
   AND member.line_user_id = created.invited_by_line_user_id
   AND member.is_active
   AND member.membership_kind = 'couple';
