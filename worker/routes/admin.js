// Eierens admin: oversikt (xAI-forbruk, kø, lagring, estimatmodell), sendinger med Grok-kall, manuell opplasting,
// sett i kø igjen, test av xAI, logg, økter, brukere og iPhone-enheter.
import { Hono } from "hono";
import grok from "../../src/grok.js";
import { config } from "../config.js";
import { one, all, run, batch, nowIso, isoAgo, parseJson, DAY_MS } from "../db.js";
import { logEvent, LEVELS } from "../log.js";
import { fail, readJson, reqCtx, str, clamp } from "../http.js";
import { USERNAME, requireAdmin, findUserByName, newSecret, normalizeUsername, revokeUserSessions } from "../auth.js";
import { pushToUser } from "../apns.js";
import { baseName, sanitizePath, r2Key, contentLength, sizeProblem, putBody } from "../files.js";
import { listSendings, loadFile, markDone, finishIfDone, sendingView, startWorkflow } from "../sendings.js";
import { costUsd, estimatorParams, grokOptions, recordCall } from "../xai.js";

const SOURCES = ["web", "ios", "system"];
// Oversettelser kan bli større enn originalen (PDF → Word).
const RESULT_MAX_MB = 100;
const ROLES = ["admin", "user"];
const likeArg = (q) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

// Midnatt i dag, norsk tid, som ISO (UTC). Bruker dagens UTC-avvik (bommer med en time de to natta sommertid skifter).
function osloMidnight() {
  const format = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", timeZoneName: "longOffset",
  });
  const p = Object.fromEntries(format.formatToParts(new Date()).map((part) => [part.type, part.value]));
  return new Date(`${p.year}-${p.month}-${p.day}T00:00:00${p.timeZoneName.replace("GMT", "") || "Z"}`).toISOString();
}

