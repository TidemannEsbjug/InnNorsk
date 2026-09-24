// Svetlanas side mot ekte wrangler dev: sending, opplasting (analyse og estimat, lagret i R2), sending med push, liste,
// nedlasting og tilgang. Den falske xAI-en svarer tregt her, så filene som sendes, blir liggende i kø / under arbeid.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const workerDev = require("../helpers/worker-dev");
const { minimalDocx } = require("../helpers/fixtures");
const { Client, newSecret, eventually } = require("./client");

const DEVICE = "a1".repeat(32);
let dev;
let svetlana;
let admin;

test.before(async () => {
  dev = await workerDev.start({ vars: { MAX_FILE_MB: "1", MAX_FILES_PER_SENDING: "3" }, xai: { mode: "slow", delayMs: 5000 } });
  [svetlana, admin] = [await dev.login("svetlana"), await dev.login("eier")];
  const res = await admin.post("/api/admin/devices", { token: DEVICE, env: "sandbox", name: "Jonas sin iPhone" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
});

test.after(async () => {
  if (dev) await dev.stop();
});

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

test("ny sending krever bokmål eller nynorsk og starter som utkast", async () => {
  assert.equal((await svetlana.post("/api/sendings", { targetLanguage: "svensk" })).status, 400);
  const sending = await svetlana.newSending("nynorsk", "  Hei, dette haster litt  ");
  assert.equal(sending.status, "draft");
  assert.equal(sending.targetLanguage, "nynorsk");
  assert.equal(sending.note, "Hei, dette haster litt");
  assert.deepEqual(sending.counts, { total: 0, waiting: 0, working: 0, done: 0, failed: 0 });
  const note = await svetlana.post(`/api/sendings/${sending.id}/note`, { note: "Ny melding" });
  assert.equal(note.data.sending.note, "Ny melding");
  const language = await svetlana.post(`/api/sendings/${sending.id}/note`, { targetLanguage: "bokmal" });
  assert.deepEqual([language.data.sending.targetLanguage, language.data.sending.note], ["bokmal", "Ny melding"], "bare språket endres");
  assert.equal((await svetlana.post(`/api/sendings/${sending.id}/note`, { targetLanguage: "svensk" })).status, 400);
});

test("opplasting lagres i R2 og kommer ut byte for byte likt, med æøå og emoji i navnet; en skadet Word-fil får en vennlig forklaring", async () => {
  const sending = await svetlana.newSending();
  const content = crypto.randomBytes(900 * 1024);
  const res = await svetlana.upload(sending.id, "Søknader/Åse 😀 søknad.docx", content);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const file = res.data.file;
  assert.deepEqual(
    { path: file.path, name: file.name, ext: file.ext, bytes: file.bytes, status: file.status, statusText: file.statusText, estimateSeconds: file.estimateSeconds },
    {
      path: "Søknader/Åse 😀 søknad.docx", name: "Åse 😀 søknad.docx", ext: ".docx", bytes: content.length, status: "failed",
      statusText: "Filen ser ut til å være skadet eller er ikke et gyldig Word-dokument.", estimateSeconds: null,
    }
  );
  assert.equal("error" in file, false, "tekniske detaljer vises ikke for henne");
  const [row] = await dev.sql("SELECT error, error_details FROM files WHERE id = ?", file.id);
  assert.match(row.error, /zip/i, "eieren ser den tekniske feilen");
  assert.match(row.error_details, /\n\s+at /);
  assert.deepEqual(await dev.r2Keys(`s/${sending.id}/`), [`s/${sending.id}/${file.id}/original`]);
  const dl = await svetlana.get(`/api/files/${file.id}/original`);
  assert.equal(dl.status, 200);
  assert.equal(sha(dl.data), sha(content));
  assert.equal(dl.headers.get("content-length"), String(content.length));
  assert.equal(
    dl.headers.get("content-disposition"),
    "attachment; filename=\"Ase _ soknad.docx\"; filename*=UTF-8''%C3%85se%20%F0%9F%98%80%20s%C3%B8knad.docx"
  );
  assert.equal(dl.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal((await svetlana.get(`/api/files/${file.id}/result`)).status, 404, "ingen oversettelse ennå");
});

test("ugyldige filer avvises med vennlige norske meldinger og logges", async () => {
  const sending = await svetlana.newSending();
  const up = (p, body = "Hello") => svetlana.upload(sending.id, p, body);
  const cases = [
    [await up("stor.pdf", Buffer.alloc(1024 * 1024 + 1)), 413, "Filen er for stor (maks 1 MB)."],
    [await up("program.exe"), 415, "Filtypen .exe støttes ikke."],
    [await up("README"), 415, "Filer uten filendelse støttes ikke."],
    [await up("~$rapport.docx"), 400, "Dette er en midlertidig låsefil, ikke et dokument."],
    [await up("mappe/.~lock.rapport.docx#"), 400, "Dette er en midlertidig låsefil, ikke et dokument."],
    [await up("Thumbs.db"), 400, "Dette er en midlertidig låsefil, ikke et dokument."],
    [await up(".DS_Store"), 400, "Dette er en midlertidig låsefil, ikke et dokument."],
    [await up("tom.txt", ""), 400, "Filen er tom."],
    [await up("../.."), 400, "Filnavnet mangler eller er ugyldig."],
  ];
  for (const [res, status, error] of cases) assert.deepEqual([res.status, res.data.error], [status, error]);
  // Uten Content-Length (strømmet kropp) → 411.
  const stream = new ReadableStream({ start(ctrl) { ctrl.enqueue(new TextEncoder().encode("Hello")); ctrl.close(); } });
  const chunked = await svetlana.upload(sending.id, "strøm.txt", stream);
  assert.equal(chunked.status, 411);
  assert.equal((await dev.sql("SELECT COUNT(*) AS n FROM files WHERE sending_id = ?", sending.id))[0].n, 0);
  assert.deepEqual(await dev.r2Keys(`s/${sending.id}/`), []);
  assert.ok((await dev.sql("SELECT COUNT(*) AS n FROM events WHERE type = 'file.rejected' AND sending_id = ?", sending.id))[0].n >= 10);
});

test("stier renses, samme sti erstatter, maks antall filer, og utkastfiler kan fjernes", async () => {
  const sending = await svetlana.newSending();
  const first = await svetlana.upload(sending.id, "..\\..\\C:\\Brev\\brev.txt", "Hello 1");
  assert.equal(first.data.file.path, "Brev/brev.txt");
  const again = await svetlana.upload(sending.id, "brev/BREV.txt", "Hello 2");
  assert.equal(again.status, 201);
  const view = (await svetlana.get(`/api/sendings/${sending.id}`)).data.sending;
  assert.deepEqual(view.files.map((f) => f.path), ["brev/BREV.txt"], "samme sti (uansett store/små bokstaver) erstatter");
  assert.deepEqual(await dev.r2Keys(`s/${sending.id}/`), [`s/${sending.id}/${again.data.file.id}/original`]);
  assert.equal((await svetlana.upload(sending.id, "b.md", "# B")).status, 201);
  assert.equal((await svetlana.upload(sending.id, "c.csv", "a,b")).status, 201);
  const tooMany = await svetlana.upload(sending.id, "d.html", "<p>d</p>");
  assert.deepEqual([tooMany.status, tooMany.data.error], [400, "Du kan sende maks 3 filer om gangen."]);
  assert.equal((await svetlana.del(`/api/sendings/${sending.id}/files/${again.data.file.id}`)).status, 204);
  assert.deepEqual(await dev.r2Keys(`s/${sending.id}/${again.data.file.id}/`), []);
  assert.equal((await svetlana.upload(sending.id, "d.html", "<p>d</p>")).status, 201);
});

test("utkastet viser analyse og estimat: «Klar – …» per fil og samlet tid for filene som kan oversettes", async () => {
  const sending = await svetlana.newSending();
  const docx = await svetlana.upload(sending.id, "brev.docx", await minimalDocx(["Dear Svetlana,", "The meeting is on Monday.", "Best regards"]));
  const txt = await svetlana.upload(sending.id, "notat.txt", "Hello\n\nWorld\n");
  const scanned = await svetlana.upload(sending.id, "tom.txt", " \n\t\n");
  for (const res of [docx, txt]) {
    assert.equal(res.data.file.status, "draft");
    assert.ok(res.data.file.estimateSeconds > 3, `estimat for ${res.data.file.name}`);
    assert.match(res.data.file.statusText, /^Klar – (under 1 min|ca\. \d+ min)$/);
  }
  assert.deepEqual([scanned.data.file.status, scanned.data.file.statusText], ["failed", "Fant ingen tekst å oversette i denne filen."]);
  const view = (await svetlana.get(`/api/sendings/${sending.id}`)).data.sending;
  const sum = docx.data.file.estimateSeconds + txt.data.file.estimateSeconds;
  assert.ok(Math.abs(view.estimateSeconds - sum) <= 1, `sendingens estimat ${view.estimateSeconds} ≈ ${sum} (uten filen som ikke kan leses)`);
  const [row] = await dev.sql("SELECT segments, chars, batches, plan_json FROM files WHERE id = ?", docx.data.file.id);
  assert.deepEqual([row.segments, row.chars, row.batches, JSON.parse(row.plan_json)], [3, 51, 1, [[51]]]);
  const [event] = await dev.sql("SELECT data_json FROM events WHERE type = 'file.uploaded' AND file_id = ?", docx.data.file.id);
  assert.deepEqual(JSON.parse(event.data_json), { path: "brev.docx", bytes: docx.data.file.bytes, ext: ".docx", segments: 3, chars: 51, batches: 1, estimateSeconds: docx.data.file.estimateSeconds });

  // Bare filer som ikke kan leses → ingenting å sende.
  const bad = await svetlana.newSending();
  await svetlana.upload(bad.id, "skadet.pptx", "ikke en zip");
  const refused = await svetlana.post(`/api/sendings/${bad.id}/send`);
  assert.deepEqual([refused.status, refused.data.error], [400, "Ingen av filene kan oversettes. Fjern dem og legg til andre."]);
  const [pptx] = (await svetlana.get(`/api/sendings/${bad.id}`)).data.sending.files;
  assert.equal(pptx.statusText, "Filen ser ut til å være skadet eller er ikke en gyldig PowerPoint-fil.");
  assert.equal((await svetlana.del(`/api/sendings/${bad.id}/files/${pptx.id}`)).status, 204, "hun kan fjerne den");
});

test("send: filene går i kø (uleselige hoppes over), Workflowen starter, og eieren får push med gyldig ES256-JWT", async () => {
  dev.apns.reset();
  const empty = await svetlana.newSending();
  assert.deepEqual((await svetlana.post(`/api/sendings/${empty.id}/send`)).data, { error: "Legg til minst én fil før du sender." });

  const sending = await svetlana.newSending("bokmal", "Takk for hjelpen!");
  await svetlana.upload(sending.id, "Søknad barnehage.docx", await minimalDocx(["Application for a place"]));
  await svetlana.upload(sending.id, "vedlegg.txt", "Hello");
  await svetlana.upload(sending.id, "ødelagt.docx", "docx-innhold");
  const res = await svetlana.post(`/api/sendings/${sending.id}/send`);
  assert.equal(res.status, 200);
  const sent = res.data.sending;
  assert.equal(sent.status, "sent");
  assert.ok(sent.sentAt);
  const byName = Object.fromEntries(sent.files.map((f) => [f.name, f.status]));
  assert.ok(["sent", "working"].includes(byName["Søknad barnehage.docx"]) && ["sent", "working"].includes(byName["vedlegg.txt"]), JSON.stringify(byName));
  assert.equal(byName["ødelagt.docx"], "failed", "hoppes over");
  assert.deepEqual([sent.counts.total, sent.counts.waiting + sent.counts.working, sent.counts.done, sent.counts.failed], [3, 2, 0, 1]);
  assert.ok(sent.estimateSeconds > 0);
  const [row] = await dev.sql("SELECT workflow_id, estimate_seconds FROM sendings WHERE id = ?", sending.id);
  assert.equal(row.workflow_id, `${sending.id}-1`);
  assert.ok(row.estimate_seconds > 0);
  await eventually(async () => (await svetlana.get(`/api/sendings/${sending.id}`)).data.sending.files.some((f) => f.status === "working"),
    { what: "Workflowen tar den første filen" });

  const [push] = await dev.apns.waitFor((p) => p.length >= 1);
  assert.equal(push.token, DEVICE);
  assert.equal(push.jwtValid, true);
  assert.deepEqual(push.jwt.header, { alg: "ES256", kid: "TESTKEY123" });
  assert.equal(push.jwt.claims.iss, "TESTTEAM12");
  assert.ok(Math.abs(push.jwt.claims.iat - Date.now() / 1000) < 60);
  assert.equal(push.topic, "no.innnorsk.varsel");
  assert.equal(push.pushType, "alert");
  assert.equal(push.priority, "10");
  assert.deepEqual(push.payload, {
    aps: { alert: { title: "Nye filer fra Svetlana", body: "2 filer: Søknad barnehage.docx og 1 til\n«Takk for hjelpen!»" }, sound: "default", "thread-id": "innnorsk" },
    sendingId: sending.id,
  });

  assert.equal((await svetlana.post(`/api/sendings/${sending.id}/send`)).status, 409);
  assert.equal((await svetlana.upload(sending.id, "sen.txt", "Hello")).status, 409);
  assert.equal((await svetlana.del(`/api/sendings/${sending.id}/files/${sent.files[0].id}`)).status, 409);
  assert.equal((await svetlana.post(`/api/sendings/${sending.id}/note`, { note: "x" })).status, 409);
  const [event] = await dev.sql("SELECT user_id, source, data_json FROM events WHERE type = 'sending.sent' AND sending_id = ?", sending.id);
  assert.equal(event.source, "web");
  assert.deepEqual([JSON.parse(event.data_json).files, JSON.parse(event.data_json).skipped], [2, 1]);
  await eventually(async () => (await dev.sql("SELECT COUNT(*) AS n FROM events WHERE type = 'push.sent'"))[0].n >= 1, { what: "push.sent" });
});

test("iPhone som er borte (410) slås av og får ikke flere push", async () => {
  const gone = "b2".repeat(32);
  await admin.post("/api/admin/devices", { token: gone, env: "production", name: "Gammel iPhone" });
  dev.apns.reset();
  dev.apns.failToken(gone, 410);
  await svetlana.send({ "en.txt": "Hello" });
  await dev.apns.waitFor((p) => p.length >= 2);
  const row = await eventually(async () => {
    const [d] = await dev.sql("SELECT disabled_at, last_error FROM devices WHERE token = ?", gone);
    return d.disabled_at && d;
  }, { what: "enheten slås av" });
  assert.equal(row.last_error, "Unregistered");
  dev.apns.reset();
  await svetlana.send({ "to.txt": "Hello" });
  await dev.apns.waitFor((p) => p.length >= 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(dev.apns.pushes.map((p) => p.token), [DEVICE]);
});

test("«Mine filer»: egne sendinger, nyeste først, uten gamle utkast og slettede, med vennlige statustekster", async () => {
  const other = await svetlana.newSending();
  const old = await svetlana.newSending();
  await dev.sql("UPDATE sendings SET created_at = ? WHERE id = ?", new Date(Date.now() - 2 * 86400000).toISOString(), old.id);
  const res = await svetlana.get("/api/sendings");
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.data), ["sendings"]);
  const ids = res.data.sendings.map((s) => s.id);
  assert.equal(ids[0], other.id, "nyeste først");
  assert.ok(!ids.includes(old.id), "utkast eldre enn ett døgn vises ikke");
  const times = res.data.sendings.map((s) => s.createdAt);
  assert.deepEqual(times, [...times].sort().reverse());
  const files = res.data.sendings.filter((s) => s.status === "sent").flatMap((s) => s.files);
  assert.ok(files.length > 0);
  for (const f of files) {
    const expected = { sent: /^I kø – starter straks$/, working: /^Oversettes nå – \d+ %( – (under 1 min|ca\. \d+ min) igjen)?$/, failed: /\.$/ }[f.status];
    assert.match(f.statusText, expected, `${f.name}: ${f.status}`);
    assert.equal("error" in f, false, "Svetlana ser ikke tekniske feil");
  }
});

test("tilgang: andre brukere ser ikke Svetlanas sendinger eller filer (404)", async () => {
  const created = await admin.post("/api/admin/users", { username: "Annen", displayName: "Annen", role: "user", mustChangePassword: false, ...newSecret("annen-passord-1") });
  assert.equal(created.status, 201);
  const other = await dev.login("Annen", { password: "annen-passord-1" });
  const sending = await svetlana.newSending();
  const file = (await svetlana.upload(sending.id, "hemmelig.txt", "Hello")).data.file;
  for (const [method, p] of [
    ["GET", `/api/sendings/${sending.id}`],
    ["GET", `/api/files/${file.id}/original`],
    ["GET", `/api/files/${file.id}/result`],
    ["GET", `/api/admin/files/${file.id}/calls`],
    ["PUT", `/api/sendings/${sending.id}/files?path=x.txt`],
    ["DELETE", `/api/sendings/${sending.id}/files/${file.id}`],
    ["POST", `/api/sendings/${sending.id}/send`],
    ["POST", `/api/sendings/${sending.id}/note`],
    ["DELETE", `/api/sendings/${sending.id}`],
  ]) {
    const res = await other.req(method, p, method === "PUT" ? { body: "Hello" } : method === "POST" ? { json: {} } : {});
    assert.equal(res.status, p.startsWith("/api/admin/") ? 403 : 404, `${method} ${p}`);
  }
  assert.deepEqual((await other.get("/api/sendings")).data.sendings, []);
  // Eieren (admin) kan lese og laste ned, men ikke endre Svetlanas sending.
  assert.equal((await admin.get(`/api/sendings/${sending.id}`)).status, 200);
  assert.equal((await admin.get(`/api/files/${file.id}/original`)).status, 200);
  assert.equal((await admin.upload(sending.id, "x.txt", "Hello")).status, 404);
});

test("sletting fjerner filene fra R2 og sendingen fra listen, også mens oversettelsen pågår", async () => {
  const sending = await svetlana.send({ "slett-meg.txt": "Hello", "og-meg.md": "# Hi" });
  assert.equal((await dev.r2Keys(`s/${sending.id}/`)).length, 2);
  await eventually(async () => (await dev.r2Keys(`work/${sending.files[0].id}/`)).length > 0, { what: "Workflowen har begynt" });
  assert.equal((await svetlana.del(`/api/sendings/${sending.id}`)).status, 204);
  assert.deepEqual(await dev.r2Keys(`s/${sending.id}/`), []);
  assert.ok(!(await svetlana.get("/api/sendings")).data.sendings.some((s) => s.id === sending.id));
  assert.equal((await svetlana.get(`/api/sendings/${sending.id}`)).status, 404);
  assert.equal((await svetlana.get(`/api/files/${sending.files[0].id}/original`)).status, 404);
  const [row] = await dev.sql("SELECT status, deleted_at FROM sendings WHERE id = ?", sending.id);
  assert.equal(row.status, "deleted");
  assert.ok(row.deleted_at);
  assert.equal((await dev.sql("SELECT COUNT(*) AS n FROM events WHERE type = 'sending.deleted' AND sending_id = ?", sending.id))[0].n, 1);
  assert.deepEqual(await dev.r2Keys(`work/${sending.files[0].id}/`), [], "mellomlageret er borte");
  assert.equal((await new Client(dev.url).get(`/api/sendings/${sending.id}`)).status, 401);
});
