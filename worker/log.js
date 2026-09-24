// Hendelseslogg: én rad i D1 (admin-UI) + én JSON-linje i Workers Logs.
// Alt vaskes for hemmeligheter før det skrives noe sted.
import { nowIso } from "./db.js";

const SECRET_KEY = /pass|token|secret|key|authorization|cookie|proof|verifier|salt|p8/i;
const COUNTER_KEY = /tokens$/i; // inputTokens o.l. er tall, ikke hemmeligheter
const HIDDEN = "[skjult]";
const SECRET_VALUE = [
  [/\b(Bearer)\s+[^\s"',]+/gi, `$1 ${HIDDEN}`],
  [/\bxai-[A-Za-z0-9_-]{8,}/g, HIDDEN],
  [/-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g, HIDDEN],
];
export const LEVELS = ["debug", "info", "warn", "error"];

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

// Siste forsvarslinje: kjente hemmeligheter fra env byttes ut uansett hvor de dukker opp
// (også hver base64-linje i APNs-nøkkelen, i tilfelle PEM-en er delt opp).
function secretsOf(env) {
  const out = [env.AGENT_TOKEN, env.SALT_PEPPER, env.APNS_KEY_P8];
  for (const line of String(env.APNS_KEY_P8 || "").split(/\\n|\s+/)) if (!line.startsWith("-")) out.push(line);
  return out.filter((s) => typeof s === "string" && s.length >= 8);
}

export function redactSecrets(env, text) {
  return secretsOf(env || {}).reduce((out, secret) => out.split(secret).join(HIDDEN), text);
}

function logLine(env, entry) {
  console.log(redactSecrets(env, JSON.stringify(entry)));
}

// ctx: { userId, sessionId, sendingId, fileId, ip, source }
export async function logEvent(env, level, type, message, data, ctx = {}) {
  const ts = nowIso();
  const msg = redactSecrets(env, scrubString(String(message ?? "")));
  const dataJson = data == null ? null : redactSecrets(env, JSON.stringify(scrub(data)));
  const sessionId = ctx.sessionId ? String(ctx.sessionId).slice(0, 8) : null;
  const source = ctx.source || "system";
  logLine(env, {
    ts, level, type, msg, source,
    userId: ctx.userId ?? undefined,
    sessionId: sessionId ?? undefined,
    sendingId: ctx.sendingId ?? undefined,
    fileId: ctx.fileId ?? undefined,
    ip: ctx.ip ?? undefined,
    data: dataJson == null ? undefined : JSON.parse(dataJson),
  });
  try {
    await env.DB.prepare(
      `INSERT INTO events (ts, level, type, message, user_id, session_id, sending_id, file_id, ip, source, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(ts, level, type, msg, ctx.userId ?? null, sessionId, ctx.sendingId ?? null, ctx.fileId ?? null, ctx.ip ?? null, source, dataJson)
      .run();
  } catch (err) {
    logLine(env, { ts, level: "error", type: "log.write_failed", msg: String(err && err.message) });
  }
}
