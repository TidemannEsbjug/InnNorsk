// Sendinger og filer: tilgang, visning (JSON for nettsiden, iPhone og admin), statusen som følger filene,
// ferdige og mislykkede filer, og start/stopp av oversettelsen (Workflow-instansene).
import { one, run, batch, nowIso, isoAgo, DAY_MS } from "./db.js";
import { fail } from "./http.js";
import { logEvent } from "./log.js";
import { pushToAdmins } from "./apns.js";
import { r2Key } from "./files.js";
import { costSql } from "./xai.js";

// Eierens navn, slik Svetlana ser det («Kunne ikke oversettes. Jonas har fått beskjed.»).
const TRANSLATOR_SQL = "SELECT COALESCE(display_name, username) AS name FROM users WHERE role = 'admin' ORDER BY id LIMIT 1";
const DEFAULT_TRANSLATOR = "oversetteren";

export async function translatorName(env) {
  const row = await one(env, TRANSLATOR_SQL);
  return row ? row.name : DEFAULT_TRANSLATOR;
}

// «1 fil» / «3 filer».
export const filesText = (n) => (n === 1 ? "1 fil" : `${n} filer`);

// Samme format som formatDuration i web/js/api.js: «under 1 min», «ca. 3 min», «ca. 1 t 5 min».
export function formatDuration(seconds) {
  if (seconds < 60) return "under 1 min";
  const min = Math.round(seconds / 60);
  if (min < 60) return `ca. ${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `ca. ${h} t ${min % 60} min` : `ca. ${h} t`;
}

// Gjenstående tid regnes fra siste fremdriftsmelding.
function remainingSeconds(f) {
  if (f.eta_seconds == null || !f.progress_at) return null;
  return Math.max(0, f.eta_seconds - Math.max(0, (Date.now() - Date.parse(f.progress_at)) / 1000));
}

export function statusText(f, translator = DEFAULT_TRANSLATOR) {
  switch (f.status) {
    case "draft":
      return f.estimate_seconds == null ? "Klar" : `Klar – ${formatDuration(f.estimate_seconds)}`;
    case "sent":
      return "I kø – starter straks";
    case "working": {
      const parts = ["Oversettes nå"];
      if (f.progress_percent != null) parts.push(`${Math.round(f.progress_percent)} %`);
      const left = remainingSeconds(f);
      if (left != null) parts.push(`${formatDuration(left)} igjen`);
      return parts.join(" – ");
    }
    case "done":
      return "Ferdig";
    default:
      return f.message || `Kunne ikke oversettes. ${translator} har fått beskjed.`;
  }
}

const secondsBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

export function serializeFile(f, translator, admin = false) {
  const view = {
    id: f.id,
    sendingId: f.sending_id,
    path: f.rel_path,
    name: f.name,
    ext: f.ext,
    bytes: f.bytes,
    status: f.status,
    statusText: statusText(f, translator),
    estimateSeconds: f.estimate_seconds == null ? null : Math.round(f.estimate_seconds),
    progress:
      f.status === "working" && f.progress_at
        ? { percent: f.progress_percent, etaSeconds: remainingSeconds(f), at: f.progress_at }
        : null,
    outputName: f.status === "done" ? f.output_name : null,
    outputBytes: f.status === "done" ? f.output_bytes : null,
    createdAt: f.created_at,
    startedAt: f.started_at,
    finishedAt: f.finished_at,
  };
  if (!admin) return view;
  return {
    ...view,
    outputName: f.output_name,
    outputBytes: f.output_bytes,
    message: f.message,
    error: f.error,
    errorDetails: f.error_details,
    attempts: f.attempts,
    segments: f.segments,
    chars: f.chars,
    batches: f.batches,
    calls: f.calls,
    inputTokens: f.input_tokens,
    outputTokens: f.output_tokens,
    costUsd: f.cost_usd,
    durationSeconds: f.started_at ? secondsBetween(f.started_at, f.finished_at || nowIso()) : null,
    outputSource: f.output_source,
  };
}

// Beregnet tid igjen for sendingen: filer som venter (klare utkast eller i kø) + resten av filen under arbeid.
function secondsLeft(files) {
  let total = null;
  for (const f of files) {
    const s = f.status === "working" ? remainingSeconds(f) ?? f.estimate_seconds : ["draft", "sent"].includes(f.status) ? f.estimate_seconds : null;
    if (s != null) total = (total ?? 0) + s;
  }
  return total == null ? null : Math.round(total);
}

function serializeSending(s, files, translator, admin = false) {
  const count = (...statuses) => files.filter((f) => statuses.includes(f.status)).length;
  return {
    id: s.id,
    userId: s.user_id,
    ...(s.username !== undefined ? { username: s.username, displayName: s.display_name || s.username } : {}),
    status: s.status,
    targetLanguage: s.target_language,
    note: s.note,
    reply: s.reply,
    createdAt: s.created_at,
    sentAt: s.sent_at,
    startedAt: s.started_at,
    finishedAt: s.finished_at,
    estimateSeconds: secondsLeft(files),
    files: files.map((f) => serializeFile(f, translator, admin)),
    counts: { total: files.length, waiting: count("draft", "sent"), working: count("working"), done: count("done"), failed: count("failed") },
  };
}

const translatorOf = (result) => (result.results[0] ? result.results[0].name : DEFAULT_TRANSLATOR);

// Sendinger med filer i én rundtur. userId = null gir alle brukeres (admin).
export async function listSendings(env, { userId = null, limit = 50, admin = false } = {}) {
  const where = `s.deleted_at IS NULL AND NOT (s.status = 'draft' AND s.created_at < ?)${userId == null ? "" : " AND s.user_id = ?"}`;
  const args = [isoAgo(DAY_MS), ...(userId == null ? [] : [userId]), limit];
  const [sendings, files, translator] = await batch(env, [
    [`SELECT s.*, u.username, u.display_name FROM sendings s LEFT JOIN users u ON u.id = s.user_id
      WHERE ${where} ORDER BY s.created_at DESC LIMIT ?`, ...args],
    [`SELECT * FROM files WHERE deleted_at IS NULL AND sending_id IN
      (SELECT s.id FROM sendings s WHERE ${where} ORDER BY s.created_at DESC LIMIT ?) ORDER BY rel_path`, ...args],
    [TRANSLATOR_SQL],
  ]);
  const bySending = Map.groupBy(files.results, (f) => f.sending_id);
  const name = translatorOf(translator);
  return { sendings: sendings.results.map((s) => serializeSending(s, bySending.get(s.id) || [], name, admin)) };
}

export async function sendingView(env, id, admin = false) {
  const [sendings, files, translator] = await batch(env, [
    ["SELECT s.*, u.username, u.display_name FROM sendings s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?", id],
    ["SELECT * FROM files WHERE sending_id = ? AND deleted_at IS NULL ORDER BY rel_path", id],
    [TRANSLATOR_SQL],
  ]);
  return serializeSending(sendings.results[0], files.results, translatorOf(translator), admin);
}

// Egen sending, eller (bare lesing) hvilken som helst for admin. Andres sendinger finnes ikke (404).
export async function loadSending(c, id, { write = false } = {}) {
  const user = c.get("user");
  const s = await one(c.env, "SELECT * FROM sendings WHERE id = ? AND deleted_at IS NULL", id);
  if (!s || (s.user_id !== user.id && (write || user.role !== "admin"))) fail(404, "Fant ikke sendingen.");
  return s;
}

// Fil med sendingens eier og status; admin ser alle, brukeren bare sine egne.
export async function loadFile(c, fileId) {
  const user = c.get("user");
  const f = await one(
    c.env,
    `SELECT f.*, s.user_id, s.status AS sending_status, s.workflow_id AS sending_workflow_id FROM files f
     JOIN sendings s ON s.id = f.sending_id WHERE f.id = ? AND f.deleted_at IS NULL AND s.deleted_at IS NULL`,
    fileId
  );
  if (!f || (f.user_id !== user.id && user.role !== "admin")) fail(404, "Fant ikke filen.");
  return f;
}

// Sendingens status følger filene: alle ferdige (done/failed) → done, noe i kø igjen → sent.
// Returnerer true når sendingen nettopp ble ferdig.
async function syncSending(env, id) {
  const [finished] = await batch(env, [
    [`UPDATE sendings SET status = 'done', finished_at = ? WHERE id = ? AND status = 'sent' AND NOT EXISTS
      (SELECT 1 FROM files WHERE sending_id = ? AND deleted_at IS NULL AND status NOT IN ('done', 'failed'))`, nowIso(), id, id],
    [`UPDATE sendings SET status = 'sent', finished_at = NULL WHERE id = ? AND status = 'done' AND EXISTS
      (SELECT 1 FROM files WHERE sending_id = ? AND deleted_at IS NULL AND status IN ('sent', 'working'))`, id, id],
  ]);
  return finished.meta.changes > 0;
}

// Når siste fil er ferdig: sending.done med estimat mot faktisk tid, antall og forbruk.
export async function finishIfDone(env, sendingId, ctx) {
  if (!(await syncSending(env, sendingId))) return;
  const s = await one(
    env,
    `SELECT s.estimate_seconds, COALESCE(s.started_at, s.sent_at) AS started_at, s.finished_at, COUNT(f.id) AS files,
       COALESCE(SUM(f.status = 'done'), 0) AS done, COALESCE(SUM(f.status = 'failed'), 0) AS failed, COALESCE(SUM(f.calls), 0) AS calls,
       COALESCE(SUM(f.input_tokens), 0) AS inputTokens, COALESCE(SUM(f.output_tokens), 0) AS outputTokens,
       ROUND(SUM(f.cost_usd), 6) AS costUsd
     FROM sendings s LEFT JOIN files f ON f.sending_id = s.id AND f.deleted_at IS NULL WHERE s.id = ? GROUP BY s.id`,
    sendingId
  );
  const { estimate_seconds: estimate, started_at: startedAt, finished_at: finishedAt, ...counts } = s;
  await logEvent(env, "info", "sending.done", "Alle filene i sendingen er ferdige", {
    estimateSeconds: estimate == null ? null : Math.round(estimate),
    actualSeconds: startedAt ? secondsBetween(startedAt, finishedAt) : null,
    ...counts,
  }, { ...ctx, sendingId });
}

// Filen er oversatt (resultatet ligger allerede i R2). owner = Workflow-instansen som må eie filen (null for admin).
// Returnerer raden, eller null når filen er borte eller tatt over; da fjernes resultatet hvis filen er slettet.
export async function markDone(env, f, { name, bytes, source, owner = null, ctx }) {
  const [cost, costArgs] = costSql(env);
  const row = await one(
    env,
    `UPDATE files SET status = 'done', output_name = ?, output_bytes = ?, output_source = ?, cost_usd = ${cost}, finished_at = ?,
       message = NULL, error = NULL, error_details = NULL, progress_percent = NULL, eta_seconds = NULL
     WHERE id = ? AND deleted_at IS NULL AND (? IS NULL OR (status = 'working' AND workflow_id = ?)) RETURNING *`,
    name, bytes, source, ...costArgs, nowIso(), f.id, owner, owner
  );
  if (!row) {
    if (!(await one(env, "SELECT 1 AS ok FROM files WHERE id = ? AND deleted_at IS NULL", f.id))) {
      await env.FILES.delete(r2Key(f.sending_id, f.id, "result"));
    }
    return null;
  }
  await logEvent(env, "info", "file.done", `${row.name} er oversatt`, {
    output: name,
    bytes,
    source,
    seconds: row.started_at ? secondsBetween(row.started_at, row.finished_at) : null,
    estimateSeconds: row.estimate_seconds == null ? null : Math.round(row.estimate_seconds),
    calls: row.calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
  }, ctx);
  return row;
}

// Filen kunne ikke oversettes. Hun ser «Kunne ikke oversettes. <eier> har fått beskjed.», eieren feilen og detaljene.
// Gjelder filer i kø, eller under arbeid hos owner (null = hvilken som helst instans).
export async function markFailed(env, fileId, { error, details = null, owner = null, ctx, push = true }) {
  const [cost, costArgs] = costSql(env);
  const row = await one(
    env,
    `UPDATE files SET status = 'failed', error = ?, error_details = COALESCE(?, error_details), message = NULL, finished_at = ?,
       progress_percent = NULL, eta_seconds = NULL, cost_usd = ${cost}
     WHERE id = ? AND deleted_at IS NULL AND (status = 'sent' OR (status = 'working' AND (? IS NULL OR workflow_id = ?))) RETURNING *`,
    error, details, nowIso(), ...costArgs, fileId, owner, owner
  );
  if (!row) return null;
  const fileCtx = { ...ctx, sendingId: row.sending_id, fileId: row.id };
  await logEvent(env, "error", "file.failed", `Kunne ikke oversette ${row.name}: ${error}`, {
    error, details: row.error_details && row.error_details.slice(0, 4000), attempts: row.attempts, calls: row.calls, costUsd: row.cost_usd,
  }, fileCtx);
  if (push) await pushToAdmins(env, { title: `Kunne ikke oversette ${row.name}`, body: error.slice(0, 180), sendingId: row.sending_id }, fileCtx);
  return row;
}

const attemptOf = (workflowId) => Number(String(workflowId || "").split("-").pop()) || 0;

// Ny Workflow-instans for sendingen: id <sendingId>-<n>, der n øker for hver start (ids kan ikke gjenbrukes).
export async function startWorkflow(env, sendingId, previousId) {
  const id = `${sendingId}-${attemptOf(previousId) + 1}`;
  await env.TRANSLATE.create({ id, params: { sendingId } });
  await run(env, "UPDATE sendings SET workflow_id = ? WHERE id = ?", id, sendingId);
  return id;
}

// Stopper alle sendingens instanser. Feil ignoreres: en instans som er ferdig, kan ikke stoppes.
export async function stopWorkflows(env, s) {
  for (let n = attemptOf(s.workflow_id); n >= 1; n--) {
    try {
      await (await env.TRANSLATE.get(`${s.id}-${n}`)).terminate();
    } catch {
      // allerede ferdig eller finnes ikke
    }
  }
}
