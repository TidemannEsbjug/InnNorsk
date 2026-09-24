-- InnNorsk v5: oversettelsen skjer i Cloudflare (Workflow «innnorsk-translate» + xAI), ikke på Mac-en.
-- Analyse og estimat ved opplasting, fremdrift per batch, og hvert Grok-kall med tokens for kostnad og estimater.

-- Analysen ved opplasting (plan_json = [[tegn per batch] per internt kall]) og forbruket så langt.
-- workflow_id = instansen som oversetter filen nå; bare den får skrive fremdrift og resultat.
ALTER TABLE files ADD COLUMN segments INTEGER;
ALTER TABLE files ADD COLUMN chars INTEGER;
ALTER TABLE files ADD COLUMN batches INTEGER;
ALTER TABLE files ADD COLUMN plan_json TEXT;
ALTER TABLE files ADD COLUMN estimate_seconds REAL;
ALTER TABLE files ADD COLUMN calls INTEGER DEFAULT 0;
ALTER TABLE files ADD COLUMN input_tokens INTEGER DEFAULT 0;
ALTER TABLE files ADD COLUMN output_tokens INTEGER DEFAULT 0;
ALTER TABLE files ADD COLUMN workflow_id TEXT;

-- workflow_id = siste instans for sendingen (<sendingId>-<n>).
ALTER TABLE sendings ADD COLUMN workflow_id TEXT;
ALTER TABLE sendings ADD COLUMN estimate_seconds REAL;
ALTER TABLE sendings ADD COLUMN started_at TEXT;

-- Ett HTTP-kall mot xAI (også mislykkede). sending_id/file_id er NULL for «Test xAI» i admin.
CREATE TABLE grok_calls (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  sending_id TEXT,
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
CREATE INDEX idx_grok_calls_file ON grok_calls (file_id);
CREATE INDEX idx_grok_calls_model ON grok_calls (model);

-- Ferdige batcher per fil (R2: work/<file_id>/b-<idx>.json). Gir fremdrift, og en batch betales aldri to ganger.
CREATE TABLE batches (
  file_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  chars INTEGER NOT NULL,
  ms INTEGER,
  done_at TEXT,
  PRIMARY KEY (file_id, idx)
);

DROP TABLE IF EXISTS agent;
