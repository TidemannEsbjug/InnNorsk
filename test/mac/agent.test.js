// Mottaket mot det falske agent-API-et og den falske Grok CLI-en. Kaller aldri ekte Grok eller nettstedet.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const { createAgent } = require("../../mac/agent");
const { localDate } = require("../../mac/local-files");
const { startFakeAgentApi } = require("../helpers/fake-agent-api");
const { minimalDocx } = require("../helpers/fixtures");
const { CLI, machine, fakeGrok, agentConfig, writeSetup, waitFor, isAlive, readLines } = require("./helpers");

async function setupAgent(t, mode, extra = {}) {
  const m = machine(t);
  fakeGrok(t, m, mode);
  const api = await startFakeAgentApi();
  t.after(() => api.close());
  const config = agentConfig(api, m, extra);
  const lines = [];
  const agent = createAgent({ config, token: api.token, paths: m.paths, write: (l) => lines.push(JSON.parse(l)) });
  return { m, api, config, agent, lines };
}

const docXml = async (buf) => (await JSZip.loadAsync(buf)).file("word/document.xml").async("string");
const callsTo = (api, pattern) => api.calls.filter((c) => pattern.test(`${c.method} ${c.path}`));

test("fil går sendt → under arbeid → ferdig, med fremdrift, estimat, kostnad og lokale kopier", async (t) => {
  const { m, api, agent, lines } = await setupAgent(t, "ok");
  const paragraphs = Array.from({ length: 60 }, (_, i) => `Paragraph number ${i} about Bergen`);
  const file = api.addFile({ name: "Rapport.docx", relPath: "Mappe/Rapport.docx", body: await minimalDocx(paragraphs) });

  assert.equal(await agent.run({ once: true }), 0);
  assert.deepEqual(file.history, ["sent", "working", "done"]);
  assert.equal(file.outputName, "Rapport.docx");
  const xml = await docXml(file.result);
  assert.match(xml, /NB:PARAGRAPH NUMBER 59 ABOUT BERGEN/);
  assert.match(xml, /<w:b\/>/, "formateringen er beholdt");

  const grokCalls = m.grokCalls().length;
  assert.equal(grokCalls, 3, "60 avsnitt = 3 batcher");
  assert.equal(file.costUsd, Number((0.0007 * grokCalls).toFixed(6)));

  assert.ok(file.progress.length >= 4, "start + én per batch");
  assert.equal(file.progress[0].message, "Starter oversettelsen");
  assert.equal(file.progress[0].percent, 0);
  assert.ok(file.progress[0].etaSeconds > 0, "estimat fra tidsmodellen før første batch");
  for (const p of file.progress) {
    assert.ok(p.percent >= 0 && p.percent <= 99);
    assert.ok(Number.isFinite(p.etaSeconds) && p.etaSeconds >= 0);
    assert.equal(p.leaseSeconds, 30);
  }
  assert.ok(file.progress.at(-1).percent > 90);

  const hb = api.heartbeats[0];
  assert.equal(hb.state, "idle");
  assert.equal(hb.version, require("../../package.json").version);
  assert.ok(hb.host);
  const types = api.events.map((e) => e.type);
  for (const type of ["agent.started", "file.processing", "file.translated"]) assert.ok(types.includes(type), type);
  const translated = api.events.find((e) => e.type === "file.translated");
  assert.equal(translated.data.costUsd, file.costUsd);
  assert.deepEqual([translated.fileId, translated.sendingId], [file.id, file.sendingId], "koblet til fila i loggen");
  assert.ok(lines.some((l) => l.type === "file.translated" && l.level === "info"));

  const folder = path.join(m.home, "InnNorsk", `${localDate()} Svetlana`, "Mappe");
  assert.deepEqual(fs.readFileSync(path.join(folder, "Rapport.docx")), file.body);
  assert.deepEqual(fs.readFileSync(path.join(folder, "Rapport (norsk).docx")), file.result);
  const [notice] = await waitFor(() => m.binCalls("osascript").length && m.binCalls("osascript"), { what: "varselet" });
  assert.match(notice[1], /Ferdig oversatt: Rapport\.docx/);
  assert.equal(JSON.parse(fs.readFileSync(m.paths.statsFile, "utf8")).batches.length, 3);
});

