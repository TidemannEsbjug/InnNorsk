// Hele fildroppet fra ende til ende uten nettleser: ekte Worker (wrangler dev) + den ekte Mac-agenten som egen prosess
// (node mac/innnorsk-mottak.js once) med falsk Grok CLI og falsk APNs. Kaller aldri ekte xAI, Grok eller Apple.
// Svetlana logger inn og sender → Jonas får push → Mac-en oversetter med fremdrift → hun laster ned «… (norsk).docx»
// → Jonas ser loggen → Grok ikke logget inn → skadet fil → Mac-en borte (cron-push én gang) → Mac-en tilbake.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const workerDev = require("../helpers/worker-dev");
const { Client, proofFor } = require("../worker/client");
const { localDate } = require("../../mac/local-files");
const { makeDocx, readDocx } = require("./documents");
const { startMac, FAKE_COST_PER_CALL } = require("./mac-agent");

const PHONE = "a1".repeat(32);
const DOCX = "Søknad æøå.docx";
const NOTE = "Hei Jonas! Søknaden haster litt.";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const HOUR = 3600000;

let dev;
let mac;
let tmp;
let svetlana;
let admin;
let sending; // den første sendingen (Word + tekst)
const ids = {};

const pushes = (re) => dev.apns.pushes.filter((p) => re.test(p.payload.aps.alert.title));
const waitForPushes = (re, n = 1) => dev.apns.waitFor(() => pushes(re).length >= n).then(() => pushes(re));
const mine = async (id) => (await svetlana.get(`/api/sendings/${id}`)).data.sending;
const theirs = async (id) => (await admin.get("/api/admin/sendings?limit=200")).data.sendings.find((s) => s.id === id);
const overview = async () => (await admin.get("/api/admin/overview")).data;
const byName = (s, name) => s.files.find((f) => f.name === name);
async function events(type, filter = () => true) {
  const { data } = await admin.get(`/api/admin/events?type=${encodeURIComponent(type)}&limit=500`);
  return data.events.filter(filter).reverse(); // eldste først
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "innnorsk-flyt-"));
  dev = await workerDev.start();
  mac = startMac(dev);
  admin = await dev.login("eier");
  const phone = await admin.post("/api/admin/devices", { token: PHONE, env: "sandbox", name: "Jonas sin iPhone" }, { headers: { "X-InnNorsk-Client": "ios" } });
  assert.equal(phone.status, 200);
});

