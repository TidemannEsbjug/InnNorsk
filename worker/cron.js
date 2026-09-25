// Hvert 15. minutt: filer som har stoppet opp under oversettelsen, mellomlager som ikke trengs lenger, og opprydding.
import { all, batch, isoAgo, DAY_MS } from "./db.js";
import { logEvent } from "./log.js";
import { deleteObjects, deleteWork } from "./files.js";
import { markFailed, finishIfDone } from "./sendings.js";

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
  const counts = { stalled: await reconcile(env), workFolders: await sweepWork(env), ...(await purgeOldDrafts(env)) };
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
