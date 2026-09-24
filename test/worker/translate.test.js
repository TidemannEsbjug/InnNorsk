// Oversettelsen i Cloudflare (Workflowen TranslateSending) mot ekte wrangler dev og en falsk xAI som byttes underveis:
// nynorsk, feil antall fra Grok, nøkkelen avvist (401) midt i en fil, sett i kø igjen uten å betale to ganger,
// cron som rydder opp etter en stoppet oversettelse, og sletting midt i oversettelsen. Kaller aldri ekte xAI eller Apple.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const workerDev = require("../helpers/worker-dev");
const { minimalDocx } = require("../helpers/fixtures");
const { makeDocx, readDocx } = require("../integration/documents");
const { eventually } = require("./client");

const PHONE = "c3".repeat(32);
const AUTH_ERROR = "[auth] xAI avviste API-nøkkelen (401). Sjekk at nøkkelen er riktig.";
let dev;
let tmp;
let svetlana;
let admin;

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "innnorsk-wf-"));
  // Én batch om gangen, så testene vet nøyaktig hvilket kall som feiler.
  dev = await workerDev.start({ vars: { GROK_CONCURRENCY: "1" } });
  [svetlana, admin] = [await dev.login("svetlana"), await dev.login("eier")];
  assert.equal((await admin.post("/api/admin/devices", { token: PHONE, env: "sandbox", name: "Jonas sin iPhone" })).status, 200);
});

