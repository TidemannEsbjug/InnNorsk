// Feil fra nettleseren havner i samme logg som serverens hendelser.
import { Hono } from "hono";
import { one, isoAgo } from "../db.js";
import { logEvent } from "../log.js";
import { fail, readJson, reqCtx, str } from "../http.js";
import { requireUser } from "../auth.js";

const MAX_PER_MINUTE = 30;
const MAX_CONTEXT = 4000;

function limitContext(value) {
  if (!value || typeof value !== "object") return undefined;
  const json = JSON.stringify(value);
  return json.length <= MAX_CONTEXT ? value : { truncated: json.slice(0, MAX_CONTEXT) };
}

const clientlog = new Hono();

clientlog.post("/", requireUser, async (c) => {
  const body = await readJson(c);
  const session = c.get("session");
  const recent = await one(
    c.env,
    "SELECT COUNT(*) AS n FROM events WHERE type = 'client.error' AND session_id = ? AND ts > ?",
    session.id.slice(0, 8), isoAgo(60000)
  );
  if (recent.n >= MAX_PER_MINUTE) fail(429, "For mange feilmeldinger. Prøv igjen om litt.");
  const level = ["error", "warn", "info"].includes(body.level) ? body.level : "error";
  await logEvent(c.env, level, "client.error", str(body.message, 500) || "(uten melding)", {
    stack: str(body.stack, 4000) || undefined,
    url: str(body.url, 500) || undefined,
    userAgent: (c.req.header("User-Agent") || "").slice(0, 200),
    context: limitContext(body.context),
  }, reqCtx(c));
  return c.body(null, 204);
});

export default clientlog;
