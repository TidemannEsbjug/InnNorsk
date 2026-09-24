// Innlogging med klientberegnet PBKDF2-bevis, økter, brems, CSRF, sider, sikkerhetshoder og make-user.js mot ekte wrangler dev.
// Workeren kjører her uten XAI_API_KEY, som før eieren har lagt inn nøkkelen.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { execFile } = require("node:child_process");
const workerDev = require("../helpers/worker-dev");
const { Client, proofFor, newSecret } = require("./client");

const WRONG = "Brukernavnet eller passordet stemmer ikke.";
const TOO_MANY = "For mange mislykkede forsøk. Vent 15 minutter og prøv igjen.";
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

let dev;
let admin;
let ipCounter = 0;
const freshIp = () => `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
const countEvents = async (type) => (await dev.sql("SELECT COUNT(*) AS n FROM events WHERE type = ?", type))[0].n;

test.before(async () => {
  dev = await workerDev.start({ vars: { XAI_API_KEY: "" } });
  admin = await dev.login("eier");
});

test.after(async () => {
  if (dev) await dev.stop();
});

async function createUser(username, password, extra = {}) {
  const res = await admin.post("/api/admin/users", { username, displayName: username, role: "user", ...newSecret(password), mustChangePassword: false, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.user;
}

test("sikkerhetshoder finnes på alle svar, også statiske filer og feil", async () => {
  const anon = new Client(dev.url);
  for (const p of ["/healthz", "/login", "/api/auth/me", "/api/finnes-ikke", "/finnes-ikke.png", "/"]) {
    const res = await anon.get(p);
    assert.equal(res.headers.get("content-security-policy"), CSP, p);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", p);
    assert.equal(res.headers.get("x-frame-options"), "DENY", p);
    assert.equal(res.headers.get("referrer-policy"), "same-origin", p);
    assert.equal(res.headers.get("strict-transport-security"), null, `${p}: ingen HSTS over http`);
  }
  assert.deepEqual((await anon.get("/healthz")).data, { ok: true });
  const missing = await admin.get("/api/finnes-ikke");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
});

test("sidene krever innlogging og riktig rolle", async () => {
  const anon = new Client(dev.url);
  assert.equal((await anon.get("/")).headers.get("location"), "/login");
  assert.equal((await anon.get("/admin")).headers.get("location"), "/login");
  assert.equal((await anon.get("/login")).status, 200);
  assert.equal((await anon.get("/admin.html")).headers.get("location"), "/admin", ".html-filene går via de beskyttede rutene");
  assert.equal((await anon.get("/index.html")).headers.get("location"), "/");
  const svetlana = await dev.login("svetlana");
  assert.equal((await svetlana.get("/login")).headers.get("location"), "/");
  assert.equal((await svetlana.get("/")).status, 200);
  assert.equal((await svetlana.get("/admin")).headers.get("location"), "/");
  assert.equal((await admin.get("/admin")).status, 200);
  assert.equal((await admin.get("/")).status, 200, "admin kan også bruke sendesiden");
});

test("salt: ekte for kjente brukere, stabilt falskt for ukjente – umulig å skille", async () => {
  const anon = new Client(dev.url);
  const salt = async (username) => (await anon.post("/api/auth/salt", { username })).data;
  const [row] = await dev.sql("SELECT salt, iterations FROM users WHERE username = 'svetlana'");
  assert.deepEqual(await salt("svetlana"), { salt: row.salt, iterations: 310000 });
  assert.deepEqual(await salt(" SVETLANA "), { salt: row.salt, iterations: 310000 });
  const fake = await salt("finnes-ikke");
  assert.deepEqual(await salt("Finnes-Ikke"), fake, "stabilt");
  assert.notEqual((await salt("finnes-heller-ikke")).salt, fake.salt);
  assert.equal(fake.iterations, 310000);
  assert.equal(fake.salt.length, row.salt.length);
  assert.match(fake.salt, /^[A-Za-z0-9_-]+$/);
  assert.equal((await anon.post("/api/auth/salt", {})).status, 400);
});

test("innlogging med riktig bevis gir økt; kapselen er HttpOnly/SameSite=Lax uten Secure over http", async () => {
  const client = new Client(dev.url, { ip: freshIp() });
  const res = await client.login("SVETLANA", dev.users.svetlana.password);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.user, { id: res.data.user.id, username: "svetlana", displayName: "Svetlana", role: "user", mustChangePassword: false });
  assert.match(res.setCookie, /^innnorsk_sid=[A-Za-z0-9_-]{43};/);
  for (const attr of [/HttpOnly/, /SameSite=Lax/, /Path=\//, /Max-Age=2592000/]) assert.match(res.setCookie, attr);
  assert.doesNotMatch(res.setCookie, /Secure/);
  const token = client.cookie.split("=")[1];
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  assert.equal((await dev.sql("SELECT COUNT(*) AS n FROM sessions WHERE id = ?", hash))[0].n, 1, "D1 har bare sha256 av tokenet");
  const me = await client.get("/api/auth/me");
  assert.equal(me.data.user.username, "svetlana");
  assert.equal(me.data.translatorName, "Jonas");
  assert.deepEqual(me.data.limits, { maxFileMb: 50, maxFilesPerSending: 50 });
});

test("innlogging og utlogging fra iPhone-appen (X-InnNorsk-Client: ios) logges med kilde ios, nettleseren med web", async () => {
  const sourceOf = async (type, sessionId) =>
    (await dev.sql("SELECT source FROM events WHERE type = ? AND session_id = ? ORDER BY id DESC LIMIT 1", type, sessionId))[0].source;
  for (const [headers, source] of [[{ "X-InnNorsk-Client": "ios" }, "ios"], [{}, "web"]]) {
    const client = new Client(dev.url, { ip: freshIp() });
    const { data } = await client.post("/api/auth/salt", { username: "eier" }, { headers });
    const proof = proofFor(dev.users.eier.password, data.salt, data.iterations);
    assert.equal((await client.post("/api/auth/login", { username: "eier", proof }, { headers })).status, 200);
    const sessionId = crypto.createHash("sha256").update(client.cookie.split("=")[1]).digest("hex").slice(0, 8);
    assert.equal(await sourceOf("auth.login", sessionId), source);
    assert.equal((await client.post("/api/auth/logout", undefined, { headers })).status, 204);
    assert.equal(await sourceOf("auth.logout", sessionId), source);
  }
  const failed = await new Client(dev.url, { ip: freshIp() }).post("/api/auth/login", { username: "eier", proof: "A".repeat(43) }, { headers: { "X-InnNorsk-Client": "ios" } });
  assert.equal(failed.status, 401);
  assert.equal((await dev.sql("SELECT source FROM events WHERE type = 'auth.login_failed' ORDER BY id DESC LIMIT 1"))[0].source, "ios");
});

test("feil passord og ukjent bruker gir samme norske melding", async () => {
  const anon = new Client(dev.url, { ip: freshIp() });
  const wrong = await anon.login("svetlana", "feil-passord-000");
  const unknown = await anon.login("finnes-ikke", "feil-passord-000");
  assert.deepEqual([wrong.status, wrong.data.error], [401, WRONG]);
  assert.deepEqual([unknown.status, unknown.data.error], [401, WRONG]);
  assert.equal((await anon.post("/api/auth/login", { username: "svetlana", proof: "kort" })).status, 400);
  assert.equal((await anon.post("/api/auth/login", { username: "", proof: "x".repeat(43) })).status, 400);
  const bad = await anon.req("POST", "/api/auth/login", { body: "{ikke json", headers: { "Content-Type": "application/json" } });
  assert.equal(bad.status, 400);
});

test("fem feil på 15 minutter sperrer brukernavnet og IP-en (429)", async () => {
  await createUser("Bremse", "riktig-passord-1");
  const attacker = new Client(dev.url, { ip: "10.0.0.66" });
  for (let i = 0; i < 5; i++) assert.equal((await attacker.login("bremse", `feil-${i}-passord`)).status, 401, `forsøk ${i + 1}`);
  const locked = await attacker.login("Bremse", "riktig-passord-1");
  assert.deepEqual([locked.status, locked.data.error], [429, TOO_MANY]);
  assert.equal((await new Client(dev.url, { ip: "10.0.0.67" }).login("Bremse", "riktig-passord-1")).status, 429, "samme bruker, ny IP");
  assert.equal((await attacker.login("svetlana", dev.users.svetlana.password)).status, 429, "samme IP, annen bruker");
  assert.equal((await new Client(dev.url, { ip: "10.0.0.68" }).login("svetlana", dev.users.svetlana.password)).status, 200);
  assert.equal(await countEvents("auth.locked"), 1);
  assert.ok((await countEvents("auth.login_failed")) >= 5);
});

test("deaktivert konto: riktig passord gir 403, åpne økter stoppes", async () => {
  const user = await createUser("Deaktiv", "deaktiv-passord-1");
  const client = await dev.login("Deaktiv", { password: "deaktiv-passord-1", ip: freshIp() });
  assert.equal((await admin.patch(`/api/admin/users/${user.id}`, { disabled: true })).status, 200);
  assert.equal((await client.get("/api/auth/me")).status, 401);
  const res = await new Client(dev.url, { ip: freshIp() }).login("Deaktiv", "deaktiv-passord-1");
  assert.deepEqual([res.status, res.data.error], [403, "Kontoen er deaktivert."]);
  assert.equal((await new Client(dev.url, { ip: freshIp() }).login("Deaktiv", "feil-passord-1")).status, 401);
  assert.equal((await admin.patch(`/api/admin/users/${user.id}`, { disabled: false })).status, 200);
  assert.equal((await new Client(dev.url, { ip: freshIp() }).login("Deaktiv", "deaktiv-passord-1")).status, 200);
});

test("utlogging avslutter økten og sletter kapselen", async () => {
  const client = await dev.login("svetlana", { ip: freshIp() });
  const cookie = client.cookie;
  const out = await client.post("/api/auth/logout");
  assert.equal(out.status, 204);
  assert.match(out.setCookie, /Max-Age=0/);
  const reused = new Client(dev.url);
  reused.cookie = cookie;
  assert.equal((await reused.get("/api/auth/me")).status, 401);
  assert.ok((await countEvents("auth.logout")) >= 1);
});

test("CSRF: endringer uten X-InnNorsk-hodet avvises med 403", async () => {
  const svetlana = await dev.login("svetlana", { ip: freshIp() });
  const blocked = await svetlana.req("POST", "/api/sendings", { json: { targetLanguage: "bokmal" }, csrf: false });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /avvist/);
  assert.equal((await svetlana.req("POST", "/api/auth/logout", { csrf: false })).status, 403);
  assert.equal((await new Client(dev.url).req("POST", "/api/auth/salt", { json: { username: "x" }, csrf: false })).status, 403);
  assert.equal((await svetlana.get("/api/auth/me")).status, 200, "GET trenger ikke hodet");
});

test("passordbytte krever riktig nåværende passord og logger ut andre økter", async () => {
  await createUser("Passbytte", "gammelt-passord-1");
  const a = await dev.login("Passbytte", { password: "gammelt-passord-1", ip: freshIp() });
  const b = await dev.login("Passbytte", { password: "gammelt-passord-1", ip: freshIp() });
  const { data: current } = await a.post("/api/auth/salt", { username: "Passbytte" });
  const currentProof = proofFor("gammelt-passord-1", current.salt, current.iterations);
  const wrong = await a.post("/api/auth/password", { currentProof: proofFor("feil-feil-feil", current.salt, current.iterations), ...newSecret("nytt-passord-2") });
  assert.deepEqual([wrong.status, wrong.data.error], [400, "Det nåværende passordet stemmer ikke."]);
  const weak = await a.post("/api/auth/password", { currentProof, ...newSecret("nytt-passord-2"), iterations: 1000 });
  assert.equal(weak.status, 400, "for få iterasjoner");
  assert.equal((await a.post("/api/auth/password", { currentProof, ...newSecret("nytt-passord-2") })).status, 204);
  assert.equal((await a.get("/api/auth/me")).status, 200, "økten som byttet, fortsetter");
  assert.equal((await b.get("/api/auth/me")).status, 401, "andre økter logges ut");
  assert.equal((await new Client(dev.url, { ip: freshIp() }).login("Passbytte", "gammelt-passord-1")).status, 401);
  assert.equal((await new Client(dev.url, { ip: freshIp() }).login("passbytte", "nytt-passord-2")).status, 200);
  assert.equal(await countEvents("auth.password_changed"), 1);
});

test("må bytte passord: alt annet enn auth er stengt til passordet er byttet", async () => {
  await createUser("Nyansatt", "midlertidig-pass-1", { mustChangePassword: true });
  const client = new Client(dev.url, { ip: freshIp() });
  const login = await client.login("Nyansatt", "midlertidig-pass-1");
  assert.equal(login.data.user.mustChangePassword, true);
  assert.equal((await client.get("/api/auth/me")).data.user.mustChangePassword, true);
  const blocked = await client.get("/api/sendings");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.mustChangePassword, true);
  const { data: current } = await client.post("/api/auth/salt", { username: "Nyansatt" });
  const currentProof = proofFor("midlertidig-pass-1", current.salt, current.iterations);
  assert.equal((await client.post("/api/auth/password", { currentProof, ...newSecret("mitt-eget-pass-2") })).status, 204);
  assert.equal((await client.get("/api/auth/me")).data.user.mustChangePassword, false);
  assert.equal((await client.get("/api/sendings")).status, 200);
});

test("tilgang: anonym får 401, vanlig bruker 403 på admin-API", async () => {
  const anon = new Client(dev.url);
  for (const p of ["/api/auth/me", "/api/sendings", "/api/admin/overview"]) {
    const res = await anon.get(p);
    assert.deepEqual([res.status, res.data.error], [401, "Du må logge inn."], p);
  }
  const svetlana = await dev.login("svetlana", { ip: freshIp() });
  for (const p of ["/api/admin/overview", "/api/admin/events", "/api/admin/users", "/api/admin/sessions", "/api/admin/sendings", "/api/admin/devices"]) {
    assert.equal((await svetlana.get(p)).status, 403, p);
  }
  assert.equal((await svetlana.post("/api/admin/users", { username: "x" })).status, 403);
  assert.equal((await svetlana.post("/api/admin/test-push")).status, 403);
});

test("klientlogg: nettleser- og iPhone-feil havner i loggen, maks 30 i minuttet per økt", async () => {
  const svetlana = await dev.login("svetlana", { ip: freshIp() });
  assert.equal((await svetlana.post("/api/client-log", { level: "error", message: "TypeError: x", stack: "at app.js:1", url: "/" })).status, 204);
  assert.equal((await svetlana.post("/api/client-log", { message: "Krasj i appen" }, { headers: { "X-InnNorsk-Client": "ios" } })).status, 204);
  const rows = await dev.sql("SELECT source, message, user_id FROM events WHERE type = 'client.error' ORDER BY id DESC LIMIT 2");
  assert.deepEqual(rows.map((r) => [r.source, r.message]), [["ios", "Krasj i appen"], ["web", "TypeError: x"]]);
  for (let i = 0; i < 28; i++) await svetlana.post("/api/client-log", { message: `feil ${i}` });
  assert.equal((await svetlana.post("/api/client-log", { message: "en for mye" })).status, 429);
  assert.equal((await new Client(dev.url).post("/api/client-log", { message: "anonym" })).status, 401);
});

test("make-user.js: CLI-en lager brukeren i D1, innlogging virker, og ny kjøring bytter passord og logger ut", async () => {
  const run = (password) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [
      path.join(__dirname, "../../scripts/make-user.js"), "Olga", "--role", "user", "--display-name", "Olga Å.",
      "--local", "--persist-to", dev.persistDir, "--apply",
    ], { cwd: path.join(__dirname, "../.."), env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n${stdout}\n${stderr}`));
      else resolve(stdout + stderr);
    });
    child.stdin.end(`${password}\n${password}\n`);
  });
  const out = await run("olgas-passord-1");
  assert.match(out, /npx wrangler d1 execute innnorsk --local --persist-to \S+ --command 'INSERT INTO users/);
  assert.doesNotMatch(out, /olgas-passord-1/, "passordet skrives aldri ut");
  const olga = new Client(dev.url, { ip: freshIp() });
  const res = await olga.login("olga", "olgas-passord-1");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.user.displayName, "Olga Å.");

  await run("olgas-nye-passord-2");
  assert.equal((await olga.get("/api/auth/me")).status, 401, "gamle økter er avsluttet");
  assert.equal((await new Client(dev.url, { ip: freshIp() }).login("olga", "olgas-passord-1")).status, 401);
  assert.equal((await new Client(dev.url, { ip: freshIp() }).login("olga", "olgas-nye-passord-2")).status, 200);
  assert.equal((await dev.sql("SELECT COUNT(*) AS n FROM users WHERE username = 'Olga'"))[0].n, 1);
});

test("uten XAI_API_KEY: sendingen avvises vennlig (503), og «Test xAI» og oversikten sier hva som mangler", async () => {
  const svetlana = await dev.login("svetlana", { ip: freshIp() });
  const sending = await svetlana.newSending();
  assert.equal((await svetlana.upload(sending.id, "brev.txt", "Hello")).status, 201);
  const res = await svetlana.post(`/api/sendings/${sending.id}/send`);
  assert.deepEqual([res.status, res.data.error], [503, "Oversettelsen er ikke satt opp ennå. Si fra til Jonas."]);
  assert.equal((await svetlana.get(`/api/sendings/${sending.id}`)).data.sending.status, "draft", "hun kan sende når nøkkelen er på plass");
  const check = await admin.post("/api/admin/test-api");
  assert.deepEqual([check.data.ok, check.data.error], [false, "XAI_API_KEY er ikke satt på serveren (npx wrangler secret put XAI_API_KEY)."]);
  assert.equal((await admin.get("/api/admin/overview")).data.translator.apiKeyConfigured, false);
  assert.equal(dev.xai.state.calls, 0, "ingen kall mot xAI");
});
