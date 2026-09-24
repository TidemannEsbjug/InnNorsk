// Mac-agentens API og cron mot ekte wrangler dev: kø, lease, fremdrift, resultat, feil, tilbakelevering,
// utløpte leaser, «Mac-en er borte»-push, opprydding og at hemmeligheter aldri havner i loggene.
const test = require("node:test");
const assert = require("node:assert/strict");
const workerDev = require("../helpers/worker-dev");
const { eventually } = require("./client");

const DEVICE = "c3".repeat(32);
let dev;
let svetlana;
let admin;
let agent;

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 3600000;
const beat = { host: "mac-mini", version: "1.0.0", state: "idle", stateMessage: null, grokOk: true };
const events = (type) => dev.sql("SELECT * FROM events WHERE type = ? ORDER BY id", type);
const fileRow = async (id) => (await dev.sql("SELECT * FROM files WHERE id = ?", id))[0];
// Push med tittel som matcher (andre push, f.eks. «Nye filer», kan komme når som helst etter en sending).
const pushes = (re) => dev.apns.pushes.filter((p) => re.test(p.payload.aps.alert.title));
const waitForPushes = (re, n = 1) => dev.apns.waitFor(() => pushes(re).length >= n).then(() => pushes(re));
const myFile = async (id) => {
  const { sendings } = (await svetlana.get("/api/sendings")).data;
  return sendings.flatMap((s) => s.files).find((f) => f.id === id);
};

test.before(async () => {
  dev = await workerDev.start();
  [svetlana, admin] = [await dev.login("svetlana"), await dev.login("eier")];
  agent = dev.agent();
  assert.equal((await admin.post("/api/admin/devices", { token: DEVICE, env: "sandbox", name: "Jonas" })).status, 200);
});

test.after(async () => {
  if (dev) await dev.stop();
});

// Tømmer køen så hver test starter med bare sine egne filer.
async function clearQueue() {
  await dev.sql("UPDATE files SET status = 'done' WHERE status IN ('sent', 'working')");
}

test("agent-API-et krever riktig nøkkel, men ikke CSRF-hodet", async () => {
  const sending = await svetlana.send({ "a.txt": "Hello" });
  const id = sending.files[0].id;
  for (const client of [dev.agent("feil-nokkel"), dev.agent("")]) {
    for (const [method, p] of [
      ["POST", "/api/agent/poll"],
      ["POST", `/api/agent/files/${id}/claim`],
      ["GET", `/api/agent/files/${id}/original`],
      ["POST", `/api/agent/files/${id}/progress`],
      ["PUT", `/api/agent/files/${id}/result?name=a.txt`],
      ["POST", `/api/agent/files/${id}/fail`],
      ["POST", `/api/agent/files/${id}/release`],
      ["POST", "/api/agent/log"],
    ]) {
      const res = await client.req(method, p, method === "PUT" ? { body: "x" } : method === "POST" ? { json: {} } : {});
      assert.deepEqual([res.status, res.data.error], [401, "Ugyldig agentnøkkel."], `${method} ${p}`);
    }
  }
  // En innlogget nettleserøkt er ikke nok.
  assert.equal((await svetlana.post("/api/agent/poll", beat)).status, 401);
  assert.equal((await agent.post("/api/agent/poll", beat)).status, 200);
  await clearQueue();
});

