-- Eieren beholder filene når Svetlana sletter en sending, fjerner en fil fra utkastet eller laster opp samme fil på nytt:
-- hun ser dem ikke lenger, men originalen og oversettelsen blir liggende i R2 i RETAIN_DELETED_DAYS dager (admin kan
-- laste dem ned). Cron sletter dem for godt etterpå og setter purged_at; radene blir stående som historikk.
-- deleted_by = brukeren som slettet (NULL = cron). deleted_reason:
--   sendings: user (Slett) | cleanup (tomt utkast ryddet bort av nettsiden) | language (utkastet laget på nytt) | expired (gammelt utkast)
--   files:    sending (slettet sammen med sendingen) | removed (fjernet fra utkastet) | cleanup (fjernet av nettsiden) | replaced (samme sti lastet opp på nytt)
ALTER TABLE sendings ADD COLUMN deleted_by INTEGER;
ALTER TABLE sendings ADD COLUMN deleted_reason TEXT;
ALTER TABLE files ADD COLUMN deleted_by INTEGER;
ALTER TABLE files ADD COLUMN deleted_reason TEXT;
ALTER TABLE files ADD COLUMN purged_at TEXT;

-- Før dette ble R2-objektene slettet i samme øyeblikk som raden, så de er allerede borte.
UPDATE sendings SET deleted_by = user_id, deleted_reason = 'user' WHERE deleted_at IS NOT NULL;
UPDATE files SET deleted_by = (SELECT user_id FROM sendings WHERE sendings.id = files.sending_id), deleted_reason = 'sending',
  purged_at = deleted_at WHERE deleted_at IS NOT NULL;

-- Filer som venter på å slettes for godt (cron), og loggen filtrert på bruker (Admin → Logg og aktivitetskortet).
CREATE INDEX idx_files_retained ON files (deleted_at) WHERE purged_at IS NULL;
CREATE INDEX idx_events_user ON events (user_id, id);
