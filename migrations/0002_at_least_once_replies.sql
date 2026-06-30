ALTER TABLE reply_jobs ADD COLUMN reply_text TEXT;
ALTER TABLE reply_jobs ADD COLUMN public_success_reply_text TEXT;

CREATE TABLE IF NOT EXISTS comment_processing_decisions (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('webhook', 'backfill', 'reconciler')),
  matched_keyword TEXT,
  action TEXT NOT NULL CHECK (action IN ('jobs_created', 'duplicate', 'skipped')),
  skipped_reason TEXT,
  created_job_types_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (comment_id) REFERENCES comments(id)
);

CREATE INDEX IF NOT EXISTS comment_processing_decisions_comment_idx
  ON comment_processing_decisions(comment_id, created_at);

CREATE INDEX IF NOT EXISTS comment_processing_decisions_source_idx
  ON comment_processing_decisions(source, created_at);

UPDATE reply_jobs
SET
  status = 'blocked',
  last_error = 'private_reply_invalid',
  next_retry_at = NULL,
  sending_started_at = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'failed'
  AND type = 'comment_private_reply'
  AND EXISTS (
    SELECT 1
    FROM reply_attempts
    WHERE reply_attempts.reply_job_id = reply_jobs.id
      AND reply_attempts.meta_code = 100
      AND reply_attempts.meta_subcode = 2534025
  );