test("hele flyten: poll → claim → original → fremdrift → resultat → Svetlana laster ned", async () => {
  dev.apns.reset();
  const sending = await svetlana.send({ "Søknad.docx": "original-docx", "vedlegg.txt": "Hello" }, { targetLanguage: "nynorsk", note: "Hei!" });
  const poll = await agent.post("/api/agent/poll", beat);
  assert.equal(poll.status, 200);
  assert.deepEqual(poll.data.files.map((f) => f.name), ["Søknad.docx", "vedlegg.txt"]);
  assert.deepEqual(poll.data.files[0], {
    id: sending.files[0].id, sendingId: sending.id, name: "Søknad.docx", relPath: "Søknad.docx", ext: ".docx", bytes: 13,
    targetLanguage: "nynorsk", note: "Hei!", username: "svetlana", displayName: "Svetlana",
  });
  const id = poll.data.files[0].id;
  assert.equal((await myFile(id)).statusText, "Mottatt – oversettes snart", "agenten er på");

  assert.deepEqual((await agent.post(`/api/agent/files/${id}/claim`, { leaseSeconds: 600 })).data, { ok: true });
  const claimed = await fileRow(id);
  assert.equal(claimed.status, "working");
  assert.equal(claimed.attempts, 1);
  assert.ok(Math.abs(Date.parse(claimed.lease_until) - Date.now() - 600000) < 10000);
  assert.equal((await myFile(id)).statusText, "Oversettes nå");

  const original = await agent.get(`/api/agent/files/${id}/original`);
  assert.equal(original.status, 200);
  assert.equal(original.data.toString(), "original-docx");

  assert.equal((await agent.post(`/api/agent/files/${id}/progress`, { percent: 45, etaSeconds: 180, message: "Avsnitt 9 av 20" })).status, 200);
  const working = await myFile(id);
  assert.equal(working.statusText, "Oversettes nå – 45 % – ca. 3 min igjen");
  assert.equal(working.progress.percent, 45);
  assert.ok(working.progress.etaSeconds > 170 && working.progress.etaSeconds <= 180);
  assert.equal(working.startedAt, claimed.started_at);

  const name = "Søknad (nynorsk).docx";
  const result = await agent.put(`/api/agent/files/${id}/result?name=${encodeURIComponent(name)}&costUsd=0.0123`, "oversatt-docx");
  assert.deepEqual([result.status, result.data], [200, { ok: true }]);
  const done = await myFile(id);
  assert.deepEqual([done.status, done.statusText, done.outputName, done.outputBytes], ["done", "Ferdig", name, 13]);
  const dl = await svetlana.get(`/api/files/${id}/result`);
  assert.equal(dl.data.toString(), "oversatt-docx");
  assert.match(dl.headers.get("content-disposition"), /filename\*=UTF-8''S%C3%B8knad%20%28nynorsk%29\.docx$/);
  const [download] = await events("download.result");
  assert.equal(download.file_id, id);

  const adminView = (await admin.get(`/api/sendings/${sending.id}`)).data.sending.files.find((f) => f.id === id);
  assert.deepEqual([adminView.costUsd, adminView.outputSource, adminView.attempts], [0.0123, "agent", 1]);
  assert.equal((await dev.sql("SELECT status FROM sendings WHERE id = ?", sending.id))[0].status, "sent", "én fil gjenstår");

  // Den andre filen feiler → sendingen er ferdig.
  const other = poll.data.files[1].id;
  await agent.post(`/api/agent/files/${other}/claim`);
  await agent.post(`/api/agent/files/${other}/fail`, { message: "Ugyldig svar fra Grok", details: "Error: invalid_output\n    at translate", costUsd: 0.001 });
  const [row] = await dev.sql("SELECT status, finished_at FROM sendings WHERE id = ?", sending.id);
  assert.equal(row.status, "done");
  assert.ok(row.finished_at);
  assert.equal((await events("sending.done")).filter((e) => e.sending_id === sending.id).length, 1);
  assert.ok((await events("file.done")).some((e) => e.file_id === id && e.source === "agent"));
});

test("feil: Svetlana ser en vennlig tekst, eieren ser detaljene og får push", async () => {
  await clearQueue();
  dev.apns.reset();
  const sending = await svetlana.send({ "skannet.pdf": "%PDF-1.4" });
  const id = sending.files[0].id;
  await agent.post(`/api/agent/files/${id}/claim`);
  const res = await agent.post(`/api/agent/files/${id}/fail`, { message: "Fant ingen tekst i PDF-en", details: "stack: scanned" });
  const [push] = await waitForPushes(/^Kunne ikke/);
  assert.equal(res.status, 200);
  const mine = await myFile(id);
  assert.deepEqual([mine.status, mine.statusText], ["failed", "Oversetteren ser på denne filen"]);
  assert.equal(mine.error, undefined);
  const theirs = (await admin.get("/api/admin/sendings")).data.sendings.find((s) => s.id === sending.id).files[0];
  assert.deepEqual([theirs.error, theirs.errorDetails, theirs.attempts], ["Fant ingen tekst i PDF-en", "stack: scanned", 1]);
  assert.deepEqual(push.payload.aps.alert, { title: "Kunne ikke oversette skannet.pdf", body: "Fant ingen tekst i PDF-en" });
  assert.equal(push.payload.sendingId, sending.id);
  const [event] = (await events("file.failed")).filter((e) => e.file_id === id);
  assert.equal(event.level, "error");
  assert.equal(event.source, "agent");
  assert.equal((await agent.post(`/api/agent/files/${id}/fail`, { message: "igjen" })).status, 409, "allerede ferdig");
});

