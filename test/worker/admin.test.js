// Eierens admin-API mot ekte wrangler dev: enheter, oversikt med xAI-forbruk, sendinger med analyse og Grok-kall,
// manuell opplasting, status og «sett i kø igjen», test av xAI, svar, logg, økter og brukere.
// Prisene er ikke satt her, så kostnaden er ukjent (null) og bare tokens vises.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const workerDev = require("../helpers/worker-dev");
const { Client, newSecret, eventually } = require("./client");

const PHONE = "d4".repeat(32);
let dev;
let svetlana;
let admin;

test.before(async () => {
  dev = await workerDev.start({ vars: { XAI_PRICE_INPUT_PER_M: "", XAI_PRICE_OUTPUT_PER_M: "" } });
  [svetlana, admin] = [await dev.login("svetlana"), await dev.login("eier")];
});

test.after(async () => {
  if (dev) await dev.stop();
});

const fileOf = async (id) => (await admin.get("/api/admin/sendings?limit=200")).data.sendings.flatMap((s) => s.files).find((f) => f.id === id);
const until = (id, status) => eventually(async () => {
  const f = await fileOf(id);
  return f.status === status && f;
}, { timeoutMs: 20000, what: `filen blir ${status}` });

test("enheter: registrer (upsert), list, test-push, slå av ved BadDeviceToken og slett", async () => {
  const none = await admin.post("/api/admin/test-push");
  assert.deepEqual(none.data, { sent: 0, failed: 0, errors: ["Ingen iPhone er registrert ennå. Åpne InnNorsk-appen og logg inn."] });
  assert.equal((await admin.post("/api/admin/devices", { token: "ikke-hex", env: "sandbox" })).status, 400);
  assert.equal((await admin.post("/api/admin/devices", { token: PHONE, env: "test" })).status, 400);
  const first = await admin.post("/api/admin/devices", { token: PHONE.toUpperCase(), env: "sandbox", name: "Gammelt navn" });
  assert.equal(first.status, 200);
  const again = await admin.post("/api/admin/devices", { token: PHONE, env: "production", name: "Jonas sin iPhone" }, { headers: { "X-InnNorsk-Client": "ios" } });
  assert.deepEqual({ token: again.data.device.token, env: again.data.device.env, name: again.data.device.name, username: again.data.device.username },
    { token: PHONE, env: "production", name: "Jonas sin iPhone", username: "eier" });
  const list = (await admin.get("/api/admin/devices")).data.devices;
  assert.equal(list.length, 1);
  assert.equal((await dev.sql("SELECT source FROM events WHERE type = 'device.registered' ORDER BY id DESC LIMIT 1"))[0].source, "ios");

  dev.apns.reset();
  const ok = await admin.post("/api/admin/test-push");
  assert.deepEqual(ok.data, { sent: 1, failed: 0, errors: [] });
  const [push] = dev.apns.pushes;
  assert.equal(push.jwtValid, true);
  assert.deepEqual(push.payload.aps.alert, { title: "Testvarsel fra InnNorsk", body: "Varslene virker. Du får beskjed når det kommer nye filer." });
  assert.ok((await dev.sql("SELECT last_ok_at FROM devices"))[0].last_ok_at);

  const bad = "e5".repeat(32);
  await admin.post("/api/admin/devices", { token: bad, env: "sandbox", name: "Ødelagt" });
  dev.apns.failToken(bad, 400);
  const mixed = await admin.post("/api/admin/test-push");
  assert.deepEqual(mixed.data, { sent: 1, failed: 1, errors: ["Ødelagt: BadDeviceToken"] });
  const broken = (await admin.get("/api/admin/devices")).data.devices.find((d) => d.token === bad);
  assert.ok(broken.disabledAt);
  assert.equal(broken.lastError, "BadDeviceToken");
  assert.equal((await dev.sql("SELECT COUNT(*) AS n FROM events WHERE type = 'push.failed'"))[0].n, 1);

  assert.equal((await admin.del(`/api/admin/devices/${bad}`)).status, 204);
  assert.equal((await admin.del(`/api/admin/devices/${bad}`)).status, 404);
  assert.deepEqual((await admin.get("/api/admin/devices")).data.devices.map((d) => d.token), [PHONE]);
});

