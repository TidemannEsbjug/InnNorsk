// Oversettelsesjobben som Cloudflare Workflow: holdbare steg som tåler omstart og prøves på nytt.
// Hvert steg er idempotent. Ferdige batcher ligger i R2 og betales aldri to ganger.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import core from "../src/core.js";
import grok from "../src/grok.js";
import { config } from "./config.js";
import { one, all, run, batch, nowIso } from "./db.js";
import { logEvent } from "./log.js";
import { keys, getJson, putJson, getOriginal, putOutput, deleteWork } from "./storage.js";
import { CHUNK_SIZE } from "./estimate.js";

const FILE_STEP = { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" };
const CHUNK_STEP = { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "15 minutes" };
const REQUEST_TIMEOUT_MS = 180000;
const MAX_WARNING_EVENTS = 20;
const AUTH_CODES = new Set(["auth", "forbidden", "no_key"]);
const RETRYABLE_CODES = new Set(["rate_limit", "server", "network", "timeout"]);

// Feilkoden reiser som "[kode] melding" i meldingen, som overlever grensen mellom steg og run().
const tagged = (code, message) => new NonRetryableError(`[${code}] ${message}`);

function parseStepError(err) {
  const raw = String((err && err.message) || err).replace(/^NonRetryableError:\s*/, "");
  const m = /^\[([a-z_]+)\]\s*/.exec(raw);
  return { code: m ? m[1] : "unknown", raw };
}

function userMessage(code) {
  if (AUTH_CODES.has(code)) return "Oversettelsen stoppet fordi tjenesten ikke fikk tilgang til xAI. Kontakt administrator.";
  if (code === "invalid_output") return "Kunne ikke oversettes: den oversatte filen ble ugyldig. Feilen er logget.";
  if (code === "unreadable") return "Kunne ikke oversettes: filen kunne ikke leses.";
  if (code === "bad_response") return "Kunne ikke oversettes: Grok ga et svar vi ikke kunne bruke. Prøv igjen senere.";
  if (RETRYABLE_CODES.has(code)) return "Kunne ikke oversettes: xAI svarte ikke som det skulle. Prøv igjen senere.";
  return "Kunne ikke oversettes på grunn av en uventet feil. Feilen er logget.";
}

const byPath = (a, b) => a.rel_path.localeCompare(b.rel_path, "nb");

function loadFile(env, fileId) {
  return one(
    env,
    `SELECT f.*, j.user_id, j.status AS job_status, j.cancel_requested, j.target_language, j.model
     FROM files f JOIN jobs j ON j.id = f.job_id WHERE f.id = ?`,
    fileId
  );
}

function assertRunning(file) {
  if (!file || file.cancel_requested || file.job_status !== "running") {
    throw tagged("cancelled", "Oversettelsen ble avbrutt.");
  }
}

const ctxOf = (file) => ({ userId: file.user_id, jobId: file.job_id, fileId: file.id });

// ---- Stegene ----

async function startJob(env, jobId) {
  const res = await run(env, "UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'", nowIso(), jobId);
  const job = await one(env, "SELECT user_id, status FROM jobs WHERE id = ?", jobId);
  if (!job || job.status !== "running") return [];
  if (res.meta.changes) await logEvent(env, "info", "job.started", "Oversettelsen startet", null, { userId: job.user_id, jobId });
  const files = await all(env, "SELECT id, rel_path FROM files WHERE job_id = ? AND status IN ('queued', 'working') AND deleted_at IS NULL", jobId);
  return files.sort(byPath).map((f) => f.id);
}

// Leser dokumentet, lagrer alle tekstbiter i R2 og returnerer batchplanen (uten tekst).
async function prepareFile(env, fileId) {
  const file = await loadFile(env, fileId);
  assertRunning(file);
  if (file.status === "queued") {
    await run(env, "UPDATE files SET status = 'working', started_at = ? WHERE id = ? AND status = 'queued'", nowIso(), fileId);
    await logEvent(env, "info", "file.started", `Oversetter ${file.name}`, { batches: file.batches }, ctxOf(file));
  }
  const original = await getOriginal(env, file, file.user_id);
  if (!original) throw tagged("unreadable", "Originalfilen mangler i lagringen.");
  let strings;
  try {
    strings = await core.collectStrings(Buffer.from(await original.arrayBuffer()), file.ext);
  } catch (err) {
    throw tagged("unreadable", err.message);
  }
  const batches = [];
  strings.forEach((call, c) => {
    grok.planBatches(call).forEach((b, k) => batches.push({ idx: batches.length, c, k, chars: b.chars }));
  });
  await putJson(env, keys.strings(file.job_id, fileId), strings);
  return { batches };
}

async function recordCall(env, file, call) {
  const usage = call.usage || {};
  const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
  const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
  const details = usage.output_tokens_details || usage.completion_tokens_details || {};
  await batch(env, [
    [
      `INSERT INTO grok_calls (ts, job_id, file_id, model, status, ok, attempt, items, input_chars, output_chars, ms,
         input_tokens, output_tokens, reasoning_tokens, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      nowIso(), file.job_id, file.id, file.model, call.status, call.ok ? 1 : 0, call.attempt, call.items,
      call.inputChars, call.outputChars, call.ms, inputTokens, outputTokens, details.reasoning_tokens || 0, call.error || null,
    ],
    [
      "UPDATE jobs SET calls = calls + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?",
      inputTokens, outputTokens, file.job_id,
    ],
  ]);
  if (!call.ok) {
    const retryable = RETRYABLE_CODES.has(call.code);
    await logEvent(
      env,
      retryable ? "warn" : "error",
      retryable ? "grok.retry" : "grok.error",
      call.error || "Tomt svar fra Grok",
      { status: call.status, attempt: call.attempt, code: call.code, items: call.items, ms: call.ms },
      ctxOf(file)
    );
  }
}

const markBatch = (env, file, b, ms) =>
  run(
    env,
    "INSERT OR IGNORE INTO batches (job_id, file_id, idx, chars, ms, done_at) VALUES (?, ?, ?, ?, ?, ?)",
    file.job_id, file.id, b.idx, b.chars, ms, nowIso()
  );

// Oversetter opptil CHUNK_SIZE batcher, GROK_CONCURRENCY om gangen. Batcher som allerede ligger i R2 hoppes over.
async function translateChunk(env, fileId, list) {
  const file = await loadFile(env, fileId);
  assertRunning(file);
  const cfg = config(env);
  const todo = [];
  for (const b of list) {
    if (await env.FILES.head(keys.batch(file.job_id, fileId, b.idx))) await markBatch(env, file, b, null);
    else todo.push(b);
  }
  if (!todo.length) return { translated: 0 };

  const strings = await getJson(env, keys.strings(file.job_id, fileId));
  const plans = new Map();
  const writes = [];
  let next = 0;
  let stop = false;
  const ctx = {
    apiKey: env.XAI_API_KEY,
    model: file.model || cfg.model,
    baseUrl: cfg.baseUrl,
    targetLanguage: file.target_language,
    timeoutMs: REQUEST_TIMEOUT_MS,
    onCall: (call) => writes.push(recordCall(env, file, call)),
  };
  async function worker() {
    while (!stop && next < todo.length) {
      const b = todo[next++];
      if (!plans.has(b.c)) plans.set(b.c, grok.planBatches(strings[b.c]));
      const warnings = [];
      const t0 = Date.now();
      try {
        const translations = await grok.translateBatch(plans.get(b.c)[b.k].items, {
          ...ctx,
          onWarning: (w) => warnings.push(w),
        });
        await putJson(env, keys.batch(file.job_id, fileId, b.idx), { translations, warnings });
        await markBatch(env, file, b, Date.now() - t0);
      } catch (err) {
        stop = true;
        throw err;
      }
    }
  }
  const results = await Promise.allSettled(Array.from({ length: Math.min(cfg.concurrency, todo.length) }, worker));
  // Alle D1-skrivinger fra onCall må være ferdige før steget returnerer.
  await Promise.allSettled(writes);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    const err = failed.reason;
    // Feil som ikke hjelper å prøve igjen (nøkkel, ugyldig svar) avslutter filen med en gang.
    if (err instanceof grok.GrokError && !err.retryable) throw tagged(err.code, err.message);
    throw err;
  }
  return { translated: todo.length };
}

async function assembleFile(env, fileId, list) {
  const file = await loadFile(env, fileId);
  if (file && file.status === "done") return { done: true };
  assertRunning(file);
  const strings = await getJson(env, keys.strings(file.job_id, fileId));
  const translated = strings.map((s) => s.slice());
  const plans = new Map();
  const warnings = [];
  for (const b of list) {
    const saved = await getJson(env, keys.batch(file.job_id, fileId, b.idx));
    if (!saved) throw new Error(`Batch ${b.idx} mangler i lagringen.`);
    if (!plans.has(b.c)) plans.set(b.c, grok.planBatches(strings[b.c]));
    plans.get(b.c)[b.k].items.forEach((it, j) => {
      translated[b.c][it.i] = saved.translations[j];
    });
    warnings.push(...saved.warnings);
  }
  const original = await getOriginal(env, file, file.user_id);
  if (!original) throw tagged("unreadable", "Originalfilen mangler i lagringen.");
  let result;
  try {
    result = await core.applyTranslations(Buffer.from(await original.arrayBuffer()), file.ext, translated);
  } catch (err) {
    if (err.code === "invalid_output") {
      await run(env, "UPDATE files SET error_details = ? WHERE id = ?", JSON.stringify(err.details || []), fileId);
    }
    throw tagged(err.code === "invalid_output" ? "invalid_output" : "unreadable", err.message);
  }
  warnings.push(...result.warnings);

  const paths = await all(env, "SELECT rel_path FROM files WHERE job_id = ? AND deleted_at IS NULL", file.job_id);
  const outputName = core.assignOutputNames(paths.map((p) => p.rel_path)).get(file.rel_path) || core.outputNameFor(file.rel_path);
  await putOutput(env, file, file.user_id, result.buffer);
  const now = nowIso();
  const durationMs = Date.now() - Date.parse(file.started_at || now);
  const res = await run(
    env,
    `UPDATE files SET status = 'done', output_name = ?, output_bytes = ?, warnings_json = ?, finished_at = ?, duration_ms = ?,
       message = NULL, error = NULL WHERE id = ? AND status = 'working'`,
    outputName, result.buffer.length, JSON.stringify(warnings.slice(0, 100)), now, durationMs, fileId
  );
  if (!res.meta.changes) {
    // Avbrutt mens vi satte sammen: ikke la en foreldreløs fil ligge igjen.
    await env.FILES.delete(keys.output(file.user_id, file.job_id, fileId));
    throw tagged("cancelled", "Oversettelsen ble avbrutt.");
  }
  const ctx = ctxOf(file);
  await logEvent(env, "info", "file.done", `${file.name} er oversatt`, {
    outputName, bytes: result.buffer.length, durationMs, warnings: warnings.length,
  }, ctx);
  for (const w of warnings.slice(0, MAX_WARNING_EVENTS)) {
    await logEvent(env, "warn", "file.warning", w.message || "Merknad", w, ctx);
  }
  return { done: true };
}

async function failFile(env, fileId, code, raw) {
  const file = await loadFile(env, fileId);
  if (!file) return;
  const message = userMessage(code);
  const now = nowIso();
  const res = await run(
    env,
    `UPDATE files SET status = 'failed', message = ?, error = ?, finished_at = ?, duration_ms = ?
     WHERE id = ? AND status IN ('queued', 'working')`,
    message, raw, now, file.started_at ? Date.now() - Date.parse(file.started_at) : null, fileId
  );
  if (res.meta.changes) await logEvent(env, "error", "file.failed", message, { code, error: raw }, ctxOf(file));
}

// Nøkkelfeil: resten av filene vil feile likt, så de merkes med en gang og jobben stoppes.
async function abortJob(env, jobId, code, raw) {
  const message = userMessage(code);
  await batch(env, [
    [
      "UPDATE files SET status = 'failed', message = ?, error = ?, finished_at = ? WHERE job_id = ? AND status IN ('queued', 'working')",
      message, raw, nowIso(), jobId,
    ],
    ["UPDATE jobs SET error = ? WHERE id = ? AND status = 'running'", message, jobId],
  ]);
}

async function finishJob(env, jobId) {
  const job = await one(env, "SELECT * FROM jobs WHERE id = ?", jobId);
  if (job && job.status === "running") {
    await run(
      env,
      "UPDATE files SET status = 'failed', message = ?, finished_at = ? WHERE job_id = ? AND status IN ('queued', 'working')",
      userMessage("unknown"), nowIso(), jobId
    );
    const files = await all(env, "SELECT status FROM files WHERE job_id = ? AND plan_json IS NOT NULL", jobId);
    const done = files.filter((f) => f.status === "done").length;
    const failed = files.length - done;
    const status = failed === 0 ? "done" : done > 0 ? "partial" : "failed";
    const error = status === "failed" ? job.error || "Ingen av dokumentene kunne oversettes." : job.error;
    const now = nowIso();
    const res = await run(
      env,
      "UPDATE jobs SET status = ?, finished_at = ?, error = ? WHERE id = ? AND status = 'running'",
      status, now, error, jobId
    );
    if (res.meta.changes) {
      const actualSeconds = Math.round((Date.parse(now) - Date.parse(job.started_at || job.queued_at || now)) / 1000);
      await logEvent(
        env,
        status === "done" ? "info" : status === "partial" ? "warn" : "error",
        "job.finished",
        status === "done" ? "Oversettelsen er ferdig" : status === "partial" ? "Oversettelsen er ferdig, men noen dokumenter feilet" : "Oversettelsen feilet",
        {
          status,
          estimateSeconds: job.estimate_seconds,
          actualSeconds,
          files: files.length,
          done,
          failed,
          calls: job.calls,
          inputTokens: job.input_tokens,
          outputTokens: job.output_tokens,
        },
        { userId: job.user_id, jobId }
      );
    }
  }
  await deleteWork(env, jobId);
  return { status: job ? job.status : null };
}

export class TranslationJob extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    const { jobId } = event.payload;
    const fileIds = await step.do("start", () => startJob(env, jobId));

    for (const fileId of fileIds) {
      try {
        const { batches } = await step.do(`prepare:${fileId}`, FILE_STEP, () => prepareFile(env, fileId));
        for (let n = 0; n * CHUNK_SIZE < batches.length; n++) {
          const list = batches.slice(n * CHUNK_SIZE, (n + 1) * CHUNK_SIZE);
          await step.do(`chunk:${fileId}:${n}`, CHUNK_STEP, () => translateChunk(env, fileId, list));
        }
        await step.do(`assemble:${fileId}`, FILE_STEP, () => assembleFile(env, fileId, batches));
      } catch (err) {
        const { code, raw } = parseStepError(err);
        if (code === "cancelled") break;
        await step.do(`fail:${fileId}`, () => failFile(env, fileId, code, raw));
        if (AUTH_CODES.has(code)) {
          await step.do("abort", () => abortJob(env, jobId, code, raw));
          break;
        }
      }
    }

    return step.do("finish", () => finishJob(env, jobId));
  }
}
