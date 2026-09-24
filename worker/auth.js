// Passord (scrypt), økter i D1, innloggingsbrems og oppstart av første brukere.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import { config } from "./config.js";
import { one, all, run, batch, nowIso, isoAgo, DAY_MS } from "./db.js";
import { logEvent } from "./log.js";
import { clientIp } from "./http.js";

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;
export const COOKIE = "innnorsk_sid";
export const MIN_PASSWORD = 8;
const THROTTLE_WINDOW_MS = 15 * 60000;
const THROTTLE_MAX = 5;
const SLIDE_EVERY_MS = 60000;

const normalize = (password) => String(password).normalize("NFC");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(normalize(password), salt, KEYLEN, { ...SCRYPT, maxmem: MAXMEM });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(normalize(password), Buffer.from(salt, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Ukjent bruker skal ta like lang tid som feil passord.
let dummyHash = null;
export function dummyVerify(password) {
  dummyHash = dummyHash || hashPassword("ingen-bruker-her");
  verifyPassword(password, dummyHash);
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 14) {
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 224 && out.length < length) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

// NOCASE i SQLite bretter bare ASCII; Ø/ø o.l. sammenlignes i JS.
export async function findUserByName(env, username) {
  const name = String(username || "").trim();
  if (!name) return null;
  const hit = await one(env, "SELECT * FROM users WHERE username = ? COLLATE NOCASE", name);
  if (hit || !/[^\x00-\x7f]/.test(name)) return hit;
  const lower = name.toLowerCase();
  return (await all(env, "SELECT * FROM users")).find((u) => u.username.toLowerCase() === lower) || null;
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

function setSessionCookie(c, token) {
  const days = Math.min(400, config(c.env).sessionDays);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: isHttps(c),
    maxAge: Math.round(days * 86400),
  });
}

export function clearSessionCookie(c) {
  setCookie(c, COOKIE, "", { httpOnly: true, sameSite: "Lax", path: "/", secure: isHttps(c), maxAge: 0 });
}

const expiresFromNow = (env) => new Date(Date.now() + config(env).sessionDays * DAY_MS).toISOString();

export async function createSession(c, user) {
  const token = randomBytes(32).toString("base64url");
  const id = sha256(token);
  const now = nowIso();
  await run(
    c.env,
    "INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id, user.id, now, now, expiresFromNow(c.env), clientIp(c), (c.req.header("User-Agent") || "").slice(0, 300)
  );
  setSessionCookie(c, token);
  return { id };
}

// Leser informasjonskapselen og setter c.get("user") / c.get("session"). Utløpet forlenges maks én gang i minuttet.
export async function loadSession(c) {
  const token = getCookie(c, COOKIE);
  if (!token || token.length > 128) return;
  const id = sha256(token);
  const row = await one(
    c.env,
    `SELECT s.id, s.last_seen_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    id, nowIso()
  );
  if (!row || row.disabled) return;
  if (Date.now() - Date.parse(row.last_seen_at || 0) > SLIDE_EVERY_MS) {
    await run(c.env, "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", nowIso(), expiresFromNow(c.env), id);
    setSessionCookie(c, token);
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

export async function requireUser(c, next) {
  if (!c.get("user")) return c.json({ error: "Du må logge inn." }, 401);
  await next();
}

export async function requireAdmin(c, next) {
  const user = c.get("user");
  if (!user) return c.json({ error: "Du må logge inn." }, 401);
  if (user.role !== "admin") return c.json({ error: "Du har ikke tilgang til dette." }, 403);
  await next();
}

// ---- Innloggingsbrems ----

const throttleKeys = (ip, username) => [`ip:${ip || "ukjent"}`, `user:${String(username).trim().toLowerCase()}`];

// Returnerer høyeste antall feil for IP eller brukernavn siste 15 minutter.
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

// ---- Første brukere ----

async function createIfMissing(env, { username, displayName, role, password }) {
  if (!username || !password || (await findUserByName(env, username))) return false;
  const res = await run(
    env,
    "INSERT OR IGNORE INTO users (username, display_name, role, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 0, ?)",
    username, displayName || username, role, hashPassword(password), nowIso()
  );
  return res.meta.changes > 0;
}

async function bootstrap(env) {
  const cfg = config(env);
  const created = [];
  const admin = { username: cfg.adminUsername, displayName: "Administrator", role: "admin", password: env.ADMIN_PASSWORD };
  if (await createIfMissing(env, admin)) created.push(admin.username);
  const seed = { username: cfg.seedUsername, displayName: cfg.seedDisplayName, role: "user", password: env.SEED_USER_PASSWORD };
  if (await createIfMissing(env, seed)) {
    created.push(seed.username);
    await logEvent(env, "info", "user.seeded", `Brukeren ${seed.username} ble opprettet`, { username: seed.username });
  }
  if (created.length) {
    await logEvent(env, "info", "system.bootstrap", "Første brukere opprettet", { created });
  }
}

// Kjøres én gang per isolat; feiler den, prøver neste forespørsel igjen.
let bootstrapped = null;
export function ensureBootstrap(env) {
  if (!bootstrapped) {
    bootstrapped = bootstrap(env).catch((err) => {
      bootstrapped = null;
      throw err;
    });
  }
  return bootstrapped;
}
