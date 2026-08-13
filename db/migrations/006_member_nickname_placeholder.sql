-- Replace the old relationship-label placeholder. Members choose their own
-- ledger identity with the `設定暱稱` command after pairing.
UPDATE member
   SET display_name = '新成員',
       updated_at = clock_timestamp()
 WHERE display_name = '另一半'
   AND command_alias IS NULL;
