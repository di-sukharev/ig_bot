CREATE TABLE IF NOT EXISTS direct_messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT,
  text TEXT,
  created_at TEXT,
  source TEXT NOT NULL CHECK (source = 'webhook'),
  matched_keyword TEXT,
  raw_json TEXT,
  inserted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS direct_messages_sender_idx
  ON direct_messages(sender_id);

CREATE INDEX IF NOT EXISTS direct_messages_created_idx
  ON direct_messages(created_at);

CREATE TABLE webhook_event_subjects_new (
  event_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('comment', 'commenter', 'username', 'direct_message')),
  subject_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, subject_type, normalized_value),
  FOREIGN KEY (event_id) REFERENCES webhook_events(id)
);

INSERT INTO webhook_event_subjects_new
  (event_id, subject_type, subject_value, normalized_value, created_at)
SELECT
  event_id,
  subject_type,
  subject_value,
  normalized_value,
  created_at
FROM webhook_event_subjects;

DROP TABLE webhook_event_subjects;

ALTER TABLE webhook_event_subjects_new RENAME TO webhook_event_subjects;

CREATE INDEX IF NOT EXISTS webhook_event_subjects_lookup_idx
  ON webhook_event_subjects(subject_type, normalized_value);

CREATE TABLE reply_attempts_backup_0003 AS
SELECT * FROM reply_attempts;

CREATE TABLE reply_rate_limit_slots_backup_0003 AS
SELECT * FROM reply_rate_limit_slots;

DROP TABLE reply_attempts;

DROP TABLE reply_rate_limit_slots;

CREATE TABLE reply_jobs_new (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL
    CHECK (type IN ('comment_public_reply', 'comment_private_reply', 'direct_message_reply')),
  comment_id TEXT,
  direct_message_id TEXT,
  reply_text TEXT,
  public_success_reply_text TEXT,
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
  CHECK (
    (
      type IN ('comment_public_reply', 'comment_private_reply')
      AND comment_id IS NOT NULL
      AND direct_message_id IS NULL
    )
    OR (
      type = 'direct_message_reply'
      AND comment_id IS NULL
      AND direct_message_id IS NOT NULL
    )
  ),
  FOREIGN KEY (comment_id) REFERENCES comments(id),
  FOREIGN KEY (direct_message_id) REFERENCES direct_messages(id)
);

INSERT INTO reply_jobs_new
  (
    id,
    idempotency_key,
    type,
    comment_id,
    direct_message_id,
    reply_text,
    public_success_reply_text,
    status,
    attempts,
    max_attempts,
    next_retry_at,
    last_error,
    meta_message_id,
    meta_recipient_id,
    created_at,
    updated_at,
    sent_at,
    sending_started_at
  )
SELECT
  id,
  idempotency_key,
  type,
  comment_id,
  NULL,
  reply_text,
  public_success_reply_text,
  status,
  attempts,
  max_attempts,
  next_retry_at,
  last_error,
  meta_message_id,
  meta_recipient_id,
  created_at,
  updated_at,
  sent_at,
  sending_started_at
FROM reply_jobs;

DROP TABLE reply_jobs;

ALTER TABLE reply_jobs_new RENAME TO reply_jobs;

CREATE INDEX IF NOT EXISTS reply_jobs_status_next_retry_idx
  ON reply_jobs(status, next_retry_at);

CREATE INDEX IF NOT EXISTS reply_jobs_sending_started_idx
  ON reply_jobs(status, sending_started_at);

CREATE INDEX IF NOT EXISTS reply_jobs_comment_idx
  ON reply_jobs(comment_id);

CREATE INDEX IF NOT EXISTS reply_jobs_direct_message_idx
  ON reply_jobs(direct_message_id);

CREATE TABLE reply_attempts (
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

INSERT INTO reply_attempts
  (
    id,
    reply_job_id,
    attempt_number,
    status,
    http_status,
    meta_code,
    meta_subcode,
    fbtrace_id,
    response_summary,
    error_message,
    created_at
  )
SELECT
  id,
  reply_job_id,
  attempt_number,
  status,
  http_status,
  meta_code,
  meta_subcode,
  fbtrace_id,
  response_summary,
  error_message,
  created_at
FROM reply_attempts_backup_0003;

DROP TABLE reply_attempts_backup_0003;

CREATE INDEX IF NOT EXISTS reply_attempts_job_idx
  ON reply_attempts(reply_job_id);

CREATE TABLE reply_rate_limit_slots (
  bucket TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  reply_job_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (bucket, slot),
  FOREIGN KEY (reply_job_id) REFERENCES reply_jobs(id)
);

INSERT INTO reply_rate_limit_slots
  (bucket, slot, reply_job_id, created_at)
SELECT
  bucket,
  slot,
  reply_job_id,
  created_at
FROM reply_rate_limit_slots_backup_0003;

DROP TABLE reply_rate_limit_slots_backup_0003;

CREATE INDEX IF NOT EXISTS reply_rate_limit_slots_created_idx
  ON reply_rate_limit_slots(created_at);