test("oversikt: xAI-forbruk siste døgn, tellere, lagring, enheter, brukere og estimatmodellen", async () => {
  const before = (await admin.get("/api/admin/overview")).data;
  assert.deepEqual(before.translator, {
    apiKeyConfigured: true, model: "grok-4.6", calls24h: 0, failedCalls24h: 0, tokens24h: { input: 0, output: 0 }, cost24h: null,
    lastCallAt: null, lastError: null, lastErrorAt: null,
  });
  assert.deepEqual(before.estimator, { a: 8, b: 0.006, samples: 0, source: "default" });
  assert.equal("agent" in before, false);

  const sending = await svetlana.send({ "a.txt": "Hello", "b.txt": "Hello!" });
  await until(sending.files[1].id, "done");
  const { data } = await admin.get("/api/admin/overview");
  const t = data.translator;
  assert.deepEqual([t.calls24h, t.failedCalls24h, t.cost24h, t.lastError], [2, 0, null, null]);
  assert.ok(t.tokens24h.input > 0 && t.tokens24h.output > 0, JSON.stringify(t.tokens24h));
  assert.ok(Date.now() - Date.parse(t.lastCallAt) < 60000);
  const [tokens] = await dev.sql("SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM grok_calls");
  assert.deepEqual(t.tokens24h, tokens);
  assert.deepEqual(data.counts, { waiting: 0, working: 0, doneToday: 2, failed: 0 });
  const outputs = (await dev.sql("SELECT SUM(output_bytes) AS n FROM files"))[0].n;
  assert.deepEqual(data.storage, { files: 4, bytes: 11 + outputs, deletedFiles: 0, deletedBytes: 0, retainDays: 30 });
  assert.deepEqual(data.devices.map((d) => d.token), [PHONE]);
  assert.equal(data.users, 2);
  assert.deepEqual(data.estimator, before.estimator, "under 8 kall: standardmodellen (og bufret i 60 s)");
});

test("sendinger for admin: brukernavn, analyse, Grok-forbruk, tid og tekniske detaljer", async () => {
  const { data } = await admin.get("/api/admin/sendings?limit=10");
  assert.deepEqual(Object.keys(data), ["sendings"]);
  const s = data.sendings[0];
  assert.deepEqual([s.username, s.displayName, s.status], ["svetlana", "Svetlana", "done"]);
  assert.ok(s.startedAt && s.finishedAt);
  const f = s.files.find((x) => x.name === "a.txt");
  assert.deepEqual(
    [f.status, f.outputName, f.outputSource, f.attempts, f.segments, f.chars, f.batches, f.calls, f.costUsd, f.error],
    ["done", "a (norsk).txt", "cloud", 1, 1, 5, 1, 1, null, null]
  );
  assert.ok(f.inputTokens > 0 && f.outputTokens > 0);
  assert.ok(f.estimateSeconds > 0 && f.durationSeconds >= 0);
  assert.equal("leaseUntil" in f, false);
  const [event] = await dev.sql("SELECT data_json FROM events WHERE type = 'sending.done' AND sending_id = ?", s.id);
  const stats = JSON.parse(event.data_json);
  assert.deepEqual({ ...stats, estimateSeconds: 0, actualSeconds: 0, inputTokens: 0, outputTokens: 0 },
    { estimateSeconds: 0, actualSeconds: 0, files: 2, done: 2, failed: 0, calls: 2, inputTokens: 0, outputTokens: 0, costUsd: null });
  assert.ok(stats.estimateSeconds > 0 && stats.actualSeconds >= 0 && stats.inputTokens > 0);
});

test("Grok-kallene for en fil, nyeste først, bare for admin", async () => {
  const s = (await admin.get("/api/admin/sendings?limit=1")).data.sendings[0];
  const id = s.files[0].id;
  const res = await admin.get(`/api/admin/files/${id}/calls`);
  assert.equal(res.status, 200);
  const [call] = res.data.calls;
  assert.equal(res.data.calls.length, 1);
  assert.deepEqual(
    [call.model, call.status, call.ok, call.attempt, call.items, call.costUsd, call.error, call.reasoningTokens],
    ["grok-4.6", 200, true, 1, 1, null, null, null]
  );
  assert.ok(call.inputChars > 0 && call.outputChars > 0 && call.ms >= 0 && call.inputTokens > 0 && call.outputTokens > 0 && call.ts);
  assert.match(dev.xai.state.requests[0].input, /Du er en profesjonell oversetter til norsk bokmål\./);
  assert.equal((await svetlana.get(`/api/admin/files/${id}/calls`)).status, 403);
  assert.equal((await admin.get("/api/admin/files/finnesikke/calls")).status, 404);
});

