// Salt, innlogging, utlogging, «hvem er jeg» og bytte av passord.
import { Hono } from "hono";
import { config } from "../config.js";
import { one, run, nowIso } from "../db.js";
import { logEvent } from "../log.js";
import { fail, readJson, reqCtx, clientIp } from "../http.js";
import {
  ITERATIONS, createSession, clearSessionCookie, findUserByName, publicUser, requireSession, fakeSalt, isProof,
  newSecret, safeEqual, sha256hex, normalizeUsername, recentFailures, isThrottled, reachesThrottle, recordFailure,
  clearUserFailures, revokeUserSessions,
} from "../auth.js";

const TOO_MANY = "For mange mislykkede forsøk. Vent 15 minutter og prøv igjen.";
const WRONG = "Brukernavnet eller passordet stemmer ikke.";
// Ukjent bruker sammenlignes mot denne, så svaret tar like lang tid.
const NO_USER = "0".repeat(64);

async function translatorName(env) {
  const row = await one(env, "SELECT display_name, username FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  return row ? row.display_name || row.username : "oversetteren";
}

const auth = new Hono();

auth.post("/salt", async (c) => {
  const username = normalizeUsername((await readJson(c)).username);
  if (!username) fail(400, "Skriv inn brukernavnet ditt.");
  const user = await findUserByName(c.env, username);
  return c.json(user ? { salt: user.salt, iterations: user.iterations } : { salt: fakeSalt(c.env, username), iterations: ITERATIONS });
});

auth.post("/login", async (c) => {
  const env = c.env;
  const body = await readJson(c);
  const username = normalizeUsername(body.username);
  const ip = clientIp(c);
  const ctx = reqCtx(c);
  if (!username || !isProof(body.proof)) fail(400, "Skriv inn brukernavn og passord.");

  const failures = await recentFailures(env, ip, username);
  if (isThrottled(failures)) fail(429, TOO_MANY);

  const user = await findUserByName(env, username);
  if (!safeEqual(sha256hex(body.proof), user ? user.verifier : NO_USER) || !user) {
    await recordFailure(env, ip, username);
    const logCtx = { ...ctx, userId: user ? user.id : null };
    await logEvent(env, "warn", "auth.login_failed", "Mislykket innlogging", { username, knownUser: Boolean(user) }, logCtx);
    if (reachesThrottle(failures)) {
      await logEvent(env, "warn", "auth.locked", "Innlogging sperret i 15 minutter etter for mange forsøk", { username }, logCtx);
    }
    fail(401, WRONG);
  }
  if (user.disabled) {
    await logEvent(env, "warn", "auth.login_failed", "Innlogging på deaktivert konto", { username: user.username, disabled: true }, { ...ctx, userId: user.id });
    fail(403, "Kontoen er deaktivert.");
  }
  await clearUserFailures(env, username);
  await run(env, "UPDATE users SET last_login_at = ? WHERE id = ?", nowIso(), user.id);
  const session = await createSession(c, user, ip);
  await logEvent(env, "info", "auth.login", `${user.username} logget inn`, {
    userAgent: (c.req.header("User-Agent") || "").slice(0, 200),
  }, { ...ctx, userId: user.id, sessionId: session.id });
  return c.json({ user: publicUser(user) });
});

auth.post("/logout", async (c) => {
  const session = c.get("session");
  if (session) {
    await run(c.env, "UPDATE sessions SET revoked_at = ?, revoked_reason = 'logout' WHERE id = ?", nowIso(), session.id);
    await logEvent(c.env, "info", "auth.logout", `${c.get("user").username} logget ut`, null, reqCtx(c));
  }
  clearSessionCookie(c);
  return c.body(null, 204);
});

// limits lar nettsiden si fra om for store filer før de lastes opp.
auth.get("/me", requireSession, async (c) => {
  const { maxFileMb, maxFilesPerSending } = config(c.env);
  return c.json({ user: c.get("user"), translatorName: await translatorName(c.env), limits: { maxFileMb, maxFilesPerSending } });
});

auth.post("/password", requireSession, async (c) => {
  const env = c.env;
  const body = await readJson(c);
  const me = c.get("user");
  const ip = clientIp(c);
  const failures = await recentFailures(env, ip, me.username);
  if (isThrottled(failures)) fail(429, TOO_MANY);
  const user = await one(env, "SELECT verifier FROM users WHERE id = ?", me.id);
  if (!isProof(body.currentProof) || !safeEqual(sha256hex(body.currentProof), user.verifier)) {
    await recordFailure(env, ip, me.username);
    await logEvent(env, "warn", "auth.password_change_failed", "Feil nåværende passord ved passordbytte", null, reqCtx(c));
    fail(400, "Det nåværende passordet stemmer ikke.");
  }
  const secret = newSecret(body);
  await run(
    env,
    "UPDATE users SET salt = ?, iterations = ?, verifier = ?, must_change_password = 0 WHERE id = ?",
    secret.salt, secret.iterations, secret.verifier, me.id
  );
  await revokeUserSessions(env, me.id, "password_changed", c.get("session").id);
  await logEvent(env, "info", "auth.password_changed", `${me.username} byttet passord`, null, reqCtx(c));
  return c.body(null, 204);
});

export default auth;
