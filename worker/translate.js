// Oversettelsen i Cloudflare: én Workflow-instans (id <sendingId>-<n>) tar sendingens filer i kø én og én.
// Cloudflare lagrer hvert steg, så en omstart fortsetter der den slapp. Tekstbitene ligger i R2 under work/<fileId>/:
// strings.json (alt som skal oversettes), plan.json (hvilke tekstbiter hver batch har, bestemt én gang i prepare, så
// en ny versjon av programmet midt i en oversettelse ikke deler opp annerledes) og b-<idx>.json per ferdig batch, så
// ingen batch betales to ganger. En fil eies av instansen som tok den (files.workflow_id); en instans som har mistet
// filen, lar den være.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import core from "../src/core.js";
import grok from "../src/grok.js";
import { config } from "./config.js";
import { one, all, run, nowIso } from "./db.js";
import { logEvent } from "./log.js";
import { CHUNK, liveEta } from "./estimate.js";
import { r2Key, workPrefix, outputName, putObject, deleteWork } from "./files.js";
import { markDone, markFailed, finishIfDone } from "./sendings.js";
import { estimatorParams, grokOptions, recordCall } from "./xai.js";

const CHUNK_STEP = { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "15 minutes" };
const FILE_STEP = { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" };
const REQUEST_TIMEOUT_MS = 240000;
const AUTH_CODES = ["auth", "forbidden", "no_key"];
const AUTH_ERROR = /\[(auth|forbidden|no_key)\]/;
const CTX = { source: "system" };

const fileCtx = (f) => ({ ...CTX, sendingId: f.sending_id, fileId: f.id });
const batchKey = (fileId, idx) => `${workPrefix(fileId)}b-${idx}.json`;
const stringsKey = (fileId) => `${workPrefix(fileId)}strings.json`;
const planKey = (fileId) => `${workPrefix(fileId)}plan.json`;
const REPLANNED = "Programmet ble oppdatert mens filen ble oversatt, og oppdelingen i deler stemmer ikke lenger. Sett filen i kø igjen.";

async function readJsonObject(env, key) {
  const obj = await env.FILES.get(key);
  return obj ? JSON.parse(await obj.text()) : null;
}

async function readOriginal(env, f) {
  const obj = await env.FILES.get(r2Key(f.sending_id, f.id, "original"));
  if (!obj) throw permanent(new Error("Originalen finnes ikke lenger i lagringen."));
  return Buffer.from(await obj.arrayBuffer());
}

// Feil som ikke blir bedre av nye forsøk: skadet dokument, ugyldig resultat, nøkkelen avvist.
function permanent(err) {
  err.permanent = true;
  return err;
}

// Stakk og ekstra felt forsvinner når feilen forlater steget, så detaljene lagres på filen her.
// Nøkkelfeil får koden foran meldingen ([auth] …) så run() kan stoppe resten av sendingen.
async function stepFailure(env, fileId, owner, err) {
  const details = [err.stack || String(err), err.details ? JSON.stringify(err.details, null, 2) : ""].filter(Boolean).join("\n\n");
  await run(env, "UPDATE files SET error_details = ? WHERE id = ? AND workflow_id = ?", details.slice(0, 20000), fileId, owner).catch(() => {});
  if (err.name === "GrokError" && AUTH_CODES.includes(err.code)) return new NonRetryableError(`[${err.code}] ${err.message}`);
  return err.permanent ? new NonRetryableError(err.message) : err;
}

async function inStep(env, fileId, owner, work) {
  try {
    return await work();
  } catch (err) {
    throw await stepFailure(env, fileId, owner, err);
  }
}

const owned = (env, fileId, owner) =>
  one(env, "SELECT * FROM files WHERE id = ? AND status = 'working' AND workflow_id = ? AND deleted_at IS NULL", fileId, owner);

async function start(env, sendingId) {
  await run(env, "UPDATE sendings SET started_at = COALESCE(started_at, ?) WHERE id = ?", nowIso(), sendingId);
  const rows = await all(env, "SELECT id FROM files WHERE sending_id = ? AND status = 'sent' AND deleted_at IS NULL ORDER BY rel_path", sendingId);
  return rows.map((r) => r.id);
}

// Andel ferdige tegn og gjenstående tid (sekunder, returneres) ut fra batchene som er ferdige så langt.
async function saveProgress(env, f, owner, batches) {
  const rows = await all(env, "SELECT idx, ms FROM batches WHERE file_id = ?", f.id);
  const done = new Map(rows.map((r) => [r.idx, r.ms]));
  const total = batches.reduce((n, b) => n + b.chars, 0);
  const doneChars = batches.reduce((n, b) => n + (done.has(b.idx) ? b.chars : 0), 0);
  const eta = Math.round(liveEta(batches, done, await estimatorParams(env), config(env).concurrency));
  await run(
    env,
    "UPDATE files SET progress_percent = ?, eta_seconds = ?, progress_at = ? WHERE id = ? AND status = 'working' AND workflow_id = ?",
    total ? Math.round((1000 * doneChars) / total) / 10 : 0, eta, nowIso(), f.id, owner
  );
  return eta;
}

// Batchene for tekstbitene: [{ c, k, i: [indekser], chars }] i rekkefølge (idx).
function planOf(strings) {
  return strings.flatMap((list, c) => grok.planBatches(list).map((b, k) => ({ c, k, i: b.items.map((it) => it.i), chars: b.chars })));
}

// Ferdige batcher fra et tidligere forsøk (sett i kø igjen) gjenbrukes bare når de gjelder nøyaktig de samme
// tekstbitene; ellers (dokumentet leses annerledes etter en oppdatering, eller batchene er delt opp annerledes)
// slettes de, så ingen del av den nye planen hoppes over eller får feil oversettelse. Hvilke tekstbiter en ferdig
// batch har, står i den lagrede planen (plan.json), så batchfilene trenger ikke leses; bare en fil som ble klargjort
// av en eldre versjon uten plan.json, leses batch for batch. Radene i batches slettes med én spørring.
async function dropStaleBatches(env, fileId, strings, plan, saved) {
  const old = await env.FILES.get(stringsKey(fileId));
  if (!old) return;
  const sameText = (await old.text()) === JSON.stringify(strings);
  const before = sameText ? await readJsonObject(env, planKey(fileId)) : null;
  // Samme tekst og samme lagrede plan (vanlig ved «sett i kø igjen»): alle ferdige batcher gjelder fortsatt.
  if (before && JSON.stringify(before) === JSON.stringify(saved)) return;
  const same = (part, want) => Boolean(part && want) && part.c === want.c && JSON.stringify(part.i) === JSON.stringify(want.i);
  const stale = [];
  let cursor;
  do {
    const page = await env.FILES.list({ prefix: `${workPrefix(fileId)}b-`, cursor });
    for (const o of page.objects) {
      const idx = Number(/b-(\d+)\.json$/.exec(o.key)?.[1]);
      const want = sameText ? plan[idx] : null;
      let ok = false;
      if (want && before) ok = same(Array.isArray(before.batches) ? before.batches[idx] : null, want);
      else if (want) ok = same(await readJsonObject(env, o.key), want);
      if (!ok) stale.push([o.key, idx]);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let n = 0; n < stale.length; n += 1000) await env.FILES.delete(stale.slice(n, n + 1000).map(([key]) => key));
  if (!sameText) await run(env, "DELETE FROM batches WHERE file_id = ?", fileId);
  else {
    const idxs = stale.map(([, idx]) => idx).filter(Number.isInteger);
    if (idxs.length) await run(env, "DELETE FROM batches WHERE file_id = ? AND idx IN (SELECT value FROM json_each(?))", fileId, JSON.stringify(idxs));
  }
}

// Tekstbitene i hver batch. Fra plan.json; en instans som ble klargjort av en eldre versjon (uten plan.json)
// planlegger på nytt, men bare når det gir nøyaktig de samme batchene. Ellers stopper filen med en melding om å sette
// den i kø igjen, i stedet for å hoppe over tekst eller krasje.
async function batchItems(env, fileId, strings, batches) {
  const saved = await readJsonObject(env, planKey(fileId));
  const plan = saved ? saved.batches : planOf(strings);
  const same = plan.length === batches.length
    && batches.every((b) => plan[b.idx] && plan[b.idx].c === b.c && plan[b.idx].chars === b.chars && (saved || plan[b.idx].k === b.k));
  if (!same) throw permanent(new Error(REPLANNED));
  return (b) => plan[b.idx].i.map((i) => ({ i, t: String(strings[b.c][i] ?? "") }));
}

// Tar filen (eller tar den igjen etter et nytt forsøk på steget), henter tekstbitene og planlegger batchene.
// Returnerer { targetLanguage, batches: [{ idx, c, k, chars }] } uten tekst, eller null hvis filen ikke er vår.
async function prepare(env, owner, fileId) {
  const now = nowIso();
  const f = await one(
    env,
    `UPDATE files SET status = 'working', workflow_id = ?, attempts = COALESCE(attempts, 0) + (status = 'sent'), started_at = ?,
       finished_at = NULL, message = 'Oversettes nå', error = NULL, error_details = NULL, progress_percent = 0,
       eta_seconds = estimate_seconds, progress_at = ?
     WHERE id = ? AND deleted_at IS NULL AND (status = 'sent' OR (status = 'working' AND workflow_id = ?)) RETURNING *`,
    owner, now, now, fileId, owner
  );
  if (!f) return null;
  return inStep(env, fileId, owner, async () => {
    const { target_language: targetLanguage } = await one(env, "SELECT target_language FROM sendings WHERE id = ?", f.sending_id);
    const original = await readOriginal(env, f);
    const strings = await core.collectStrings(original, f.ext).catch((err) => Promise.reject(permanent(err)));
    const plan = planOf(strings);
    const batches = plan.map((b, idx) => ({ idx, c: b.c, k: b.k, chars: b.chars }));
    const saved = { batches: plan.map(({ c, i, chars }) => ({ c, i, chars })) };
    await dropStaleBatches(env, f.id, strings, plan, saved);
    await env.FILES.put(stringsKey(f.id), JSON.stringify(strings));
    await env.FILES.put(planKey(f.id), JSON.stringify(saved));
    const estimateSeconds = await saveProgress(env, f, owner, batches);
    await logEvent(env, "info", "file.started", `Oversetter ${f.name}`, {
      attempt: f.attempts, batches: batches.length, chars: batches.reduce((n, b) => n + b.chars, 0), estimateSeconds,
    }, fileCtx(f));
    return { targetLanguage, batches };
  });
}

// Én bit à CHUNK batcher, GROK_CONCURRENCY om gangen. Hvert kall havner i grok_calls; hver ferdig batch i R2 og batches.
// Returnerer false hvis filen ikke lenger er vår (slettet, satt i kø på nytt eller endret av eieren).
async function translateChunk(env, owner, fileId, { targetLanguage, batches }, n) {
  const f = await owned(env, fileId, owner);
  if (!f) return false;
  return inStep(env, fileId, owner, async () => {
    const strings = await readJsonObject(env, stringsKey(fileId));
    const itemsOf = await batchItems(env, fileId, strings, batches);
    const calls = [];
    const options = grokOptions(env, {
      targetLanguage,
      timeoutMs: REQUEST_TIMEOUT_MS,
      onCall: (info) => calls.push(recordCall(env, { sendingId: f.sending_id, fileId }, info)),
    });
    const queue = batches.slice(n * CHUNK, (n + 1) * CHUNK);
    let progress = Promise.resolve();
    let stopped = false;
    async function worker() {
      for (let b = queue.shift(); b && !stopped; b = queue.shift()) {
        if (await env.FILES.head(batchKey(fileId, b.idx))) continue;
        const items = itemsOf(b);
        const warnings = [];
        const started = Date.now();
        const translated = await grok.translateBatch(items, { ...options, onWarning: (w) => warnings.push(w) });
        const ms = Date.now() - started;
        await env.FILES.put(batchKey(fileId, b.idx), JSON.stringify({ c: b.c, i: items.map((it) => it.i), t: translated, w: warnings }));
        await run(env, "INSERT OR IGNORE INTO batches (file_id, idx, chars, ms, done_at) VALUES (?, ?, ?, ?, ?)", fileId, b.idx, b.chars, ms, nowIso());
        progress = progress.then(() => saveProgress(env, f, owner, batches));
        await progress;
      }
    }
    const workers = Array.from({ length: Math.min(config(env).concurrency, queue.length) }, () => worker().catch((err) => {
      stopped = true;
      throw err;
    }));
    try {
      await Promise.all(workers);
    } finally {
      await Promise.allSettled(workers);
      await Promise.allSettled(calls);
    }
    return true;
  });
}

// Setter oversettelsene inn i originalen, lagrer «<navn> (norsk).<ext>» og rydder mellomlageret.
async function assemble(env, owner, fileId, { batches }) {
  const f = await owned(env, fileId, owner);
  if (!f) return false;
  return inStep(env, fileId, owner, async () => {
    const strings = await readJsonObject(env, stringsKey(fileId));
    const itemsOf = await batchItems(env, fileId, strings, batches);
    const warnings = [];
    for (const b of batches) {
      const part = await readJsonObject(env, batchKey(fileId, b.idx));
      if (!part) throw permanent(new Error(`Del ${b.idx + 1} av ${batches.length} av oversettelsen mangler.`));
      if (part.c !== b.c || JSON.stringify(part.i) !== JSON.stringify(itemsOf(b).map((it) => it.i))) throw permanent(new Error(REPLANNED));
      part.i.forEach((pos, k) => {
        strings[part.c][pos] = part.t[k];
      });
      warnings.push(...part.w);
    }
    const original = await readOriginal(env, f);
    const out = await core.applyTranslations(original, f.ext, strings).catch((err) => Promise.reject(permanent(err)));
    warnings.push(...out.warnings);
    const name = outputName(f.rel_path, out.outExt);
    await putObject(env, r2Key(f.sending_id, f.id, "result"), name, out.buffer);
    const row = await markDone(env, f, { name, bytes: out.buffer.length, source: "cloud", owner, ctx: fileCtx(f) });
    if (!row) return false;
    if (warnings.length) {
      await logEvent(env, "warn", "file.warning", `${f.name}: ${warnings.length} advarsel(er) under oversettelsen`, {
        count: warnings.length, warnings: warnings.slice(0, 20),
      }, fileCtx(f));
    }
    await deleteWork(env, fileId);
    await run(env, "DELETE FROM batches WHERE file_id = ?", fileId);
    return true;
  });
}

// Nøkkelen virker ikke: resten av filene i kø feiler med samme feil (uten én push per fil).
async function abortRemaining(env, sendingId, error) {
  const rows = await all(env, "SELECT id FROM files WHERE sending_id = ? AND status = 'sent' AND deleted_at IS NULL ORDER BY rel_path", sendingId);
  for (const r of rows) await markFailed(env, r.id, { error, ctx: CTX, push: false });
  return rows.length;
}

export class TranslateSending extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    const owner = event.instanceId;
    const { sendingId } = event.payload;
    const fileIds = await step.do("start", () => start(env, sendingId));
    for (const fileId of fileIds) {
      try {
        const prep = await step.do(`prepare:${fileId}`, FILE_STEP, () => prepare(env, owner, fileId));
        if (!prep) continue;
        let ours = true;
        for (let n = 0; ours && n * CHUNK < prep.batches.length; n++) {
          ours = await step.do(`chunk:${fileId}:${n}`, CHUNK_STEP, () => translateChunk(env, owner, fileId, prep, n));
        }
        if (ours) await step.do(`assemble:${fileId}`, FILE_STEP, () => assemble(env, owner, fileId, prep));
      } catch (err) {
        // Meldingen kan få «NonRetryableError: » foran seg på veien ut av steget.
        const error = String(err.message || err).replace(/^NonRetryableError:?\s*/, "");
        await step.do(`fail:${fileId}`, async () => Boolean(await markFailed(env, fileId, { error, owner, ctx: CTX })));
        if (AUTH_ERROR.test(error)) {
          await step.do("abort", () => abortRemaining(env, sendingId, error));
          break;
        }
      }
    }
    await step.do("finish", async () => {
      await finishIfDone(env, sendingId, CTX);
      return true;
    });
  }
}