test.after(async () => {
  if (process.env.DEV_LOG) fs.writeFileSync(process.env.DEV_LOG, dev.logs() + "\n\nREQUESTS\n" + JSON.stringify(dev.xai.state.requests.map((r) => r.input.slice(-120)), null, 1));
  if (dev) await dev.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const mine = async (id) => (await svetlana.get(`/api/sendings/${id}`)).data.sending;
const theirs = async (id) => (await admin.get("/api/admin/sendings?limit=200")).data.sendings.find((s) => s.id === id);
const finished = (id) => eventually(async () => {
  const s = await mine(id);
  return s.status === "done" && s;
}, { timeoutMs: 30000, what: "sendingen blir ferdig" });
const requestsSince = (n) => dev.xai.state.requests.slice(n);

async function downloadDocx(fileId, name) {
  const res = await svetlana.get(`/api/files/${fileId}/result`);
  assert.equal(res.status, 200);
  const file = path.join(tmp, name);
  fs.writeFileSync(file, res.data);
  return readDocx(file);
}

test("nynorsk: prompten ber om norsk nynorsk, og resultatet kommer som «(norsk)»", async () => {
  dev.xai.setMode("upper");
  const before = dev.xai.state.requests.length;
  const sending = await svetlana.send({ "Morgon.txt": "Good morning\n\nSee you soon\n" }, { targetLanguage: "nynorsk" });
  const done = await finished(sending.id);
  assert.equal(done.files[0].outputName, "Morgon (norsk).txt");
  const [request] = requestsSince(before);
  assert.match(request.input, /^Du er en profesjonell oversetter til norsk nynorsk\./);
  assert.equal((await svetlana.get(`/api/files/${done.files[0].id}/result`)).data.toString("utf8"), "NB:GOOD MORNING\n\nNB:SEE YOU SOON\n");
});

test("Grok svarer med feil antall (mismatch): batchen deles opp, og filen blir likevel ferdig og riktig", async () => {
  dev.xai.setMode("mismatch");
  if (dev.xai.state.calls % 2 === 1) dev.xai.state.calls++; // neste kall får oddetall, og da mangler siste element
  const paragraphs = Array.from({ length: 10 }, (_, i) => `Line ${i + 1} of the letter`);
  const sending = await svetlana.send({ "brev.docx": await minimalDocx(paragraphs) });
  const done = await finished(sending.id);
  dev.xai.setMode("upper");
  assert.equal(done.files[0].status, "done");
  const doc = await downloadDocx(done.files[0].id, "brev (norsk).docx");
  assert.deepEqual(doc.paragraphs.map((p) => p.text), paragraphs.map((p) => `NB:${p.toUpperCase()}`));
  assert.ok(doc.paragraphs.every((p) => p.runs[0].bold), "fet skrift beholdt");
  assert.ok((await theirs(sending.id)).files[0].calls >= 2, "flere kall enn batcher");
});

test("nøkkelen avvises (401) midt i en fil: filen feiler vennlig, resten av sendingen stopper, og eieren får vite hvorfor", async () => {
  const docx = fs.readFileSync(makeDocx(path.join(tmp, "a-lang.docx")));
  const sending = await svetlana.newSending();
  for (const [name, body] of [["a-lang.docx", docx], ["b.txt", "Hello"], ["c.txt", "World"]]) {
    assert.equal((await svetlana.upload(sending.id, name, body)).status, 201);
  }
  dev.xai.setMode("slow", 1500);
  dev.apns.reset();
  const calls = dev.xai.state.calls;
  assert.equal((await svetlana.post(`/api/sendings/${sending.id}/send`)).status, 200);
  // Første batch er underveis (svaret er allerede bestemt); alt som kommer etter, blir avvist.
  await eventually(() => dev.xai.state.calls === calls + 1, { timeoutMs: 15000, what: "første Grok-kall" });
  dev.xai.setMode("fail401");

  const done = await finished(sending.id);
  assert.deepEqual(done.files.map((f) => [f.name, f.status, f.statusText]), [
    ["a-lang.docx", "failed", "Kunne ikke oversettes. Jonas har fått beskjed."],
    ["b.txt", "failed", "Kunne ikke oversettes. Jonas har fått beskjed."],
    ["c.txt", "failed", "Kunne ikke oversettes. Jonas har fått beskjed."],
  ]);
  assert.ok(done.files.every((f) => !("error" in f)), "hun ser ingen tekniske detaljer");
  assert.equal(dev.xai.state.calls, calls + 2, "én vellykket batch + ett avvist kall; b.txt og c.txt ble aldri sendt");

  const files = (await theirs(sending.id)).files;
  assert.ok(files.every((f) => f.error === AUTH_ERROR), JSON.stringify(files.map((f) => f.error)));
  assert.match(files[0].errorDetails, /GrokError: xAI avviste API-nøkkelen/);
  assert.deepEqual([files[0].calls, files[0].attempts], [2, 1]);
  assert.ok(files[0].costUsd > 0, "den vellykkede batchen koster");
  const [first] = await dev.sql("SELECT progress_percent FROM files WHERE id = ?", files[0].id);
  assert.equal(first.progress_percent, null);
  assert.deepEqual((await dev.r2Keys(`work/${files[0].id}/`)).sort(), [`work/${files[0].id}/b-0.json`, `work/${files[0].id}/strings.json`], "den ferdige batchen er tatt vare på");

  const rows = await dev.sql("SELECT status, ok, error FROM grok_calls WHERE file_id = ? ORDER BY id", files[0].id);
  assert.deepEqual(rows.map((r) => [r.status, r.ok]), [[200, 1], [401, 0]]);
  const { translator } = (await admin.get("/api/admin/overview")).data;
  assert.equal(translator.lastError, "xAI avviste API-nøkkelen (401). Sjekk at nøkkelen er riktig.");
  assert.ok(translator.failedCalls24h >= 1 && translator.lastErrorAt);

  const failed = await dev.sql("SELECT file_id, level, message FROM events WHERE type = 'file.failed' AND sending_id = ? ORDER BY id", sending.id);
  assert.deepEqual(failed.map((e) => [e.file_id, e.level]), files.map((f) => [f.id, "error"]));
  const failures = (pushes) => pushes.filter((p) => p.payload.aps.alert.title.startsWith("Kunne ikke"));
  await dev.apns.waitFor((p) => failures(p).length >= 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(failures(dev.apns.pushes).map((p) => p.payload.aps.alert), [{ title: "Kunne ikke oversette a-lang.docx", body: AUTH_ERROR }],
    "én push, ikke én per fil");
  const [stats] = await dev.sql("SELECT data_json FROM events WHERE type = 'sending.done' AND sending_id = ?", sending.id);
  assert.deepEqual([JSON.parse(stats.data_json).done, JSON.parse(stats.data_json).failed], [0, 3]);
});

test("sett i kø igjen når nøkkelen virker: ferdige batcher gjenbrukes (ingen betales to ganger), og alt blir ferdig", async () => {
  dev.xai.setMode("upper");
  const sending = (await admin.get("/api/admin/sendings?limit=1")).data.sendings[0];
  const [word, ...texts] = sending.files;
  const before = dev.xai.state.requests.length;
  const res = await admin.post(`/api/admin/files/${word.id}/status`, { status: "sent" });
  assert.equal(res.status, 200);
  assert.equal(res.data.sending.status, "sent");
  const done = await eventually(async () => {
    const f = (await theirs(sending.id)).files[0];
    return f.status === "done" && f;
  }, { timeoutMs: 30000, what: "Word-filen blir ferdig" });
  assert.equal(requestsSince(before).length, 2, "bare batch 2 og 3; batch 1 lå i mellomlageret");
  assert.deepEqual([done.attempts, done.calls, done.error, done.errorDetails, done.outputSource], [2, 4, null, null, "cloud"]);
  assert.deepEqual(await dev.r2Keys(`work/${word.id}/`), [], "mellomlageret er ryddet");
  const doc = await downloadDocx(word.id, "a-lang (norsk).docx");
  assert.ok(doc.paragraphs.every((p) => !p.text || p.text.startsWith("NB:")), "hele dokumentet er oversatt");
  assert.deepEqual(doc.tables[0][0], ["NB:NAME", "NB:ÅSE ØVREBØ"]);

  for (const f of texts) assert.equal((await admin.post(`/api/admin/files/${f.id}/status`, { status: "sent" })).status, 200);
  const all = await finished(sending.id);
  assert.deepEqual(all.files.map((f) => f.status), ["done", "done", "done"]);
  const [row] = await dev.sql("SELECT workflow_id FROM sendings WHERE id = ?", sending.id);
  assert.equal(row.workflow_id, `${sending.id}-4`, "én ny instans per «sett i kø igjen»");
  const events = await dev.sql("SELECT COUNT(*) AS n FROM events WHERE type = 'sending.done' AND sending_id = ?", sending.id);
  assert.ok(events[0].n >= 2, "ferdig igjen");
});

test("cron: en fil som har stått fast i over 30 minutter uten levende instans, feiler; en som lever, får fortsette", async () => {
  dev.xai.setMode("upper");
  const stuck = await svetlana.send({ "fast.txt": "Hello" });
  await finished(stuck.id);
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  await dev.sql("UPDATE files SET status = 'working', workflow_id = 'finnesikke-1', progress_at = ? WHERE id = ?", hourAgo, stuck.files[0].id);
  await dev.sql("UPDATE sendings SET status = 'sent', finished_at = NULL WHERE id = ?", stuck.id);

  dev.xai.setMode("slow", 3000);
  const alive = await svetlana.send({ "lever.txt": "Hello" });
  const aliveId = alive.files[0].id;
  await eventually(async () => (await mine(alive.id)).files[0].status === "working", { what: "filen er under arbeid" });
  await dev.sql("UPDATE files SET progress_at = ?, started_at = ? WHERE id = ?", hourAgo, hourAgo, aliveId);

  await dev.cron();
  const [f] = (await theirs(stuck.id)).files;
  assert.deepEqual([f.status, f.error, f.statusText], ["failed", "Oversettelsen stoppet uventet.", "Kunne ikke oversettes. Jonas har fått beskjed."]);
  assert.match(f.errorDetails, /finnesikke-1.*unknown/);
  assert.equal((await mine(stuck.id)).status, "done");
  assert.equal((await mine(alive.id)).files[0].status, "working", "instansen lever");
  const [sweep] = await dev.sql("SELECT data_json FROM events WHERE type = 'retention.sweep' ORDER BY id DESC LIMIT 1");
  assert.equal(JSON.parse(sweep.data_json).stalled, 1);
  await finished(alive.id);
});

test("sletting midt i oversettelsen stopper Workflowen og rydder R2; cron tar resten av mellomlageret", async () => {
  dev.xai.setMode("slow", 1500);
  const docx = fs.readFileSync(makeDocx(path.join(tmp, "slett.docx")));
  const sending = await svetlana.send({ "først.txt": "Hello", "slett.docx": docx });
  const fileId = sending.files.find((f) => f.name === "slett.docx").id;
  await eventually(async () => (await dev.sql("SELECT COUNT(*) AS n FROM batches WHERE file_id = ?", fileId))[0].n >= 1,
    { timeoutMs: 15000, what: "første batch er ferdig" });
  assert.equal((await svetlana.del(`/api/sendings/${sending.id}`)).status, 204);
  const calls = dev.xai.state.calls;
  assert.deepEqual(await dev.r2Keys(`s/${sending.id}/`), []);
  assert.deepEqual(await dev.r2Keys(`work/${fileId}/`), []);

  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(dev.xai.state.calls <= calls + 1, "ingen nye kall etter at instansen er stoppet");
  const types = (await dev.sql("SELECT type FROM events WHERE sending_id = ? ORDER BY id", sending.id)).map((e) => e.type);
  assert.deepEqual(types.slice(types.indexOf("sending.deleted")), ["sending.deleted"], `ingenting skjer etter slettingen: ${types.join(", ")}`);
  assert.equal(types.filter((t) => t === "file.done").length, 1, "bare først.txt ble ferdig før slettingen");
  assert.deepEqual(await dev.r2Keys(`s/${sending.id}/`), [], "ingen resultat dukket opp etterpå");
  await dev.cron();
  assert.deepEqual(await dev.r2Keys("work/"), [], "cron rydder mellomlager for slettede og ferdige filer");
  dev.xai.setMode("upper");
});