test("release: filen går tilbake i køen uten å telle som forsøk", async () => {
  await clearQueue();
  const sending = await svetlana.send({ "tilbake.txt": "Hello" });
  const id = sending.files[0].id;
  await agent.post(`/api/agent/files/${id}/claim`);
  await agent.post(`/api/agent/files/${id}/progress`, { percent: 10, etaSeconds: 60 });
  const res = await agent.post(`/api/agent/files/${id}/release`, { reason: "Grok CLI er ikke logget inn" });
  assert.equal(res.status, 200);
  const row = await fileRow(id);
  assert.deepEqual([row.status, row.attempts, row.lease_until, row.progress_percent], ["sent", 0, null, null]);
  assert.deepEqual((await agent.post("/api/agent/poll", beat)).data.files.map((f) => f.id), [id]);
  assert.equal((await agent.post(`/api/agent/files/${id}/release`, {})).status, 409, "ikke i arbeid");
  assert.equal((await agent.post(`/api/agent/files/${id}/progress`, { percent: 5 })).status, 409);
  const [event] = (await events("file.released")).filter((e) => e.file_id === id);
  assert.match(event.message, /Grok CLI er ikke logget inn/);
});

test("samtidige claim: bare én vinner, den andre får 409", async () => {
  await clearQueue();
  const sending = await svetlana.send({ "kappløp.txt": "Hello" });
  const id = sending.files[0].id;
  const results = await Promise.all([1, 2, 3].map(() => agent.post(`/api/agent/files/${id}/claim`)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal((await fileRow(id)).attempts, 1);
});

test("utløpt lease: poll tilbyr filen igjen, og cron legger den tilbake i køen", async () => {
  await clearQueue();
  const sending = await svetlana.send({ "treg.txt": "Hello", "treg2.txt": "Hello" });
  const [a, b] = sending.files.map((f) => f.id);
  await agent.post(`/api/agent/files/${a}/claim`);
  await agent.post(`/api/agent/files/${b}/claim`);
  await dev.sql("UPDATE files SET lease_until = ? WHERE id IN (?, ?)", ago(1000), a, b);
  assert.deepEqual((await agent.post("/api/agent/poll", beat)).data.files.map((f) => f.id), [a, b], "utløpte leaser tilbys igjen");
  assert.equal((await agent.post(`/api/agent/files/${a}/claim`)).status, 200, "kan tas på nytt");
  assert.equal((await fileRow(a)).attempts, 2);
  await dev.cron();
  const row = await fileRow(b);
  assert.deepEqual([row.status, row.lease_until, row.started_at], ["sent", null, null]);
  assert.equal((await fileRow(a)).status, "working", "gyldig lease røres ikke");
  const [event] = (await events("file.lease_expired")).filter((e) => e.file_id === b);
  assert.equal(event.level, "warn");
  assert.equal(event.source, "system");
});

test("resultat for slettet sending avvises, og ingenting blir liggende i R2", async () => {
  await clearQueue();
  const sending = await svetlana.send({ "angret.txt": "Hello" });
  const id = sending.files[0].id;
  await agent.post(`/api/agent/files/${id}/claim`);
  assert.equal((await svetlana.del(`/api/sendings/${sending.id}`)).status, 204);
  assert.equal((await agent.post(`/api/agent/files/${id}/progress`, { percent: 50 })).status, 409);
  assert.equal((await agent.put(`/api/agent/files/${id}/result?name=a.txt`, "Hei")).status, 404);
  assert.equal((await agent.get(`/api/agent/files/${id}/original`)).status, 404);
  assert.deepEqual(await dev.r2Keys(`s/${sending.id}/`), []);
  assert.ok(!(await agent.post("/api/agent/poll", beat)).data.files.some((f) => f.id === id));
});

test("resultatopplasting krever navn og Content-Length", async () => {
  await clearQueue();
  const sending = await svetlana.send({ "navn.txt": "Hello" });
  const id = sending.files[0].id;
  await agent.post(`/api/agent/files/${id}/claim`);
  assert.equal((await agent.put(`/api/agent/files/${id}/result`, "Hei")).status, 400);
  assert.equal((await agent.put(`/api/agent/files/${id}/result?name=a.txt`, "")).status, 400);
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("Hei")); c.close(); } });
  assert.equal((await agent.put(`/api/agent/files/${id}/result?name=a.txt`, stream)).status, 411);
  assert.equal((await fileRow(id)).status, "working");
});

