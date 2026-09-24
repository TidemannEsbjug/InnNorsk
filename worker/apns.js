// Push til eierens iPhone via APNs. JWT (ES256) signeres med WebCrypto og gjenbrukes i 50 minutter.
// Enheten bestemmer sandbox/production, med mindre APNS_BASE_URL er satt (tester peker den mot en falsk server).
import { config } from "./config.js";
import { all, batch, nowIso } from "./db.js";
import { logEvent } from "./log.js";

const BASE_URL = { sandbox: "https://api.sandbox.push.apple.com", production: "https://api.push.apple.com" };
const JWT_TTL_MS = 50 * 60000;

let signer = null; // { pem, key }
let jwtCache = null; // { id, jwt, at }

const b64url = (data) => Buffer.from(data).toString("base64url");

async function signingKey(pem) {
  if (signer && signer.pem === pem) return signer.key;
  const der = Buffer.from(pem.replace(/\\n/g, "\n").replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  signer = { pem, key };
  return key;
}

async function providerToken(env) {
  const id = `${env.APNS_TEAM_ID}:${env.APNS_KEY_ID}`;
  if (jwtCache && jwtCache.id === id && signer && signer.pem === env.APNS_KEY_P8 && Date.now() - jwtCache.at < JWT_TTL_MS) {
    return jwtCache.jwt;
  }
  const key = await signingKey(env.APNS_KEY_P8);
  const at = Date.now();
  const unsigned = `${b64url(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }))}.${b64url(
    JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(at / 1000) })
  )}`;
  // WebCrypto gir r||s (64 byte), som er akkurat JOSE-formatet ES256 skal ha.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  jwtCache = { id, jwt: `${unsigned}.${b64url(signature)}`, at };
  return jwtCache.jwt;
}

const deviceLabel = (d) => d.name || `iPhone ${d.token.slice(0, 6)}`;

async function sendOne(env, jwt, device, payload) {
  const base = env.APNS_BASE_URL || BASE_URL[device.env] || BASE_URL.sandbox;
  try {
    const res = await fetch(`${base}/3/device/${device.token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-topic": config(env).apnsBundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      },
      body: payload,
    });
    if (res.ok) return { ok: true };
    const reason = (await res.json().catch(() => ({}))).reason || `HTTP ${res.status}`;
    return { ok: false, status: res.status, reason, gone: res.status === 410 || (res.status === 400 && reason === "BadDeviceToken") };
  } catch (err) {
    return { ok: false, status: 0, reason: String(err && err.message).slice(0, 200) };
  }
}

// message: { title, body, sendingId? }. Returnerer { sent, failed, errors } (errors er norske tekster for admin).
async function push(env, devices, message, ctx = {}) {
  const result = { sent: 0, failed: 0, errors: [] };
  if (!devices.length) return result;
  if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) {
    await logEvent(env, "warn", "push.skipped", "Push er ikke satt opp (APNS_KEY_P8, APNS_KEY_ID og APNS_TEAM_ID mangler)", { title: message.title }, ctx);
    return { sent: 0, failed: devices.length, errors: ["Push er ikke satt opp på serveren ennå."] };
  }
  let jwt;
  try {
    jwt = await providerToken(env);
  } catch (err) {
    await logEvent(env, "error", "push.failed", "APNs-nøkkelen kunne ikke leses", { error: String(err && err.message) }, ctx);
    return { sent: 0, failed: devices.length, errors: ["APNs-nøkkelen (APNS_KEY_P8) kunne ikke leses."] };
  }
  const payload = JSON.stringify({
    aps: { alert: { title: message.title, body: message.body }, sound: "default", "thread-id": "innnorsk" },
    ...(message.sendingId ? { sendingId: message.sendingId } : {}),
  });
  const now = nowIso();
  const updates = [];
  for (const device of devices) {
    const r = await sendOne(env, jwt, device, payload);
    if (r.ok) {
      result.sent++;
      updates.push(["UPDATE devices SET last_ok_at = ?, last_error = NULL WHERE token = ?", now, device.token]);
      continue;
    }
    result.failed++;
    result.errors.push(`${deviceLabel(device)}: ${r.reason}`);
    if (r.status === 403 && /ProviderToken/.test(r.reason)) jwtCache = null;
    updates.push([
      "UPDATE devices SET last_error = ?, disabled_at = CASE WHEN ? THEN ? ELSE disabled_at END WHERE token = ?",
      r.reason, r.gone ? 1 : 0, now, device.token,
    ]);
    await logEvent(env, "warn", "push.failed", `Push til ${deviceLabel(device)} feilet: ${r.reason}`, {
      device: device.token.slice(0, 8), status: r.status, reason: r.reason, disabled: Boolean(r.gone), title: message.title,
    }, ctx);
  }
  await batch(env, updates);
  if (result.sent) {
    await logEvent(env, "info", "push.sent", `Push sendt: ${message.title}`, { title: message.title, devices: result.sent }, ctx);
  }
  return result;
}

export async function pushToAdmins(env, message, ctx) {
  const devices = await all(
    env,
    `SELECT d.* FROM devices d JOIN users u ON u.id = d.user_id
     WHERE u.role = 'admin' AND u.disabled = 0 AND d.disabled_at IS NULL ORDER BY d.created_at`
  );
  return push(env, devices, message, ctx);
}

export async function pushToUser(env, userId, message, ctx) {
  const devices = await all(env, "SELECT * FROM devices WHERE user_id = ? AND disabled_at IS NULL ORDER BY created_at", userId);
  return push(env, devices, message, ctx);
}
