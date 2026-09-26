// Hele fildroppet fra ende til ende uten nettleser: ekte Worker (wrangler dev) med Workflowen, falsk xAI (treg, så
// fremdriften synes) og falsk APNs. Kaller aldri ekte xAI eller Apple.
// Svetlana logger inn → laster opp Word med æøå og tabell, en tekstfil og en skannet PDF → ser estimatene → sender
// (Jonas får push) → Cloudflare oversetter med fremdrift og tid igjen → hun laster ned «… (norsk).docx» (sjekket med
// python-docx) → Jonas ser loggen, hvert Grok-kall, tokens og kostnad.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../../src/core");
const workerDev = require("../helpers/worker-dev");
const { minimalPdf } = require("../helpers/fixtures");
const { Client, proofFor, eventually } = require("../worker/client");
const { makeDocx, readDocx } = require("./documents");

const PHONE = "a1".repeat(32);
const DOCX = "Søknad æøå.docx";
const NOTE = "Hei Jonas! Søknaden haster litt.";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// Testprisene i worker-dev (USD per million tokens).
const cost = (input, output) => Number(((input * 2 + output * 10) / 1e6).toFixed(6));

let dev;
let tmp;
let svetlana;
let admin;
let sending;
const ids = {};

const mine = async (id) => (await svetlana.get(`/api/sendings/${id}`)).data.sending;
const theirs = async (id) => (await admin.get("/api/admin/sendings?limit=200")).data.sendings.find((s) => s.id === id);
const byName = (s, name) => s.files.find((f) => f.name === name);
async function events(type, filter = () => true) {
  const { data } = await admin.get(`/api/admin/events?type=${encodeURIComponent(type)}&limit=500`);
  return data.events.filter(filter).reverse(); // eldste først
}

// En PDF uten tekstlag, som en skannet side: fixture-PDF-en med innholdet byttet mot en tegnet firkant (samme lengde).
function scannedPdf() {
  const pdf = minimalPdf().toString("latin1");
  const stream = pdf.slice(pdf.indexOf("stream\n") + 7, pdf.indexOf("\nendstream"));
  return Buffer.from(pdf.replace(stream, "72 700 200 100 re f".padEnd(stream.length)), "latin1");
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "innnorsk-flyt-"));
  dev = await workerDev.start({ xai: { mode: "slow", delayMs: 1200 } });
  admin = await dev.login("eier");
  const phone = await admin.post("/api/admin/devices", { token: PHONE, env: "sandbox", name: "Jonas sin iPhone" }, { headers: { "X-InnNorsk-Client": "ios" } });
  assert.equal(phone.status, 200);
});

