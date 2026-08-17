-- A pairing may only be dissolved after both active members consent. Historical
-- ledgers are archived on completion so a future pairing in the same LINE group
-- can never read the previous couple's data.
CREATE TABLE pairing_dissolution_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES ledger (id) ON DELETE CASCADE,
  requested_by_member_id uuid NOT NULL,
  responded_by_member_id uuid,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
  responded_at timestamptz,
  CONSTRAINT pairing_dissolution_request_requester_fk
    FOREIGN KEY (ledger_id, requested_by_member_id)
    REFERENCES member (ledger_id, id),
  CONSTRAINT pairing_dissolution_request_responder_fk
    FOREIGN KEY (ledger_id, responded_by_member_id)
    REFERENCES member (ledger_id, id),
  CONSTRAINT pairing_dissolution_request_status_check
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'rejected', 'expired')),
  CONSTRAINT pairing_dissolution_request_responder_distinct
    CHECK (responded_by_member_id IS NULL OR responded_by_member_id <> requested_by_member_id),
  CONSTRAINT pairing_dissolution_request_expiry_check
    CHECK (expires_at > requested_at),
  CONSTRAINT pairing_dissolution_request_resolution_check CHECK (
    (status = 'pending' AND responded_by_member_id IS NULL AND responded_at IS NULL)
    OR
    (status <> 'pending' AND responded_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX pairing_dissolution_request_one_pending_per_ledger
  ON pairing_dissolution_request (ledger_id)
  WHERE status = 'pending';

CREATE INDEX pairing_dissolution_request_pending_expiry_idx
  ON pairing_dissolution_request (expires_at)
  WHERE status = 'pending';

COMMENT ON TABLE pairing_dissolution_request IS
  'Durable two-party consent workflow for dissolving a paired ledger; pending requests expire after 24 hours.';
