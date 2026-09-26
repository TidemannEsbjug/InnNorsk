// Feil fra nettleseren og iPhone-appen havner i samme logg som serverens hendelser, og det samme gjør det Svetlana
// opplever på nettsiden som serveren ellers aldri ser (track() i web/js/api.js): sidevisninger, filer nettleseren ikke
// tok med, opplastinger som feilet og feilmeldingene hun fikk se. Aldri filinnhold eller passord.
import { Hono } from "hono";
import { one, isoAgo } from "../db.js";
import { logEvent, LEVELS, scrub } from "../log.js";
import { fail, readJson, reqCtx, str } from "../http.js";
import { requireSession } from "../auth.js";

const ERROR = "client.error";
const MAX_PER_MINUTE = 30;
// Aktivitet fra nettsiden: standardnivå og melding når nettsiden ikke har sendt noen.
export const ACTIVITY = {
  "client.page": ["info", "Åpnet siden"],
  "client.file_rejected": ["warn", "Filer ble ikke tatt med"],
  "client.upload_failed": ["warn", "Opplastingen feilet"],
  "client.error_shown": ["warn", "Viste en feilmelding"],
};
// Egen, rausere kvote for aktivitet, så den aldri spiser av kvoten for feil (og omvendt).
const MAX_ACTIVITY_PER_MINUTE = 60;
const MAX_DATA_CHARS = 4000;
// Samlet tak per bruker (alle økter), så flere innlogginger ikke gir større kvote.
const MAX_PER_USER_PER_MINUTE = 120;

// Et lite JSON-objekt fra nettsiden; for stort → bare starten, som tekst. Vaskes for hemmeligheter før det kortes ned
// (i teksten kjenner ikke logEvent igjen nøklene lenger).
export function clientData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const clean = scrub(data);
  const json = JSON.stringify(clean);
  return json.length <= MAX_DATA_CHARS ? clean : { truncated: true, preview: json.slice(0, MAX_DATA_CHARS) };
}

const perUser = (c) => one(
  c.env,
  "SELECT COUNT(*) AS n FROM events WHERE type LIKE 'client.%' AND user_id = ? AND ts > ?",
  c.get("user").id, isoAgo(60000)
);

const recent = (c, types) => one(
  c.env,
  `SELECT COUNT(*) AS n FROM events WHERE type IN (SELECT value FROM json_each(?)) AND session_id = ? AND ts > ?`,
  JSON.stringify(types), c.get("session").id.slice(0, 8), isoAgo(60000)
);

// Bare egne sendinger (admin: alle) kobles til hendelsen; en ukjent id droppes stille.
async function ownSending(c, id) {
  if (typeof id !== "string" || !/^[a-z2-7]{1,64}$/.test(id)) return null;
  const user = c.get("user");
  const row = await one(c.env, "SELECT id FROM sendings WHERE id = ? AND (user_id = ? OR ? = 'admin')", id, user.id, user.role);
  return row ? row.id : null;
}

const clientlog = new Hono();

clientlog.post("/", requireSession, async (c) => {
  const body = await readJson(c);
  const type = body.type == null ? ERROR : String(body.type);
  const activity = ACTIVITY[type];
  if (type !== ERROR && !activity) fail(400, "Ukjent hendelsestype.");
  const userAgent = (c.req.header("User-Agent") || "").slice(0, 200);
  if ((await perUser(c)).n >= MAX_PER_USER_PER_MINUTE) fail(429, "For mange hendelser. Prøv igjen om litt.");
  if (!activity) {
    if ((await recent(c, [ERROR])).n >= MAX_PER_MINUTE) fail(429, "For mange feilmeldinger. Prøv igjen om litt.");
    await logEvent(c.env, LEVELS.includes(body.level) ? body.level : "error", ERROR, str(body.message, 500) || "(uten melding)", {
      stack: str(body.stack, 4000) || undefined,
      url: str(body.url, 500) || undefined,
      userAgent,
    }, reqCtx(c));
    return c.body(null, 204);
  }
  if ((await recent(c, Object.keys(ACTIVITY))).n >= MAX_ACTIVITY_PER_MINUTE) fail(429, "For mange hendelser. Prøv igjen om litt.");
  const [level, fallback] = activity;
  await logEvent(c.env, ["info", "warn", "error"].includes(body.level) ? body.level : level, type, str(body.message, 500) || fallback, {
    ...clientData(body.data),
    url: str(body.url, 500) || undefined,
    userAgent: type === "client.page" ? userAgent : undefined,
  }, reqCtx(c, { sendingId: await ownSending(c, body.sendingId) }));
  return c.body(null, 204);
});

export default clientlog;