test("Grok CLI ikke logget inn eller mangler: fila legges tilbake og agenten melder feil", async (t) => {
  const { api, agent } = await setupAgent(t, "auth");
  const file = api.addFile({ name: "Brev.txt", body: Buffer.from("Hello\n\nWorld\n") });
  assert.equal(await agent.run({ once: true }), 1);
  assert.deepEqual(file.history, ["sent", "working", "sent"]);
  assert.match(file.releaseReason, /grok login/);
  const hb = api.heartbeats.at(-1);
  assert.equal(hb.state, "error");
  assert.match(hb.stateMessage, /ikke logget inn/);
  assert.equal(hb.grokOk, false);
  assert.ok(api.events.some((e) => e.type === "agent.error" && e.level === "error"));
  assert.equal(callsTo(api, /\/fail$/).length, 0);

  const missing = await setupAgent(t, "ok", { grok: { command: "/finnes/ikke/grok", args: [], effort: null, timeoutSeconds: 5 } });
  const other = missing.api.addFile({ name: "Brev.txt", body: Buffer.from("Hello") });
  assert.equal(await missing.agent.run({ once: true }), 1);
  assert.deepEqual(other.history, ["sent", "working", "sent"]);
  assert.match(missing.api.heartbeats.at(-1).stateMessage, /Fant ikke Grok CLI/);
});

test("etter pausen prøver mottaket igjen, og klarer det når Grok er i orden", async (t) => {
  const { api, agent, m } = await setupAgent(t, "auth");
  const file = api.addFile({ name: "Brev.txt", body: Buffer.from("Hello\n\nWorld\n") });
  const running = agent.run();
  await waitFor(() => file.history.length >= 3, { what: "at fila legges tilbake" });
  assert.equal(file.releaseReason.includes("grok login"), true);
  process.env.FAKE_GROK_MODE = "ok";
  await waitFor(() => file.status === "done", { what: "ny runde etter pausen" });
  await waitFor(() => api.heartbeats.some((h) => h.state === "idle" && h.grokOk === true), { what: "frisk status" });
  agent.stop();
  assert.equal(await running, 0);
  assert.equal(file.result.toString(), "NB:HELLO\n\nNB:WORLD\n");
  assert.deepEqual(file.history, ["sent", "working", "sent", "working", "done"]);
  await waitFor(() => m.binCalls("osascript").some((c) => /Ferdig oversatt/.test(c[1])), { what: "varselet" });
  assert.equal(m.binCalls("osascript").filter((c) => /trenger hjelp/.test(c[1])).length, 1, "bare ett varsel per problem");
});

test("skadet dokument markeres som feilet med melding og detaljer", async (t) => {
  const { api, agent } = await setupAgent(t, "ok");
  const file = api.addFile({ name: "Skadet.docx", body: Buffer.from("dette er ikke en zip-fil") });
  assert.equal(await agent.run({ once: true }), 0);
  assert.deepEqual(file.history, ["sent", "working", "failed"]);
  assert.match(file.error, /zip/i);
  assert.match(file.errorDetails, /\n\s+at /, "stakk med i detaljene");
  assert.equal(callsTo(api, /\/release$/).length, 0);
  assert.ok(api.events.some((e) => e.type === "file.failed" && e.level === "error"));
});

test("Grok som krasjer igjen og igjen på samme fil: tilbake i køen to ganger, så feilet", async (t) => {
  const { api, agent } = await setupAgent(t, "crash", { pauseSeconds: 0.05 });
  const file = api.addFile({ name: "Brev.txt", body: Buffer.from("Hello") });
  const running = agent.run();
  await waitFor(() => file.status === "failed", { what: "feilet fil" });
  agent.stop();
  await running;
  assert.deepEqual(file.history, ["sent", "working", "sent", "working", "sent", "working", "failed"]);
  assert.match(file.error, /Grok CLI feilet: panic/);
});

