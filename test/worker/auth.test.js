// Innlogging, økter, brems, CSRF, sider og sikkerhetshoder mot ekte wrangler dev.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const workerDev = require("../helpers/worker-dev");
const { Client, loggedIn } = require("./client");

const { DEFAULT_VARS: V } = workerDev;
const WRONG = "Brukernavnet eller passordet stemmer ikke.";
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

let dev;
let admin;

test.before(async () => {
  dev = await workerDev.start();
  admin = await loggedIn(dev.url, "admin", V.ADMIN_PASSWORD);
});

test.after(async () => {
  if (dev) await dev.stop();
});

async function createUser(username, password) {
  const res = await admin.post("/api/admin/users", { username, displayName: username, role: "user", password });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.user;
}

const countEvents = async (type) => (await dev.sql("SELECT COUNT(*) AS n FROM events WHERE type = ?", type))[0].n;

test("første forespørsel oppretter admin og Svetlana, og Svetlana slipper å bytte passord", async () => {
  for (const name of ["Svetlana", "svetlana", "SVETLANA"]) {
    const res = await new Client(dev.url).login(name, V.SEED_USER_PASSWORD);
    assert.equal(res.status, 200, name);
    assert.deepEqual(res.data.user, {
      id: res.data.user.id,
      username: "Svetlana",
      displayName: "Svetlana",
      role: "user",
      mustChangePassword: false,
    });
  }
  const me = await admin.get("/api/auth/me");
  assert.equal(me.data.user.role, "admin");
  assert.equal(me.data.user.mustChangePassword, false);
  assert.deepEqual(me.data.limits, { maxFileMb: 30, maxFilesPerJob: 100 });
  assert.deepEqual(
    (await dev.sql("SELECT username, role FROM users ORDER BY id")).map((u) => `${u.username}:${u.role}`),
    ["admin:admin", "Svetlana:user"]
  );
  assert.equal(await countEvents("user.seeded"), 1);
  assert.equal(await countEvents("system.bootstrap"), 1);
});

test("sikkerhetshoder finnes på alle svar, også statiske filer og feil", async () => {
  const anon = new Client(dev.url);
  for (const path of ["/healthz", "/login", "/css/app.css", "/api/auth/me", "/api/finnes-ikke", "/finnes-ikke.png", "/"]) {
    const res = await anon.get(path);
    assert.equal(res.headers.get("content-security-policy"), CSP, path);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(res.headers.get("x-frame-options"), "DENY", path);
    assert.equal(res.headers.get("referrer-policy"), "same-origin", path);
    assert.equal(res.headers.get("strict-transport-security"), null, `${path}: ingen HSTS over http`);
  }
  const health = await anon.get("/healthz");
  assert.deepEqual(health.data, { ok: true });
  const missing = await anon.get("/api/finnes-ikke");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
});

test("sidene krever innlogging og riktig rolle", async () => {
  const anon = new Client(dev.url);
  assert.equal((await anon.get("/")).headers.get("location"), "/login");
  assert.equal((await anon.get("/admin")).headers.get("location"), "/login");
  const login = await anon.get("/login");
  assert.equal(login.status, 200);
  assert.match(login.data.toString(), /<html/i);
  assert.ok([301, 302, 307, 308].includes((await anon.get("/index.html")).status), "index.html går via beskyttet /");

  const svetlana = await loggedIn(dev.url, "Svetlana", V.SEED_USER_PASSWORD);
  assert.equal((await svetlana.get("/login")).headers.get("location"), "/");
  assert.equal((await svetlana.get("/")).status, 200);
  assert.equal((await svetlana.get("/admin")).headers.get("location"), "/");
  assert.equal((await admin.get("/admin")).status, 200);
});

test("innloggingskapselen er HttpOnly og SameSite=Lax, uten Secure over http", async () => {
  const res = await new Client(dev.url).login("Svetlana", V.SEED_USER_PASSWORD);
  assert.match(res.setCookie, /^innnorsk_sid=[A-Za-z0-9_-]{43};/);
  assert.match(res.setCookie, /HttpOnly/);
  assert.match(res.setCookie, /SameSite=Lax/);
  assert.match(res.setCookie, /Path=\//);
  assert.match(res.setCookie, /Max-Age=2592000/);
  assert.doesNotMatch(res.setCookie, /Secure/);
});

test("feil passord og ukjent bruker gir samme norske melding", async () => {
  const anon = new Client(dev.url, { ip: "10.0.0.1" });
  const wrong = await anon.login("Svetlana", "feil-passord-000");
  const unknown = await anon.login("finnes-ikke", "feil-passord-000");
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.data.error, WRONG);
  assert.equal(unknown.data.error, WRONG);
  assert.equal((await anon.post("/api/auth/login", { username: "" })).status, 400);
  assert.equal((await anon.req("POST", "/api/auth/login", { body: "{ikke json", headers: { "Content-Type": "application/json" } })).status, 400);
});