test("manuell opplasting av oversettelse gjør filen ferdig, og Svetlana kan laste den ned", async () => {
  const draft = await svetlana.newSending();
  const unsent = (await svetlana.upload(draft.id, "utkast.txt", "Hello")).data.file;
  assert.equal((await admin.put(`/api/admin/files/${unsent.id}/result?name=x.txt`, "x")).status, 409, "ikke sendt ennå");
  const sending = await svetlana.send({ "manuell.txt": "original" });
  const id = sending.files[0].id;
  await until(id, "done");
  const res = await admin.put(`/api/admin/files/${id}/result?name=${encodeURIComponent("manuell (norsk).txt")}`, "håndlaget");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const file = res.data.sending.files[0];
  assert.deepEqual([file.status, file.outputSource, file.outputName], ["done", "manual", "manuell (norsk).txt"]);
  assert.equal(res.data.sending.status, "done");
  assert.equal((await svetlana.get(`/api/files/${id}/result`)).data.toString(), "håndlaget");
  assert.equal((await svetlana.put(`/api/admin/files/${id}/result?name=x.docx`, "x")).status, 403);
});

test("status: feilet med melding til Svetlana, sett i kø igjen (ny Workflow-instans), og ferdig bare med resultat", async () => {
  const sending = await svetlana.send({ "status.txt": "Hello" });
  const id = sending.files[0].id;
  await until(id, "done");
  const failed = await admin.post(`/api/admin/files/${id}/status`, { status: "failed", message: "Dette er et skannet bilde – send gjerne originalen." });
  assert.equal(failed.status, 200);
  assert.equal(failed.data.sending.status, "done", "alle filer ferdige");
  const mine = async () => (await svetlana.get(`/api/sendings/${sending.id}`)).data.sending;
  assert.equal((await mine()).files[0].statusText, "Dette er et skannet bilde – send gjerne originalen.");
  assert.equal((await admin.post(`/api/admin/files/${id}/status`, { status: "working" })).status, 400);

  const calls = dev.xai.state.calls;
  const requeued = await admin.post(`/api/admin/files/${id}/status`, { status: "sent" });
  assert.equal(requeued.status, 200);
  assert.equal(requeued.data.sending.status, "sent", "sendingen er åpen igjen");
  assert.equal((await dev.sql("SELECT workflow_id FROM sendings WHERE id = ?", sending.id))[0].workflow_id, `${sending.id}-2`);
  const again = await until(id, "done");
  assert.deepEqual([again.attempts, again.outputSource, again.outputName, again.error], [2, "cloud", "status (norsk).txt", null]);
  assert.equal(dev.xai.state.calls, calls + 1, "oversatt på nytt");
  assert.equal((await mine()).status, "done");

  await admin.post(`/api/admin/files/${id}/status`, { status: "failed" });
  assert.equal((await mine()).files[0].statusText, "Kunne ikke oversettes. Jonas har fått beskjed.");
  const done = await admin.post(`/api/admin/files/${id}/status`, { status: "done" });
  assert.equal(done.data.sending.files[0].status, "done", "har resultat → kan merkes ferdig");
  const [event] = await dev.sql("SELECT message, source FROM events WHERE type = 'file.status_changed' ORDER BY id DESC LIMIT 1");
  assert.deepEqual([event.message, event.source], ["status.txt: failed → done", "web"]);

  const draft = await svetlana.newSending();
  const unreadable = (await svetlana.upload(draft.id, "skadet.docx", "ikke zip")).data.file;
  assert.equal((await admin.post(`/api/admin/files/${unreadable.id}/status`, { status: "sent" })).status, 409, "utkast kan ikke settes i kø");
});

test("«Test xAI»: ett lite kall med serverens nøkkel, maks ett i minuttet, logges uten fil (utenfor estimatet)", async () => {
  assert.equal((await svetlana.post("/api/admin/test-api")).status, 403);
  const res = await admin.post("/api/admin/test-api");
  assert.equal(res.status, 200);
  assert.deepEqual([res.data.ok, res.data.sample], [true, "OK"]);
  assert.ok(res.data.ms >= 0);
  const again = await admin.post("/api/admin/test-api");
  assert.deepEqual([again.status, again.data.error], [429, "Vent et minutt før du tester igjen."]);
  const [event] = await dev.sql("SELECT level, message, data_json FROM events WHERE type = 'admin.test_api'");
  assert.equal(event.level, "info");
  assert.equal(JSON.parse(event.data_json).model, "grok-4.6");
  const [call] = await dev.sql("SELECT sending_id, file_id, ok FROM grok_calls ORDER BY id DESC LIMIT 1");
  assert.deepEqual(call, { sending_id: null, file_id: null, ok: 1 });
});

