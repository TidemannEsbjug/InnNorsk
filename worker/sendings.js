// Sendinger og filer: tilgang, visning (JSON for nettsiden, iPhone og admin), statusen som følger filene,
// ferdige og mislykkede filer, start/stopp av oversettelsen (Workflow-instansene) og sletting for godt.
// Det Svetlana sletter, er borte for henne med én gang (deleted_at), men ligger i R2 for eieren til purged_at er satt.
import { config } from "./config.js";
import { one, all, run, batch, nowIso, isoAgo, DAY_MS } from "./db.js";
import { fail } from "./http.js";
import { logEvent } from "./log.js";
import { pushToAdmins } from "./apns.js";
import { r2Key, deleteObjects } from "./files.js";
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

// Når en slettet fil slettes for godt (cron kjører hvert 15. minutt, så det kan gå litt lenger).
const purgeAt = (deletedAt, retainDays) =>
  deletedAt && retainDays ? new Date(Date.parse(deletedAt) + retainDays * DAY_MS).toISOString() : null;

// retainDays (RETAIN_DELETED_DAYS) trengs bare for admin-visningen av slettede filer.
export function serializeFile(f, translator, admin = false, retainDays = null) {
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
    deletedAt: f.deleted_at ?? null,
    deletedReason: f.deleted_reason ?? null,
    purgedAt: f.purged_at ?? null,
    purgeAt: f.purged_at ? null : purgeAt(f.deleted_at, retainDays),
  };
}

// Filene som hørte til sendingen (også når hele sendingen er slettet), ikke de hun fjernet fra utkastet eller erstattet.
const inSending = (f) => !f.deleted_at || f.deleted_reason === "sending";

// Beregnet tid igjen for sendingen: filer som venter (klare utkast eller i kø) + resten av filen under arbeid.
function secondsLeft(files) {
  let total = null;
  for (const f of files) {
    const s = f.status === "working" ? remainingSeconds(f) ?? f.estimate_seconds : ["draft", "sent"].includes(f.status) ? f.estimate_seconds : null;
    if (s != null) total = (total ?? 0) + s;
  }
  return total == null ? null : Math.round(total);
}

// files kan (for admin) også ha filer hun har fjernet eller erstattet; de telles ikke med.
function serializeSending(s, files, { translator, admin = false, retainDays = null }) {
  const kept = files.filter(inSending);
  const count = (...statuses) => kept.filter((f) => statuses.includes(f.status)).length;
  const view = {
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
    estimateSeconds: secondsLeft(kept),
    files: files.map((f) => serializeFile(f, translator, admin, retainDays)),
    counts: { total: kept.length, waiting: count("draft", "sent"), working: count("working"), done: count("done"), failed: count("failed") },
  };
  if (!admin) return view;
  return { ...view, deletedAt: s.deleted_at ?? null, deletedBy: s.deleted_by_name ?? null, deletedReason: s.deleted_reason ?? null };
}

const translatorOf = (result) => (result.results[0] ? result.results[0].name : DEFAULT_TRANSLATOR);

const SENDING_SELECT = `SELECT s.*, u.username, u.display_name, COALESCE(d.display_name, d.username) AS deleted_by_name
  FROM sendings s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN users d ON d.id = s.deleted_by`;

// Sendinger med filer i én rundtur. userId = null gir alle brukeres (admin).
// withDeleted (bare admin): også slettede sendinger (som har hatt filer), utkast eldre enn et døgn og filer hun har
// fjernet eller erstattet. Uten er utvalget det samme som hun ser (og det iPhone-appen får).
export async function listSendings(env, { userId = null, limit = 50, admin = false, withDeleted = false } = {}) {
  const visible = withDeleted
    ? "(s.deleted_at IS NULL OR EXISTS (SELECT 1 FROM files x WHERE x.sending_id = s.id))"
    : "s.deleted_at IS NULL AND NOT (s.status = 'draft' AND s.created_at < ?)";
  const where = `${visible}${userId == null ? "" : " AND s.user_id = ?"}`;
  const args = [...(withDeleted ? [] : [isoAgo(DAY_MS)]), ...(userId == null ? [] : [userId]), limit];
  const [sendings, files, translator] = await batch(env, [
    [`${SENDING_SELECT} WHERE ${where} ORDER BY s.created_at DESC LIMIT ?`, ...args],
    [`SELECT * FROM files WHERE ${withDeleted ? "" : "deleted_at IS NULL AND "}sending_id IN
      (SELECT s.id FROM sendings s WHERE ${where} ORDER BY s.created_at DESC LIMIT ?) ORDER BY rel_path, created_at`, ...args],
    [TRANSLATOR_SQL],
  ]);
  const bySending = Map.groupBy(files.results, (f) => f.sending_id);
  const opts = { translator: translatorOf(translator), admin, retainDays: config(env).retainDeletedDays };
  return { sendings: sendings.results.map((s) => serializeSending(s, bySending.get(s.id) || [], opts)) };
}