test("leien forlenges mens en lang batch pågår, og agenten melder seg underveis", async (t) => {
  const { api, agent } = await setupAgent(t, "slow", { leaseSeconds: 0.9 });
  process.env.FAKE_GROK_DELAY_MS = "1500";
  const file = api.addFile({ name: "Brev.txt", body: Buffer.from("Hello\n\nWorld\n") });
  assert.equal(await agent.run({ once: true }), 0);
  assert.deepEqual(file.history, ["sent", "working", "done"]);
  const claimedAt = callsTo(api, /\/claim$/)[0].at;
  const late = file.progress.filter((p) => p.at > claimedAt + 900);
  assert.ok(late.length >= 1, "fremdrift etter at første leie ville gått ut");
  assert.ok(file.progress.length >= 4);
  assert.ok(api.heartbeats.some((h) => h.state === "working" && /Brev\.txt/.test(h.stateMessage)));
});

test("nettverksfeil mot nettstedet: prøver igjen og beholder fila", async (t) => {
  const { api, agent, lines } = await setupAgent(t, "ok");
  api.failNext("GET", /\/original$/, 502, 1);
  api.failNext("PUT", /\/result$/, 503, 2);
  const file = api.addFile({ name: "Brev.txt", body: Buffer.from("Hello") });
  assert.equal(await agent.run({ once: true }), 0);
  assert.deepEqual(file.history, ["sent", "working", "done"]);
  assert.equal(callsTo(api, /PUT .*\/result$/).length, 3);
  assert.equal(callsTo(api, /\/(release|fail)$/).length, 0);
  assert.equal(lines.filter((l) => l.type === "worker.retry").length, 3);
});

test("fila er slettet på nettstedet underveis: mottaket hopper over den", async (t) => {
  const { api, agent } = await setupAgent(t, "ok");
  const file = api.addFile({ name: "Brev.txt", body: Buffer.from("Hello") });
  api.failNext("PUT", /\/result$/, 404, 1);
  assert.equal(await agent.run({ once: true }), 0);
  assert.equal(file.status, "working");
  assert.equal(callsTo(api, /\/(release|fail)$/).length, 0);
});

test("fil med utløpt leie (mottaket stoppet brått) tas opp og gjøres ferdig", async (t) => {
  const { api, agent } = await setupAgent(t, "ok");
  const file = api.addFile({ name: "Brev.txt", body: Buffer.from("Hello") });
  Object.assign(file, { status: "working", history: ["sent", "working"], attempts: 1, leaseUntil: Date.now() - 1000 });
  assert.equal(await agent.run({ once: true }), 0);
  assert.deepEqual(file.history, ["sent", "working", "working", "done"]);
  assert.equal(file.attempts, 2);
});

test("SIGTERM under oversettelse: CLI-en stoppes og fila legges tilbake i køen", async (t) => {
  const m = machine(t);
  const api = await startFakeAgentApi();
  t.after(() => api.close());
  writeSetup(m, agentConfig(api, m), api.token);
  const pidFile = path.join(m.home, "barnebarn.pid");
  const env = { ...m.env, FAKE_GROK_MODE: "slow", FAKE_GROK_DELAY_MS: "30000", FAKE_GROK_PIDFILE: pidFile, FAKE_GROK_LOG: m.grokLog };
  const file = api.addFile({ name: "Brev.txt", body: Buffer.from("Hello") });
  const child = spawn(process.execPath, [CLI, "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

  const grandchild = Number(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8"), { what: "Grok-kallet" }));
  assert.equal(file.status, "working");
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.deepEqual(file.history, ["sent", "working", "sent"]);
  assert.match(file.releaseReason, /stoppet/);
  await waitFor(() => !isAlive(grandchild), { what: "at Grok-prosessene stopper" });
  const types = stdout.trim().split("\n").map((l) => JSON.parse(l).type);
  assert.deepEqual([types[0], types.at(-1)], ["agent.started", "agent.stopped"]);
  assert.ok(types.includes("file.released"));
  assert.equal(readLines(m.grokLog)[0].mode, "slow");
});