test("CSRF: endringer uten X-InnNorsk-hodet avvises", async () => {
  const svetlana = await loggedIn(dev.url, "Svetlana", V.SEED_USER_PASSWORD);
  const blocked = await svetlana.req("POST", "/api/jobs", { json: { targetLanguage: "bokmal" }, csrf: false });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /avvist/);
  const login = await new Client(dev.url).req("POST", "/api/auth/login", {
    json: { username: "Svetlana", password: V.SEED_USER_PASSWORD },
    csrf: false,
  });
  assert.equal(login.status, 403);
  assert.equal((await svetlana.get("/api/auth/me")).status, 200, "GET trenger ikke hodet");
});

test("fem feil på 15 minutter sperrer brukernavnet og IP-en", async () => {
  await createUser("Bremse", "riktig-passord-1");
  const attacker = new Client(dev.url, { ip: "10.0.0.66" });
  for (let i = 0; i < 5; i++) {
    const res = await attacker.login("bremse", `feil-${i}-passord`);
    assert.equal(res.status, 401, `forsøk ${i + 1}`);
  }
  const locked = await attacker.login("Bremse", "riktig-passord-1");
  assert.equal(locked.status, 429);
  assert.equal(locked.data.error, "For mange mislykkede forsøk. Vent 15 minutter og prøv igjen.");
  // Samme brukernavn fra en annen IP er også sperret, andre brukere fra samme IP likeså.
  assert.equal((await new Client(dev.url, { ip: "10.0.0.67" }).login("Bremse", "riktig-passord-1")).status, 429);
  assert.equal((await attacker.login("Svetlana", V.SEED_USER_PASSWORD)).status, 429);
  // Svetlana fra sin egen IP er ikke berørt.
  assert.equal((await new Client(dev.url, { ip: "10.0.0.68" }).login("Svetlana", V.SEED_USER_PASSWORD)).status, 200);
  assert.equal(await countEvents("auth.locked"), 1);
  assert.ok((await countEvents("auth.login_failed")) >= 5);
});

test("utlogging avslutter økten og sletter kapselen", async () => {
  const client = await loggedIn(dev.url, "Svetlana", V.SEED_USER_PASSWORD);
  const cookie = client.cookie;
  const out = await client.post("/api/auth/logout");
  assert.equal(out.status, 204);
  assert.match(out.setCookie, /Max-Age=0/);
  assert.equal(client.cookie, null);
  const reused = new Client(dev.url);
  reused.cookie = cookie;
  assert.equal((await reused.get("/api/auth/me")).status, 401);
  assert.ok((await countEvents("auth.logout")) >= 1);
});

test("passordbytte krever riktig nåværende passord og logger ut andre økter", async () => {
  await createUser("Passbytte", "gammelt-passord-1");
  const a = await loggedIn(dev.url, "Passbytte", "gammelt-passord-1", { ip: "10.1.0.1" });
  const b = await loggedIn(dev.url, "Passbytte", "gammelt-passord-1", { ip: "10.1.0.2" });
  const short = await a.post("/api/auth/password", { currentPassword: "gammelt-passord-1", newPassword: "kort" });
  assert.equal(short.status, 400);
  assert.equal(short.data.error, "Det nye passordet må ha minst 8 tegn.");
  const wrong = await a.post("/api/auth/password", { currentPassword: "feil-feil-feil", newPassword: "nytt-passord-2" });
  assert.equal(wrong.status, 400);
  assert.equal((await a.post("/api/auth/password", { currentPassword: "gammelt-passord-1", newPassword: "nytt-passord-2" })).status, 204);
  assert.equal((await a.get("/api/auth/me")).status, 200, "økten som byttet, fortsetter");
  assert.equal((await b.get("/api/auth/me")).status, 401, "andre økter logges ut");
  assert.equal((await new Client(dev.url, { ip: "10.1.0.3" }).login("Passbytte", "gammelt-passord-1")).status, 401);
  assert.equal((await new Client(dev.url, { ip: "10.1.0.3" }).login("passbytte", "nytt-passord-2")).status, 200);
  assert.equal(await countEvents("auth.password_changed"), 1);
});

