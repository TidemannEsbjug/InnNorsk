// Feil fra nettleseren og iPhone-appen havner i samme logg som serverens hendelser.
import { Hono } from "hono";
import { one, isoAgo } from "../db.js";
import { logEvent, LEVELS } from "../log.js";
import { fail, readJson, reqCtx, str } from "../http.js";
import { requireSession } from "../auth.js";

const MAX_PER_MINUTE = 30;

const clientlog = new Hono();

clientlog.post("/", requireSession, async (c) => {
  const body = await readJson(c);
  const recent = await one(
    c.env,
    "SELECT COUNT(*) AS n FROM events WHERE type = 'client.error' AND session_id = ? AND ts > ?",
    c.get("session").id.slice(0, 8), isoAgo(60000)
  );
  if (recent.n >= MAX_PER_MINUTE) fail(429, "For mange feilmeldinger. Prøv igjen om litt.");
  await logEvent(c.env, LEVELS.includes(body.level) ? body.level : "error", "client.error", str(body.message, 500) || "(uten melding)", {
    stack: str(body.stack, 4000) || undefined,
    url: str(body.url, 500) || undefined,
    userAgent: (c.req.header("User-Agent") || "").slice(0, 200),
  }, reqCtx(c));
  return c.body(null, 204);
});

export default clientlog;
