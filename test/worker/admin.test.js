// Admin-API og klientlogg mot wrangler dev + falsk xAI.
const test = require("node:test");
const assert = require("node:assert/strict");
const workerDev = require("../helpers/worker-dev");
const mockServer = require("../helpers/mock-xai-server");
const { Client, loggedIn } = require("./client");

const { DEFAULT_VARS: V } = workerDev;

let dev;
let mock;
let admin;
let svetlana;
let job;

test.before(async () => {
  mock = await mockServer.start({ mode: "upper" });
  dev = await workerDev.start({ mockUrl: mock.url });
  admin = await loggedIn(dev.url, "admin", V.ADMIN_PASSWORD);
  svetlana = await loggedIn(dev.url, "Svetlana", V.SEED_USER_PASSWORD);
  job = await svetlana.translate({
    "ok.txt": "Hello admin\n\nSecond part\n",
    "feil.txt": `Breaks ${mockServer.FAIL_MARKER}\n`,
  });
});

test.after(async () => {
  if (dev) await dev.stop();
  if (mock) await mock.close();
});

test("oversikten viser nøkkelstatus, bruk, lagring og estimator", async () => {
  const { status, data } = await admin.get("/api/admin/overview");
  assert.equal(status, 200);
  assert.equal(data.apiKeyConfigured, true);
  assert.equal(data.model, "grok-4.6");
  assert.equal(data.users, 2);
  assert.ok(data.activeSessions >= 2);
  assert.equal(data.jobs24h, 1);
  assert.equal(data.failedFiles24h, 1);
  assert.equal(data.calls24h, mock.state.calls);
  assert.ok(data.tokens24h.input > 0 && data.tokens24h.output > 0);
  assert.deepEqual(data.storage.objects, 3, "original + utfil for ok.txt, original for feil.txt");
  assert.ok(data.storage.bytes > 0);
  assert.deepEqual(Object.keys(data.estimator).sort(), ["a", "accuracy", "b", "samples", "source"]);
  assert.equal(data.estimator.source, "default");
  assert.deepEqual(Object.keys(data.estimator.accuracy).sort(), ["jobs", "medianAbsPctError"]);
  assert.equal("XAI_API_KEY" in data, false);
});

test("loggen kan filtreres og blas bakover", async () => {
  const all = (await admin.get("/api/admin/events?limit=500")).data.events;
  assert.ok(all.length > 10);
  assert.ok(all.every((e, i) => i === 0 || all[i - 1].id > e.id), "nyeste først");

  const logins = (await admin.get("/api/admin/events?type=auth.login")).data.events;
  assert.ok(logins.length >= 2 && logins.every((e) => e.type === "auth.login"));
  assert.ok(logins.some((e) => e.username === "Svetlana"));
  const prefixed = (await admin.get("/api/admin/events?type=file.")).data.events;
  assert.ok(prefixed.length && prefixed.every((e) => e.type.startsWith("file.")));
  const warnings = (await admin.get("/api/admin/events?level=error")).data.events;
  assert.ok(warnings.length && warnings.every((e) => e.level === "error"));
  const forJob = (await admin.get(`/api/admin/events?jobId=${job.job.id}`)).data.events;
  assert.ok(forJob.length && forJob.every((e) => e.jobId === job.job.id));
  const forUser = (await admin.get(`/api/admin/events?userId=${job.job.userId}`)).data.events;
  assert.ok(forUser.length && forUser.every((e) => e.userId === job.job.userId));
  const search = (await admin.get(`/api/admin/events?q=${encodeURIComponent("ok.txt er oversatt")}`)).data.events;
  assert.equal(search.length, 1);
  assert.equal(search[0].type, "file.done");
  assert.equal(typeof search[0].data, "object");
  assert.equal((await admin.get("/api/admin/events?q=100%25_")).data.events.length, 0, "% og _ er vanlige tegn");

  const page1 = (await admin.get("/api/admin/events?limit=3")).data.events;
  const page2 = (await admin.get(`/api/admin/events?limit=3&beforeId=${page1[2].id}`)).data.events;
  assert.equal(page1.length, 3);
  assert.equal(page2.length, 3);
  assert.ok(page2[0].id < page1[2].id);
});