test("deaktivert konto kan ikke logge inn, og åpne økter stoppes", async () => {
  const user = await createUser("Deaktiv", "deaktiv-passord-1");
  const client = await loggedIn(dev.url, "Deaktiv", "deaktiv-passord-1", { ip: "10.2.0.1" });
  assert.equal((await admin.patch(`/api/admin/users/${user.id}`, { disabled: true })).status, 200);
  assert.equal((await client.get("/api/auth/me")).status, 401);
  const res = await new Client(dev.url, { ip: "10.2.0.2" }).login("Deaktiv", "deaktiv-passord-1");
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "Kontoen er deaktivert.");
  assert.equal((await admin.patch(`/api/admin/users/${user.id}`, { disabled: false })).status, 200);
  assert.equal((await new Client(dev.url, { ip: "10.2.0.3" }).login("Deaktiv", "deaktiv-passord-1")).status, 200);
});

test("admin kan avslutte en bestemt økt", async () => {
  const keep = await loggedIn(dev.url, "Svetlana", V.SEED_USER_PASSWORD);
  const victim = await loggedIn(dev.url, "Svetlana", V.SEED_USER_PASSWORD);
  const token = victim.cookie.split("=")[1];
  const idPrefix = crypto.createHash("sha256").update(token).digest("hex").slice(0, 8);
  const list = await admin.get("/api/admin/sessions");
  const row = list.data.sessions.find((s) => s.idPrefix === idPrefix);
  assert.ok(row, "økten vises i listen");
  assert.equal(row.username, "Svetlana");
  assert.equal(row.active, true);
  assert.equal("id" in row, false, "full økt-id sendes aldri ut");
  assert.equal((await admin.post(`/api/admin/sessions/${idPrefix}/revoke`)).status, 204);
  assert.equal((await victim.get("/api/auth/me")).status, 401);
  assert.equal((await keep.get("/api/auth/me")).status, 200);
  assert.equal((await admin.post(`/api/admin/sessions/${idPrefix}/revoke`)).status, 404, "allerede avsluttet");
  const all = await admin.get("/api/admin/sessions?all=1");
  assert.ok(all.data.sessions.find((s) => s.idPrefix === idPrefix && s.revokedAt && s.revokedReason === "admin"));
  assert.ok((await countEvents("session.revoked")) >= 1);
});

test("tilgangskontroll: anonym får 401, vanlig bruker 403 på admin-API", async () => {
  const anon = new Client(dev.url);
  for (const path of ["/api/auth/me", "/api/jobs", "/api/documents", "/api/admin/overview"]) {
    const res = await anon.get(path);
    assert.equal(res.status, 401, path);
    assert.equal(res.data.error, "Du må logge inn.");
  }
  const svetlana = await loggedIn(dev.url, "Svetlana", V.SEED_USER_PASSWORD);
  for (const path of ["/api/admin/overview", "/api/admin/events", "/api/admin/users", "/api/admin/sessions", "/api/admin/jobs"]) {
    assert.equal((await svetlana.get(path)).status, 403, path);
  }
  assert.equal((await svetlana.post("/api/admin/users", { username: "x" })).status, 403);
});

test("Svetlana opprettes aldri på nytt, selv etter omstart med nytt passord i miljøet", async () => {
  const dir = dev.persistDir;
  await dev.stop({ keepData: true });
  dev = null;
  const restarted = await workerDev.start({
    persistDir: dir,
    vars: { SEED_USER_PASSWORD: "et-annet-testpassord-456", XAI_API_KEY: "" },
  });
  try {
    assert.equal((await new Client(restarted.url).login("Svetlana", V.SEED_USER_PASSWORD)).status, 200);
    assert.equal((await new Client(restarted.url).login("Svetlana", "et-annet-testpassord-456")).status, 401);
    assert.equal((await restarted.sql("SELECT COUNT(*) AS n FROM events WHERE type = 'user.seeded'"))[0].n, 1);

    // Uten API-nøkkel: admin ser det, og oversettelser kan ikke startes.
    const boss = await loggedIn(restarted.url, "admin", V.ADMIN_PASSWORD);
    assert.equal((await boss.get("/api/admin/overview")).data.apiKeyConfigured, false);
    const svetlana = await loggedIn(restarted.url, "Svetlana", V.SEED_USER_PASSWORD);
    const job = await svetlana.newJob();
    assert.equal((await svetlana.upload(job.id, "hei.txt", "Hello there\n")).status, 201);
    const start = await svetlana.post(`/api/jobs/${job.id}/start`);
    assert.equal(start.status, 503);
    assert.equal(start.data.error, "Tjenesten mangler API-nøkkel. Kontakt administrator.");
  } finally {
    await restarted.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
