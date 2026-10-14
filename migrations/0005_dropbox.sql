-- Fildropp: filer Svetlana sender rett til eieren (hvilken som helst filtype, ingen oversettelse), f.eks. et dokument
-- som ikke ble riktig, så eieren kan se på det. Én rad i drops per gang hun sender (med valgfri melding), én rad per fil.
-- R2: drop/<drop_id>/<file_id>. Ligger til eieren sletter dem (Admin → Fildropp); teller med i lagringstaket.
CREATE TABLE drops (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  deleted_at TEXT
);

CREATE TABLE drop_files (
  id TEXT PRIMARY KEY,
  drop_id TEXT NOT NULL REFERENCES drops(id),
  name TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX idx_drops_user ON drops (user_id, created_at);
CREATE INDEX idx_drop_files_drop ON drop_files (drop_id);