test("livstegn: status, feiltilstand og «tilbake»-hendelser; Mac-en offline gir annen tekst til Svetlana", async () => {
  await clearQueue();
  const sending = await svetlana.send({ "vent.txt": "Hello" });
  const id = sending.files[0].id;
  await agent.post("/api/agent/poll", { ...beat, state: "error", stateMessage: "Grok CLI er ikke logget inn – kjør «grok login»", grokOk: false });
  let overview = (await admin.get("/api/admin/overview")).data.agent;
  assert.deepEqual(
    { online: overview.online, host: overview.host, version: overview.version, state: overview.state, grokOk: overview.grokOk },
    { online: true, host: "mac-mini", version: "1.0.0", state: "error", grokOk: false }
  );
  assert.match(overview.stateMessage, /grok login/);
  const [stateEvent] = (await events("agent.state")).slice(-1);
  assert.equal(stateEvent.level, "warn");
  await agent.post("/api/agent/poll", beat);
  assert.equal((await events("agent.state")).slice(-1)[0].level, "info", "tilbake fra feil");

  await dev.sql("UPDATE agent SET last_seen_at = ?", ago(10 * 60000));
  assert.equal((await myFile(id)).statusText, "Mottatt – oversettelsen starter når oversetteren er klar");
  overview = (await admin.get("/api/admin/overview")).data.agent;
  assert.equal(overview.online, false);
  const before = (await events("agent.online")).length;
  await agent.post("/api/agent/poll", beat);
  assert.equal((await events("agent.online")).length, before + 1);
  assert.match((await events("agent.online")).slice(-1)[0].message, /Mac-en er tilbake \(mac-mini\)/);
  assert.equal((await myFile(id)).statusText, "Mottatt – oversettes snart");
});

