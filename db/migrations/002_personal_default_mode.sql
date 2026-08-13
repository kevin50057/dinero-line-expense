ALTER TABLE ledger
  ALTER COLUMN default_scope SET DEFAULT 'personal'::expense_scope;

COMMENT ON COLUMN ledger.default_scope IS
  'Persistent group-wide mode for bare expense entries; personal by default and switchable through LINE commands.';
