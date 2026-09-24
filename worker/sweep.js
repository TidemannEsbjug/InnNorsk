// Daglig opprydding (cron): hengende jobber, gamle utkast, logger, økter og eventuelt gamle dokumenter.
import { config } from "./config.js";
import { all, run, nowIso, isoAgo, DAY_MS } from "./db.js";
import { logEvent } from "./log.js";
import { deleteJobObjects, deleteFileObjects, deleteWork, listWorkJobIds } from "./storage.js";
import { ACTIVE } from "./jobs.js";

const STUCK_AFTER_MS = 30 * 60000;
const DEAD_WORKFLOW = new Set(["errored", "terminated", "unknown", "complete"]);
const STUCK_MESSAGE = "Jobben stoppet uventet. Prøv igjen.";

async function workflowStatus(env, job) {
  try {
    return (await (await env.JOB.get(job.workflow_id || job.id)).status()).status;
  } catch {
    return "unknown";
  }
}

async function failStuckJobs(env) {
  const jobs = await all(
    env,
    "SELECT * FROM jobs WHERE status IN ('queued', 'running') AND COALESCE(started_at, queued_at) < ?",
    isoAgo(STUCK_AFTER_MS)
  );
  let failed = 0;
  for (const job of jobs) {
    const status = await workflowStatus(env, job);
    if (!DEAD_WORKFLOW.has(status)) continue;
    const now = nowIso();
    await run(env, "UPDATE jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status IN ('queued', 'running')", now, STUCK_MESSAGE, job.id);
    await run(
      env,
      "UPDATE files SET status = 'failed', message = ?, finished_at = ? WHERE job_id = ? AND status IN ('queued', 'working')",
      STUCK_MESSAGE, now, job.id
    );
    await deleteWork(env, job.id);
    await logEvent(env, "error", "job.failed", STUCK_MESSAGE, { workflowStatus: status }, { userId: job.user_id, jobId: job.id });
    failed++;
  }
  return failed;
}

async function purgeDrafts(env) {
  const drafts = await all(env, "SELECT id, user_id FROM jobs WHERE status = 'draft' AND created_at < ?", isoAgo(2 * DAY_MS));
  for (const job of drafts) {
    await deleteJobObjects(env, job.user_id, job.id);
    await run(env, "DELETE FROM files WHERE job_id = ?", job.id);
    await run(env, "DELETE FROM jobs WHERE id = ?", job.id);
  }
  return drafts.length;
}

async function expireDocuments(env, days) {
  if (!(days > 0)) return 0;
  const files = await all(
    env,
    `SELECT f.id, f.job_id, j.user_id FROM files f JOIN jobs j ON j.id = f.job_id
     WHERE f.deleted_at IS NULL AND j.finished_at IS NOT NULL AND j.finished_at < ?`,
    isoAgo(days * DAY_MS)
  );
  const now = nowIso();
  for (const f of files) {
    await deleteFileObjects(env, f.user_id, f.job_id, f.id);
    await run(env, "UPDATE files SET deleted_at = ? WHERE id = ?", now, f.id);
  }
  return files.length;
}

// Arbeidsfiler som ble liggende etter avbrudd eller krasj.
async function purgeOrphanWork(env) {
  let purged = 0;
  for (const jobId of await listWorkJobIds(env)) {
    const [job] = await all(env, "SELECT status FROM jobs WHERE id = ?", jobId);
    if (job && ACTIVE.includes(job.status)) continue;
    purged += await deleteWork(env, jobId);
  }
  return purged;
}

export async function sweep(env) {
  const cfg = config(env);
  const counts = {
    stuckJobs: await failStuckJobs(env),
    drafts: await purgeDrafts(env),
    documents: await expireDocuments(env, cfg.retentionDays),
    workObjects: await purgeOrphanWork(env),
  };
  const eventCutoff = isoAgo(cfg.eventRetentionDays * DAY_MS);
  counts.events = (await run(env, "DELETE FROM events WHERE ts < ?", eventCutoff)).meta.changes;
  counts.grokCalls = (await run(env, "DELETE FROM grok_calls WHERE ts < ?", eventCutoff)).meta.changes;
  counts.batches = (
    await run(env, "DELETE FROM batches WHERE job_id IN (SELECT id FROM jobs WHERE finished_at < ?)", isoAgo(30 * DAY_MS))
  ).meta.changes;
  counts.loginAttempts = (await run(env, "DELETE FROM login_attempts WHERE ts < ?", isoAgo(DAY_MS))).meta.changes;
  counts.sessions = (
    await run(env, "DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?", isoAgo(30 * DAY_MS), isoAgo(30 * DAY_MS))
  ).meta.changes;
  await logEvent(env, "info", "retention.sweep", "Daglig opprydding fullført", counts);
  return counts;
}
