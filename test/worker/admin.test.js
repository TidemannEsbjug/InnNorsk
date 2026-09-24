// Eierens admin-API mot ekte wrangler dev: oversikt, sendinger, manuell opplasting, status, svar, logg, økter, brukere og enheter.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const workerDev = require("../helpers/worker-dev");
const { Client, newSecret } = require("./client");

const PHONE = "d4".repeat(32);
let dev;
let svetlana;
let admin;
let agent;

test.before(async () => {
  dev = await workerDev.start();
  [svetlana, admin] = [await dev.login("svetlana"), await dev.login("eier")];
  agent = dev.agent();
});

test.after(async () => {
  if (dev) await dev.stop();
});

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

test("oversikt: agent, tellere, lagring, enheter og brukere", async () => {
  await agent.post("/api/agent/poll", { host: "mac-mini", version: "2.0.0", state: "idle", grokOk: true });
  const sending = await svetlana.send({ "a.txt": "Hello", "b.txt": "Hello!" });
  await agent.post(`/api/agent/files/${sending.files[0].id}/claim`);
  const { data } = await admin.get("/api/admin/overview");
  assert.deepEqual(data.agent, { online: true, lastSeenAt: data.agent.lastSeenAt, host: "mac-mini", version: "2.0.0", state: "idle", stateMessage: null, grokOk: true });
  assert.deepEqual(data.counts, { waiting: 1, working: 1, doneToday: 0, failed: 0 });
  assert.deepEqual(data.storage, { files: 2, bytes: 11 });
  assert.deepEqual(data.devices.map((d) => d.token), [PHONE]);
  assert.equal(data.users, 2);
});

test("sendinger for admin viser brukernavn og tekniske detaljer", async () => {
  const { data } = await admin.get("/api/admin/sendings?limit=10");
  const s = data.sendings[0];
  assert.equal(s.username, "svetlana");
  assert.equal(s.displayName, "Svetlana");
  assert.deepEqual(Object.keys(s.files[0]).filter((k) => ["error", "errorDetails", "attempts", "costUsd", "outputSource", "leaseUntil"].includes(k)).sort(),
    ["attempts", "costUsd", "error", "errorDetails", "leaseUntil", "outputSource"]);
  assert.equal(typeof data.agentOnline, "boolean");
});

test("manuell opplasting av oversettelse gjør filen ferdig, og Svetlana kan laste den ned", async () => {
  const sending = await svetlana.send({ "manuell.docx": "original" });
  const id = sending.files[0].id;
  const res = await admin.put(`/api/admin/files/${id}/result?name=${encodeURIComponent("manuell (norsk).docx")}`, "håndlaget");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const file = res.data.sending.files[0];
  assert.deepEqual([file.status, file.outputSource, file.outputName], ["done", "manual", "manuell (norsk).docx"]);
  assert.equal(res.data.sending.status, "done");
  assert.equal((await svetlana.get(`/api/files/${id}/result`)).data.toString(), "håndlaget");
  assert.equal((await svetlana.put(`/api/admin/files/${id}/result?name=x.docx`, "x")).status, 403);
});

test("status: sett i kø igjen, merk som feilet med melding til Svetlana, og ferdig bare med resultat", async () => {
  const sending = await svetlana.send({ "status.txt": "Hello" });
  const id = sending.files[0].id;
  const failed = await admin.post(`/api/admin/files/${id}/status`, { status: "failed", message: "Dette er et skannet bilde – send gjerne originalen." });
  assert.equal(failed.status, 200);
  assert.equal(failed.data.sending.status, "done", "alle filer ferdige");
  const mine = (await svetlana.get(`/api/sendings/${sending.id}`)).data.sending.files[0];
  assert.equal(mine.statusText, "Dette er et skannet bilde – send gjerne originalen.");
  assert.equal((await admin.post(`/api/admin/files/${id}/status`, { status: "done" })).status, 409, "ingen oversettelse ennå");
  assert.equal((await admin.post(`/api/admin/files/${id}/status`, { status: "working" })).status, 400);

  const requeued = await admin.post(`/api/admin/files/${id}/status`, { status: "sent" });
  assert.equal(requeued.data.sending.status, "sent", "sendingen er åpen igjen");
  assert.ok((await agent.post("/api/agent/poll", {})).data.files.some((f) => f.id === id), "agenten ser filen igjen");
  await agent.post(`/api/agent/files/${id}/claim`);
  await agent.put(`/api/agent/files/${id}/result?name=status.txt`, "Hei");
  await admin.post(`/api/admin/files/${id}/status`, { status: "failed" });
  const done = await admin.post(`/api/admin/files/${id}/status`, { status: "done" });
  assert.equal(done.data.sending.files[0].status, "done", "har resultat → kan merkes ferdig");
  const [event] = await dev.sql("SELECT message, source FROM events WHERE type = 'file.status_changed' ORDER BY id DESC LIMIT 1");
  assert.equal(event.message, "status.txt: failed → done");
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
  const exact = await get("type=file.claimed");
  assert.ok(exact.events.length > 0 && exact.events.every((e) => e.type === "file.claimed" && e.source === "agent"));
  assert.ok((await get("source=agent&limit=500")).events.every((e) => e.source === "agent"));
  const text = await get(`q=${encodeURIComponent("manuell.docx")}`);
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
