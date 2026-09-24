// Agent-API for Mac-en: livstegn + kø, ta en fil (lease), hent original, meld fremdrift, lever resultat,
// meld feil eller gi filen tilbake, og send logglinjer. Autentisering: Authorization: Bearer <AGENT_TOKEN>.
import { Hono } from "hono";
import { one, batch, nowIso, isoAgo } from "../db.js";
import { logEvent, LEVELS } from "../log.js";
import { fail, readJson, clientIp, str, clamp } from "../http.js";
import { requireAgent } from "../auth.js";
import { pushToAdmins } from "../apns.js";
import { r2Key, download } from "../files.js";
import { isAgentOnline, saveResult, finishIfDone } from "../sendings.js";

const STATES = ["idle", "working", "error"];
const DEFAULT_LEASE_S = 900;
const MAX_QUEUE = 20;
const LOG_PER_MINUTE = 120;
const NOT_WORKING = "Filen er ikke lenger i arbeid.";

const leaseUntil = (seconds) => new Date(Date.now() + clamp(seconds, 60, 3600, DEFAULT_LEASE_S) * 1000).toISOString();
const agentCtx = (c, f = {}) => ({ source: "agent", ip: clientIp(c), sendingId: f.sending_id, fileId: f.id });

async function agentFile(c) {
  return (await one(c.env, "SELECT * FROM files WHERE id = ? AND deleted_at IS NULL", c.req.param("id"))) || fail(404, "Fant ikke filen.");
}

const agent = new Hono();
agent.use("*", requireAgent);

agent.post("/poll", async (c) => {
  const env = c.env;
  const body = await readJson(c, { optional: true });
  const now = nowIso();
  const beat = {
    host: str(body.host, 100) || null,
    version: str(body.version, 50) || null,
    state: STATES.includes(body.state) ? body.state : "idle",
    stateMessage: str(body.stateMessage, 500) || null,
  };
  const [prev, , queue] = await batch(env, [
    ["SELECT * FROM agent WHERE id = 1"],
    [
      `UPDATE agent SET last_seen_at = ?, host = ?, version = ?, state = ?, state_message = ?, grok_ok = ?,
         offline_alert_sent_at = NULL WHERE id = 1`,
      now, beat.host, beat.version, beat.state, beat.stateMessage, body.grokOk == null ? null : body.grokOk ? 1 : 0,
    ],
    [
      `SELECT f.id, f.sending_id, f.name, f.rel_path, f.ext, f.bytes, s.target_language, s.note, u.username, u.display_name
       FROM files f JOIN sendings s ON s.id = f.sending_id JOIN users u ON u.id = s.user_id
       WHERE f.deleted_at IS NULL AND (f.status = 'sent' OR (f.status = 'working' AND f.lease_until < ?))
       ORDER BY s.sent_at, f.rel_path LIMIT ?`,
      now, MAX_QUEUE,
    ],
  ]);
  const before = prev.results[0];
  const ctx = agentCtx(c);
  if (!isAgentOnline(before)) {
    const message = before.last_seen_at ? `Mac-en er tilbake (${beat.host || "ukjent maskin"})` : `Mac-en meldte seg for første gang (${beat.host || "ukjent maskin"})`;
    await logEvent(env, "info", "agent.online", message, { ...beat, offlineSince: before.last_seen_at }, ctx);
  }
  if (before.state !== beat.state && (beat.state === "error" || before.state === "error")) {
    await logEvent(env, beat.state === "error" ? "warn" : "info", "agent.state", beat.stateMessage || `Agenten er ${beat.state}`, {
      state: beat.state, previous: before.state,
    }, ctx);
  }
  return c.json({
    files: queue.results.map((f) => ({
      id: f.id,
      sendingId: f.sending_id,
      name: f.name,
      relPath: f.rel_path,
      ext: f.ext,
      bytes: f.bytes,
      targetLanguage: f.target_language,
      note: f.note,
      username: f.username,
      displayName: f.display_name || f.username,
    })),
  });
});

agent.post("/files/:id/claim", async (c) => {
  const body = await readJson(c, { optional: true });
  const now = nowIso();
  const row = await one(
    c.env,
    `UPDATE files SET status = 'working', started_at = ?, lease_until = ?, attempts = COALESCE(attempts, 0) + 1,
       progress_percent = NULL, eta_seconds = NULL, progress_at = NULL, message = NULL, error = NULL, error_details = NULL
     WHERE id = ? AND deleted_at IS NULL AND (status = 'sent' OR (status = 'working' AND lease_until < ?)) RETURNING *`,
    now, leaseUntil(body.leaseSeconds), c.req.param("id"), now
  );
  if (!row) fail(409, "Filen er allerede tatt, eller ikke lenger i kø.");
  await logEvent(c.env, "info", "file.claimed", `Mac-en begynner på ${row.name}`, { attempt: row.attempts, leaseUntil: row.lease_until }, agentCtx(c, row));
  return c.json({ ok: true });
});

