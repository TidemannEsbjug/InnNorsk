-- InnNorsk Sky: brukere, økter, jobber, filer, fremdrift, hendelseslogg og Grok-kall.
-- Tidsstempler er ISO 8601-strenger (UTC).

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

-- id = sha256 (hex) av tokenet i informasjonskapselen; selve tokenet lagres aldri.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT,
  last_seen_at TEXT,
  expires_at TEXT,
  ip TEXT,
  user_agent TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE login_attempts (
  key TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX idx_login_attempts_key_ts ON login_attempts (key, ts);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  target_language TEXT NOT NULL,
  model TEXT,
  workflow_id TEXT,
  created_at TEXT,
  queued_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  estimate_seconds REAL,
  calls INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  error TEXT,
  cancel_requested INTEGER DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX idx_jobs_user_created ON jobs (user_id, created_at);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  bytes INTEGER,
  status TEXT NOT NULL,
  message TEXT,
  segments INTEGER,
  chars INTEGER,
  batches INTEGER,
  plan_json TEXT, -- number[][]: tegn per batch, per kall i formathandleren
  estimate_seconds REAL,
  output_name TEXT,
  output_bytes INTEGER,
  warnings_json TEXT,
  error TEXT,
  error_details TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  created_at TEXT,
  deleted_at TEXT
);
CREATE INDEX idx_files_job ON files (job_id);

-- Én rad per ferdig batch. Gir fremdrift og ETA, og gjør stegene idempotente.
CREATE TABLE batches (
  job_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  chars INTEGER NOT NULL,
  ms INTEGER,
  done_at TEXT,
  PRIMARY KEY (job_id, file_id, idx)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT,
  user_id INTEGER,
  session_id TEXT, -- de første 8 tegnene av økt-id
  job_id TEXT,
  file_id TEXT,
  ip TEXT,
  data_json TEXT
);
CREATE INDEX idx_events_ts ON events (ts);
CREATE INDEX idx_events_type ON events (type);
CREATE INDEX idx_events_job ON events (job_id);
CREATE INDEX idx_events_user ON events (user_id);

CREATE TABLE grok_calls (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  job_id TEXT,
  file_id TEXT,
  model TEXT,
  status INTEGER,
  ok INTEGER,
  attempt INTEGER,
  items INTEGER,
  input_chars INTEGER,
  output_chars INTEGER,
  ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  error TEXT
);
CREATE INDEX idx_grok_calls_ts ON grok_calls (ts);
CREATE INDEX idx_grok_calls_model ON grok_calls (model);
CREATE INDEX idx_grok_calls_job ON grok_calls (job_id);
