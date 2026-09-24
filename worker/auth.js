// Innlogging uten passordhashing på serveren (Free-plan: ≤ 10 ms CPU):
// klienten regner ut proof = PBKDF2-SHA256(passord, salt, iterations), vi lagrer og sammenligner bare sha256(proof).
// Her er også økter i D1, innloggingsbrems, rolle-sjekker og agentnøkkelen.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import { one, all, run, batch, nowIso, isoAgo, DAY_MS } from "./db.js";
import { fail } from "./http.js";

const COOKIE = "innnorsk_sid";
export const ITERATIONS = 310000;
const MAX_ITERATIONS = 2000000;
const SALT_BYTES = 16;
const PROOF_BYTES = 32;
const SESSION_DAYS = 30;
const SLIDE_EVERY_MS = 60000;
const THROTTLE_WINDOW_MS = 15 * 60000;
const THROTTLE_MAX = 5;
export const USERNAME = /^[\p{L}\p{N}._@-]{1,64}$/u;

export const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

// Sammenligner via sha256 så lengden aldri avsløres.
export function safeEqual(a, b) {
  const x = createHash("sha256").update(String(a)).digest();
  const y = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(x, y);
}

export const normalizeUsername = (name) => String(name ?? "").normalize("NFC").trim().slice(0, 100);
const lower = (name) => normalizeUsername(name).toLowerCase();

// Ukjente brukernavn får et fast, falskt salt (samme lengde som ekte) så de ikke kan skilles fra ekte.
export function fakeSalt(env, username) {
  const mac = createHmac("sha256", env.SALT_PEPPER || "innnorsk").update(lower(username)).digest();
  return mac.subarray(0, SALT_BYTES).toString("base64url");
}

const bytesOf = (b64url) => (typeof b64url === "string" && /^[A-Za-z0-9_-]+$/.test(b64url) ? Buffer.from(b64url, "base64url").length : 0);

export const isProof = (proof) => typeof proof === "string" && proof.length < 64 && bytesOf(proof) === PROOF_BYTES;

// { salt, iterations, proof } fra klienten (nytt passord) → det som lagres. Kaster 400 ved ugyldige verdier.
export function newSecret(body) {
  const { salt, iterations, proof } = body || {};
  const saltBytes = typeof salt === "string" && salt.length <= 100 ? bytesOf(salt) : 0;
  if (saltBytes < SALT_BYTES || saltBytes > 64) fail(400, "Ugyldig salt.");
  if (!Number.isInteger(iterations) || iterations < ITERATIONS || iterations > MAX_ITERATIONS) fail(400, "Ugyldig antall iterasjoner.");
  if (!isProof(proof)) fail(400, "Ugyldig passordbevis.");
  return { salt, iterations, verifier: sha256hex(proof) };
}

// NOCASE i SQLite bretter bare ASCII; Ø/ø o.l. sammenlignes i JS (det finnes bare en håndfull brukere).
export async function findUserByName(env, username) {
  const name = normalizeUsername(username);
  if (!name) return null;
  const hit = await one(env, "SELECT * FROM users WHERE username = ?", name);
  if (hit || !/[^\x00-\x7f]/.test(name)) return hit;
  return (await all(env, "SELECT * FROM users")).find((u) => lower(u.username) === lower(name)) || null;
}

export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || u.username,
    role: u.role,
    mustChangePassword: Boolean(u.must_change_password),
  };
}

// ---- Økter ----

const isHttps = (c) => new URL(c.req.url).protocol === "https:";
const cookieOptions = (c, maxAge) => ({ httpOnly: true, sameSite: "Lax", path: "/", secure: isHttps(c), maxAge });
const expiresFromNow = () => new Date(Date.now() + SESSION_DAYS * DAY_MS).toISOString();

export async function createSession(c, user, ip) {
  const token = randomBytes(32).toString("base64url");
  const id = sha256hex(token);
  const now = nowIso();
  await run(
    c.env,
    "INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id, user.id, now, now, expiresFromNow(), ip, (c.req.header("User-Agent") || "").slice(0, 300)
  );
  setCookie(c, COOKIE, token, cookieOptions(c, SESSION_DAYS * 86400));
  c.set("session", { id });
  return { id };
}

export function clearSessionCookie(c) {
  setCookie(c, COOKIE, "", cookieOptions(c, 0));
}

// Leser informasjonskapselen og setter c.get("user") / c.get("session"). Utløpet forlenges maks én gang i minuttet.
export async function loadSession(c) {
  const token = getCookie(c, COOKIE);
  if (!token || token.length > 128) return;
  const id = sha256hex(token);
  const row = await one(
    c.env,
    `SELECT s.last_seen_at AS seen_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    id, nowIso()
  );
  if (!row || row.disabled) return;
  if (Date.now() - Date.parse(row.seen_at || 0) > SLIDE_EVERY_MS) {
    await run(c.env, "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", nowIso(), expiresFromNow(), id);
    setCookie(c, COOKIE, token, cookieOptions(c, SESSION_DAYS * 86400));
  }
  c.set("session", { id });
  c.set("user", publicUser(row));
}

export function revokeUserSessions(env, userId, reason, exceptId = null) {
  return run(
    env,
    "UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?",
    nowIso(), reason, userId, exceptId
  );
}

// Innlogget, også om passordet må byttes (auth-rutene og klientloggen).
export async function requireSession(c, next) {
  if (!c.get("user")) return c.json({ error: "Du må logge inn." }, 401);
  await next();
}

// Innlogget og ferdig med eventuelt tvunget passordbytte.
export async function requireUser(c, next) {
  const user = c.get("user");
  if (!user) return c.json({ error: "Du må logge inn." }, 401);
  if (user.mustChangePassword) return c.json({ error: "Du må bytte passord før du kan fortsette.", mustChangePassword: true }, 403);
  await next();
}

export function requireAdmin(c, next) {
  const user = c.get("user");
  if (user && user.role !== "admin") return c.json({ error: "Du har ikke tilgang til dette." }, 403);
  return requireUser(c, next);
}

// Mac-agenten: Authorization: Bearer <AGENT_TOKEN>.
export async function requireAgent(c, next) {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!c.env.AGENT_TOKEN || !token || !safeEqual(token, c.env.AGENT_TOKEN)) {
    return c.json({ error: "Ugyldig agentnøkkel." }, 401);
  }
  await next();
}

// ---- Innloggingsbrems ----

const throttleKeys = (ip, username) => [`ip:${ip || "ukjent"}`, `user:${lower(username)}`];

// Høyeste antall feil for IP eller brukernavn siste 15 minutter.
export async function recentFailures(env, ip, username) {
  const [ipKey, userKey] = throttleKeys(ip, username);
  const rows = await all(
    env,
    "SELECT key, COUNT(*) AS n FROM login_attempts WHERE key IN (?, ?) AND ts > ? GROUP BY key",
    ipKey, userKey, isoAgo(THROTTLE_WINDOW_MS)
  );
  return rows.reduce((m, r) => Math.max(m, r.n), 0);
}

export const isThrottled = (failures) => failures >= THROTTLE_MAX;
export const reachesThrottle = (failuresBefore) => failuresBefore + 1 === THROTTLE_MAX;

export function recordFailure(env, ip, username) {
  const ts = nowIso();
  return batch(env, throttleKeys(ip, username).map((key) => ["INSERT INTO login_attempts (key, ts) VALUES (?, ?)", key, ts]));
}

export function clearUserFailures(env, username) {
  return run(env, "DELETE FROM login_attempts WHERE key = ?", throttleKeys(null, username)[1]);
}
