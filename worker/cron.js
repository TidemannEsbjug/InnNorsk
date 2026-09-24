// Hvert 15. minutt: utløpte leaser tilbake i kø, push hvis Mac-en er borte mens noen venter, og opprydding.
import { config } from "./config.js";
import { all, one, run, batch, nowIso, isoAgo, DAY_MS } from "./db.js";
import { logEvent } from "./log.js";
import { pushToAdmins } from "./apns.js";
import { deleteObjects } from "./files.js";
import { filesText } from "./sendings.js";

const CTX = { source: "system" };
const DRAFT_DAYS = 2;
const SESSION_KEEP_DAYS = 30;
const EVENT_KEEP_DAYS = 365;

// «14:32», eller «23.9. 14:32» hvis det er mer enn et døgn siden (norsk tid).
function osloTime(iso) {
  const date = new Date(iso);
  const opts = { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  if (Date.now() - date.getTime() > DAY_MS) Object.assign(opts, { day: "numeric", month: "numeric" });
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", opts).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.day ? `${p.day}.${p.month}. ` : ""}${p.hour}:${p.minute}`;
}

async function expireLeases(env) {
  const files = await all(
    env,
    `UPDATE files SET status = 'sent', lease_until = NULL, started_at = NULL, progress_percent = NULL, eta_seconds = NULL,
       progress_at = NULL WHERE status = 'working' AND lease_until < ? AND deleted_at IS NULL RETURNING id, sending_id, name`,
    nowIso()
  );
  for (const f of files) {
    await logEvent(env, "warn", "file.lease_expired", `${f.name} ble lagt tilbake i køen (Mac-en svarte ikke)`, null, {
      ...CTX, sendingId: f.sending_id, fileId: f.id,
    });
  }
}

// Én push per periode Mac-en er borte; nullstilles når agenten spør etter filer igjen.
async function alertIfAgentOffline(env) {
  const minutes = config(env).agentOfflineAlertMinutes;
  const agent = await one(env, "SELECT * FROM agent WHERE id = 1");
  if (agent.offline_alert_sent_at || (agent.last_seen_at && agent.last_seen_at > isoAgo(minutes * 60000))) return;
  const waiting = await one(
    env,
    `SELECT COALESCE(u.display_name, u.username) AS who, COUNT(*) OVER () AS n
     FROM files f JOIN sendings s ON s.id = f.sending_id JOIN users u ON u.id = s.user_id
     WHERE f.status = 'sent' AND f.deleted_at IS NULL ORDER BY s.sent_at LIMIT 1`
  );
  if (!waiting) return;
  const res = await run(env, "UPDATE agent SET offline_alert_sent_at = ? WHERE id = 1 AND offline_alert_sent_at IS NULL", nowIso());
  if (!res.meta.changes) return;
  const since = agent.last_seen_at ? `har ikke svart siden ${osloTime(agent.last_seen_at)}` : "har ikke meldt seg ennå";
  const message = {
    title: `${waiting.who} venter: Mac-en ${since}`,
    body: `${filesText(waiting.n)} ligger i kø. Sjekk at Mac-en er på og at InnNorsk-mottaket kjører.`,
  };
  await logEvent(env, "warn", "agent.offline_alert", message.title, { waitingFiles: waiting.n, lastSeenAt: agent.last_seen_at }, CTX);
  await pushToAdmins(env, message, CTX);
}

async function purgeOldDrafts(env) {
  const cutoff = isoAgo(DRAFT_DAYS * DAY_MS);
  const files = await all(
    env,
    "SELECT f.id, f.sending_id FROM files f JOIN sendings s ON s.id = f.sending_id WHERE s.status = 'draft' AND s.created_at < ?",
    cutoff
  );
  await deleteObjects(env, files);
  const [, sendings] = await batch(env, [
    ["DELETE FROM files WHERE sending_id IN (SELECT id FROM sendings WHERE status = 'draft' AND created_at < ?)", cutoff],
    ["DELETE FROM sendings WHERE status = 'draft' AND created_at < ?", cutoff],
  ]);
  return { drafts: sendings.meta.changes, draftFiles: files.length };
}

export async function runCron(env) {
  await expireLeases(env);
  await alertIfAgentOffline(env);
  const counts = await purgeOldDrafts(env);
  const [attempts, sessions, events] = await batch(env, [
    ["DELETE FROM login_attempts WHERE ts < ?", isoAgo(DAY_MS)],
    ["DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?", isoAgo(SESSION_KEEP_DAYS * DAY_MS), isoAgo(SESSION_KEEP_DAYS * DAY_MS)],
    ["DELETE FROM events WHERE ts < ?", isoAgo(EVENT_KEEP_DAYS * DAY_MS)],
  ]);
  Object.assign(counts, { loginAttempts: attempts.meta.changes, sessions: sessions.meta.changes, events: events.meta.changes });
  if (Object.values(counts).some((n) => n > 0)) await logEvent(env, "info", "retention.sweep", "Opprydding", counts, CTX);
  return counts;
}
