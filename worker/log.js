// Hendelseslogg: én rad i D1 (admin-UI) + én JSON-linje i Workers Logs.
// Alt vaskes for hemmeligheter før det skrives noe sted.
import { nowIso } from "./db.js";

const SECRET_KEY = /pass|token|secret|key|authorization|cookie/i;
const COUNTER_KEY = /tokens$|configured$/i; // inputTokens o.l. er tall, ikke hemmeligheter
const HIDDEN = "[skjult]";
const SECRET_VALUE = [
  [/\b(Bearer)\s+[^\s"',]+/gi, `$1 ${HIDDEN}`],
  [/\bxai-[A-Za-z0-9_-]{8,}/g, HIDDEN],
];

function scrubString(s) {
  return SECRET_VALUE.reduce((out, [re, replacement]) => out.replace(re, replacement), s);
}

export function scrub(value, depth = 0) {
  if (typeof value === "string") return scrubString(value);
  if (value == null || typeof value !== "object") return value;
  if (depth > 8) return "[for dypt]";
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) && !COUNTER_KEY.test(k) ? HIDDEN : scrub(v, depth + 1);
  }
  return out;
}

// Siste forsvarslinje: kjente hemmeligheter fra env byttes ut uansett hvor de dukker opp.
export function redactSecrets(env, text) {
  let out = text;
  for (const key of ["XAI_API_KEY", "ADMIN_PASSWORD", "SEED_USER_PASSWORD"]) {
    const secret = env && env[key];
    if (typeof secret === "string" && secret.length >= 4) out = out.split(secret).join(HIDDEN);
  }
  return out;
}

export function logLine(env, entry) {
  console.log(redactSecrets(env, JSON.stringify(entry)));
}

// ctx: { userId, sessionId, jobId, fileId, ip }
export async function logEvent(env, level, type, message, data, ctx = {}) {
  const ts = nowIso();
  const msg = redactSecrets(env, scrubString(String(message ?? "")));
  const dataJson = data == null ? null : redactSecrets(env, JSON.stringify(scrub(data)));
  const sessionId = ctx.sessionId ? String(ctx.sessionId).slice(0, 8) : null;
  logLine(env, {
    ts, level, type, msg,
    userId: ctx.userId ?? undefined,
    sessionId: sessionId ?? undefined,
    jobId: ctx.jobId ?? undefined,
    fileId: ctx.fileId ?? undefined,
    ip: ctx.ip ?? undefined,
    data: dataJson == null ? undefined : JSON.parse(dataJson),
  });
  try {
    await env.DB.prepare(
      "INSERT INTO events (ts, level, type, message, user_id, session_id, job_id, file_id, ip, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(ts, level, type, msg, ctx.userId ?? null, sessionId, ctx.jobId ?? null, ctx.fileId ?? null, ctx.ip ?? null, dataJson)
      .run();
  } catch (err) {
    logLine(env, { ts, level: "error", type: "log.write_failed", msg: String(err && err.message) });
  }
}
