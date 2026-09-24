// Administrasjon: oversikt, logg, økter, brukere, jobber og test av xAI-tilkoblingen.
import { Hono } from "hono";
import grok from "../../src/grok.js";
import { config } from "../config.js";
import { one, all, run, batch, nowIso, isoAgo, parseJson, DAY_MS } from "../db.js";
import { logEvent, grokCallRow } from "../log.js";
import { fail, readJson, reqCtx, str } from "../http.js";
import {
  MIN_PASSWORD, requireAdmin, findUserByName, hashPassword, generatePassword, revokeUserSessions,
} from "../auth.js";
import { buildViews, jobView, estimatorParams } from "../jobs.js";

const USERNAME = /^[\p{L}\p{N}._@-]{1,64}$/u;
const TEST_API_EVERY_MS = 60000;

const limitOf = (value, fallback, max) => Math.min(max, Math.max(1, Math.floor(Number(value)) || fallback));
const likeArg = (q) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

function serializeEvent(e) {
  return {
    id: e.id,
    ts: e.ts,
    level: e.level,
    type: e.type,
    message: e.message,
    userId: e.user_id,
    username: e.username ?? null,
    sessionId: e.session_id,
    jobId: e.job_id,
    fileId: e.file_id,
    ip: e.ip,
    data: parseJson(e.data_json, null),
  };
}

function serializeUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || u.username,
    role: u.role,
    disabled: Boolean(u.disabled),
    mustChangePassword: Boolean(u.must_change_password),
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    activeSessions: u.active_sessions ?? 0,
  };
}