agent.get("/files/:id/original", async (c) => {
  const f = await agentFile(c);
  return download(c.env, r2Key(f.sending_id, f.id, "original"), f.name);
});

agent.post("/files/:id/progress", async (c) => {
  const body = await readJson(c);
  const res = await one(
    c.env,
    `UPDATE files SET progress_percent = ?, eta_seconds = ?, progress_at = ?, message = COALESCE(?, message), lease_until = ?
     WHERE id = ? AND deleted_at IS NULL AND status = 'working' RETURNING id`,
    clamp(body.percent, 0, 100, null), clamp(body.etaSeconds, 0, 7 * 86400, null), nowIso(), str(body.message, 300) || null,
    leaseUntil(body.leaseSeconds), c.req.param("id")
  );
  if (!res) fail(409, NOT_WORKING);
  return c.json({ ok: true });
});

agent.put("/files/:id/result", async (c) => {
  const f = await agentFile(c);
  if (!["sent", "working"].includes(f.status)) fail(409, NOT_WORKING);
  await saveResult(c, f, { source: "agent", costUsd: clamp(c.req.query("costUsd"), 0, 1000, null), ctx: agentCtx(c, f) });
  return c.json({ ok: true });
});

agent.post("/files/:id/fail", async (c) => {
  const env = c.env;
  const body = await readJson(c);
  const message = str(body.message, 1000) || "Ukjent feil";
  const details = str(body.details, 20000) || null;
  const row = await one(
    env,
    `UPDATE files SET status = 'failed', error = ?, error_details = ?, cost_usd = COALESCE(?, cost_usd), finished_at = ?,
       lease_until = NULL, message = NULL
     WHERE id = ? AND deleted_at IS NULL AND status IN ('sent', 'working') RETURNING *`,
    message, details, clamp(body.costUsd, 0, 1000, null), nowIso(), c.req.param("id")
  );
  if (!row) fail(409, NOT_WORKING);
  const ctx = agentCtx(c, row);
  await logEvent(env, "error", "file.failed", `Kunne ikke oversette ${row.name}: ${message}`, {
    message, details: details && details.slice(0, 4000), attempts: row.attempts,
  }, ctx);
  c.executionCtx.waitUntil(pushToAdmins(env, { title: `Kunne ikke oversette ${row.name}`, body: message.slice(0, 180), sendingId: row.sending_id }, ctx));
  await finishIfDone(env, row.sending_id, ctx);
  return c.json({ ok: true });
});

// Problemet er hos agenten (f.eks. Grok CLI ikke logget inn): filen går tilbake i køen, og forsøket telles ikke.
agent.post("/files/:id/release", async (c) => {
  const body = await readJson(c, { optional: true });
  const row = await one(
    c.env,
    `UPDATE files SET status = 'sent', lease_until = NULL, started_at = NULL, progress_percent = NULL, eta_seconds = NULL,
       progress_at = NULL, message = NULL, attempts = MAX(COALESCE(attempts, 1) - 1, 0)
     WHERE id = ? AND deleted_at IS NULL AND status = 'working' RETURNING *`,
    c.req.param("id")
  );
  if (!row) fail(409, NOT_WORKING);
  const reason = str(body.reason, 500) || "uten begrunnelse";
  await logEvent(c.env, "warn", "file.released", `Mac-en ga tilbake ${row.name}: ${reason}`, { reason }, agentCtx(c, row));
  return c.json({ ok: true });
});

agent.post("/log", async (c) => {
  const env = c.env;
  const body = await readJson(c);
  const recent = await one(env, "SELECT COUNT(*) AS n FROM events WHERE source = 'agent' AND ts > ?", isoAgo(60000));
  if (recent.n >= LOG_PER_MINUTE) fail(429, "For mange loggmeldinger. Prøv igjen om litt.");
  const type = typeof body.type === "string" && /^[a-z][a-z0-9_.-]{0,63}$/i.test(body.type) ? body.type : "agent.log";
  const json = body.data === undefined ? "" : JSON.stringify(body.data);
  const data = json.length > 8000 ? { truncated: json.slice(0, 8000) } : body.data;
  await logEvent(env, LEVELS.includes(body.level) ? body.level : "info", type, str(body.message, 1000) || type, data, {
    ...agentCtx(c),
    sendingId: str(body.sendingId, 32) || null,
    fileId: str(body.fileId, 32) || null,
  });
  return c.body(null, 204);
});

export default agent;