test.after(async () => {
  if (dev) await dev.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test("Svetlana logger inn med PBKDF2-bevis, laster opp Word med æøå og tabell, en tekstfil og en skannet PDF, og ser estimatene", async () => {
  svetlana = new Client(dev.url);
  const { data: salt } = await svetlana.post("/api/auth/salt", { username: "svetlana" });
  assert.equal(salt.iterations, 310000);
  const login = await svetlana.post("/api/auth/login", { username: "svetlana", proof: proofFor(dev.users.svetlana.password, salt.salt, salt.iterations) });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const me = (await svetlana.get("/api/auth/me")).data;
  assert.deepEqual([me.user.displayName, me.translatorName], ["Svetlana", "Jonas"]);

  const draft = await svetlana.newSending("bokmal", NOTE);
  const docx = fs.readFileSync(makeDocx(path.join(tmp, DOCX)));
  ids.docxBytes = docx;
  const up = async (name, body) => {
    const res = await svetlana.upload(draft.id, name, body);
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data.file;
  };
  const word = await up(DOCX, docx);
  const txt = await up("notat.txt", "Hello\n\nWorld\n");
  const pdf = await up("skannet.pdf", scannedPdf());
  assert.deepEqual([word.status, txt.status], ["draft", "draft"]);
  assert.match(word.statusText, /^Klar – (under 1 min|ca\. \d+ min)$/);
  assert.deepEqual([pdf.status, pdf.statusText], ["failed", "Denne PDF-en er et bilde uten tekst og kan ikke oversettes."]);

  const view = await mine(draft.id);
  assert.ok(Math.abs(view.estimateSeconds - (word.estimateSeconds + txt.estimateSeconds)) <= 1, "samlet estimat uten PDF-en");
  const analysis = await core.analyzeBuffer(docx, ".docx");
  const his = byName(await theirs(draft.id), DOCX);
  assert.deepEqual([his.segments, his.chars, his.batches], [analysis.segments, analysis.chars, analysis.batches]);
  assert.equal(analysis.batches, 3, "60 avsnitt + tabell gir tre batcher");
  assert.match(byName(await theirs(draft.id), "skannet.pdf").error, /Fant ingen tekst i PDF-en/);
  assert.deepEqual(dev.apns.pushes, [], "ingen push før hun trykker send");

  const sent = await svetlana.post(`/api/sendings/${draft.id}/send`);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  sending = sent.data.sending;
  assert.equal(sending.status, "sent");
  ids.docx = byName(sending, DOCX).id;
  ids.txt = byName(sending, "notat.txt").id;
  ids.pdf = byName(sending, "skannet.pdf").id;
  assert.equal(byName(sending, "skannet.pdf").status, "failed", "hoppes over");

  const [push] = await dev.apns.waitFor((p) => p.length >= 1);
  assert.equal(push.jwtValid, true, "ES256-JWT-en er signert med APNs-nøkkelen");
  assert.deepEqual([push.token, push.topic, push.pushType, push.priority], [PHONE, "no.innnorsk.varsel", "alert", "10"]);
  assert.deepEqual(push.payload, {
    aps: { alert: { title: "Nye filer fra Svetlana", body: `2 filer: ${DOCX} og 1 til\n«${NOTE}»` }, sound: "default", "thread-id": "innnorsk" },
    sendingId: sending.id,
  });
});

test("Cloudflare oversetter filene én og én, med fremdrift og tid igjen underveis", async () => {
  const seen = [];
  const done = await eventually(async () => {
    const s = await mine(sending.id);
    seen.push({ estimateSeconds: s.estimateSeconds, files: s.files.map((f) => ({ name: f.name, status: f.status, statusText: f.statusText, progress: f.progress })) });
    return s.status === "done" && s;
  }, { timeoutMs: 60000, what: "sendingen blir ferdig" });

  const rows = seen.flatMap((s) => s.files);
  const working = rows.filter((f) => f.name === DOCX && f.status === "working" && f.progress);
  assert.ok(working.length >= 2, `fremdrift underveis: ${JSON.stringify(rows.filter((f) => f.name === DOCX).map((f) => f.statusText))}`);
  for (const f of working) {
    assert.match(f.statusText, /^Oversettes nå – \d+ % – (under 1 min|ca\. \d+ min) igjen$/);
    assert.ok(Number.isFinite(f.progress.etaSeconds) && f.progress.etaSeconds >= 0, "etaSeconds = sekunder igjen nå");
    assert.ok(f.progress.at);
  }
  const percents = new Set(working.map((f) => f.progress.percent));
  assert.ok([...percents].some((p) => p > 0 && p < 100), `delvis ferdig underveis: ${[...percents]}`);
  assert.ok(percents.size >= 2, "prosenten øker mens filen oversettes");
  assert.ok(rows.some((f) => f.name === "notat.txt" && f.status === "sent" && f.statusText === "I kø – starter straks"), "neste fil venter i kø");
  assert.ok(seen.some((s) => s.estimateSeconds > 0 && s.files.some((f) => f.status === "working")), "samlet tid igjen mens den jobber");

  assert.ok(done.finishedAt && done.startedAt);
  assert.equal(done.estimateSeconds, null, "ingenting igjen");
  assert.deepEqual(done.files.map((f) => [f.name, f.status, f.statusText, f.outputName]), [
    [DOCX, "done", "Ferdig", "Søknad æøå (norsk).docx"],
    ["notat.txt", "done", "Ferdig", "notat (norsk).txt"],
    ["skannet.pdf", "failed", "Denne PDF-en er et bilde uten tekst og kan ikke oversettes.", null],
  ]);
  assert.deepEqual(done.counts, { total: 3, waiting: 0, working: 0, done: 2, failed: 1 });
  assert.equal(dev.xai.state.calls, 4, "3 batcher for Word-filen + 1 for teksten, ingen for PDF-en");
  assert.ok(dev.xai.state.requests.every((r) => r.model === "grok-4.6" && r.auth && r.input.startsWith("Du er en profesjonell oversetter til norsk bokmål.")));
  assert.deepEqual(await dev.r2Keys("work/"), [], "mellomlageret er ryddet");
});

test("Svetlana laster ned «Søknad æøå (norsk).docx»: gyldig Word med NB:-tekst, formatering og tabell", async () => {
  const res = await svetlana.get(`/api/files/${ids.docx}/result`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), DOCX_MIME);
  assert.equal(res.headers.get("content-disposition"),
    "attachment; filename=\"Soknad aeoa (norsk).docx\"; filename*=UTF-8''S%C3%B8knad%20%C3%A6%C3%B8%C3%A5%20%28norsk%29.docx");
  assert.equal(Number(res.headers.get("content-length")), res.data.length);
  const file = path.join(tmp, "Søknad æøå (norsk).docx");
  fs.writeFileSync(file, res.data);
  const before = readDocx(path.join(tmp, DOCX));
  const after = readDocx(file);

  assert.equal(after.paragraphs.length, before.paragraphs.length, "ingen avsnitt slått sammen eller borte");
  assert.deepEqual(after.paragraphs[0].runs, [{ text: "NB:APPLICATION FOR A KINDERGARTEN PLACE", bold: true, italic: null, size: 20 }]);
  assert.equal(after.paragraphs[60].text, "NB:PARAGRAPH 60: WE WOULD LIKE TO APPLY FOR A PLACE FOR OUR DAUGHTER ÅSE ØVREBØ.");
  assert.deepEqual(after.paragraphs.at(-1).runs, [{ text: "NB:THANK YOU FOR YOUR HELP.", bold: null, italic: true, size: null }]);
  assert.ok(after.paragraphs.every((p) => !p.text || p.text.startsWith("NB:")), "all tekst er oversatt");
  assert.deepEqual(after.tables, [[
    ["NB:NAME", "NB:ÅSE ØVREBØ"],
    ["NB:PLACE", "NB:TROMSØ, NEAR THE FJORD"],
    ["NB:WISHES", "NB:CLOSE TO HOME"],
  ]]);

  const txt = await svetlana.get(`/api/files/${ids.txt}/result`);
  assert.equal(txt.data.toString("utf8"), "NB:HELLO\n\nNB:WORLD\n");
  assert.match(txt.headers.get("content-disposition"), /filename\*=UTF-8''notat%20%28norsk%29\.txt$/);
  assert.deepEqual((await svetlana.get(`/api/files/${ids.docx}/original`)).data, ids.docxBytes, "originalen er uendret");
  assert.equal((await svetlana.get(`/api/files/${ids.pdf}/result`)).status, 404);
});

test("Jonas ser forløpet i loggen, hvert Grok-kall med tokens, og kostnaden per fil, sending og døgn", async () => {
  const ofSending = (e) => e.sendingId === sending.id;
  const expectations = [
    ["sending.created", "web", 1],
    ["file.uploaded", "web", 3],
    ["sending.sent", "web", 1],
    ["push.sent", "web", 1],
    ["file.started", "system", 2],
    ["file.done", "system", 2],
    ["sending.done", "system", 1],
    ["download.result", "web", 2],
    ["download.original", "web", 1],
  ];
  for (const [type, source, count] of expectations) {
    const found = await events(type, ofSending);
    assert.equal(found.length, count, `${type}: ${JSON.stringify(found.map((e) => e.message))}`);
    assert.ok(found.every((e) => e.source === source), `${type} har kilde ${source}`);
  }
  const [sent] = await events("sending.sent", ofSending);
  assert.deepEqual([sent.username, sent.message, sent.data.files, sent.data.skipped, sent.data.note],
    ["svetlana", "Svetlana sendte 2 filer", 2, 1, "Hei Jonas! Søknaden haster litt."], "meldingen hennes står i loggen");
  const [pdf] = await events("file.uploaded", (e) => e.fileId === ids.pdf);
  assert.equal(pdf.level, "warn");

  const calls = await dev.sql("SELECT file_id, ok, status, input_tokens, output_tokens FROM grok_calls ORDER BY id");
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.ok === 1 && c.status === 200 && c.input_tokens > 0 && c.output_tokens > 0));
  const tokens = (fileId) => calls.filter((c) => c.file_id === fileId).reduce((t, c) => [t[0] + c.input_tokens, t[1] + c.output_tokens], [0, 0]);

  const files = (await theirs(sending.id)).files;
  const word = byName({ files }, DOCX);
  assert.deepEqual([word.calls, word.inputTokens, word.outputTokens, word.costUsd, word.outputSource, word.attempts],
    [3, ...tokens(ids.docx), cost(...tokens(ids.docx)), "cloud", 1]);
  assert.ok(word.durationSeconds >= 1 && word.estimateSeconds > 0);
  assert.equal(byName({ files }, "notat.txt").costUsd, cost(...tokens(ids.txt)));

  const [done] = await events("file.done", (e) => e.fileId === ids.docx);
  assert.deepEqual([done.message, done.data.output, done.data.source, done.data.calls, done.data.costUsd],
    [`${DOCX} er oversatt`, "Søknad æøå (norsk).docx", "cloud", 3, word.costUsd]);
  const [finished] = await events("sending.done", ofSending);
  const total = tokens(ids.docx).map((n, i) => n + tokens(ids.txt)[i]);
  assert.deepEqual({ ...finished.data, estimateSeconds: 0, actualSeconds: 0 }, {
    estimateSeconds: 0, actualSeconds: 0, files: 3, done: 2, failed: 1, calls: 4,
    inputTokens: total[0], outputTokens: total[1], costUsd: Number((word.costUsd + byName({ files }, "notat.txt").costUsd).toFixed(6)),
  });
  assert.ok(finished.data.estimateSeconds > 0 && finished.data.actualSeconds >= 2, JSON.stringify(finished.data));

  const perCall = (await admin.get(`/api/admin/files/${ids.docx}/calls`)).data.calls;
  assert.equal(perCall.length, 3);
  assert.ok(perCall.every((c) => c.ok && c.items > 0 && c.costUsd === cost(c.inputTokens, c.outputTokens)));
  assert.ok(perCall[0].id > perCall[2].id, "nyeste først");

  const { translator } = (await admin.get("/api/admin/overview")).data;
  assert.deepEqual([translator.calls24h, translator.failedCalls24h, translator.tokens24h, translator.cost24h],
    [4, 0, { input: total[0], output: total[1] }, cost(...total)]);
  const [download] = await events("download.result", (e) => e.fileId === ids.docx);
  assert.equal(download.message, "Søknad æøå (norsk).docx lastet ned");
  const [phone] = await events("device.registered");
  assert.equal(phone.source, "ios", "registrert fra iPhone-appen");
});
