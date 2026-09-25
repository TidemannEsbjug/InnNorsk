-- Tak mot uventet forbruk (lekket passord eller en feil): tekst som er sendt til oversettelse, per sending og per
-- «Sett i kø igjen». Døgn- og månedstaket (MAX_CHARS_PER_DAY / MAX_CHARS_PER_MONTH) summerer chars herfra.
-- Radene blir stående når en sending slettes, så sletting frigjør ikke kvote. Cron fjerner rader eldre enn 31 dager.
CREATE TABLE quota_usage (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  chars INTEGER NOT NULL,
  user_id INTEGER,
  sending_id TEXT,
  file_id TEXT
);
CREATE INDEX idx_quota_usage_ts ON quota_usage (ts);