test.after(async () => {
  if (mac) await mac.cleanup();
  if (dev) await dev.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test("Svetlana logger inn med PBKDF2-bevis og sender Word med æøå og tabell + en tekstfil; Jonas får push", async () => {
  svetlana = new Client(dev.url);
  const { data: salt } = await svetlana.post("/api/auth/salt", { username: "svetlana" });
  assert.equal(salt.iterations, 310000);
  const login = await svetlana.post("/api/auth/login", { username: "svetlana", proof: proofFor(dev.users.svetlana.password, salt.salt, salt.iterations) });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const me = (await svetlana.get("/api/auth/me")).data;
  assert.deepEqual([me.user.displayName, me.translatorName], ["Svetlana", "Jonas"]);

  const draft = await svetlana.newSending("bokmal", NOTE);
  assert.equal(draft.status, "draft");
  const docx = fs.readFileSync(makeDocx(path.join(tmp, DOCX)));
  ids.docxBytes = docx;
  assert.equal((await svetlana.upload(draft.id, DOCX, docx)).status, 201);
  assert.equal((await svetlana.upload(draft.id, "notat.txt", "Hello\n\nWorld\n")).status, 201);
  assert.deepEqual(dev.apns.pushes, [], "ingen push før hun trykker send");

  const sent = await svetlana.post(`/api/sendings/${draft.id}/send`);
  assert.equal(sent.status, 200);
  sending = sent.data.sending;
  assert.equal(sending.status, "sent");
  assert.deepEqual(sending.files.map((f) => [f.name, f.status]), [[DOCX, "sent"], ["notat.txt", "sent"]]);
  ids.docx = byName(sending, DOCX).id;
  ids.txt = byName(sending, "notat.txt").id;
  assert.equal(byName(sending, DOCX).statusText, "Mottatt – oversettelsen starter når oversetteren er klar", "Mac-en har ikke meldt seg ennå");

  const [push] = await waitForPushes(/^Nye filer/);
  assert.equal(push.jwtValid, true, "ES256-JWT-en er signert med APNs-nøkkelen");
  assert.deepEqual(push.jwt.header, { alg: "ES256", kid: "TESTKEY123" });
  assert.equal(push.jwt.claims.iss, "TESTTEAM12");
  assert.ok(Math.abs(push.jwt.claims.iat - Date.now() / 1000) < 3600);
  assert.deepEqual([push.token, push.topic, push.pushType, push.priority], [PHONE, "no.innnorsk.varsel", "alert", "10"]);
  assert.deepEqual(push.payload, {
    aps: { alert: { title: "Nye filer fra Svetlana", body: `2 filer: ${DOCX} og 1 til\n«${NOTE}»` }, sound: "default", "thread-id": "innnorsk" },
    sendingId: sending.id,
  });
});

test("Mac-agenten henter filene, melder fremdrift underveis og leverer oversettelsen med kostnad", async () => {
  const agent = mac.spawn("once", { FAKE_GROK_MODE: "slow", FAKE_GROK_DELAY_MS: "1200" });
  const seen = [];
  let running = true;
  agent.exited.then(() => {
    running = false;
  });
  while (running) {
    const s = await mine(sending.id);
    seen.push(...s.files.map((f) => ({ name: f.name, status: f.status, statusText: f.statusText, progress: f.progress })));
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(await agent.exited, 0, agent.stderr);

  const docxRows = seen.filter((f) => f.name === DOCX);
  const working = docxRows.filter((f) => f.status === "working" && f.progress);
  assert.ok(working.length >= 2, `fremdrift underveis: ${JSON.stringify(docxRows.map((f) => f.statusText))}`);
  for (const f of working) {
    assert.match(f.statusText, /^Oversettes nå – \d+ % – (under 1 min|ca\. \d+ min) igjen$/);
    assert.ok(Number.isFinite(f.progress.etaSeconds) && f.progress.etaSeconds >= 0, "etaSeconds = sekunder igjen nå");
    assert.ok(f.progress.at);
  }
  const percents = new Set(working.map((f) => f.progress.percent));
  assert.ok([...percents].some((p) => p > 0 && p < 100), `delvis ferdig underveis: ${[...percents]}`);
  assert.ok(percents.size >= 2, "prosenten øker mens Mac-en jobber");
  assert.ok(seen.some((f) => f.name === "notat.txt" && f.status === "sent" && f.statusText === "Mottatt – oversettes snart"),
    "neste fil venter mens Mac-en er på nett");

  const done = await mine(sending.id);
  assert.equal(done.status, "done");
  assert.ok(done.finishedAt);
  assert.deepEqual(done.files.map((f) => [f.name, f.status, f.statusText, f.outputName]), [
    [DOCX, "done", "Ferdig", "Søknad æøå (norsk).docx"],
    ["notat.txt", "done", "Ferdig", "notat (norsk).txt"],
  ]);
  assert.deepEqual(done.counts, { total: 2, waiting: 0, working: 0, done: 2, failed: 0 });

  const calls = mac.grokCalls();
  assert.equal(calls.length, 4, "3 batcher for Word-filen + 1 for teksten");
  assert.ok(calls.every((c) => c.mode === "slow" && c.args.includes("--prompt-file")));
  const files = (await theirs(sending.id)).files;
  for (const f of files) {
    assert.deepEqual([f.outputSource, f.attempts, f.error], ["agent", 1, null], f.name);
    assert.ok(f.costUsd > 0, `kostnad for ${f.name}`);
  }
  assert.equal(byName({ files }, DOCX).costUsd, Number((3 * FAKE_COST_PER_CALL).toFixed(6)));
  assert.equal(byName({ files }, "notat.txt").costUsd, Number(FAKE_COST_PER_CALL.toFixed(6)));

  const types = agent.types();
  assert.deepEqual([types[0], types.at(-1)], ["agent.started", "agent.stopped"]);
  assert.equal(types.filter((t) => t === "file.translated").length, 2);
  const folder = path.join(mac.home, "InnNorsk", `${localDate()} Svetlana`);
  assert.deepEqual(fs.readFileSync(path.join(folder, DOCX)), ids.docxBytes, "lokal kopi av originalen på Mac-en");
  assert.ok(fs.existsSync(path.join(folder, "Søknad æøå (norsk).docx")), "og av oversettelsen");
  assert.ok(mac.notifications().some((n) => n.includes(`Ferdig oversatt: ${DOCX} (fra Svetlana)`)));
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
});

test("Jonas ser hele forløpet i loggen: nettside, Mac og push", async () => {
  const ofSending = (e) => e.sendingId === sending.id;
  const expectations = [
    ["sending.created", "web", 1],
    ["file.uploaded", "web", 2],
    ["sending.sent", "web", 1],
    ["push.sent", "web", 1],
    ["agent.started", "agent", 1, () => true],
    ["file.claimed", "agent", 2],
    ["file.processing", "agent", 2],
    ["file.translated", "agent", 2],
    ["file.done", "agent", 2],
    ["sending.done", "agent", 1],
    ["download.result", "web", 2],
    ["download.original", "web", 1],
  ];
  for (const [type, source, count, filter = ofSending] of expectations) {
    const found = await events(type, filter);
    assert.equal(found.length, count, `${type}: ${JSON.stringify(found.map((e) => e.message))}`);
    assert.ok(found.every((e) => e.source === source), `${type} har kilde ${source}`);
  }
  const [sent] = await events("sending.sent", ofSending);
  assert.deepEqual([sent.username, sent.message, sent.data.files, sent.data.note], ["svetlana", "Svetlana sendte 2 filer", 2, true]);
  const [claimed] = await events("file.claimed", (e) => e.fileId === ids.docx);
  assert.equal(claimed.message, `Mac-en begynner på ${DOCX}`);
  const [translated] = await events("file.translated", (e) => e.fileId === ids.docx);
  assert.equal(translated.data.costUsd, Number((3 * FAKE_COST_PER_CALL).toFixed(6)));
  assert.equal(translated.data.outputName, "Søknad æøå (norsk).docx");
  const [download] = await events("download.result", (e) => e.fileId === ids.docx);
  assert.equal(download.message, "Søknad æøå (norsk).docx lastet ned");
  const [online] = await events("agent.online");
  assert.match(online.message, /^Mac-en meldte seg for første gang/);
  const [phone] = await events("device.registered");
  assert.equal(phone.source, "ios", "registrert fra iPhone-appen");
});

test("Grok CLI ikke logget inn: fila legges tilbake i køen, og feilen vises i oversikten", async () => {
  const second = await svetlana.send({ "brev.txt": "Dear neighbour,\n\nThe party starts at six.\n" });
  ids.brev = second.files[0].id;
  const run = await mac.once({ FAKE_GROK_MODE: "auth" });
  assert.equal(run.code, 1, "once avslutter med feilkode når Grok ikke virker");
  assert.ok(run.types.includes("agent.error"));

  const [row] = await dev.sql("SELECT status, attempts, lease_until FROM files WHERE id = ?", ids.brev);
  assert.deepEqual([row.status, row.attempts, row.lease_until], ["sent", 0, null], "tilbake i køen, forsøket telles ikke");
  assert.equal(byName(await mine(second.id), "brev.txt").statusText, "Mottatt – oversettes snart");
  const [released] = await events("file.released", (e) => e.fileId === ids.brev);
  assert.match(released.message, /^Mac-en ga tilbake brev\.txt: Grok CLI er ikke logget inn\. Kjør «grok login»/);
  assert.equal(released.source, "agent");

  const { agent, counts } = await overview();
  assert.deepEqual([agent.online, agent.state, agent.grokOk], [true, "error", false]);
  assert.match(agent.stateMessage, /Grok CLI er ikke logget inn.*grok login/);
  assert.equal(counts.waiting, 1);
  const [state] = (await events("agent.state")).slice(-1);
  assert.deepEqual([state.level, state.source], ["warn", "agent"]);
  assert.ok(mac.notifications().some((n) => /trenger hjelp/.test(n) && /grok login/.test(n)), "varsel på Mac-en");
  assert.equal(pushes(/^Kunne ikke/).length, 0, "ingen push til Jonas: fila er ikke ødelagt");
});

test("skadet Word-fil feiler med push til Jonas; den frigitte fila oversettes når Grok virker igjen", async () => {
  const third = await svetlana.send({ "Skadet.docx": "dette er ikke en zip-fil" });
  ids.skadet = third.files[0].id;
  const run = await mac.once({ FAKE_GROK_MODE: "ok" });
  assert.equal(run.code, 0, run.stderr);

  const brev = (await dev.sql("SELECT status, output_name FROM files WHERE id = ?", ids.brev))[0];
  assert.deepEqual([brev.status, brev.output_name], ["done", "brev (norsk).txt"]);
  const hers = byName(await mine(third.id), "Skadet.docx");
  assert.deepEqual([hers.status, hers.statusText, hers.outputName], ["failed", "Oversetteren ser på denne filen", null]);
  assert.equal("error" in hers, false, "tekniske detaljer vises ikke for henne");
  const his = byName(await theirs(third.id), "Skadet.docx");
  assert.equal(his.attempts, 1);
  assert.ok(his.error, "feilmelding for Jonas");
  assert.match(his.errorDetails, /\n\s+at /, "med stakk i detaljene");

  const [push] = await waitForPushes(/^Kunne ikke/);
  assert.equal(push.payload.aps.alert.title, "Kunne ikke oversette Skadet.docx");
  assert.equal(push.payload.aps.alert.body, his.error.slice(0, 180));
  assert.equal(push.payload.sendingId, third.id);
  assert.equal(push.jwtValid, true);

  const { agent, counts } = await overview();
  assert.deepEqual([agent.state, agent.stateMessage, agent.grokOk], ["idle", "Venter på filer", true]);
  assert.equal(counts.failed, 1);
  const [failed] = await events("file.failed", (e) => e.fileId === ids.skadet);
  assert.deepEqual([failed.level, failed.source], ["error", "agent"]);
  assert.equal((await events("agent.state")).slice(-1)[0].level, "info", "tilbake fra feiltilstanden");
});

test("Mac-en borte mens Svetlana venter: cron varsler Jonas én gang, og alt går videre når Mac-en er tilbake", async () => {
  const WAITING = /venter: Mac-en/;
  const fourth = await svetlana.send({ "vent.txt": "Hello" });
  await dev.sql("UPDATE agent SET last_seen_at = ?, offline_alert_sent_at = NULL", new Date(Date.now() - 3 * HOUR).toISOString());
  assert.equal(byName(await mine(fourth.id), "vent.txt").statusText, "Mottatt – oversettelsen starter når oversetteren er klar");
  assert.equal((await overview()).agent.online, false);

  await dev.cron();
  const [alert] = await waitForPushes(WAITING);
  assert.match(alert.payload.aps.alert.title, /^Svetlana venter: Mac-en har ikke svart siden \d{2}:\d{2}$/);
  assert.equal(alert.payload.aps.alert.body, "1 fil ligger i kø. Sjekk at Mac-en er på og at InnNorsk-mottaket kjører.");
  assert.equal(alert.jwtValid, true);
  await dev.cron();
  await dev.cron();
  assert.equal(pushes(WAITING).length, 1, "bare én push per fravær");

  const run = await mac.once({ FAKE_GROK_MODE: "ok" });
  assert.equal(run.code, 0, run.stderr);
  const back = await mine(fourth.id);
  assert.deepEqual([back.status, back.files[0].outputName], ["done", "vent (norsk).txt"]);
  assert.equal((await dev.sql("SELECT offline_alert_sent_at FROM agent"))[0].offline_alert_sent_at, null, "nullstilt til neste fravær");
  assert.match((await events("agent.online")).slice(-1)[0].message, /^Mac-en er tilbake/);
  assert.equal((await events("agent.offline_alert")).length, 1);
});
