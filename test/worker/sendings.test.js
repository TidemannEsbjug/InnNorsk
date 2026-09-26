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

test("stier renses, samme sti erstatter, maks antall filer, og utkastfiler kan fjernes (eieren beholder de gamle)", async () => {
  const sending = await svetlana.newSending();
  const first = await svetlana.upload(sending.id, "..\\..\\C:\\Brev\\brev.txt", "Hello 1");
  assert.equal(first.data.file.path, "Brev/brev.txt");
  const again = await svetlana.upload(sending.id, "brev/BREV.txt", "Hello 2");
  assert.equal(again.status, 201);
  const view = (await svetlana.get(`/api/sendings/${sending.id}`)).data.sending;
  assert.deepEqual(view.files.map((f) => f.path), ["brev/BREV.txt"], "samme sti (uansett store/små bokstaver) erstatter");
  // Borte for henne, men den forrige versjonen ligger i R2 og kan lastes ned av eieren.
  const originalOf = (res) => `s/${sending.id}/${res.data.file.id}/original`;
  assert.deepEqual((await dev.r2Keys(`s/${sending.id}/`)).sort(), [originalOf(first), originalOf(again)].sort());
  assert.equal((await svetlana.get(`/api/files/${first.data.file.id}/original`)).status, 404);
  assert.equal((await admin.get(`/api/files/${first.data.file.id}/original`)).data.toString(), "Hello 1");
  const [replaced] = await dev.sql("SELECT deleted_reason, purged_at FROM files WHERE id = ?", first.data.file.id);
  assert.deepEqual([replaced.deleted_reason, replaced.purged_at], ["replaced", null]);
  assert.ok((await dev.sql("SELECT 1 FROM events WHERE type = 'file.replaced' AND file_id = ?", first.data.file.id)).length);

  assert.equal((await svetlana.upload(sending.id, "b.md", "# B")).status, 201);
  assert.equal((await svetlana.upload(sending.id, "c.csv", "a,b")).status, 201);
  const tooMany = await svetlana.upload(sending.id, "d.html", "<p>d</p>");
  assert.deepEqual([tooMany.status, tooMany.data.error], [400, "Du kan sende maks 3 filer om gangen."], "erstattede filer teller ikke");
  assert.equal((await svetlana.del(`/api/sendings/${sending.id}/files/${again.data.file.id}`)).status, 204);
  assert.equal((await svetlana.del(`/api/sendings/${sending.id}/files/${again.data.file.id}`)).status, 404, "allerede fjernet");
  assert.deepEqual(await dev.r2Keys(`s/${sending.id}/${again.data.file.id}/`), [originalOf(again)], "eieren kan fortsatt laste den ned");
  assert.equal((await svetlana.upload(sending.id, "d.html", "<p>d</p>")).status, 201);
  const [removed] = await dev.sql("SELECT data_json, message FROM events WHERE type = 'file.removed' AND file_id = ?", again.data.file.id);
  assert.deepEqual([removed.message, JSON.parse(removed.data_json).reason], ["BREV.txt fjernet før sending", "removed"]);

  // Hun ser tre filer; admin (med all=1) ser også den erstattede og den fjernede, merket, men de telles ikke med.
  assert.deepEqual((await svetlana.get(`/api/sendings/${sending.id}`)).data.sending.files.map((f) => f.name), ["b.md", "c.csv", "d.html"]);
  const theirs = (await admin.get("/api/admin/sendings?all=1&limit=500")).data.sendings.find((s) => s.id === sending.id);
  assert.deepEqual(theirs.files.map((f) => [f.path, f.deletedReason]), [
    ["Brev/brev.txt", "replaced"], ["b.md", null], ["brev/BREV.txt", "removed"], ["c.csv", null], ["d.html", null],
  ]);
  assert.equal(theirs.counts.total, 3);
  assert.ok(!(await admin.get("/api/admin/sendings?limit=200")).data.sendings.find((s) => s.id === sending.id).files.some((f) => f.deletedAt),
    "uten all=1 (iPhone-appen) er listen som før");
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

// Slettet mens den ble oversatt (brukes igjen under: ligger fortsatt i R2 når cron rydder, og slettes for godt av eieren).
let stopped;
// Ferdig oversatt og lastet ned av henne før hun slettet den (slettes for godt av cron under).
let finished;

const theirs = async (id) => (await admin.get("/api/admin/sendings?all=1&limit=500")).data.sendings.find((s) => s.id === id);
const DAY_MS = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

test("sletting: borte for henne (404) med én gang, oversettelsen stopper og mellomlageret ryddes, men eieren beholder filene", async () => {
  const sending = await svetlana.send({ "slett-meg.txt": "Hello", "og-meg.md": "# Hi" });
  stopped = sending;
  const originals = sending.files.map((f) => `s/${sending.id}/${f.id}/original`).sort();
  assert.deepEqual((await dev.r2Keys(`s/${sending.id}/`)).sort(), originals);
  await eventually(async () => (await dev.r2Keys(`work/${sending.files[0].id}/`)).length > 0, { what: "Workflowen har begynt" });
  assert.equal((await svetlana.del(`/api/sendings/${sending.id}`)).status, 204);

  // For henne er den borte, akkurat som før.
  assert.ok(!(await svetlana.get("/api/sendings")).data.sendings.some((s) => s.id === sending.id));
  assert.equal((await svetlana.get(`/api/sendings/${sending.id}`)).status, 404);
  assert.equal((await svetlana.get(`/api/files/${sending.files[0].id}/original`)).status, 404);
  assert.equal((await svetlana.del(`/api/sendings/${sending.id}`)).status, 404);
  assert.equal((await new Client(dev.url).get(`/api/sendings/${sending.id}`)).status, 401);
  assert.deepEqual(await dev.r2Keys(`work/${sending.files[0].id}/`), [], "mellomlageret er borte");
  assert.deepEqual((await dev.r2Keys(`s/${sending.id}/`)).sort(), originals, "originalene ligger der fortsatt");

  const [row] = await dev.sql("SELECT s.status, s.deleted_at, s.deleted_reason, u.username FROM sendings s JOIN users u ON u.id = s.deleted_by WHERE s.id = ?", sending.id);
  assert.deepEqual([row.status, Boolean(row.deleted_at), row.deleted_reason, row.username], ["deleted", true, "user", "svetlana"]);
  const [event] = await dev.sql("SELECT message, data_json FROM events WHERE type = 'sending.deleted' AND sending_id = ?", sending.id);
  assert.equal(event.message, "Svetlana slettet sendingen");
  assert.deepEqual(JSON.parse(event.data_json).names, ["og-meg.md", "slett-meg.txt"]);

  // Eieren: ikke i standardlisten (iPhone-appen), men med all=1, merket med hvem og når, og filene kan lastes ned i 30 dager.
  assert.ok(!(await admin.get("/api/admin/sendings?limit=200")).data.sendings.some((s) => s.id === sending.id));
  const s = await theirs(sending.id);
  assert.deepEqual([s.status, s.deletedBy, s.deletedReason, s.deletedAt], ["deleted", "Svetlana", "user", row.deleted_at]);
  assert.equal(s.counts.total, 2);
  for (const f of s.files) {
    assert.deepEqual([f.deletedAt, f.deletedReason, f.purgedAt], [row.deleted_at, "sending", null]);
    assert.equal(Date.parse(f.purgeAt) - Date.parse(f.deletedAt), 30 * DAY_MS, "RETAIN_DELETED_DAYS = 30");
  }
  const dl = await admin.get(`/api/files/${sending.files[1].id}/original`);
  assert.deepEqual([dl.status, dl.data.toString()], [200, "Hello"]);
  assert.equal((await admin.get(`/api/admin/files/${sending.files[1].id}/calls`)).status, 200);

  // …men ingenting kan startes eller endres igjen.
  const refused = await admin.post(`/api/admin/files/${sending.files[1].id}/status`, { status: "sent" });
  assert.deepEqual([refused.status, refused.data.error], [410, "Sendingen er slettet. Filene kan lastes ned, men ikke endres eller oversettes på nytt."]);
  assert.equal((await admin.put(`/api/admin/files/${sending.files[1].id}/result?name=x.txt`, "x")).status, 410);
  assert.equal((await admin.post(`/api/admin/sendings/${sending.id}/reply`, { reply: "Hei" })).status, 404);
  assert.deepEqual((await dev.r2Keys(`s/${sending.id}/`)).sort(), originals, "ingen oversettelse lastet opp");
});

test("sletting av en ferdig sending: eieren laster ned originalen og oversettelsen, hun får 404; historikken viser alt i rekkefølge", async () => {
  dev.xai.setMode("upper");
  const sending = await svetlana.send({ "ferdig.txt": "Good morning" }, { note: "Til legen" });
  finished = sending;
  const [file] = sending.files;
  await eventually(async () => (await svetlana.get(`/api/sendings/${sending.id}`)).data.sending.status === "done",
    { timeoutMs: 30000, what: "sendingen blir ferdig" });
  dev.xai.setMode("slow", 5000);
  assert.equal((await svetlana.get(`/api/files/${file.id}/result`)).data.toString(), "NB:GOOD MORNING");
  assert.equal((await svetlana.del(`/api/sendings/${sending.id}`)).status, 204);

  assert.equal((await svetlana.get(`/api/files/${file.id}/result`)).status, 404);
  assert.equal((await svetlana.get(`/api/files/${file.id}/original`)).status, 404);
  const result = await admin.get(`/api/files/${file.id}/result`);
  assert.deepEqual([result.status, result.data.toString()], [200, "NB:GOOD MORNING"]);
  assert.match(result.headers.get("content-disposition"), /ferdig%20%28norsk%29\.txt$/);
  assert.equal((await admin.get(`/api/files/${file.id}/original`)).data.toString(), "Good morning");
  const f = (await theirs(sending.id)).files[0];
  assert.deepEqual([f.status, f.outputName, f.deletedReason], ["done", "ferdig (norsk).txt", "sending"]);

  // Historikken for sendingen (Admin → Sendinger → Historikk), eldste først, med hvem som gjorde hva.
  const { events } = (await admin.get(`/api/admin/events?sendingId=${sending.id}&limit=200`)).data;
  const timeline = events.reverse().map((e) => [e.type, e.username]);
  const expected = [
    ["sending.created", "svetlana"], ["file.uploaded", "svetlana"], ["sending.sent", "svetlana"], ["file.started", null], ["file.done", null],
    ["sending.done", null], ["download.result", "svetlana"], ["sending.deleted", "svetlana"], ["download.result", "eier"], ["download.original", "eier"],
  ];
  assert.deepEqual(timeline.filter(([type]) => !type.startsWith("push.")), expected);
  assert.equal(events.find((e) => e.type === "sending.sent").data.note, "Til legen", "meldingen hennes står i loggen");
});

test("cron sletter filene for godt etter RETAIN_DELETED_DAYS: R2 tømmes, historikken blir stående, nedlasting gir 410", async () => {
  // Slettet, men ikke slettet for godt: med i lagringstaket (MAX_STORAGE_GB) og vist for seg i Oversikt.
  const storage = async () => (await admin.get("/api/admin/overview")).data.storage;
  const stored = async (id) => (await dev.sql("SELECT COALESCE(SUM(bytes), 0) + COALESCE(SUM(output_bytes), 0) AS n FROM files WHERE sending_id = ? AND purged_at IS NULL", id))[0].n;
  const bytes = await stored(finished.id);
  const before = await storage();
  assert.ok(before.deletedBytes >= bytes && before.deletedFiles >= 4 && before.bytes >= before.deletedBytes, JSON.stringify(before));
  assert.equal(before.retainDays, 30);

  await dev.sql("UPDATE files SET deleted_at = ? WHERE sending_id = ?", daysAgo(31), finished.id);
  await dev.cron();
  assert.deepEqual(await dev.r2Keys(`s/${finished.id}/`), []);
  const after = await storage();
  assert.deepEqual([after.deletedBytes, after.deletedFiles, await stored(finished.id)], [before.deletedBytes - bytes, before.deletedFiles - 2, 0],
    "lagringstaket teller det ikke lenger");
  const [file] = finished.files;
  const gone = await admin.get(`/api/files/${file.id}/result`);
  assert.deepEqual([gone.status, gone.data.error], [410, "Filen er slettet for godt."]);
  assert.equal((await admin.get(`/api/files/${file.id}/original`)).status, 410);
  assert.equal((await svetlana.get(`/api/files/${file.id}/original`)).status, 404, "for henne er den fortsatt bare borte");

  const s = await theirs(finished.id);
  assert.ok(s.files[0].purgedAt && s.files[0].purgeAt === null, "historikken står igjen, merket som slettet for godt");
  const [event] = await dev.sql("SELECT message, data_json, source FROM events WHERE type = 'sending.purged' AND sending_id = ?", finished.id);
  assert.equal(event.message, "1 fil slettet for godt etter 30 dager");
  assert.deepEqual([JSON.parse(event.data_json).reason, JSON.parse(event.data_json).files, event.source], ["retention", ["ferdig.txt"], "system"]);
  const [sweep] = await dev.sql("SELECT data_json FROM events WHERE type = 'retention.sweep' ORDER BY id DESC LIMIT 1");
  assert.equal(JSON.parse(sweep.data_json).purgedFiles, 1);

  // Det som ble slettet nylig, ligger der fortsatt.
  assert.equal((await dev.r2Keys(`s/${stopped.id}/`)).length, 2);
});

test("«Slett for godt nå» i admin: bare det som er slettet, med én gang", async () => {
  const live = await svetlana.newSending();
  await svetlana.upload(live.id, "lever.txt", "Hello");
  assert.equal((await admin.post(`/api/admin/sendings/${live.id}/purge`)).status, 409, "ingenting er slettet her");
  assert.equal((await svetlana.post(`/api/admin/sendings/${stopped.id}/purge`)).status, 403);
  assert.equal((await admin.post("/api/admin/sendings/finnesikke/purge")).status, 404);

  const res = await admin.post(`/api/admin/sendings/${stopped.id}/purge`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.sending.files.every((f) => f.purgedAt));
  assert.deepEqual(await dev.r2Keys(`s/${stopped.id}/`), []);
  assert.equal((await admin.post(`/api/admin/sendings/${stopped.id}/purge`)).status, 409, "allerede slettet for godt");
  const [event] = await dev.sql("SELECT message, user_id FROM events WHERE type = 'sending.purged' AND sending_id = ?", stopped.id);
  assert.equal(event.message, "2 filer slettet for godt av Jonas");
  assert.equal((await dev.r2Keys(`s/${live.id}/`)).length, 1, "andre sendinger er urørt");
});

test("cron: utkast som aldri ble sendt – tomme fjernes etter to dager, de med filer slettes som om hun slettet dem", async () => {
  const withFile = await svetlana.newSending();
  const file = (await svetlana.upload(withFile.id, "glemt.txt", "Hello")).data.file;
  const empty = await svetlana.newSending();
  await dev.sql("UPDATE sendings SET created_at = ? WHERE id IN (?, ?)", daysAgo(3), withFile.id, empty.id);
  assert.ok(!(await svetlana.get("/api/sendings")).data.sendings.some((s) => s.id === withFile.id), "hun ser ikke gamle utkast");
  assert.equal((await theirs(withFile.id)).status, "draft", "men eieren gjør det");

  await dev.cron();
  assert.deepEqual(await dev.sql("SELECT id FROM sendings WHERE id = ?", empty.id), [], "tomt utkast fjernes helt");
  const s = await theirs(withFile.id);
  assert.deepEqual([s.status, s.deletedReason, s.deletedBy], ["deleted", "expired", null]);
  assert.deepEqual(await dev.r2Keys(`s/${withFile.id}/`), [`s/${withFile.id}/${file.id}/original`]);
  assert.equal((await admin.get(`/api/files/${file.id}/original`)).data.toString(), "Hello");
  assert.equal((await svetlana.get(`/api/files/${file.id}/original`)).status, 404);
  const [event] = await dev.sql("SELECT message, source FROM events WHERE type = 'sending.deleted' AND sending_id = ?", withFile.id);
  assert.deepEqual([event.message, event.source], ["Utkastet ble aldri sendt og er ryddet bort (1 fil)", "system"]);
});

test("nettsiden rydder selv (?reason=): eieren ser forskjell på et klikk og automatisk opprydding", async () => {
  const draft = await svetlana.newSending();
  const file = (await svetlana.upload(draft.id, "rest.txt", "Hello")).data.file;
  assert.equal((await svetlana.del(`/api/sendings/${draft.id}/files/${file.id}?reason=cleanup`)).status, 204);
  assert.equal((await svetlana.del(`/api/sendings/${draft.id}?reason=language`)).status, 204);
  const s = await theirs(draft.id);
  assert.deepEqual([s.deletedReason, s.files[0].deletedReason], ["language", "cleanup"]);
  const events = await dev.sql("SELECT type, message FROM events WHERE sending_id = ? AND type IN ('file.removed', 'sending.deleted') ORDER BY id", draft.id);
  assert.deepEqual(events.map((e) => e.message), [
    "rest.txt fjernet av nettsiden før sending (var ikke lenger i listen)",
    "Utkastet ble forkastet fordi språket ble byttet (filene lastes opp på nytt)",
  ]);
  // Språk og melding på et utkast logges.
  const other = await svetlana.newSending("bokmal");
  await svetlana.post(`/api/sendings/${other.id}/note`, { targetLanguage: "nynorsk", note: "Haster" });
  const [updated] = await dev.sql("SELECT message, data_json FROM events WHERE type = 'sending.updated' AND sending_id = ?", other.id);
  assert.equal(updated.message, "Språket er byttet til nynorsk. Meldingen er endret");
  assert.deepEqual(JSON.parse(updated.data_json), { targetLanguage: "nynorsk", previousLanguage: "bokmal", note: "Haster" });
});

test("aktivitet fra nettleseren: sidevisning, filer som ikke ble tatt med, opplastingsfeil og feilmeldinger havner i loggen", async () => {
  const browser = await dev.login("svetlana"); // egen økt, så kvoten per økt starter på null
  const session = crypto.createHash("sha256").update(browser.cookie.split("=")[1]).digest("hex").slice(0, 8);
  const draft = await browser.newSending();
  const post = (body, opts) => browser.post("/api/client-log", body, opts);
  const ua = { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36" } };
  assert.equal((await post({ type: "client.page", message: "Åpnet / · Chrome på Windows · 1280×800",
    data: { page: "/", viewport: "1280×800", browser: "Chrome på Windows" } }, ua)).status, 204);
  assert.equal((await post({ type: "client.file_rejected", level: "warn", sendingId: draft.id, message: "2 filer ble ikke tatt med: bilde.jpg, gammel.doc",
    data: { headline: "2 filer ble ikke tatt med:", total: 2, reasons: { type: "Filtyper som ikke kan oversettes, for eksempel bilder." },
      files: [{ name: "bilde.jpg", size: 1234, reason: "type" }, { name: "gammel.doc", size: 99, reason: "type" }] } })).status, 204);
  assert.equal((await post({ type: "client.upload_failed", sendingId: draft.id, message: "Opplastingen av brev.docx feilet: Opplastingen ble brutt.",
    data: { name: "brev.docx", size: 5000, status: 0, message: "Opplastingen ble brutt." } })).status, 204);
  assert.equal((await post({ type: "client.error_shown", message: "Feilmelding vist ved sending: «Oversettelsen er ikke satt opp ennå.»",
    data: { where: "send", status: 503, password: "skal-aldri-lagres" } })).status, 204);
  const foreign = await admin.newSending();
  assert.equal((await post({ type: "client.error_shown", message: "fremmed", sendingId: foreign.id })).status, 204);
  assert.equal((await post({ type: "client.error_shown", message: "stor", data: { text: "x".repeat(10000) } })).status, 204);
  assert.equal((await post({ type: "client.noe_annet", message: "x" })).status, 400);

  const rows = await dev.sql("SELECT type, level, message, sending_id, user_id, source, data_json FROM events WHERE session_id = ? AND type LIKE 'client.%' ORDER BY id", session);
  const [page, rejected, failed, shown, other, big] = rows;
  assert.deepEqual(rows.map((r) => [r.type, r.level]), [
    ["client.page", "info"], ["client.file_rejected", "warn"], ["client.upload_failed", "warn"], ["client.error_shown", "warn"],
    ["client.error_shown", "warn"], ["client.error_shown", "warn"],
  ]);
  assert.ok(rows.every((r) => r.source === "web" && r.user_id === page.user_id && r.user_id));
  assert.equal(page.message, "Åpnet / · Chrome på Windows · 1280×800");
  assert.match(JSON.parse(page.data_json).userAgent, /Windows NT 10\.0/);
  assert.deepEqual([rejected.sending_id, JSON.parse(rejected.data_json).files.map((f) => f.name)], [draft.id, ["bilde.jpg", "gammel.doc"]]);
  assert.equal(failed.sending_id, draft.id);
  assert.equal(JSON.parse(shown.data_json).password, "[skjult]", "hemmeligheter vaskes bort");
  assert.equal(other.sending_id, null, "andres sendinger kobles ikke til");
  assert.equal(JSON.parse(big.data_json).truncated, true);
  assert.ok(big.data_json.length < 4500);

  // Egen kvote (60 i minuttet per økt) som ikke tar av kvoten for JavaScript-feil.
  for (let i = rows.length; i < 60; i++) assert.equal((await post({ type: "client.page", message: `side ${i}` })).status, 204);
  const limited = await post({ type: "client.page", message: "en for mye" });
  assert.deepEqual([limited.status, limited.data.error], [429, "For mange hendelser. Prøv igjen om litt."]);
  assert.equal((await post({ message: "TypeError: x" })).status, 204, "client.error har sin egen kvote");
  assert.equal((await new Client(dev.url).post("/api/client-log", { type: "client.page" })).status, 401);
});
