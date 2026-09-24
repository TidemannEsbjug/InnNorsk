// Jobbvisning: rader fra D1 → JSON for UI, med levende fremdrift og ETA.
import { config } from "./config.js";
import { all, one, run, parseJson, nowIso } from "./db.js";
import { fitParams, predictJob, computeProgress } from "./estimate.js";
import { fail } from "./http.js";
import { logEvent } from "./log.js";
import { deleteWork } from "./storage.js";

export const ACTIVE = ["queued", "running"];
export const FINAL = ["done", "partial", "failed", "cancelled"];

// ---- Estimatorparametre: tilpasset siste vellykkede kall per modell, bufret 60 s ----

const FIT_TTL_MS = 60000;
const fitCache = new Map();

export async function estimatorParams(env, model) {
  const key = model || config(env).model;
  const hit = fitCache.get(key);
  if (hit && Date.now() - hit.at < FIT_TTL_MS) return hit.params;
  const rows = await all(
    env,
    "SELECT input_chars, ms FROM grok_calls WHERE ok = 1 AND model = ? AND job_id IS NOT NULL ORDER BY id DESC LIMIT 300",
    key
  );
  const params = fitParams(rows);
  fitCache.set(key, { at: Date.now(), params });
  return params;
}

// ---- Tilgang ----

// Egen jobb, eller hvilken som helst for admin. Andres jobber finnes ikke (404).
export async function loadJob(c, jobId, { includeDeleted = false } = {}) {
  const user = c.get("user");
  const job = await one(c.env, "SELECT * FROM jobs WHERE id = ?", jobId);
  if (!job || (job.user_id !== user.id && user.role !== "admin") || (job.deleted_at && !includeDeleted)) {
    fail(404, "Fant ikke jobben.");
  }
  return job;
}

export async function loadFile(c, job, fileId) {
  const file = await one(c.env, "SELECT * FROM files WHERE id = ? AND job_id = ?", fileId, job.id);
  if (!file) fail(404, "Fant ikke dokumentet.");
  return file;
}

// Stopper Workflow-instansen og merker jobben avbrutt. Returnerer false hvis den ikke var aktiv.
export async function cancelJob(env, job, ctx) {
  const now = nowIso();
  const res = await run(
    env,
    "UPDATE jobs SET cancel_requested = 1, status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued', 'running')",
    now, job.id
  );
  if (!res.meta.changes) return false;
  try {
    await (await env.JOB.get(job.workflow_id || job.id)).terminate();
  } catch {
    // Instansen er allerede ferdig eller finnes ikke; statusen i D1 er det som gjelder.
  }
  await run(
    env,
    "UPDATE files SET status = 'cancelled', message = 'Avbrutt', finished_at = ? WHERE job_id = ? AND status IN ('queued', 'working')",
    now, job.id
  );
  await deleteWork(env, job.id);
  await logEvent(env, "info", "job.cancelled", "Oversettelsen ble avbrutt", null, { ...ctx, jobId: job.id });
  return true;
}

// ---- Visning ----

const byPath = (a, b) => a.rel_path.localeCompare(b.rel_path, "nb");

function fileMessage(f, percent, warnings) {
  switch (f.status) {
    case "ready":
      return "Klar";
    case "queued":
      return "Venter";
    case "working":
      return `Oversetter … ${percent} %`;
    case "done":
      return warnings.length ? "Ferdig (med merknader)" : "Ferdig";
    case "cancelled":
      return f.message || "Avbrutt";
    default:
      return f.message || "Kunne ikke oversettes.";
  }
}

export function serializeFile(f, doneChars, { admin = false } = {}) {
  const totalChars = f.chars || 0;
  const done = f.status === "done" ? totalChars : Math.min(totalChars, doneChars || 0);
  const percent = f.status === "done" ? 100 : totalChars ? Math.min(99, Math.floor((100 * done) / totalChars)) : 0;
  const warnings = parseJson(f.warnings_json, []);
  const view = {
    id: f.id,
    jobId: f.job_id,
    path: f.rel_path,
    name: f.name,
    ext: f.ext,
    bytes: f.bytes,
    status: f.status,
    message: fileMessage(f, percent, warnings),
    segments: f.segments,
    chars: f.chars,
    batches: f.batches,
    estimateSeconds: f.estimate_seconds,
    outputName: f.output_name,
    outputBytes: f.output_bytes,
    warnings,
    error: f.error,
    startedAt: f.started_at,
    finishedAt: f.finished_at,
    durationMs: f.duration_ms,
    progress: { doneChars: done, totalChars, percent },
  };
  if (admin) {
    view.errorDetails = parseJson(f.error_details, f.error_details);
    view.deleted = Boolean(f.deleted_at);
  }
  return view;
}

