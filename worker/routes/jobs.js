// Jobber: opprett, last opp, start, avbryt, slett og last ned.
import { Hono } from "hono";
import JSZip from "jszip";
import core from "../../src/core.js";
import { config } from "../config.js";
import { one, all, run, batch, nowIso, isoAgo, newId, parseJson, DAY_MS } from "../db.js";
import { logEvent } from "../log.js";
import { fail, readJson, reqCtx } from "../http.js";
import { requireUser } from "../auth.js";
import { ACTIVE, loadJob, loadFile, jobView, buildViews, estimatorParams, serializeFile, cancelJob } from "../jobs.js";
import { predictFile, predictJob } from "../estimate.js";
import { putOriginal, getOriginal, getOutput, deleteJobObjects, deleteFileObjects } from "../storage.js";

const MIME = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".rtf": "application/rtf",
  ".zip": "application/zip",
};
const ALREADY_COMPRESSED = new Set([".docx", ".pptx", ".xlsx"]);
const MAX_PATH = 240;

const baseName = (p) => String(p || "").split("/").pop();

// Relativ sti fra nettleseren → trygg sti: bare mappenavn og filnavn, aldri .. eller stasjonsbokstav.
export function sanitizePath(input) {
  if (typeof input !== "string") return "";
  const parts = input
    .normalize("NFC")
    .replace(/\\/g, "/")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..");
  if (parts.length) parts[0] = parts[0].replace(/^[a-zA-Z]:/, "");
  const clean = parts.map((s) => s.replace(/[<>:"|?*]/g, "_")).filter(Boolean);
  while (clean.length > 1 && clean.join("/").length > MAX_PATH) clean.shift();
  const rel = clean.join("/");
  return rel.length > MAX_PATH ? "" : rel;
}

// RFC 6266/5987: ASCII-reserve for gamle klienter + UTF-8-navnet for alle andre.
export function contentDisposition(name) {
  const fallback = name
    .replace(/æ/g, "ae").replace(/Æ/g, "AE").replace(/ø/g, "o").replace(/Ø/g, "O")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/gu, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function downloadHeaders(name, size) {
  const headers = {
    "Content-Type": MIME[core.extOf(name)] || "application/octet-stream",
    "Content-Disposition": contentDisposition(name),
    "Cache-Control": "private, no-store",
  };
  if (size != null) headers["Content-Length"] = String(size);
  return headers;
}

// yyyy-mm-dd-HHMM i norsk tid.
function osloStamp(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Oslo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}`;
}

function analysisMessage(err, ext) {
  if (ext === ".pdf" && /ingen tekst/i.test(err.message)) {
    return "Fant ingen tekst i PDF-en. Den er trolig skannet, og skannede dokumenter kan dessverre ikke oversettes.";
  }
  return "Filen kunne ikke leses. Kanskje den er skadet eller passordbeskyttet?";
}

const jobs = new Hono();
jobs.use("*", requireUser);

jobs.post("/", async (c) => {
  const { targetLanguage } = await readJson(c);
  if (!["bokmal", "nynorsk"].includes(targetLanguage)) fail(400, "Velg bokmål eller nynorsk.");
  const id = newId(16);
  await run(
    c.env,
    "INSERT INTO jobs (id, user_id, status, target_language, model, created_at) VALUES (?, ?, 'draft', ?, ?, ?)",
    id, c.get("user").id, targetLanguage, config(c.env).model, nowIso()
  );
  await logEvent(c.env, "info", "job.created", "Ny oversettelse opprettet", { targetLanguage }, reqCtx(c, { jobId: id }));
  return c.json({ job: (await jobView(c.env, id)).job }, 201);
});

jobs.get("/", async (c) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));
  const rows = await all(
    c.env,
    `SELECT * FROM jobs WHERE user_id = ? AND deleted_at IS NULL AND NOT (status = 'draft' AND created_at < ?)
     ORDER BY created_at DESC LIMIT ?`,
    c.get("user").id, isoAgo(DAY_MS), limit
  );
  return c.json({ jobs: (await buildViews(c.env, rows)).map((v) => v.job) });
});

jobs.get("/:id", async (c) => {
  const job = await loadJob(c, c.req.param("id"));
  return c.json({ ...(await jobView(c.env, job.id)), serverTime: nowIso() });
});

jobs.put("/:id/files", async (c) => {
  const env = c.env;
  const cfg = config(env);
  const job = await loadJob(c, c.req.param("id"));
  const rawPath = c.req.query("path");
  const reject = async (status, message) => {
    await logEvent(env, "warn", "file.rejected", message, { path: String(rawPath || "").slice(0, 300) }, reqCtx(c, { jobId: job.id }));
    fail(status, message);
  };
  if (job.status !== "draft") fail(409, "Denne oversettelsen er allerede startet. Start en ny for å legge til flere dokumenter.");
  const maxBytes = cfg.maxFileMb * 1024 * 1024;
  const tooBig = `Filen er for stor (maks ${cfg.maxFileMb} MB).`;
  if (Number(c.req.header("Content-Length")) > maxBytes) await reject(413, tooBig);

  const relPath = sanitizePath(rawPath);
  if (!relPath) await reject(400, "Filnavnet mangler eller er ugyldig.");
  const name = baseName(relPath);
  if (core.isIgnoredName(relPath)) {
    await reject(400, /^(~\$|\.~lock)/.test(name)
      ? "Dette er en midlertidig låsefil fra Word, ikke et dokument."
      : "Dette er en systemfil, ikke et dokument.");
  }
  const ext = core.extOf(relPath);
  if (!core.SUPPORTED.includes(ext)) await reject(415, ext ? `Filtypen ${ext} støttes ikke.` : "Filer uten filendelse støttes ikke.");

  // Samme sti lastet opp på nytt erstatter den forrige.
  const existing = await all(env, "SELECT id, rel_path FROM files WHERE job_id = ? AND deleted_at IS NULL", job.id);
  const replaced = existing.filter((f) => f.rel_path.toLowerCase() === relPath.toLowerCase());
  if (existing.length - replaced.length >= cfg.maxFilesPerJob) {
    await reject(400, `Du kan legge til maks ${cfg.maxFilesPerJob} dokumenter i én oversettelse.`);
  }
  const buffer = Buffer.from(await c.req.arrayBuffer());
  if (buffer.length > maxBytes) await reject(413, tooBig);

  const now = nowIso();
  for (const f of replaced) {
    await deleteFileObjects(env, job.user_id, job.id, f.id);
    await run(env, "UPDATE files SET deleted_at = ? WHERE id = ?", now, f.id);
  }

  const file = { id: newId(16), job_id: job.id };
  const ctx = reqCtx(c, { jobId: job.id, fileId: file.id });
  const insert = (fields) => {
    const row = { id: file.id, job_id: job.id, rel_path: relPath, name, ext, bytes: buffer.length, created_at: now, ...fields };
    const cols = Object.keys(row);
    return run(env, `INSERT INTO files (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...Object.values(row));
  };
  await logEvent(env, "info", "file.uploaded", `${name} lastet opp`, { path: relPath, bytes: buffer.length, ext }, ctx);

  let analysis = null;
  let failure = null;
  if (!buffer.length) {
    failure = { message: "Filen er tom.", error: "empty" };
  } else {
    try {
      analysis = await core.analyzeBuffer(buffer, ext);
      if (!analysis.segments) failure = { message: "Fant ingen tekst å oversette i filen.", error: "no_text" };
    } catch (err) {
      failure = { message: analysisMessage(err, ext), error: String(err.message).slice(0, 1000) };
    }
  }

  if (failure) {
    await insert({ status: "failed", message: failure.message, error: failure.error });
    await logEvent(env, "warn", "file.analysis_failed", failure.message, { error: failure.error }, ctx);
  } else {
    await putOriginal(env, file, job.user_id, buffer);
    const params = await estimatorParams(env, job.model);
    const estimate = Math.round(predictFile(analysis.calls, params, cfg.concurrency));
    await insert({
      status: "ready",
      segments: analysis.segments,
      chars: analysis.chars,
      batches: analysis.batches,
      plan_json: JSON.stringify(analysis.calls),
      estimate_seconds: estimate,
    });
    await logEvent(env, "info", "file.analyzed", `${name} er klar`, {
      segments: analysis.segments, chars: analysis.chars, batches: analysis.batches, estimateSeconds: estimate,
    }, ctx);
  }
  const row = await one(env, "SELECT * FROM files WHERE id = ?", file.id);
  return c.json({ file: serializeFile(row, 0) }, 201);
});

jobs.delete("/:id/files/:fileId", async (c) => {
  const job = await loadJob(c, c.req.param("id"));
  const file = await loadFile(c, job, c.req.param("fileId"));
  if (file.deleted_at) return c.body(null, 204);
  if (job.status !== "draft" && !["done", "failed", "cancelled"].includes(file.status)) {
    fail(409, "Dokumentet oversettes nå og kan ikke slettes ennå.");
  }
  await deleteFileObjects(c.env, job.user_id, job.id, file.id);
  await run(c.env, "UPDATE files SET deleted_at = ? WHERE id = ?", nowIso(), file.id);
  await logEvent(c.env, "info", "file.deleted", `${file.name} slettet`, { path: file.rel_path, status: file.status }, reqCtx(c, { jobId: job.id, fileId: file.id }));
  return c.body(null, 204);
});

jobs.post("/:id/start", async (c) => {
  const env = c.env;
  const cfg = config(env);
  const job = await loadJob(c, c.req.param("id"));
  if (job.status !== "draft") fail(409, "Denne oversettelsen er allerede startet.");
  const ready = await all(env, "SELECT plan_json FROM files WHERE job_id = ? AND status = 'ready' AND deleted_at IS NULL", job.id);
  if (!ready.length) fail(400, "Legg til minst ett dokument som kan oversettes.");
  if (!env.XAI_API_KEY) fail(503, "Tjenesten mangler API-nøkkel. Kontakt administrator.");

  const params = await estimatorParams(env, job.model);
  const estimate = Math.round(predictJob(ready.map((f) => ({ plan: parseJson(f.plan_json, []) })), params, cfg.concurrency));
  const now = nowIso();
  const [res] = await batch(env, [
    ["UPDATE jobs SET status = 'queued', queued_at = ?, estimate_seconds = ? WHERE id = ? AND status = 'draft'", now, estimate, job.id],
    ["UPDATE files SET status = 'queued' WHERE job_id = ? AND status = 'ready' AND deleted_at IS NULL", job.id],
  ]);
  if (!res.meta.changes) fail(409, "Denne oversettelsen er allerede startet.");
  const ctx = reqCtx(c, { jobId: job.id });
  try {
    const instance = await env.JOB.create({ id: job.id, params: { jobId: job.id } });
    await run(env, "UPDATE jobs SET workflow_id = ? WHERE id = ?", instance.id, job.id);
  } catch (err) {
    const message = "Kunne ikke starte oversettelsen akkurat nå. Prøv igjen om litt.";
    await batch(env, [
      ["UPDATE jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?", nowIso(), message, job.id],
      ["UPDATE files SET status = 'failed', message = ? WHERE job_id = ? AND status = 'queued'", message, job.id],
    ]);
    await logEvent(env, "error", "job.failed", message, { error: err.message }, ctx);
    fail(503, message);
  }
  await logEvent(env, "info", "job.queued", "Oversettelsen er satt i kø", { files: ready.length, estimateSeconds: estimate }, ctx);
  return c.json({ job: (await jobView(env, job.id)).job });
});

jobs.post("/:id/cancel", async (c) => {
  const job = await loadJob(c, c.req.param("id"));
  if (job.status === "draft") fail(409, "Oversettelsen er ikke startet.");
  if (ACTIVE.includes(job.status)) await cancelJob(c.env, job, reqCtx(c));
  return c.json({ job: (await jobView(c.env, job.id)).job });
});

jobs.delete("/:id", async (c) => {
  const env = c.env;
  const job = await loadJob(c, c.req.param("id"));
  const ctx = reqCtx(c, { jobId: job.id });
  if (ACTIVE.includes(job.status)) await cancelJob(env, job, ctx);
  const objects = await deleteJobObjects(env, job.user_id, job.id);
  const now = nowIso();
  await batch(env, [
    ["UPDATE jobs SET deleted_at = ? WHERE id = ?", now, job.id],
    ["UPDATE files SET deleted_at = ? WHERE job_id = ? AND deleted_at IS NULL", now, job.id],
  ]);
  await logEvent(env, "info", "job.deleted", "Oversettelsen ble slettet", { status: job.status, objects }, ctx);
  return c.body(null, 204);
});

async function sendFile(c, kind) {
  const job = await loadJob(c, c.req.param("id"), { includeDeleted: true });
  const file = await loadFile(c, job, c.req.param("fileId"));
  if (job.deleted_at || file.deleted_at) fail(410, "Dokumentet er slettet.");
  if (kind === "output" && file.status !== "done") fail(404, "Dokumentet er ikke ferdig oversatt ennå.");
  const obj = kind === "output" ? await getOutput(c.env, file, job.user_id) : await getOriginal(c.env, file, job.user_id);
  if (!obj) fail(410, "Dokumentet er slettet.");
  const name = baseName(kind === "output" ? file.output_name : file.rel_path);
  await logEvent(
    c.env, "info", kind === "output" ? "download.file" : "download.original", `${name} lastet ned`,
    { name, bytes: obj.size }, reqCtx(c, { jobId: job.id, fileId: file.id })
  );
  return new Response(obj.body, { headers: downloadHeaders(name, obj.size) });
}

jobs.get("/:id/files/:fileId/download", (c) => sendFile(c, "output"));
jobs.get("/:id/files/:fileId/original", (c) => sendFile(c, "original"));

jobs.get("/:id/download.zip", async (c) => {
  const job = await loadJob(c, c.req.param("id"));
  const files = await all(c.env, "SELECT * FROM files WHERE job_id = ? AND status = 'done' AND deleted_at IS NULL", job.id);
  const zip = new JSZip();
  let count = 0;
  for (const f of files) {
    const obj = await getOutput(c.env, f, job.user_id);
    if (!obj) continue;
    const compression = ALREADY_COMPRESSED.has(core.extOf(f.output_name)) ? "STORE" : "DEFLATE";
    zip.file(f.output_name, new Uint8Array(await obj.arrayBuffer()), { compression, date: new Date(f.finished_at || Date.now()) });
    count++;
  }
  if (!count) fail(404, "Det er ingen ferdige dokumenter å laste ned ennå.");
  const bytes = await zip.generateAsync({ type: "uint8array", compressionOptions: { level: 6 } });
  const name = `InnNorsk-${osloStamp(new Date(job.finished_at || Date.now()))}.zip`;
  await logEvent(c.env, "info", "download.zip", `${name} lastet ned`, { files: count, bytes: bytes.length }, reqCtx(c, { jobId: job.id }));
  return new Response(bytes, { headers: downloadHeaders(name, bytes.length) });
});

export default jobs;
