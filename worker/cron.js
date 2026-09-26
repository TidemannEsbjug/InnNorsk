// Hvert 15. minutt: filer som har stoppet opp under oversettelsen, mellomlager som ikke trengs lenger, gamle utkast,
// filer Svetlana slettet for mer enn RETAIN_DELETED_DAYS dager siden (slettes for godt i R2), og opprydding.
import { config } from "./config.js";
import { all, run, batch, nowIso, isoAgo, DAY_MS } from "./db.js";
import { logEvent } from "./log.js";
import { deleteWork } from "./files.js";
import { markFailed, finishIfDone, retainedFiles, purgeFiles, filesText } from "./sendings.js";

const CTX = { source: "system" };
const DRAFT_DAYS = 2;
const SESSION_KEEP_DAYS = 30;
const EVENT_KEEP_DAYS = 365;
const QUOTA_KEEP_DAYS = 31; // månedstaket ser 30 dager bakover
const STALLED_MS = 30 * 60000;
const ALIVE = ["queued", "running", "paused", "waiting", "waitingForPause"];
// Filer som fortsatt kan trenge mellomlagrede batcher (en feilet fil kan settes i kø igjen).
const OPEN_FILES = "SELECT id FROM files WHERE deleted_at IS NULL AND status IN ('sent', 'working', 'failed')";

async function instanceStatus(env, id) {
  try {
    return (await (await env.TRANSLATE.get(id)).status()).status;
  } catch {
    return "unknown";
  }
}

// En fil som har stått i «working» i over 30 minutter uten fremdrift, og der instansen som eier den ikke lever,
// merkes som feilet (eieren kan sette den i kø igjen).
async function reconcile(env) {
  const stalled = await all(
    env,
    `SELECT id, sending_id, workflow_id FROM files
     WHERE status = 'working' AND deleted_at IS NULL AND COALESCE(progress_at, started_at) < ?`,
    isoAgo(STALLED_MS)
  );
  const statuses = new Map();
  const sendings = new Set();
  let failed = 0;
  for (const f of stalled) {
    if (!statuses.has(f.workflow_id)) statuses.set(f.workflow_id, f.workflow_id ? await instanceStatus(env, f.workflow_id) : "unknown");
    const status = statuses.get(f.workflow_id);
    if (ALIVE.includes(status)) continue;
    const row = await markFailed(env, f.id, {
      error: "Oversettelsen stoppet uventet.",
      details: `Workflow-instansen ${f.workflow_id || "(ingen)"} har status «${status}».`,
      owner: f.workflow_id,
      ctx: CTX,
    });
    if (row) {
      failed++;
      sendings.add(f.sending_id);
    }
  }
  for (const id of sendings) await finishIfDone(env, id, CTX);
  return failed;
}

// work/<fileId>/ og batches-rader for filer som er ferdige eller slettet.
async function sweepWork(env) {
  const [{ delimitedPrefixes }, open] = await Promise.all([env.FILES.list({ prefix: "work/", delimiter: "/" }), all(env, OPEN_FILES)]);
  const keep = new Set(open.map((f) => f.id));
  const stale = delimitedPrefixes.map((p) => p.split("/")[1]).filter((id) => !keep.has(id));
  for (const id of stale) await deleteWork(env, id);
  return stale.length;
}

// Utkast som aldri ble sendt (hun ser dem ikke etter et døgn): tomme fjernes helt, de med filer slettes som om hun
// hadde slettet dem, så eieren kan laste filene ned til de slettes for godt.
async function expireOldDrafts(env) {
  const drafts = await all(
    env,
    `SELECT s.id, (SELECT COUNT(*) FROM files f WHERE f.sending_id = s.id) AS files FROM sendings s
     WHERE s.status = 'draft' AND s.deleted_at IS NULL AND s.created_at < ?`,
    isoAgo(DRAFT_DAYS * DAY_MS)
  );
  const empty = drafts.filter((d) => !d.files).map((d) => d.id);
  if (empty.length) {
    await run(env, `DELETE FROM sendings WHERE status = 'draft' AND id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM files WHERE files.sending_id = sendings.id)`, JSON.stringify(empty));
  }
  let draftFiles = 0;
  for (const { id } of drafts.filter((d) => d.files)) {
    const now = nowIso();
    const files = await all(env, "SELECT name FROM files WHERE sending_id = ? AND deleted_at IS NULL ORDER BY rel_path", id);
    const [expired] = await batch(env, [
      ["UPDATE sendings SET status = 'deleted', deleted_at = ?, deleted_reason = 'expired' WHERE id = ? AND status = 'draft'", now, id],
      [`UPDATE files SET deleted_at = ?, deleted_reason = 'sending' WHERE sending_id = ? AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM sendings WHERE id = ? AND deleted_at = ? AND deleted_reason = 'expired')`, now, id, id, now],
    ]);
    if (!expired.meta.changes) continue; // sendt i mellomtiden
    draftFiles += files.length;
    await logEvent(env, "info", "sending.deleted", `Utkastet ble aldri sendt og er ryddet bort (${filesText(files.length)})`, {
      status: "draft", reason: "expired", files: files.length, names: files.slice(0, 50).map((f) => f.name),
    }, { ...CTX, sendingId: id });
  }
  return { drafts: drafts.length, draftFiles };
}

// Det Svetlana slettet for mer enn RETAIN_DELETED_DAYS dager siden, slettes for godt i R2 (maks 500 filer per runde).
async function purgeDeleted(env) {
  const days = config(env).retainDeletedDays;
  const files = await retainedFiles(env, { cutoff: isoAgo(days * DAY_MS), limit: 500 });
  return purgeFiles(env, files, { reason: "retention", why: `etter ${days} dager`, ctx: CTX });
}

export async function runCron(env) {
  const counts = {
    stalled: await reconcile(env), workFolders: await sweepWork(env), ...(await expireOldDrafts(env)), purgedFiles: await purgeDeleted(env),
  };
  const [attempts, sessions, events, batches, quota] = await batch(env, [
    ["DELETE FROM login_attempts WHERE ts < ?", isoAgo(DAY_MS)],
    ["DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?", isoAgo(SESSION_KEEP_DAYS * DAY_MS), isoAgo(SESSION_KEEP_DAYS * DAY_MS)],
    ["DELETE FROM events WHERE ts < ?", isoAgo(EVENT_KEEP_DAYS * DAY_MS)],
    [`DELETE FROM batches WHERE file_id NOT IN (${OPEN_FILES})`],
    ["DELETE FROM quota_usage WHERE ts < ?", isoAgo(QUOTA_KEEP_DAYS * DAY_MS)],
  ]);
  Object.assign(counts, {
    loginAttempts: attempts.meta.changes, sessions: sessions.meta.changes, events: events.meta.changes, batches: batches.meta.changes,
    quotaRows: quota.meta.changes,
  });
  if (Object.values(counts).some((n) => n > 0)) await logEvent(env, "info", "retention.sweep", "Opprydding", counts, CTX);
  return counts;
}