test("agentlogg havner i hendelsesloggen med kilde agent, med grense per minutt", async () => {
  const res = await agent.post("/api/agent/log", { level: "warn", type: "file.processing", message: "Starter på vent.txt", data: { chars: 1200 }, fileId: "abc" });
  assert.equal(res.status, 204);
  const [row] = (await events("file.processing")).slice(-1);
  assert.deepEqual([row.level, row.source, row.message, row.file_id, JSON.parse(row.data_json).chars], ["warn", "agent", "Starter på vent.txt", "abc", 1200]);
  assert.equal((await agent.post("/api/agent/log", { type: "ugyldig type!", message: "x" })).status, 204);
  assert.equal((await events("agent.log")).length, 1, "ugyldig type blir agent.log");
  const now = new Date().toISOString();
  await dev.sql(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120)
     INSERT INTO events (ts, level, type, source) SELECT ?, 'debug', 'agent.flom', 'agent' FROM n`,
    now
  );
  assert.equal((await agent.post("/api/agent/log", { message: "en for mye" })).status, 429);
  await dev.sql("DELETE FROM events WHERE type = 'agent.flom'");
});

test("cron: push når Mac-en er borte og noen venter – én gang per fravær", async () => {
  const WAITING = /venter/;
  await clearQueue();
  dev.apns.reset();
  await dev.sql("UPDATE agent SET last_seen_at = ?, offline_alert_sent_at = NULL", ago(3 * HOUR));
  await dev.cron();
  assert.equal(pushes(WAITING).length, 0, "ingen venter → ingen push");

  await svetlana.send({ "venter1.txt": "Hello", "venter2.txt": "Hello" });
  await dev.cron();
  const [push] = await waitForPushes(WAITING);
  assert.match(push.payload.aps.alert.title, /^Svetlana venter: Mac-en har ikke svart siden \d{2}:\d{2}$/);
  assert.equal(push.payload.aps.alert.body, "2 filer ligger i kø. Sjekk at Mac-en er på og at InnNorsk-mottaket kjører.");
  await dev.cron();
  assert.equal(pushes(WAITING).length, 1, "bare én gang per fravær");
  assert.equal((await events("agent.offline_alert")).length, 1);

  // Mac-en kommer tilbake → nullstilles; går den bort igjen, varsles det på nytt.
  await agent.post("/api/agent/poll", beat);
  assert.equal((await dev.sql("SELECT offline_alert_sent_at FROM agent"))[0].offline_alert_sent_at, null);
  await dev.sql("UPDATE agent SET last_seen_at = ?", ago(3 * HOUR));
  await dev.cron();
  await waitForPushes(WAITING, 2);
  assert.equal((await events("agent.offline_alert")).length, 2);

  // Aldri sett: egen tekst.
  await dev.sql("UPDATE agent SET last_seen_at = NULL, offline_alert_sent_at = NULL");
  await dev.cron();
  const all = await waitForPushes(WAITING, 3);
  assert.equal(all[2].payload.aps.alert.title, "Svetlana venter: Mac-en har ikke meldt seg ennå");
  await agent.post("/api/agent/poll", beat);
});

test("cron: gamle utkast, innloggingsforsøk, økter og hendelser ryddes – nyere røres ikke", async () => {
  const oldDraft = await svetlana.newSending();
  const oldFile = (await svetlana.upload(oldDraft.id, "gammel.txt", "Hello")).data.file;
  const newDraft = await svetlana.newSending();
  await svetlana.upload(newDraft.id, "ny.txt", "Hello");
  await dev.sql("UPDATE sendings SET created_at = ? WHERE id = ?", ago(3 * 24 * HOUR), oldDraft.id);
  await dev.sql("INSERT INTO login_attempts (key, ts) VALUES ('ip:gammel', ?), ('ip:ny', ?)", ago(2 * 24 * HOUR), ago(1000));
  await dev.sql(
    "INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES ('gammel', 1, ?, ?, ?), ('utlopt-nylig', 1, ?, ?, ?)",
    ago(90 * 24 * HOUR), ago(90 * 24 * HOUR), ago(40 * 24 * HOUR), ago(40 * 24 * HOUR), ago(40 * 24 * HOUR), ago(2 * 24 * HOUR)
  );
  await dev.sql("INSERT INTO events (ts, level, type) VALUES (?, 'info', 'gammel.hendelse'), (?, 'info', 'ny.hendelse')", ago(400 * 24 * HOUR), ago(300 * 24 * HOUR));
  await dev.cron();

  assert.deepEqual(await dev.sql("SELECT id FROM sendings WHERE id = ?", oldDraft.id), []);
  assert.deepEqual(await dev.sql("SELECT id FROM files WHERE id = ?", oldFile.id), []);
  assert.deepEqual(await dev.r2Keys(`s/${oldDraft.id}/`), []);
  assert.equal((await dev.r2Keys(`s/${newDraft.id}/`)).length, 1);
  assert.deepEqual((await dev.sql("SELECT key FROM login_attempts WHERE key LIKE 'ip:%' AND key IN ('ip:gammel', 'ip:ny')")).map((r) => r.key), ["ip:ny"]);
  assert.deepEqual((await dev.sql("SELECT id FROM sessions WHERE id IN ('gammel', 'utlopt-nylig')")).map((r) => r.id), ["utlopt-nylig"]);
  assert.deepEqual((await dev.sql("SELECT type FROM events WHERE type IN ('gammel.hendelse', 'ny.hendelse')")).map((r) => r.type), ["ny.hendelse"]);
  const [sweep] = (await events("retention.sweep")).slice(-1);
  assert.deepEqual(JSON.parse(sweep.data_json), { drafts: 1, draftFiles: 1, loginAttempts: 1, sessions: 1, events: 1 });

  const count = (await events("retention.sweep")).length;
  await dev.cron();
  assert.equal((await events("retention.sweep")).length, count, "ingen hendelse når ingenting ble ryddet");
});

test("hemmeligheter havner aldri i hendelsesloggen eller konsollen", async () => {
  await agent.post("/api/agent/log", {
    level: "error", type: "agent.error", message: `Bearer ${dev.agentToken} feilet`,
    data: { token: dev.agentToken, nested: { note: `nøkkel ${dev.agentToken}` } },
  });
  await eventually(async () => (await events("agent.error")).length > 0);
  const secrets = [
    dev.agentToken,
    dev.vars.SALT_PEPPER,
    ...dev.vars.APNS_KEY_P8.split("\n").filter((l) => l && !l.startsWith("-")),
    dev.users.svetlana.password,
    dev.users.eier.password,
    ...(await dev.sql("SELECT verifier FROM users")).map((r) => r.verifier),
    svetlana.cookie.split("=")[1],
  ];
  const all = JSON.stringify(await dev.sql("SELECT * FROM events"));
  const logs = dev.logs();
  assert.match(logs, /"type":"auth.login"/, "hendelsene skrives også som JSON-linjer i konsollen");
  for (const secret of secrets) {
    assert.ok(!all.includes(secret), `hemmelighet i events: ${secret.slice(0, 6)}…`);
    assert.ok(!logs.includes(secret), `hemmelighet i konsollen: ${secret.slice(0, 6)}…`);
  }
});