function serializeEvent(e) {
  return {
    id: e.id,
    ts: e.ts,
    level: e.level,
    type: e.type,
    message: e.message,
    source: e.source,
    userId: e.user_id,
    username: e.username ?? null,
    sessionId: e.session_id,
    sendingId: e.sending_id,
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

function serializeDevice(d) {
  return {
    token: d.token,
    env: d.env,
    name: d.name,
    userId: d.user_id,
    username: d.username ?? null,
    createdAt: d.created_at,
    lastOkAt: d.last_ok_at,
    disabledAt: d.disabled_at,
    lastError: d.last_error,
  };
}

function serializeCall(env, r) {
  return {
    id: r.id,
    ts: r.ts,
    model: r.model,
    status: r.status,
    ok: Boolean(r.ok),
    attempt: r.attempt,
    items: r.items,
    inputChars: r.input_chars,
    outputChars: r.output_chars,
    ms: r.ms,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    reasoningTokens: r.reasoning_tokens,
    costUsd: costUsd(env, r.input_tokens, r.output_tokens),
    error: r.error,
  };
}

const USER_SELECT = `SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?)
  AS active_sessions FROM users u`;
const DEVICE_SELECT = "SELECT d.*, u.username FROM devices d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.created_at";

const loadUser = async (env, id) =>
  (await one(env, `${USER_SELECT} WHERE u.id = ?`, nowIso(), Number(id))) || fail(404, "Fant ikke brukeren.");

const admin = new Hono();
admin.use("*", requireAdmin);

admin.get("/overview", async (c) => {
  const env = c.env;
  const [counts, storage, devices, users, usage, lastCall, lastError] = await batch(env, [
    [
      `SELECT COALESCE(SUM(status = 'sent'), 0) AS waiting, COALESCE(SUM(status = 'working'), 0) AS working,
         COALESCE(SUM(status = 'done' AND finished_at >= ?), 0) AS doneToday, COALESCE(SUM(status = 'failed'), 0) AS failed
       FROM files WHERE deleted_at IS NULL`,
      osloMidnight(),
    ],
    [
      `SELECT COUNT(*) + COUNT(output_bytes) AS files, COALESCE(SUM(bytes), 0) + COALESCE(SUM(output_bytes), 0) AS bytes
       FROM files WHERE deleted_at IS NULL`,
    ],
    [DEVICE_SELECT],
    ["SELECT COUNT(*) AS n FROM users"],
    [
      `SELECT COUNT(*) AS calls, COALESCE(SUM(ok = 0), 0) AS failed, COALESCE(SUM(input_tokens), 0) AS input,
         COALESCE(SUM(output_tokens), 0) AS output FROM grok_calls WHERE ts >= ?`,
      isoAgo(DAY_MS),
    ],
    ["SELECT MAX(ts) AS ts FROM grok_calls"],
    ["SELECT ts, error FROM grok_calls WHERE ok = 0 ORDER BY id DESC LIMIT 1"],
  ]);
  const day = usage.results[0];
  const error = lastError.results[0];
  const params = await estimatorParams(env);
  return c.json({
    translator: {
      apiKeyConfigured: Boolean(env.XAI_API_KEY),
      model: config(env).model,
      calls24h: day.calls,
      failedCalls24h: day.failed,
      tokens24h: { input: day.input, output: day.output },
      cost24h: costUsd(env, day.input, day.output),
      lastCallAt: lastCall.results[0].ts,
      lastError: error ? error.error : null,
      lastErrorAt: error ? error.ts : null,
    },
    counts: counts.results[0],
    storage: storage.results[0],
    devices: devices.results.map(serializeDevice),
    users: users.results[0].n,
    estimator: { a: Number(params.a.toFixed(2)), b: Number(params.b.toFixed(5)), samples: params.samples, source: params.source },
  });
});

admin.get("/sendings", async (c) =>
  c.json(await listSendings(c.env, { limit: clamp(c.req.query("limit"), 1, 200, 50), admin: true })));

const notSentYet = (f) => f.status === "draft" || f.sending_status === "draft";

admin.put("/files/:fileId/result", async (c) => {
  const env = c.env;
  const f = await loadFile(c, c.req.param("fileId"));
  if (notSentYet(f)) fail(409, "Filen er ikke sendt ennå.");
  const name = baseName(sanitizePath(c.req.query("name")));
  if (!name) fail(400, "Filnavnet på oversettelsen mangler.");
  const problem = sizeProblem(contentLength(c), RESULT_MAX_MB * 1024 * 1024, `Oversettelsen er for stor (maks ${RESULT_MAX_MB} MB).`);
  if (problem) fail(...problem);
  const ctx = reqCtx(c, { sendingId: f.sending_id, fileId: f.id });
  const bytes = await putBody(c, r2Key(f.sending_id, f.id, "result"), name, ctx);
  if (!(await markDone(env, f, { name, bytes, source: "manual", ctx }))) fail(410, "Sendingen er slettet.");
  await finishIfDone(env, f.sending_id, ctx);
  return c.json({ sending: await sendingView(env, f.sending_id, true) });
});

// «sent» = sett i kø igjen: en ny Workflow-instans tar filen (mellomlagrede batcher gjenbrukes).
// message er en valgfri tekst Svetlana ser (brukes for «failed»).
admin.post("/files/:fileId/status", async (c) => {
  const env = c.env;
  const f = await loadFile(c, c.req.param("fileId"));
  const body = await readJson(c);
  const message = str(body.message, 1000).trim() || null;
  const now = nowIso();
  const change = {
    sent: [`status = 'sent', workflow_id = NULL, started_at = NULL, finished_at = NULL, progress_percent = NULL, eta_seconds = NULL,
      progress_at = NULL, error = NULL, error_details = NULL`, []],
    failed: ["status = 'failed', finished_at = ?", [now]],
    done: ["status = 'done', finished_at = COALESCE(finished_at, ?)", [now]],
  }[body.status];
  if (!change) fail(400, "Ugyldig status.");
  if (notSentYet(f)) fail(409, "Filen er ikke sendt ennå.");
  if (body.status === "done" && !f.output_name) fail(409, "Filen har ingen oversettelse ennå. Last opp en først.");
  if (body.status === "sent" && !env.XAI_API_KEY) fail(503, "XAI_API_KEY er ikke satt på serveren (npx wrangler secret put XAI_API_KEY).");
  const [assignments, args] = change;
  await run(env, `UPDATE files SET ${assignments}, message = ? WHERE id = ?`, ...args, message, f.id);
  const ctx = reqCtx(c, { sendingId: f.sending_id, fileId: f.id });
  await logEvent(env, "info", "file.status_changed", `${f.name}: ${f.status} → ${body.status}`, { from: f.status, to: body.status, message }, ctx);
  await finishIfDone(env, f.sending_id, ctx);
  if (body.status === "sent") {
    try {
      await startWorkflow(env, f.sending_id, f.sending_workflow_id);
    } catch (err) {
      await run(env, "UPDATE files SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'sent'",
        `Oversettelsen kunne ikke startes: ${err.message}`, nowIso(), f.id);
      await finishIfDone(env, f.sending_id, ctx);
      fail(503, "Oversettelsen kunne ikke startes akkurat nå. Prøv igjen om litt.");
    }
  }
  return c.json({ sending: await sendingView(env, f.sending_id, true) });
});

admin.get("/files/:fileId/calls", async (c) => {
  const f = await loadFile(c, c.req.param("fileId"));
  const rows = await all(c.env, "SELECT * FROM grok_calls WHERE file_id = ? ORDER BY id DESC LIMIT 200", f.id);
  return c.json({ calls: rows.map((r) => serializeCall(c.env, r)) });
});

// Ett lite kall mot xAI med serverens nøkkel (maks ett i minuttet). Kallet havner i grok_calls som alle andre.
admin.post("/test-api", async (c) => {
  const env = c.env;
  const recent = await one(env, "SELECT COUNT(*) AS n FROM events WHERE type = 'admin.test_api' AND ts > ?", isoAgo(60000));
  if (recent.n) fail(429, "Vent et minutt før du tester igjen.");
  const started = Date.now();
  const calls = [];
  let result;
  try {
    if (!env.XAI_API_KEY) throw new Error("XAI_API_KEY er ikke satt på serveren (npx wrangler secret put XAI_API_KEY).");
    const { ms, sample } = await grok.testConnection(grokOptions(env, { onCall: (info) => calls.push(recordCall(env, {}, info)) }));
    result = { ok: true, ms, sample };
  } catch (err) {
    result = { ok: false, ms: Date.now() - started, error: err.message };
  }
  await Promise.allSettled(calls);
  await logEvent(env, result.ok ? "info" : "warn", "admin.test_api",
    result.ok ? `xAI svarte på ${result.ms} ms` : `Test av xAI feilet: ${result.error}`, { ...result, model: config(env).model }, reqCtx(c));
  return c.json(result);
});

admin.post("/sendings/:id/reply", async (c) => {
  const env = c.env;
  const id = c.req.param("id");
  const reply = str((await readJson(c)).reply, 2000).trim() || null;
  const res = await run(env, "UPDATE sendings SET reply = ? WHERE id = ? AND deleted_at IS NULL", reply, id);
  if (!res.meta.changes) fail(404, "Fant ikke sendingen.");
  await logEvent(env, "info", "sending.reply", reply ? "Svar til avsenderen lagret" : "Svaret ble fjernet", { length: reply ? reply.length : 0 }, reqCtx(c, { sendingId: id }));
  return c.json({ sending: await sendingView(env, id, true) });
});

admin.get("/events", async (c) => {
  const q = c.req.query();
  const where = [];
  const args = [];
  const add = (sql, ...values) => {
    where.push(sql);
    args.push(...values);
  };
  if (LEVELS.includes(q.level)) add("e.level = ?", q.level);
  if (SOURCES.includes(q.source)) add("e.source = ?", q.source);
  // «auth.» gir alle auth-hendelser.
  if (q.type) {
    if (q.type.endsWith(".")) add("e.type LIKE ? ESCAPE '\\'", `${q.type.replace(/[\\%_]/g, "\\$&")}%`);
    else add("e.type = ?", q.type);
  }
  if (q.sendingId) add("e.sending_id = ?", q.sendingId);
  if (q.q) {
    const like = likeArg(q.q.slice(0, 200));
    add("(e.message LIKE ? ESCAPE '\\' OR e.data_json LIKE ? ESCAPE '\\' OR e.type LIKE ? ESCAPE '\\')", like, like, like);
  }
  if (q.beforeId) add("e.id < ?", Number(q.beforeId));
  const limit = clamp(q.limit, 1, 500, 100);
  const rows = await all(
    c.env,
    `SELECT e.*, u.username FROM events e LEFT JOIN users u ON u.id = e.user_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.id DESC LIMIT ?`,
    ...args, limit
  );
  return c.json({ events: rows.map(serializeEvent), nextBeforeId: rows.length === limit ? rows[rows.length - 1].id : null });
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
  const username = normalizeUsername(body.username);
  if (!USERNAME.test(username)) fail(400, "Brukernavnet kan bare ha bokstaver, tall og . _ - @ (1–64 tegn).");
  const role = body.role ?? "user";
  if (!ROLES.includes(role)) fail(400, "Ugyldig rolle.");
  const displayName = str(body.displayName, 100).trim() || username;
  const secret = newSecret(body);
  const mustChange = body.mustChangePassword === false ? 0 : 1;
  if (await findUserByName(env, username)) fail(409, "Brukernavnet er allerede i bruk.");
  const res = await run(
    env,
    `INSERT OR IGNORE INTO users (username, display_name, role, salt, iterations, verifier, must_change_password, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    username, displayName, role, secret.salt, secret.iterations, secret.verifier, mustChange, nowIso()
  );
  if (!res.meta.changes) fail(409, "Brukernavnet er allerede i bruk.");
  await logEvent(env, "info", "user.created", `Bruker ${username} opprettet`, { username, role, mustChangePassword: Boolean(mustChange) }, reqCtx(c));
  return c.json({ user: serializeUser(await loadUser(env, res.meta.last_row_id)) }, 201);
});

admin.patch("/users/:id", async (c) => {
  const env = c.env;
  const target = await loadUser(env, c.req.param("id"));
  const body = await readJson(c);
  const me = c.get("user");
  const changes = {};
  if (body.displayName !== undefined) changes.display_name = str(body.displayName, 100).trim() || target.username;
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) fail(400, "Ugyldig rolle.");
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

// Nytt passord laget i nettleseren (vises én gang der); bare salt og bevis kommer hit.
admin.post("/users/:id/password", async (c) => {
  const env = c.env;
  const target = await loadUser(env, c.req.param("id"));
  const body = await readJson(c);
  const secret = newSecret(body);
  await run(
    env,
    "UPDATE users SET salt = ?, iterations = ?, verifier = ?, must_change_password = ? WHERE id = ?",
    secret.salt, secret.iterations, secret.verifier, body.mustChangePassword === false ? 0 : 1, target.id
  );
  const keep = target.id === c.get("user").id ? c.get("session").id : null;
  await revokeUserSessions(env, target.id, "password_reset", keep);
  await logEvent(env, "info", "user.password_reset", `Nytt passord for ${target.username}`, { username: target.username }, reqCtx(c));
  return c.json({ user: serializeUser(await loadUser(env, target.id)) });
});

admin.get("/devices", async (c) => c.json({ devices: (await all(c.env, DEVICE_SELECT)).map(serializeDevice) }));

admin.post("/devices", async (c) => {
  const env = c.env;
  const body = await readJson(c);
  const token = str(body.token, 300).trim().toLowerCase();
  if (!/^[0-9a-f]{32,256}$/.test(token)) fail(400, "Ugyldig enhetstoken.");
  if (!["sandbox", "production"].includes(body.env)) fail(400, "Ugyldig miljø (sandbox eller production).");
  const name = str(body.name, 100).trim() || null;
  const me = c.get("user");
  await run(
    env,
    `INSERT INTO devices (token, user_id, env, name, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, env = excluded.env, name = excluded.name,
       disabled_at = NULL, last_error = NULL`,
    token, me.id, body.env, name, nowIso()
  );
  await logEvent(env, "info", "device.registered", `${name || "iPhone"} er registrert for push`, { device: token.slice(0, 8), env: body.env, name }, reqCtx(c));
  const device = await one(env, "SELECT d.*, u.username FROM devices d LEFT JOIN users u ON u.id = d.user_id WHERE d.token = ?", token);
  return c.json({ device: serializeDevice(device) });
});

admin.delete("/devices/:token", async (c) => {
  const token = c.req.param("token").toLowerCase();
  const res = await run(c.env, "DELETE FROM devices WHERE token = ?", token);
  if (!res.meta.changes) fail(404, "Fant ikke enheten.");
  await logEvent(c.env, "info", "device.deleted", "Enhet fjernet fra push", { device: token.slice(0, 8) }, reqCtx(c));
  return c.body(null, 204);
});

admin.post("/test-push", async (c) => {
  const me = c.get("user");
  const ctx = reqCtx(c);
  const result = await pushToUser(c.env, me.id, { title: "Testvarsel fra InnNorsk", body: "Varslene virker. Du får beskjed når det kommer nye filer." }, ctx);
  if (!result.sent && !result.failed) result.errors.push("Ingen iPhone er registrert ennå. Åpne InnNorsk-appen og logg inn.");
  await logEvent(c.env, result.sent ? "info" : "warn", "admin.test_push", `Testvarsel: ${result.sent} sendt, ${result.failed} feilet`, result, ctx);
  return c.json(result);
});

export default admin;