// withDeleted: også filer hun har fjernet eller erstattet (bare for admin).
export async function sendingView(env, id, admin = false, { withDeleted = false } = {}) {
  const [sendings, files, translator] = await batch(env, [
    [`${SENDING_SELECT} WHERE s.id = ?`, id],
    [`SELECT * FROM files WHERE sending_id = ?${withDeleted ? "" : " AND deleted_at IS NULL"} ORDER BY rel_path, created_at`, id],
    [TRANSLATOR_SQL],
  ]);
  const opts = { translator: translatorOf(translator), admin, retainDays: config(env).retainDeletedDays };
  return serializeSending(sendings.results[0], files.results, opts);
}

// Egen sending, eller (bare lesing) hvilken som helst for admin. Andres sendinger finnes ikke (404).
export async function loadSending(c, id, { write = false } = {}) {
  const user = c.get("user");
  const s = await one(c.env, "SELECT * FROM sendings WHERE id = ? AND deleted_at IS NULL", id);
  if (!s || (s.user_id !== user.id && (write || user.role !== "admin"))) fail(404, "Fant ikke sendingen.");
  return s;
}

// Fil med sendingens eier og status; admin ser alle, brukeren bare sine egne. withDeleted: admin får også en fil som er
// slettet (deleted_at / sending_deleted_at / purged_at sier hvordan); for alle andre er en slettet fil borte (404).
export async function loadFile(c, fileId, { withDeleted = false } = {}) {
  const user = c.get("user");
  const admin = user.role === "admin";
  const f = await one(
    c.env,
    `SELECT f.*, s.user_id, s.status AS sending_status, s.workflow_id AS sending_workflow_id, s.deleted_at AS sending_deleted_at
     FROM files f JOIN sendings s ON s.id = f.sending_id WHERE f.id = ?`,
    fileId
  );
  const deleted = f && (f.deleted_at || f.sending_deleted_at);
  if (!f || (f.user_id !== user.id && !admin) || (deleted && !(admin && withDeleted))) fail(404, "Fant ikke filen.");
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
// Returnerer raden, eller null når filen er borte eller tatt over. Ble filen slettet underveis, fjernes et resultat som
// aldri ble registrert; fantes det en oversettelse fra før, er den nettopp overskrevet og beholdes for eieren.
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
    // Slettet av henne mens oversettelsen ble ferdig: eieren beholder resultatet til filen ryddes bort.
    const kept = await run(
      env,
      `UPDATE files SET output_name = ?, output_bytes = ?, output_source = ?, finished_at = COALESCE(finished_at, ?)
       WHERE id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL`,
      name, bytes, source, nowIso(), f.id
    );
    if (kept.meta.changes) return null;
    const current = await one(env, "SELECT deleted_at, purged_at FROM files WHERE id = ?", f.id);
    if (!current || current.purged_at) await env.FILES.delete(r2Key(f.sending_id, f.id, "result"));
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

// Filene i R2 som eieren fortsatt kan laste ned etter at Svetlana har slettet dem (eller cron har ryddet et gammelt utkast).
// sendingId: bare én sending; cutoff: bare filer slettet før dette tidspunktet (RETAIN_DELETED_DAYS).
export function retainedFiles(env, { sendingId = null, cutoff = null, limit = 500 } = {}) {
  return all(
    env,
    `SELECT id, sending_id, name, bytes, output_bytes FROM files WHERE deleted_at IS NOT NULL AND purged_at IS NULL
       ${sendingId ? "AND sending_id = ?" : ""} ${cutoff ? "AND deleted_at < ?" : ""} ORDER BY deleted_at LIMIT ?`,
    ...[sendingId, cutoff].filter(Boolean), limit
  );
}

// Sletter originalen og oversettelsen i R2 for godt og setter purged_at; radene blir stående som historikk i admin.
// files: rader fra retainedFiles. Én hendelse sending.purged per sending; why fullfører meldingen («etter 30 dager»).
export async function purgeFiles(env, files, { reason, why, ctx }) {
  if (!files.length) return 0;
  await deleteObjects(env, files);
  await run(env, "UPDATE files SET purged_at = ? WHERE purged_at IS NULL AND id IN (SELECT value FROM json_each(?))",
    nowIso(), JSON.stringify(files.map((f) => f.id)));
  for (const [sendingId, list] of Map.groupBy(files, (f) => f.sending_id)) {
    await logEvent(env, "info", "sending.purged", `${filesText(list.length)} slettet for godt ${why}`, {
      reason,
      count: list.length,
      bytes: list.reduce((n, f) => n + (f.bytes || 0) + (f.output_bytes || 0), 0),
      files: list.slice(0, 50).map((f) => f.name),
    }, { ...ctx, sendingId });
  }
  return files.length;
}
