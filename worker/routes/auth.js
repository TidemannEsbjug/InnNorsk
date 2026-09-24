// Innlogging, utlogging, «hvem er jeg» og bytte av passord.
import { Hono } from "hono";
import { config } from "../config.js";
import { one, run, nowIso } from "../db.js";
import { logEvent } from "../log.js";
import { fail, readJson, reqCtx, clientIp, str } from "../http.js";
import {
  MIN_PASSWORD, createSession, clearSessionCookie, findUserByName, publicUser, requireUser, verifyPassword,
  dummyVerify, hashPassword, recentFailures, isThrottled, reachesThrottle, recordFailure, clearUserFailures,
  revokeUserSessions,
} from "../auth.js";

const TOO_MANY = "For mange mislykkede forsøk. Vent 15 minutter og prøv igjen.";
const WRONG = "Brukernavnet eller passordet stemmer ikke.";

const auth = new Hono();

auth.post("/login", async (c) => {
  const env = c.env;
  const body = await readJson(c);
  const username = str(body.username, 100).trim();
  const password = str(body.password, 500);
  const ip = clientIp(c);
  const ctx = reqCtx(c);
  if (!username || !password) fail(400, "Skriv inn brukernavn og passord.");

  const failures = await recentFailures(env, ip, username);
  if (isThrottled(failures)) fail(429, TOO_MANY);

  const user = await findUserByName(env, username);
  const ok = user ? verifyPassword(password, user.password_hash) : (dummyVerify(password), false);
  if (!ok) {
    await recordFailure(env, ip, username);
    await logEvent(env, "warn", "auth.login_failed", "Mislykket innlogging", { username, knownUser: Boolean(user) }, { ...ctx, userId: user ? user.id : null });
    if (reachesThrottle(failures)) {
      await logEvent(env, "warn", "auth.locked", "Innlogging sperret i 15 minutter etter for mange forsøk", { username }, { ...ctx, userId: user ? user.id : null });
    }
    fail(401, WRONG);
  }
  if (user.disabled) {
    await logEvent(env, "warn", "auth.login_failed", "Innlogging på deaktivert konto", { username: user.username, disabled: true }, { ...ctx, userId: user.id });
    fail(403, "Kontoen er deaktivert.");
  }
  await clearUserFailures(env, username);
  await run(env, "UPDATE users SET last_login_at = ? WHERE id = ?", nowIso(), user.id);
  const session = await createSession(c, user);
  await logEvent(env, "info", "auth.login", `${user.username} logget inn`, { userAgent: (c.req.header("User-Agent") || "").slice(0, 200) }, { ...ctx, userId: user.id, sessionId: session.id });
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
auth.get("/me", requireUser, (c) => {
  const { maxFileMb, maxFilesPerJob } = config(c.env);
  return c.json({ user: c.get("user"), limits: { maxFileMb, maxFilesPerJob } });
});

auth.post("/password", requireUser, async (c) => {
  const env = c.env;
  const body = await readJson(c);
  const current = str(body.currentPassword, 500);
  const next = str(body.newPassword, 500);
  const me = c.get("user");
  const ip = clientIp(c);
  const failures = await recentFailures(env, ip, me.username);
  if (isThrottled(failures)) fail(429, TOO_MANY);
  const user = await one(env, "SELECT * FROM users WHERE id = ?", me.id);
  if (!verifyPassword(current, user.password_hash)) {
    await recordFailure(env, ip, me.username);
    fail(400, "Det nåværende passordet stemmer ikke.");
  }
  if ([...next].length < MIN_PASSWORD) fail(400, `Det nye passordet må ha minst ${MIN_PASSWORD} tegn.`);
  if (next === current) fail(400, "Det nye passordet må være forskjellig fra det gamle.");
  await run(env, "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", hashPassword(next), me.id);
  await revokeUserSessions(env, me.id, "password_changed", c.get("session").id);
  await logEvent(env, "info", "auth.password_changed", `${me.username} byttet passord`, null, reqCtx(c));
  return c.body(null, 204);
});

export default auth;