test("svar til Svetlana vises på sendingen hennes", async () => {
  const sending = await svetlana.send({ "svar.txt": "Hello" });
  const res = await admin.post(`/api/admin/sendings/${sending.id}/reply`, { reply: "Takk, Svetlana! Ferdig i kveld 😊" });
  assert.equal(res.status, 200);
  assert.equal((await svetlana.get(`/api/sendings/${sending.id}`)).data.sending.reply, "Takk, Svetlana! Ferdig i kveld 😊");
  assert.equal((await admin.post("/api/admin/sendings/finnesikke/reply", { reply: "x" })).status, 404);
});

test("logg: filtrer på nivå, type (prefiks), kilde og tekst, og bla bakover", async () => {
  const get = async (q) => (await admin.get(`/api/admin/events?${q}`)).data;
  const warn = await get("level=warn&limit=500");
  assert.ok(warn.events.length > 0 && warn.events.every((e) => e.level === "warn"));
  const auth = await get("type=auth.&limit=500");
  assert.ok(auth.events.every((e) => e.type.startsWith("auth.")));
  assert.ok(auth.events.some((e) => e.type === "auth.login" && e.username === "eier"));
  const exact = await get("type=file.started");
  assert.ok(exact.events.length > 0 && exact.events.every((e) => e.type === "file.started" && e.source === "system"));
  assert.ok((await get("source=system&limit=500")).events.every((e) => e.source === "system"));
  const text = await get(`q=${encodeURIComponent("manuell.txt")}`);
  assert.ok(text.events.some((e) => e.type === "file.uploaded"));
  assert.deepEqual((await get(`q=${encodeURIComponent("100%_")}`)).events, [], "% og _ er vanlige tegn i søket");

  const page1 = await get("limit=5");
  assert.equal(page1.events.length, 5);
  assert.deepEqual(page1.events.map((e) => e.id), [...page1.events.map((e) => e.id)].sort((a, b) => b - a), "nyeste først");
  const page2 = await get(`limit=5&beforeId=${page1.nextBeforeId}`);
  assert.ok(page2.events.every((e) => e.id < page1.events[4].id));
  const sample = page1.events[0];
  for (const key of ["id", "ts", "level", "type", "message", "source", "userId", "username", "sessionId", "sendingId", "fileId", "ip", "data"]) {
    assert.ok(key in sample, key);
  }
});

test("aktivitet for Svetlana i Oversikt: sist innom, opplasting, sending, nedlasting, siste 7 dager og problemer siste døgn", async () => {
  const sending = await svetlana.send({ "aktiv.txt": "Hello" });
  const file = await until(sending.files[0].id, "done");
  assert.equal((await svetlana.get(`/api/files/${file.id}/result`)).status, 200);
  assert.equal((await admin.get(`/api/files/${file.id}/original`)).status, 200, "eierens egne nedlastinger teller ikke som hennes");
  const shown = "Feilmelding vist ved sending: «Noe gikk galt på serveren. Feilen er logget.»";
  assert.equal((await svetlana.post("/api/client-log", { type: "client.error_shown", message: shown, sendingId: sending.id, data: { where: "send" } })).status, 204);

  const { data } = await admin.get("/api/admin/overview");
  assert.deepEqual(data.activity.map((a) => a.username), ["svetlana"], "bare brukere som sender filer");
  const a = data.activity[0];
  const [me] = await dev.sql("SELECT id FROM users WHERE username = 'svetlana'");
  assert.deepEqual([a.userId, a.displayName, a.disabled], [me.id, "Svetlana", false]);
  for (const key of ["lastSeenAt", "lastLoginAt", "lastUploadAt", "lastSentAt", "lastDownloadAt"]) {
    assert.ok(Date.now() - Date.parse(a[key]) < 10 * 60000, `${key}: ${a[key]}`);
  }
  const [download] = await dev.sql("SELECT ts FROM events WHERE type = 'download.result' AND user_id = ? ORDER BY id DESC LIMIT 1", me.id);
  assert.equal(a.lastDownloadAt, download.ts);
  const [week] = await dev.sql("SELECT COUNT(*) AS n FROM sendings WHERE user_id = ? AND sent_at IS NOT NULL", me.id);
  assert.equal(a.week.sendings, week.n);
  assert.ok(a.week.files >= a.week.sendings && a.week.done >= 1, JSON.stringify(a.week));
  assert.equal(a.problems24h.errorsShown, 1);
  assert.ok(a.problems24h.total >= 2, "også den uleselige filen hun lastet opp");
  assert.deepEqual([a.problems24h.recent[0].type, a.problems24h.recent[0].message, a.problems24h.recent[0].sendingId],
    ["client.error_shown", shown, sending.id]);
  assert.ok(a.problems24h.recent.length <= 5);

  // «Vis loggen»: det hun gjorde, og det Workflowen gjorde med sendingene hennes, men ikke eierens egne handlinger.
  const events = async (q) => (await admin.get(`/api/admin/events?userId=${a.userId}&limit=500&${q}`)).data.events;
  const hers = await events("");
  assert.ok(hers.some((e) => e.type === "file.done" && e.userId === null && e.sendingId === sending.id), "Workflowens hendelser");
  assert.ok(hers.some((e) => e.type === "auth.login" && e.username === "svetlana"));
  assert.ok(hers.every((e) => e.userId === a.userId || e.userId === null));
  assert.ok(!hers.some((e) => e.username === "eier"), "ikke eierens nedlastinger eller «Sett i kø igjen»");
  const problems = await events("level=problems");
  assert.ok(problems.length >= 2 && problems.every((e) => ["warn", "error"].includes(e.level)));

  // Brukere: sist aktiv.
  const users = (await admin.get("/api/admin/users")).data.users;
  assert.ok(Date.now() - Date.parse(users.find((u) => u.username === "svetlana").lastSeenAt) < 10 * 60000);
});