function serializeCall(g) {
  return {
    id: g.id,
    ts: g.ts,
    fileId: g.file_id,
    model: g.model,
    status: g.status,
    ok: Boolean(g.ok),
    attempt: g.attempt,
    items: g.items,
    inputChars: g.input_chars,
    outputChars: g.output_chars,
    ms: g.ms,
    inputTokens: g.input_tokens,
    outputTokens: g.output_tokens,
    reasoningTokens: g.reasoning_tokens,
    error: g.error,
  };
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const USER_SELECT = `SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?)
  AS active_sessions FROM users u`;

const loadUser = async (env, id) =>
  (await one(env, `${USER_SELECT} WHERE u.id = ?`, nowIso(), Number(id))) || fail(404, "Fant ikke brukeren.");

const admin = new Hono();
admin.use("*", requireAdmin);

admin.get("/overview", async (c) => {
  const env = c.env;
  const cfg = config(env);
  const now = nowIso();
  const since = isoAgo(DAY_MS);
  const [users, sessions, jobs, failed, calls, storage] = await batch(env, [
    ["SELECT COUNT(*) AS n FROM users"],
    ["SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?", now],
    ["SELECT COUNT(*) AS n FROM jobs WHERE queued_at > ?", since],
    ["SELECT COUNT(*) AS n FROM files WHERE status = 'failed' AND COALESCE(finished_at, created_at) > ?", since],
    [
      "SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM grok_calls WHERE ts > ?",
      since,
    ],
    [
      `SELECT COUNT(*) + COUNT(output_bytes) AS objects, COALESCE(SUM(bytes), 0) + COALESCE(SUM(output_bytes), 0) AS bytes
       FROM files WHERE deleted_at IS NULL AND plan_json IS NOT NULL`,
    ],
  ]);
  const first = (r) => r.results[0];
  const params = await estimatorParams(env, cfg.model);
  const finished = await all(
    env,
    `SELECT estimate_seconds, started_at, finished_at FROM jobs
     WHERE status = 'done' AND estimate_seconds > 0 AND started_at IS NOT NULL ORDER BY finished_at DESC LIMIT 50`
  );
  const errors = finished
    .map((j) => ({ est: j.estimate_seconds, actual: (Date.parse(j.finished_at) - Date.parse(j.started_at)) / 1000 }))
    .filter((j) => j.actual > 0)
    .map((j) => (100 * Math.abs(j.est - j.actual)) / j.actual);
  const mape = median(errors);
  return c.json({
    apiKeyConfigured: Boolean(env.XAI_API_KEY),
    model: cfg.model,
    users: first(users).n,
    activeSessions: first(sessions).n,
    jobs24h: first(jobs).n,
    failedFiles24h: first(failed).n,
    calls24h: first(calls).n,
    tokens24h: { input: first(calls).input, output: first(calls).output },
    storage: { objects: first(storage).objects, bytes: first(storage).bytes },
    estimator: {
      a: params.a,
      b: params.b,
      samples: params.samples,
      source: params.source,
      accuracy: { jobs: errors.length, medianAbsPctError: mape == null ? null : Math.round(mape) },
    },
  });
});

admin.get("/events", async (c) => {
  const q = c.req.query();
  const where = [];
  const args = [];
  if (q.level) {
    where.push("e.level = ?");
    args.push(q.level);
  }
  if (q.type) {
    // "auth." gir alle auth-hendelser
    where.push(q.type.endsWith(".") ? "e.type LIKE ? ESCAPE '\\'" : "e.type = ?");
    args.push(q.type.endsWith(".") ? `${q.type.replace(/[\\%_]/g, "\\$&")}%` : q.type);
  }
  if (q.userId) {
    where.push("e.user_id = ?");
    args.push(Number(q.userId));
  }
  if (q.jobId) {
    where.push("e.job_id = ?");
    args.push(q.jobId);
  }
  if (q.q) {
    where.push("(e.message LIKE ? ESCAPE '\\' OR e.data_json LIKE ? ESCAPE '\\' OR e.type LIKE ? ESCAPE '\\')");
    const like = likeArg(q.q.slice(0, 200));
    args.push(like, like, like);
  }
  if (q.beforeId) {
    where.push("e.id < ?");
    args.push(Number(q.beforeId));
  }
  const rows = await all(
    c.env,
    `SELECT e.*, u.username FROM events e LEFT JOIN users u ON u.id = e.user_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.id DESC LIMIT ?`,
    ...args, limitOf(q.limit, 100, 500)
  );
  return c.json({ events: rows.map(serializeEvent) });
});

admin.get("/sessions", async (c) => {
  const now = nowIso();
  const everything = c.req.query("all") === "1";
  const rows = await all(
    c.env,
    `SELECT s.*, u.username, u.display_name FROM sessions s LEFT JOIN users u ON u.id = s.user_id
     ${everything ? "" : "WHERE s.revoked_at IS NULL AND s.expires_at > ?"} ORDER BY s.last_seen_at DESC LIMIT 200`,
    ...(everything ? [] : [now])
  );
  const current = c.get("session").id;
  return c.json({
    sessions: rows.map((s) => ({
      idPrefix: s.id.slice(0, 8),
      userId: s.user_id,
      username: s.username,
      displayName: s.display_name || s.username,
      ip: s.ip,
      userAgent: s.user_agent,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      revokedAt: s.revoked_at,
      revokedReason: s.revoked_reason,
      active: !s.revoked_at && s.expires_at > now,
      current: s.id === current,
    })),
  });
});

admin.post("/sessions/:idPrefix/revoke", async (c) => {
  const prefix = c.req.param("idPrefix");
  if (!/^[0-9a-f]{8}$/.test(prefix)) fail(400, "Ugyldig økt.");
  const res = await run(
    c.env,
    "UPDATE sessions SET revoked_at = ?, revoked_reason = 'admin' WHERE substr(id, 1, 8) = ? AND revoked_at IS NULL",
    nowIso(), prefix
  );
  if (!res.meta.changes) fail(404, "Fant ingen aktiv økt med denne id-en.");
  await logEvent(c.env, "info", "session.revoked", "Økt avsluttet av administrator", { idPrefix: prefix }, reqCtx(c));
  return c.body(null, 204);
});

admin.get("/users", async (c) => {
  const rows = await all(c.env, `${USER_SELECT} ORDER BY u.username COLLATE NOCASE`, nowIso());
  return c.json({ users: rows.map(serializeUser) });
});

admin.post("/users", async (c) => {
  const env = c.env;
  const body = await readJson(c);
  const username = str(body.username, 100).trim();
  if (!USERNAME.test(username)) fail(400, "Brukernavnet kan bare ha bokstaver, tall og . _ - @ (1–64 tegn).");
  const role = body.role == null ? "user" : body.role;
  if (!["admin", "user"].includes(role)) fail(400, "Ugyldig rolle.");
  const displayName = str(body.displayName, 100).trim() || username;
  const generated = body.password == null || body.password === "";
  const password = generated ? generatePassword(14) : str(body.password, 500);
  if ([...password].length < MIN_PASSWORD) fail(400, `Passordet må ha minst ${MIN_PASSWORD} tegn.`);
  if (await findUserByName(env, username)) fail(409, "Brukernavnet er allerede i bruk.");
  const res = await run(
    env,
    "INSERT OR IGNORE INTO users (username, display_name, role, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    username, displayName, role, hashPassword(password), generated ? 1 : 0, nowIso()
  );
  if (!res.meta.changes) fail(409, "Brukernavnet er allerede i bruk.");
  const user = await loadUser(env, res.meta.last_row_id);
  await logEvent(env, "info", "user.created", `Bruker ${username} opprettet`, { username, role, generated }, reqCtx(c));
  return c.json({ user: serializeUser(user), password }, 201);
});

admin.patch("/users/:id", async (c) => {
  const env = c.env;
  const target = await loadUser(env, c.req.param("id"));
  const body = await readJson(c);
  const me = c.get("user");
  const changes = {};
  if (body.displayName !== undefined) changes.display_name = str(body.displayName, 100).trim() || target.username;
  if (body.role !== undefined) {
    if (!["admin", "user"].includes(body.role)) fail(400, "Ugyldig rolle.");
    if (target.id === me.id && body.role !== "admin") fail(400, "Du kan ikke fjerne din egen administratortilgang.");
    changes.role = body.role;
  }
  if (body.disabled !== undefined) {
    if (target.id === me.id && body.disabled) fail(400, "Du kan ikke deaktivere din egen konto.");
    changes.disabled = body.disabled ? 1 : 0;
  }
  const cols = Object.keys(changes);
  if (!cols.length) fail(400, "Ingen endringer å lagre.");
  await run(env, `UPDATE users SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...Object.values(changes), target.id);
  if (changes.disabled) await revokeUserSessions(env, target.id, "disabled");
  await logEvent(env, "info", "user.updated", `Bruker ${target.username} endret`, { username: target.username, changes }, reqCtx(c));
  return c.json({ user: serializeUser(await loadUser(env, target.id)) });
});

admin.post("/users/:id/reset-password", async (c) => {
  const env = c.env;
  const target = await loadUser(env, c.req.param("id"));
  const password = generatePassword(14);
  await run(env, "UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?", hashPassword(password), target.id);
  const keep = target.id === c.get("user").id ? c.get("session").id : null;
  await revokeUserSessions(env, target.id, "password_reset", keep);
  await logEvent(env, "info", "user.password_reset", `Nytt passord for ${target.username}`, { username: target.username }, reqCtx(c));
  return c.json({ password });
});

admin.get("/jobs", async (c) => {
  const userId = c.req.query("userId");
  const rows = await all(
    c.env,
    `SELECT j.*, u.username FROM jobs j LEFT JOIN users u ON u.id = j.user_id
     ${userId ? "WHERE j.user_id = ?" : ""} ORDER BY j.created_at DESC LIMIT ?`,
    ...(userId ? [Number(userId)] : []), limitOf(c.req.query("limit"), 50, 90)
  );
  return c.json({ jobs: (await buildViews(c.env, rows, { admin: true })).map((v) => v.job) });
});

admin.get("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const view = await jobView(c.env, id, { admin: true });
  const events = await all(
    c.env,
    "SELECT e.*, u.username FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.job_id = ? ORDER BY e.id LIMIT 1000",
    id
  );
  const calls = await all(c.env, "SELECT * FROM grok_calls WHERE job_id = ? ORDER BY id LIMIT 2000", id);
  return c.json({ ...view, events: events.map(serializeEvent), calls: calls.map(serializeCall) });
});

admin.post("/test-api", async (c) => {
  const env = c.env;
  const cfg = config(env);
  const recent = await one(env, "SELECT COUNT(*) AS n FROM events WHERE type = 'admin.test_api' AND ts > ?", isoAgo(TEST_API_EVERY_MS));
  if (recent.n) fail(429, "Vent ett minutt før du tester igjen.");
  const rows = [];
  const t0 = Date.now();
  let result;
  try {
    const r = await grok.testConnection({
      apiKey: env.XAI_API_KEY,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      onCall: (call) => rows.push(grokCallRow({ model: cfg.model }, call).statement),
    });
    result = { ok: true, ms: r.ms, sample: r.sample };
  } catch (err) {
    result = { ok: false, ms: Date.now() - t0, error: err.message };
  }
  if (rows.length) await batch(env, rows);
  await logEvent(env, result.ok ? "info" : "error", "admin.test_api", result.ok ? "API-tilkoblingen virker" : "API-testen feilet", result, reqCtx(c));
  return c.json(result);
});

export default admin;
