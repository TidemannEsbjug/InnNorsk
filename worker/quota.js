// Tak mot en uventet regning (lekket passord eller en feil): hvor mye tekst som kan sendes til xAI per døgn og per
// 30 dager (quota_usage), og hvor mye som kan ligge i R2 (godt under gratiskvoten på 10 GB). Grensene står i wrangler.jsonc.
import { config } from "./config.js";
import { one, run, nowIso, isoAgo, DAY_MS } from "./db.js";
import { fail } from "./http.js";
import { logEvent } from "./log.js";
import { translatorName } from "./sendings.js";

const MONTH_MS = 30 * DAY_MS;
const GB = 1024 ** 3;
const CHARS_PER_PAGE = 2500;

function pages(chars) {
  const n = Math.max(1, Math.round(chars / CHARS_PER_PAGE));
  return n === 1 ? "1 side" : `${n} sider`;
}

const USED_SQL = "SELECT COALESCE(SUM(chars), 0) FROM quota_usage WHERE ts > ?";

async function charsUsed(env, windowMs) {
  return (await one(env, `SELECT (${USED_SQL}) AS n`, isoAgo(windowMs))).n;
}

// { day, month, storage }: { used, cap } for admin-oversikten (tegn og byte).
export async function quotaStatus(env) {
  const cfg = config(env);
  const storage = await one(env, "SELECT COALESCE(SUM(bytes), 0) + COALESCE(SUM(output_bytes), 0) AS n FROM files WHERE deleted_at IS NULL");
  return {
    day: { used: await charsUsed(env, DAY_MS), cap: cfg.maxCharsPerDay },
    month: { used: await charsUsed(env, MONTH_MS), cap: cfg.maxCharsPerMonth },
    storage: { used: storage.n, cap: Math.round(cfg.maxStorageGb * GB) },
  };
}

// Reserverer chars tegn hvis både døgn- og månedstaket tillater det (sjekk og reservasjon i én SQL-setning, så to
// samtidige sendinger ikke kan gå forbi taket). Returnerer radens id (til releaseTranslation); kaster 429 ellers.
// ctx: loggkonteksten ({ userId, sendingId, fileId, … }); admin: meldingen er til eieren, ikke Svetlana.
export async function reserveTranslation(env, chars, ctx, { admin = false } = {}) {
  const { maxCharsPerDay: day, maxCharsPerMonth: month } = config(env);
  const [dayAgo, monthAgo] = [isoAgo(DAY_MS), isoAgo(MONTH_MS)];
  const row = await one(
    env,
    `INSERT INTO quota_usage (ts, chars, user_id, sending_id, file_id)
     SELECT ?, ?, ?, ?, ? WHERE (${USED_SQL}) + ? <= ? AND (${USED_SQL}) + ? <= ? RETURNING id`,
    nowIso(), chars, ctx.userId, ctx.sendingId, ctx.fileId, dayAgo, chars, day, monthAgo, chars, month
  );
  if (row) return row.id;

  const [usedDay, usedMonth] = [await charsUsed(env, DAY_MS), await charsUsed(env, MONTH_MS)];
  const daily = usedDay + chars > day;
  const [cap, used, per, later, setting] = daily
    ? [day, usedDay, "døgn", "Prøv igjen i morgen", "MAX_CHARS_PER_DAY"]
    : [month, usedMonth, "30 dager", "Prøv igjen senere", "MAX_CHARS_PER_MONTH"];
  await logEvent(env, "warn", "quota.translation", `Taket for oversettelse per ${per} er nådd`, {
    requestedChars: chars, usedChars: used, capChars: cap, setting,
  }, ctx);
  const limit = `ca. ${pages(cap)} per ${per}`;
  if (admin) fail(429, `Taket for oversettelse er nådd (${used} + ${chars} tegn > ${setting} = ${cap}). Hev ${setting} i wrangler.jsonc om nødvendig.`);
  const who = await translatorName(env);
  fail(429, chars > cap
    ? `Disse filene har for mye tekst til å sendes på én gang (grensen er ${limit}). Send færre filer om gangen, eller si fra til ${who}.`
    : `Grensen for hvor mye som kan oversettes (${limit}) er nådd. ${later}, eller si fra til ${who}.`);
}

// Gir tilbake en reservasjon når oversettelsen likevel ikke startet.
export const releaseTranslation = (env, id) => run(env, "DELETE FROM quota_usage WHERE id = ?", id);

// Kaster 507 hvis en ny fil på bytes byte ville gjøre at det samlet lagres mer enn MAX_STORAGE_GB (originaler og resultater).
export async function checkStorage(env, bytes, ctx) {
  const cap = Math.round(config(env).maxStorageGb * GB);
  const { n: used } = await one(env, "SELECT COALESCE(SUM(bytes), 0) + COALESCE(SUM(output_bytes), 0) AS n FROM files WHERE deleted_at IS NULL");
  if (used + bytes <= cap) return;
  await logEvent(env, "warn", "quota.storage", "Lagringstaket er nådd", { usedBytes: used, requestedBytes: bytes, capBytes: cap }, ctx);
  fail(507, `Lagringsplassen er full. Slett gamle sendinger under «Mine filer», eller si fra til ${await translatorName(env)}.`);
}