test("økter: list og avslutt en bestemt økt", async () => {
  const victim = await dev.login("svetlana");
  const idPrefix = crypto.createHash("sha256").update(victim.cookie.split("=")[1]).digest("hex").slice(0, 8);
  const row = (await admin.get("/api/admin/sessions")).data.sessions.find((s) => s.idPrefix === idPrefix);
  assert.equal(row.username, "svetlana");
  assert.equal(row.active, true);
  assert.equal("id" in row, false, "full økt-id sendes aldri ut");
  assert.ok((await admin.get("/api/admin/sessions")).data.sessions.find((s) => s.current).username === "eier");
  assert.equal((await admin.post(`/api/admin/sessions/${idPrefix}/revoke`)).status, 204);
  assert.equal((await victim.get("/api/auth/me")).status, 401);
  assert.equal((await svetlana.get("/api/auth/me")).status, 200, "andre økter lever");
  assert.equal((await admin.post(`/api/admin/sessions/${idPrefix}/revoke`)).status, 404);
  assert.equal((await admin.post("/api/admin/sessions/xyz/revoke")).status, 400);
  const all = (await admin.get("/api/admin/sessions?all=1")).data.sessions;
  assert.ok(all.find((s) => s.idPrefix === idPrefix && s.revokedReason === "admin"));
});

test("brukere: opprett med bevis fra nettleseren, endre, deaktiver og nytt passord", async () => {
  const create = (body) => admin.post("/api/admin/users", { role: "user", ...body });
  assert.equal((await create({ username: "ugyldig navn", ...newSecret("passord-123") })).status, 400);
  assert.equal((await create({ username: "Vera", salt: "kort", iterations: 310000, proof: "x" })).status, 400);
  assert.equal((await create({ username: "Vera", ...newSecret("passord-123"), iterations: 1000 })).status, 400);
  assert.equal((await create({ username: "Vera", ...newSecret("passord-123"), role: "sjef" })).status, 400);
  const res = await create({ username: "Vera", displayName: "Vera V.", ...newSecret("vera-passord-1") });
  assert.equal(res.status, 201);
  assert.deepEqual(
    { username: res.data.user.username, displayName: res.data.user.displayName, role: res.data.user.role, mustChangePassword: res.data.user.mustChangePassword },
    { username: "Vera", displayName: "Vera V.", role: "user", mustChangePassword: true }
  );
  assert.equal((await create({ username: "vera", ...newSecret("x-passord-1") })).status, 409);
  const [stored] = await dev.sql("SELECT salt, iterations, verifier FROM users WHERE username = 'Vera'");
  assert.equal(stored.iterations, 310000);
  assert.match(stored.verifier, /^[0-9a-f]{64}$/);
  const vera = await dev.login("Vera", { password: "vera-passord-1" });
  assert.equal((await vera.get("/api/auth/me")).data.user.mustChangePassword, true);

  const id = res.data.user.id;
  assert.equal((await admin.patch(`/api/admin/users/${id}`, { displayName: "Vera Veras" })).data.user.displayName, "Vera Veras");
  const reset = await admin.post(`/api/admin/users/${id}/password`, { ...newSecret("nytt-vera-pass-2"), mustChangePassword: true });
  assert.equal(reset.status, 200);
  assert.equal((await vera.get("/api/auth/me")).status, 401, "gamle økter avsluttes");
  assert.equal((await new Client(dev.url).login("Vera", "vera-passord-1")).status, 401);
  assert.equal((await new Client(dev.url).login("Vera", "nytt-vera-pass-2")).status, 200);

  const me = (await admin.get("/api/auth/me")).data.user.id;
  assert.equal((await admin.patch(`/api/admin/users/${me}`, { role: "user" })).status, 400);
  assert.equal((await admin.patch(`/api/admin/users/${me}`, { disabled: true })).status, 400);
  assert.equal((await admin.patch(`/api/admin/users/${id}`, {})).status, 400);
  assert.equal((await admin.patch("/api/admin/users/9999", { disabled: true })).status, 404);
  const users = (await admin.get("/api/admin/users")).data.users;
  assert.deepEqual(users.map((u) => u.username), ["eier", "svetlana", "Vera"]);
  assert.ok(users.every((u) => !("verifier" in u) && !("salt" in u)));
  assert.equal((await dev.sql("SELECT COUNT(*) AS n FROM events WHERE type IN ('user.created', 'user.updated', 'user.password_reset')"))[0].n, 3);
});