test("brukere: opprett med engangspassord, endre, nullstill og vern mot å låse seg selv ute", async () => {
  const list = (await admin.get("/api/admin/users")).data.users;
  assert.deepEqual(list.map((u) => [u.username, u.role]), [["admin", "admin"], ["Svetlana", "user"]]);
  assert.ok(list.every((u) => !("password_hash" in u) && !("passwordHash" in u)));

  const created = await admin.post("/api/admin/users", { username: "Øyvind", displayName: "Øyvind Ås", role: "user" });
  assert.equal(created.status, 201);
  const { user, password } = created.data;
  assert.match(password, /^[A-Za-z2-9]{14}$/);
  assert.equal(user.mustChangePassword, true);
  assert.equal(user.displayName, "Øyvind Ås");
  const oyvind = await loggedIn(dev.url, "øYVIND", password);
  assert.equal((await oyvind.get("/api/auth/me")).data.user.mustChangePassword, true);

  assert.equal((await admin.post("/api/admin/users", { username: "øyvind" })).status, 409);
  assert.equal((await admin.post("/api/admin/users", { username: "SVETLANA" })).status, 409);
  assert.equal((await admin.post("/api/admin/users", { username: "med mellomrom" })).status, 400);
  assert.equal((await admin.post("/api/admin/users", { username: "kort", password: "1234567" })).status, 400);
  assert.equal((await admin.post("/api/admin/users", { username: "rolle", role: "sjef" })).status, 400);
  const own = await admin.post("/api/admin/users", { username: "Egenvalgt", password: "valgt-passord-1" });
  assert.equal(own.data.user.mustChangePassword, false);
  assert.equal((await new Client(dev.url).login("egenvalgt", "valgt-passord-1")).status, 200);

  const patched = await admin.patch(`/api/admin/users/${user.id}`, { displayName: "Øyvind", role: "admin" });
  assert.equal(patched.status, 200);
  assert.deepEqual([patched.data.user.displayName, patched.data.user.role], ["Øyvind", "admin"]);
  assert.equal((await admin.patch(`/api/admin/users/${user.id}`, {})).status, 400);
  assert.equal((await admin.patch("/api/admin/users/9999", { role: "user" })).status, 404);

  const me = (await admin.get("/api/auth/me")).data.user;
  const demote = await admin.patch(`/api/admin/users/${me.id}`, { role: "user" });
  assert.deepEqual([demote.status, demote.data.error], [400, "Du kan ikke fjerne din egen administratortilgang."]);
  const disable = await admin.patch(`/api/admin/users/${me.id}`, { disabled: true });
  assert.deepEqual([disable.status, disable.data.error], [400, "Du kan ikke deaktivere din egen konto."]);

  const reset = await admin.post(`/api/admin/users/${user.id}/reset-password`);
  assert.equal(reset.status, 200);
  assert.match(reset.data.password, /^[A-Za-z2-9]{14}$/);
  assert.equal((await oyvind.get("/api/auth/me")).status, 401, "gamle økter avsluttes");
  assert.equal((await new Client(dev.url).login("Øyvind", password)).status, 401);
  assert.equal((await new Client(dev.url).login("Øyvind", reset.data.password)).status, 200);

  const events = await dev.sql("SELECT type, data_json FROM events WHERE type LIKE 'user.%' ORDER BY id");
  const types = events.map((e) => e.type);
  for (const t of ["user.seeded", "user.created", "user.updated", "user.password_reset"]) assert.ok(types.includes(t), t);
  const dump = JSON.stringify(events);
  assert.ok(!dump.includes(password) && !dump.includes(reset.data.password), "passord logges aldri");
});

