ALTER TABLE instagram_accounts ADD COLUMN token_state TEXT
  CHECK (token_state IS NULL OR json_valid(token_state));
