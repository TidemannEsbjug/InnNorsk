-- InnNorsk Drop: brukere, økter, sendinger fra Svetlana, filer i kø for Mac-agenten, iPhone-enheter og hendelseslogg.
-- Tidsstempler er ISO 8601-strenger (UTC).

-- Passord lagres aldri. Klienten regner ut proof = PBKDF2-SHA256(passord, salt, iterations);
-- verifier = sha256 (hex) av proof.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  verifier TEXT NOT NULL,
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

-- status: draft | sent | done | deleted (sammendrag av filene, holdes i takt av Workeren).
CREATE TABLE sendings (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  target_language TEXT NOT NULL,
  note TEXT,
  reply TEXT,
  created_at TEXT,
  sent_at TEXT,
  finished_at TEXT,
  deleted_at TEXT
);
CREATE INDEX idx_sendings_user_created ON sendings (user_id, created_at);

-- status: draft | sent | working | done | failed. R2: s/<sending_id>/<id>/original og .../result.
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  sending_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  bytes INTEGER,
  status TEXT NOT NULL,
  message TEXT,
  progress_percent REAL,
  eta_seconds REAL,
  progress_at TEXT,
  lease_until TEXT,
  attempts INTEGER DEFAULT 0,
  output_name TEXT,
  output_bytes INTEGER,
  output_source TEXT,
  cost_usd REAL,
  error TEXT,
  error_details TEXT,
  created_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  deleted_at TEXT
);
CREATE INDEX idx_files_sending ON files (sending_id);
CREATE INDEX idx_files_status ON files (status);

-- Én rad: Mac-agentens siste livstegn.
CREATE TABLE agent (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen_at TEXT,
  host TEXT,
  version TEXT,
  state TEXT,
  state_message TEXT,
  grok_ok INTEGER,
  offline_alert_sent_at TEXT
);
INSERT INTO agent (id) VALUES (1);

-- iPhone-enheter som får push (APNs). env: sandbox | production.
CREATE TABLE devices (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  env TEXT NOT NULL,
  name TEXT,
  created_at TEXT,
  last_ok_at TEXT,
  disabled_at TEXT,
  last_error TEXT
);

-- source: web | agent | ios | system. session_id er de første 8 tegnene av økt-id-en.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT,
  user_id INTEGER,
  session_id TEXT,
  sending_id TEXT,
  file_id TEXT,
  ip TEXT,
  source TEXT,
  data_json TEXT
);
CREATE INDEX idx_events_ts ON events (ts);
CREATE INDEX idx_events_type ON events (type);
CREATE INDEX idx_events_sending ON events (sending_id);