test("økter: listen viser min egen økt", async () => {
  const sessions = (await admin.get("/api/admin/sessions")).data.sessions;
  const mine = sessions.filter((s) => s.current);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].username, "admin");
  assert.match(mine[0].idPrefix, /^[0-9a-f]{8}$/);
  assert.equal(mine[0].userAgent, "node");
  assert.equal(mine[0].ip, "127.0.0.1");
  assert.equal((await admin.post("/api/admin/sessions/ikke-hex/revoke")).status, 400);
});

test("jobber: liste med brukernavn og detaljer med filer, hendelser og kall", async () => {
  const jobs = (await admin.get("/api/admin/jobs")).data.jobs;
  const row = jobs.find((j) => j.id === job.job.id);
  assert.equal(row.username, "Svetlana");
  assert.equal(row.status, "partial");
  assert.equal(row.deleted, false);
  const filtered = (await admin.get(`/api/admin/jobs?userId=${job.job.userId + 1000}`)).data.jobs;
  assert.equal(filtered.length, 0);

  const detail = (await admin.get(`/api/admin/jobs/${job.job.id}`)).data;
  assert.equal(detail.job.username, "Svetlana");
  assert.equal(detail.files.length, 2);
  const failed = detail.files.find((f) => f.status === "failed");
  assert.ok("errorDetails" in failed && failed.deleted === false);
  assert.match(failed.error, /^\[bad_response\]/);
  assert.ok(detail.events.some((e) => e.type === "job.finished"));
  assert.ok(detail.events.every((e, i) => i === 0 || detail.events[i - 1].id < e.id), "eldste først");
  assert.ok(detail.calls.length >= 2);
  const call = detail.calls.find((c) => c.ok);
  assert.deepEqual(
    Object.keys(call).sort(),
    ["attempt", "error", "fileId", "id", "inputChars", "inputTokens", "items", "model", "ms", "ok", "outputChars", "outputTokens", "reasoningTokens", "status", "ts"]
  );
  assert.equal(call.status, 200);
  assert.ok(detail.calls.some((c) => !c.ok && c.status === 400));
  assert.equal((await admin.get("/api/admin/jobs/finnes-ikke")).status, 404);
});

test("test av API-tilkoblingen: ett lite kall, maks én gang i minuttet", async () => {
  const before = mock.state.calls;
  const res = await admin.post("/api/admin/test-api");
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.sample, "OK");
  assert.ok(Number.isFinite(res.data.ms));
  assert.equal(mock.state.calls, before + 1);
  const again = await admin.post("/api/admin/test-api");
  assert.equal(again.status, 429);
  assert.equal(mock.state.calls, before + 1);
  const rows = await dev.sql("SELECT ok, job_id FROM grok_calls WHERE job_id IS NULL");
  assert.deepEqual(rows, [{ ok: 1, job_id: null }]);
  assert.equal((await dev.sql("SELECT COUNT(*) AS n FROM events WHERE type = 'admin.test_api'"))[0].n, 1);
});

test("klientlogg: krever innlogging og CSRF, kutter lange felt og bremser etter 30 per minutt", async () => {
  assert.equal((await new Client(dev.url).post("/api/client-log", { message: "x" })).status, 401);
  const client = await loggedIn(dev.url, "Svetlana", V.SEED_USER_PASSWORD);
  assert.equal((await client.req("POST", "/api/client-log", { json: { message: "x" }, csrf: false })).status, 403);
  const long = await client.post("/api/client-log", { level: "warn", message: "m".repeat(900), stack: "s".repeat(5000) });
  assert.equal(long.status, 204);
  const [row] = await dev.sql("SELECT level, message, data_json FROM events WHERE type = 'client.error' ORDER BY id DESC LIMIT 1");
  assert.equal(row.level, "warn");
  assert.equal(row.message.length, 500);
  assert.equal(JSON.parse(row.data_json).stack.length, 4000);
  for (let i = 1; i < 30; i++) assert.equal((await client.post("/api/client-log", { message: `feil ${i}` })).status, 204);
  assert.equal((await client.post("/api/client-log", { message: "for mye" })).status, 429);
  assert.equal((await svetlana.post("/api/client-log", { message: "annen økt" })).status, 204, "grensen gjelder per økt");
});