function buildView(job, files, batches, { params, n, now, admin }) {
  const visible = files.filter((f) => admin || !f.deleted_at).sort(byPath);
  const planned = visible.filter((f) => f.plan_json);
  const counted = planned.filter((f) => !f.deleted_at && !["failed", "cancelled"].includes(f.status));
  const doneByFile = new Map();
  for (const b of batches) doneByFile.set(b.file_id, (doneByFile.get(b.file_id) || 0) + b.chars);

  const progressFiles = counted.map((f) => ({ id: f.id, plan: parseJson(f.plan_json, []) }));
  const p = computeProgress({ files: progressFiles, doneBatches: batches, startedAt: job.started_at, now, params, n });
  const active = ACTIVE.includes(job.status);
  let percent = p.percent;
  if (job.status === "done") percent = 100;
  else if (active) percent = Math.min(99, percent);

  const working = visible.find((f) => f.status === "working");
  const workingView = working && serializeFile(working, doneByFile.get(working.id));
  const estimate = job.estimate_seconds ?? (job.status === "draft" ? predictJob(progressFiles, params, n) : null);

  const view = {
    id: job.id,
    userId: job.user_id,
    status: job.status,
    targetLanguage: job.target_language,
    model: job.model,
    createdAt: job.created_at,
    queuedAt: job.queued_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    fileCount: visible.filter((f) => !f.deleted_at).length,
    totals: {
      segments: planned.reduce((s, f) => s + (f.segments || 0), 0),
      chars: planned.reduce((s, f) => s + (f.chars || 0), 0),
      batches: planned.reduce((s, f) => s + (f.batches || 0), 0),
    },
    estimateSeconds: estimate == null ? null : Math.round(estimate),
    progress: {
      doneChars: job.status === "done" ? p.totalChars : p.doneChars,
      totalChars: p.totalChars,
      doneBatches: job.status === "done" ? p.totalBatches : p.doneBatches,
      totalBatches: p.totalBatches,
      percent,
    },
    eta: active ? p.eta : null,
    currentFile: workingView ? { id: working.id, name: working.name, percent: workingView.progress.percent } : null,
    usage: { calls: job.calls || 0, inputTokens: job.input_tokens || 0, outputTokens: job.output_tokens || 0 },
    error: job.error,
    deleted: Boolean(job.deleted_at),
  };
  if (job.username !== undefined) view.username = job.username;
  return { job: view, files: visible.map((f) => serializeFile(f, doneByFile.get(f.id), { admin })) };
}

// jobs: rader fra jobs-tabellen (evt. med username). Returnerer [{ job, files }] i samme rekkefølge.
export async function buildViews(env, jobs, { admin = false } = {}) {
  if (!jobs.length) return [];
  const cfg = config(env);
  const ids = jobs.map((j) => j.id);
  const marks = ids.map(() => "?").join(", ");
  const files = await all(env, `SELECT * FROM files WHERE job_id IN (${marks})`, ...ids);
  const needBatches = jobs.filter((j) => !["draft", "done"].includes(j.status)).map((j) => j.id);
  const batches = needBatches.length
    ? await all(
        env,
        `SELECT job_id, file_id, idx, chars, ms FROM batches WHERE job_id IN (${needBatches.map(() => "?").join(", ")})`,
        ...needBatches
      )
    : [];
  const now = Date.now();
  const views = [];
  for (const job of jobs) {
    const params = await estimatorParams(env, job.model);
    views.push(
      buildView(
        job,
        files.filter((f) => f.job_id === job.id),
        batches.filter((b) => b.job_id === job.id),
        { params, n: cfg.concurrency, now, admin }
      )
    );
  }
  return views;
}

export async function jobView(env, jobId, { admin = false } = {}) {
  const job = await one(env, "SELECT j.*, u.username FROM jobs j LEFT JOIN users u ON u.id = j.user_id WHERE j.id = ?", jobId);
  if (!job) fail(404, "Fant ikke jobben.");
  const [view] = await buildViews(env, [job], { admin });
  if (!admin) delete view.job.username;
  return view;
}
