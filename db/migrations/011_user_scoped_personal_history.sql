-- Personal ownership follows the LINE user across private and couple ledgers.
-- Public IDs must therefore be globally addressable, and inactive historical
-- memberships must remain efficient to resolve after an unpair.
CREATE UNIQUE INDEX expense_transaction_public_id_global_unique
  ON expense_transaction (public_id);

CREATE INDEX member_line_user_id_history_idx
  ON member (line_user_id, ledger_id, id);

-- A historical personal owner remains the owner after unpairing, even though
-- that old couple membership is inactive. Shared expenses still require an
-- active membership in their exact ledger.
CREATE OR REPLACE FUNCTION expense_actor_can_mutate(
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
      JOIN member actor
        ON actor.ledger_id=et.ledger_id
       AND actor.id=p_actor_member_id
     WHERE et.ledger_id=p_ledger_id
       AND et.id=p_transaction_id
       AND (
         (et.scope='shared' AND actor.is_active)
         OR
         (et.scope='personal' AND et.personal_owner_member_id=actor.id)
       )
  );
$$;

CREATE OR REPLACE FUNCTION assert_expense_actor_can_mutate(
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
BEGIN
  PERFORM 1
    FROM expense_transaction et
   WHERE et.ledger_id=p_ledger_id AND et.id=p_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'expense not found' USING ERRCODE='P0002';
  END IF;

  IF NOT expense_actor_can_mutate(
    p_ledger_id,
    p_transaction_id,
    p_actor_member_id
  ) THEN
    RAISE EXCEPTION 'actor is not allowed to mutate this expense'
      USING ERRCODE='42501';
  END IF;
END;
$$;

-- Preserve an already chosen couple nickname when the private ledger was
-- provisioned later with the placeholder display name.
UPDATE member personal
   SET display_name = paired.display_name,
       command_alias = paired.display_name,
       updated_at = clock_timestamp()
  FROM member paired
 WHERE personal.line_user_id = paired.line_user_id
   AND personal.membership_kind = 'personal'
   AND personal.display_name IN ('我', '新成員', '另一半')
   AND paired.membership_kind = 'couple'
   AND paired.is_active
   AND paired.display_name NOT IN ('我', '新成員', '另一半');

COMMENT ON INDEX expense_transaction_public_id_global_unique IS
  'Makes a transaction card/action unambiguous across a user personal ledger and current or archived couple ledgers.';

COMMENT ON INDEX member_line_user_id_history_idx IS
  'Supports the logical personal account spanning every ledger membership ever owned by the same LINE user.';

COMMENT ON FUNCTION assert_expense_actor_can_mutate(uuid, uuid, uuid) IS
  'Locks and authorizes a mutation: current members may mutate current shared expenses; a historical personal owner may still mutate their own personal expense after unpairing.';
