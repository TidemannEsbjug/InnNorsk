// Hono-appen: sikkerhetshoder, økt, CSRF, API-ruter, beskyttede sider og statiske filer.
import { Hono } from "hono";
import { loadSession } from "./auth.js";
import { HttpError, reqCtx } from "./http.js";
import { logEvent } from "./log.js";
import authRoutes from "./routes/auth.js";
import sendingRoutes from "./routes/sendings.js";
import adminRoutes from "./routes/admin.js";
import clientLogRoutes from "./routes/clientlog.js";

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const app = new Hono();

// Gjelder alle svar, også statiske filer, nedlastinger og feil.
app.use("*", async (c, next) => {
  await next();
  const res = new Response(c.res.body, c.res);
  res.headers.set("Content-Security-Policy", CSP);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "same-origin");
  res.headers.set("X-Frame-Options", "DENY");
  if (new URL(c.req.url).protocol === "https:") res.headers.set("Strict-Transport-Security", "max-age=31536000");
  if (c.req.path.startsWith("/api/") && !res.headers.has("Cache-Control")) res.headers.set("Cache-Control", "no-store");
  c.res = res;
});

app.onError(async (err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  await logEvent(c.env, "error", "server.error", err.message || String(err), {
    method: c.req.method,
    path: c.req.path,
    stack: String(err.stack || "").slice(0, 4000),
  }, reqCtx(c));
  return c.json({ error: "Noe gikk galt på serveren. Feilen er logget." }, 500);
});

app.get("/healthz", (c) => c.json({ ok: true }));

// Økten trengs bare for API-et og de beskyttede sidene, ikke for css/js/bilder.
const withSession = async (c, next) => {
  await loadSession(c);
  await next();
};
app.use("/api/*", withSession);
for (const page of ["/", "/login", "/admin"]) app.use(page, withSession);

// CSRF: nettlesere kan ikke sette egne hoder på tvers av domener uten CORS.
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method) && c.req.header("X-InnNorsk") !== "1") {
    return c.json({ error: "Forespørselen ble avvist av sikkerhetshensyn. Last inn siden på nytt." }, 403);
  }
  await next();
});

app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/client-log", clientLogRoutes);
app.route("/api", sendingRoutes);
app.all("/api/*", (c) => c.json({ error: "Fant ikke dette API-et." }, 404));

const asset = (c) => c.env.ASSETS.fetch(c.req.raw);

app.get("/login", (c) => (c.get("user") ? c.redirect("/") : asset(c)));
app.get("/", (c) => (c.get("user") ? asset(c) : c.redirect("/login")));
app.get("/admin", (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/login");
  return user.role === "admin" ? asset(c) : c.redirect("/");
});
app.all("*", asset);

export default app;
