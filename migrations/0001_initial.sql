CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source = 'instagram'),
  raw_payload TEXT NOT NULL,
  headers_json TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  received_at TEXT NOT NULL,
  processing_started_at TEXT,
  processed_at TEXT,
  last_error TEXT,
  raw_payload_retention_until TEXT NOT NULL,
  raw_payload_redacted_at TEXT
);

CREATE INDEX IF NOT EXISTS webhook_events_status_received_idx
  ON webhook_events(status, received_at);

CREATE INDEX IF NOT EXISTS webhook_events_retention_idx
  ON webhook_events(raw_payload_redacted_at, raw_payload_retention_until);

CREATE TABLE IF NOT EXISTS webhook_event_subjects (
  event_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('comment', 'commenter', 'username')),
  subject_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, subject_type, normalized_value),
  FOREIGN KEY (event_id) REFERENCES webhook_events(id)
);

CREATE INDEX IF NOT EXISTS webhook_event_subjects_lookup_idx
  ON webhook_event_subjects(subject_type, normalized_value);

CREATE TABLE IF NOT EXISTS instagram_accounts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'token_invalid')),
  token_expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  comment_kind TEXT NOT NULL DEFAULT 'feed'
    CHECK (comment_kind IN ('feed', 'live')),
  commenter_id TEXT,
  username TEXT,
  username_normalized TEXT,
  text TEXT,
  created_at TEXT,
  source TEXT NOT NULL CHECK (source IN ('webhook', 'backfill')),
  last_seen_source TEXT NOT NULL CHECK (last_seen_source IN ('webhook', 'backfill')),
  matched_keyword TEXT,
  private_reply_eligible INTEGER NOT NULL DEFAULT 0 CHECK (private_reply_eligible IN (0, 1)),
  raw_json TEXT,
  inserted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS comments_kind_source_idx
  ON comments(comment_kind, source);

CREATE INDEX IF NOT EXISTS comments_media_idx
  ON comments(media_id);

CREATE INDEX IF NOT EXISTS comments_commenter_idx
  ON comments(commenter_id);

CREATE INDEX IF NOT EXISTS comments_username_idx
  ON comments(username);

CREATE INDEX IF NOT EXISTS comments_username_normalized_idx
  ON comments(username_normalized);

CREATE TABLE IF NOT EXISTS reply_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL
    CHECK (type IN ('comment_public_reply', 'comment_private_reply')),
  comment_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'sending', 'sent', 'retryable', 'failed', 'blocked')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  next_retry_at TEXT,
  last_error TEXT,
  meta_message_id TEXT,
  meta_recipient_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  sending_started_at TEXT,
  FOREIGN KEY (comment_id) REFERENCES comments(id)
);

CREATE INDEX IF NOT EXISTS reply_jobs_status_next_retry_idx
  ON reply_jobs(status, next_retry_at);

CREATE INDEX IF NOT EXISTS reply_jobs_sending_started_idx
  ON reply_jobs(status, sending_started_at);

CREATE INDEX IF NOT EXISTS reply_jobs_comment_idx
  ON reply_jobs(comment_id);

CREATE TABLE IF NOT EXISTS reply_attempts (
  id TEXT PRIMARY KEY,
  reply_job_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'retryable', 'blocked')),
  http_status INTEGER,
  meta_code INTEGER,
  meta_subcode INTEGER,
  fbtrace_id TEXT,
  response_summary TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (reply_job_id) REFERENCES reply_jobs(id)
);

CREATE INDEX IF NOT EXISTS reply_attempts_job_idx
  ON reply_attempts(reply_job_id);

CREATE TABLE IF NOT EXISTS media_backfill_runs (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'failed')),
  send_enabled INTEGER NOT NULL DEFAULT 0 CHECK (send_enabled IN (0, 1)),
  after_cursor TEXT,
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  matched_count INTEGER NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  eligible_private_reply_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_private_reply_count >= 0),
  stale_saved_only_count INTEGER NOT NULL DEFAULT 0 CHECK (stale_saved_only_count >= 0),
  duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS media_backfill_runs_media_idx
  ON media_backfill_runs(media_id, started_at);

CREATE TABLE IF NOT EXISTS media_commenters (
  media_id TEXT NOT NULL,
  commenter_id TEXT NOT NULL,
  username TEXT,
  username_normalized TEXT,
  first_comment_id TEXT NOT NULL,
  last_comment_at TEXT,
  inserted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (media_id, commenter_id),
  FOREIGN KEY (first_comment_id) REFERENCES comments(id)
);

CREATE INDEX IF NOT EXISTS media_commenters_commenter_idx
  ON media_commenters(commenter_id);

CREATE INDEX IF NOT EXISTS media_commenters_username_idx
  ON media_commenters(username);

CREATE INDEX IF NOT EXISTS media_commenters_username_normalized_idx
  ON media_commenters(username_normalized);

CREATE TABLE IF NOT EXISTS reply_rate_limit_slots (
  bucket TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  reply_job_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (bucket, slot),
  FOREIGN KEY (reply_job_id) REFERENCES reply_jobs(id)
);

CREATE INDEX IF NOT EXISTS reply_rate_limit_slots_created_idx
  ON reply_rate_limit_slots(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
