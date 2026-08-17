-- One LINE command may intentionally update several transactions. Preserve
-- idempotency per affected transaction instead of limiting a webhook event to
-- exactly one audit row.
ALTER TABLE transaction_event
  DROP CONSTRAINT transaction_event_source_unique;

ALTER TABLE transaction_event
  ADD CONSTRAINT transaction_event_source_transaction_unique
  UNIQUE (ledger_id, source_webhook_event_id, transaction_id);
