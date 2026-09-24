// Sendinger og filer: tilgang, visning (JSON for nettsiden, iPhone og admin) og statusen som følger filene.
import { one, batch, nowIso, isoAgo, DAY_MS } from "./db.js";
import { fail } from "./http.js";
import { logEvent } from "./log.js";
import { baseName, sanitizePath, r2Key, contentLength, sizeProblem, putBody } from "./files.js";

const AGENT_ONLINE_MS = 3 * 60000;
// Oversettelser kan bli større enn originalen (PDF → Word); 100 MB er grensen for én forespørsel på Free-planen.
const RESULT_MAX_MB = 100;

// «1 fil» / «3 filer».
export const filesText = (n) => (n === 1 ? "1 fil" : `${n} filer`);

export const isAgentOnline = (agent) =>
  Boolean(agent && agent.last_seen_at && Date.now() - Date.parse(agent.last_seen_at) < AGENT_ONLINE_MS);

// Samme format som formatDuration i web/js/api.js: «under 1 min», «ca. 3 min», «ca. 1 t 5 min».
export function formatDuration(seconds) {
  if (seconds < 60) return "under 1 min";
  const min = Math.round(seconds / 60);
  if (min < 60) return `ca. ${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `ca. ${h} t ${min % 60} min` : `ca. ${h} t`;
}

// Gjenstående tid regnes fra da agenten sist meldte fremdrift.
function remainingSeconds(f) {
  if (f.eta_seconds == null) return null;
  return Math.max(0, f.eta_seconds - Math.max(0, (Date.now() - Date.parse(f.progress_at)) / 1000));
}

export function statusText(f, agentOnline) {
  switch (f.status) {
    case "draft":
      return "Ikke sendt ennå";
    case "sent":
      return agentOnline ? "Mottatt – oversettes snart" : "Mottatt – oversettelsen starter når oversetteren er klar";
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
      return f.message || "Oversetteren ser på denne filen";
  }
}

export function serializeFile(f, agentOnline, admin = false) {
  const view = {
    id: f.id,
    sendingId: f.sending_id,
    path: f.rel_path,
    name: f.name,
    ext: f.ext,
    bytes: f.bytes,
    status: f.status,
    statusText: statusText(f, agentOnline),
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
    costUsd: f.cost_usd,
    outputSource: f.output_source,
    leaseUntil: f.lease_until,
  };
}

function serializeSending(s, files, agentOnline, admin = false) {
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
    finishedAt: s.finished_at,
    agentOnline,
    files: files.map((f) => serializeFile(f, agentOnline, admin)),
    counts: { total: files.length, waiting: count("draft", "sent"), working: count("working"), done: count("done"), failed: count("failed") },
  };
}

// Sendinger med filer og agentstatus i én rundtur. userId = null gir alle brukeres (admin).
export async function listSendings(env, { userId = null, limit = 50, admin = false } = {}) {
  const where = `s.deleted_at IS NULL AND NOT (s.status = 'draft' AND s.created_at < ?)${userId == null ? "" : " AND s.user_id = ?"}`;
  const args = [isoAgo(DAY_MS), ...(userId == null ? [] : [userId]), limit];
  const [sendings, files, agent] = await batch(env, [
    [`SELECT s.*, u.username, u.display_name FROM sendings s LEFT JOIN users u ON u.id = s.user_id
      WHERE ${where} ORDER BY s.created_at DESC LIMIT ?`, ...args],
    [`SELECT * FROM files WHERE deleted_at IS NULL AND sending_id IN
      (SELECT s.id FROM sendings s WHERE ${where} ORDER BY s.created_at DESC LIMIT ?) ORDER BY rel_path`, ...args],
    ["SELECT * FROM agent WHERE id = 1"],
  ]);
  const online = isAgentOnline(agent.results[0]);
  const bySending = Map.groupBy(files.results, (f) => f.sending_id);
  return {
    agentOnline: online,
    sendings: sendings.results.map((s) => serializeSending(s, bySending.get(s.id) || [], online, admin)),
  };
}

export async function sendingView(env, id, admin = false) {
  const [sendings, files, agent] = await batch(env, [
    ["SELECT s.*, u.username, u.display_name FROM sendings s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?", id],
    ["SELECT * FROM files WHERE sending_id = ? AND deleted_at IS NULL ORDER BY rel_path", id],
    ["SELECT * FROM agent WHERE id = 1"],
  ]);
  return serializeSending(sendings.results[0], files.results, isAgentOnline(agent.results[0]), admin);
}

// Egen sending, eller (bare lesing) hvilken som helst for admin. Andres sendinger finnes ikke (404).
export async function loadSending(c, id, { write = false } = {}) {
  const user = c.get("user");
  const s = await one(c.env, "SELECT * FROM sendings WHERE id = ? AND deleted_at IS NULL", id);
  if (!s || (s.user_id !== user.id && (write || user.role !== "admin"))) fail(404, "Fant ikke sendingen.");
  return s;
}

// Fil med sendingens eier; admin ser alle, brukeren bare sine egne.
export async function loadFile(c, fileId) {
  const user = c.get("user");
  const f = await one(
    c.env,
    `SELECT f.*, s.user_id FROM files f JOIN sendings s ON s.id = f.sending_id
     WHERE f.id = ? AND f.deleted_at IS NULL AND s.deleted_at IS NULL`,
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

// Lagrer en ferdig oversettelse (fra agenten eller lastet opp av admin) og markerer filen som ferdig.
// Kroppen strømmes rett til R2. ctx er loggkonteksten.
export async function saveResult(c, f, { source, costUsd = null, ctx }) {
  const env = c.env;
  const name = baseName(sanitizePath(c.req.query("name")));
  if (!name) fail(400, "Filnavnet på oversettelsen mangler.");
  const problem = sizeProblem(contentLength(c), RESULT_MAX_MB * 1024 * 1024, `Oversettelsen er for stor (maks ${RESULT_MAX_MB} MB).`);
  if (problem) fail(...problem);
  const key = r2Key(f.sending_id, f.id, "result");
  const bytes = await putBody(c, key, name, ctx);
  const row = await one(
    env,
    `UPDATE files SET status = 'done', output_name = ?, output_bytes = ?, output_source = ?, cost_usd = COALESCE(?, cost_usd),
       finished_at = ?, lease_until = NULL, error = NULL, error_details = NULL
     WHERE id = ? AND deleted_at IS NULL RETURNING *`,
    name, bytes, source, costUsd, nowIso(), f.id
  );
  if (!row) {
    await env.FILES.delete(key);
    fail(410, "Sendingen er slettet.");
  }
  const seconds = row.started_at ? Math.round((Date.parse(row.finished_at) - Date.parse(row.started_at)) / 1000) : null;
  await logEvent(env, "info", "file.done", `${row.name} er oversatt`, { output: name, bytes, costUsd, source, seconds }, ctx);
  await finishIfDone(env, row.sending_id, ctx);
}

export async function finishIfDone(env, sendingId, ctx) {
  if (await syncSending(env, sendingId)) {
    await logEvent(env, "info", "sending.done", "Alle filene i sendingen er ferdige", null, { ...ctx, sendingId });
  }
}