test("enheter: ny registrering av samme token (ny eier, nytt miljø) slår den på igjen og fjerner gammel feil", async () => {
  const token = "f6".repeat(32);
  await admin.post("/api/admin/devices", { token, env: "sandbox", name: "Gammel iPhone" });
  dev.apns.failToken(token, 410);
  await admin.post("/api/admin/test-push");
  const [gone] = await dev.sql("SELECT disabled_at, last_error FROM devices WHERE token = ?", token);
  assert.ok(gone.disabled_at, "Unregistered slår av enheten");
  assert.equal(gone.last_error, "Unregistered");

  // Telefonen går videre til en annen admin og registrerer seg på nytt fra appen.
  const created = await admin.post("/api/admin/users", {
    username: "reserve", displayName: "Reserve", role: "admin", ...newSecret("reserve-pass-123"), mustChangePassword: false,
  });
  assert.equal(created.status, 201);
  const other = await dev.login("reserve", { password: "reserve-pass-123" });
  const again = await other.post("/api/admin/devices", { token: token.toUpperCase(), env: "production", name: "Ny iPhone" }, { headers: { "X-InnNorsk-Client": "ios" } });
  assert.equal(again.status, 200);
  assert.deepEqual(
    { env: again.data.device.env, name: again.data.device.name, username: again.data.device.username, disabledAt: again.data.device.disabledAt, lastError: again.data.device.lastError },
    { env: "production", name: "Ny iPhone", username: "reserve", disabledAt: null, lastError: null }
  );
  const [row] = await dev.sql("SELECT user_id, env, name, disabled_at, last_error FROM devices WHERE token = ?", token);
  assert.equal(row.user_id, created.data.user.id);
  assert.deepEqual([row.env, row.name, row.disabled_at, row.last_error], ["production", "Ny iPhone", null, null]);
  assert.equal((await dev.sql("SELECT COUNT(*) AS n FROM devices WHERE token = ?", token))[0].n, 1, "ingen duplikat");

  // Nå får den nye eieren testvarselet, ikke den gamle.
  dev.apns.reset();
  assert.deepEqual((await other.post("/api/admin/test-push")).data, { sent: 1, failed: 0, errors: [] });
  assert.deepEqual(dev.apns.pushes.map((p) => p.token), [token]);
  assert.ok(!(await admin.post("/api/admin/test-push")).data.errors.some((e) => e.startsWith("Ny iPhone")));

  // Fjerning fra appen (DELETE /api/admin/devices/:token, også med store bokstaver).
  const removed = await other.del(`/api/admin/devices/${token.toUpperCase()}`, { headers: { "X-InnNorsk-Client": "ios" } });
  assert.equal(removed.status, 204);
  assert.deepEqual(await dev.sql("SELECT token FROM devices WHERE token = ?", token), []);
  const [event] = await dev.sql("SELECT source, user_id FROM events WHERE type = 'device.deleted' ORDER BY id DESC LIMIT 1");
  assert.deepEqual([event.source, event.user_id], ["ios", created.data.user.id]);
});
