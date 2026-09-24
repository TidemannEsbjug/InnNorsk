// Opplasting, analyse, hele oversettelsen via Workflow, nedlasting, dokumenter, avbrudd og feil — mot wrangler dev + falsk xAI.
const test = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const workerDev = require("../helpers/worker-dev");
const mockServer = require("../helpers/mock-xai-server");
const mockGrok = require("../helpers/mock-grok");
const { minimalDocx, minimalPdf } = require("../helpers/fixtures");
const core = require("../../src/core");
const { Client, loggedIn } = require("./client");

const { DEFAULT_VARS: V } = workerDev;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const AUTH_MESSAGE = "Oversettelsen stoppet på grunn av et problem hos oss – ikke noe du har gjort. Gi beskjed til den som ga deg tilgang, så ordner vi det.";

let dev;
let mock;
let svetlana;
let admin;
let userId;
let docx;
let pdf;

function textlessPdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const paragraphs = (n, prefix = "Sentence") =>
  Array.from({ length: n }, (_, i) => `${prefix} number ${i} is here, and it is long enough to matter.`).join("\n\n") + "\n";

// Samme oversettelse lokalt med mock-grok i prosessen: fasit for hva Workeren skal levere.
async function expectedOutput(buf, ext) {
  mockGrok.install({ mode: "upper" });
  try {
    return (await core.translateBuffer(buf, ext, { apiKey: "test", retryDelayMs: 1 })).buffer;
  } finally {
    mockGrok.uninstall();
  }
}

const documentXml = async (buf) => (await JSZip.loadAsync(buf)).file("word/document.xml").async("string");
const eventTypes = async (jobId) => (await dev.sql("SELECT type FROM events WHERE job_id = ? ORDER BY id", jobId)).map((e) => e.type);

test.before(async () => {
  mock = await mockServer.start({ mode: "upper" });
  dev = await workerDev.start({ mockUrl: mock.url, vars: { MAX_FILE_MB: "1", MAX_FILES_PER_JOB: "5", GROK_CONCURRENCY: "2" } });
  svetlana = await loggedIn(dev.url, "Svetlana", V.SEED_USER_PASSWORD);
  admin = await loggedIn(dev.url, "admin", V.ADMIN_PASSWORD);
  userId = (await svetlana.get("/api/auth/me")).data.user.id;
  docx = await minimalDocx(["Hello world", "Second paragraph æøå"]);
  pdf = minimalPdf();
});

test.after(async () => {
  if (dev) await dev.stop();
  if (mock) await mock.close();
});

test.beforeEach(() => {
  mock.setMode("upper");
  mock.reset();
});

test("opplasting renser stien og avviser farlige eller ugyldige navn", async () => {
  const job = await svetlana.newJob();
  const cases = [
    ["..\\..\\C:\\Users\\ola\\./Dokumenter/../rapport.txt", "Users/ola/Dokumenter/rapport.txt"],
    ["/mappe/\u0001skjult\u0007.txt", "mappe/skjult.txt"],
    ["D:rot.txt", "rot.txt"],
  ];
  for (const [raw, clean] of cases) {
    const res = await svetlana.upload(job.id, raw, "Hello\n");
    assert.equal(res.status, 201, raw);
    assert.equal(res.data.file.path, clean);
    assert.equal(res.data.file.name, clean.split("/").pop());
  }
  for (const raw of ["", "../..", "./"]) {
    const res = await svetlana.upload(job.id, raw, "Hello\n");
    assert.equal(res.status, 400, JSON.stringify(raw));
    assert.equal(res.data.error, "Filnavnet mangler eller er ugyldig.");
  }
  const long = `${"mappe/".repeat(60)}lang.txt`;
  const trimmed = await svetlana.upload(job.id, long, "Hello\n");
  assert.equal(trimmed.status, 201);
  assert.ok(trimmed.data.file.path.length <= 240 && trimmed.data.file.path.endsWith("mappe/lang.txt"));
});

test("opplasting: for stor, feil filtype, låsefil, systemfil og for mange filer", async () => {
  const job = await svetlana.newJob();
  const big = await svetlana.upload(job.id, "stor.txt", Buffer.alloc(1024 * 1024 + 10, 65));
  assert.equal(big.status, 413);
  assert.equal(big.data.error, "Filen er for stor (maks 1 MB).");
  const exe = await svetlana.upload(job.id, "program.EXE", "MZ");
  assert.equal(exe.status, 415);
  assert.equal(exe.data.error, "Filtypen .exe støttes ikke.");
  assert.equal((await svetlana.upload(job.id, "README", "hei")).status, 415);
  const lock = await svetlana.upload(job.id, "mappe/~$Rapport.docx", "x");
  assert.equal(lock.status, 400);
  assert.equal(lock.data.error, "Dette er en midlertidig låsefil fra Word, ikke et dokument.");
  const libre = await svetlana.upload(job.id, ".~lock.Rapport.docx#", "x");
  assert.deepEqual([libre.status, libre.data.error], [400, lock.data.error]);
  const ds = await svetlana.upload(job.id, "mappe/.DS_Store", "x");
  assert.equal(ds.status, 400);
  assert.equal(ds.data.error, "Dette er en systemfil, ikke et dokument.");
  for (let i = 0; i < 5; i++) assert.equal((await svetlana.upload(job.id, `f${i}.txt`, "Hello\n")).status, 201);
  const sixth = await svetlana.upload(job.id, "f5.txt", "Hello\n");
  assert.equal(sixth.status, 400);
  assert.equal(sixth.data.error, "Du kan legge til maks 5 dokumenter i én oversettelse.");
  assert.equal((await svetlana.upload(job.id, "F0.txt", "Hello again\n")).status, 201, "samme sti erstatter");
  const view = await svetlana.get(`/api/jobs/${job.id}`);
  assert.equal(view.data.files.length, 5);
  assert.equal(view.data.files.find((f) => f.path === "F0.txt").bytes, 12);
  const rejected = await dev.sql("SELECT COUNT(*) AS n FROM events WHERE type = 'file.rejected' AND job_id = ?", job.id);
  assert.ok(rejected[0].n >= 5);
});

test("tom fil og skannet PDF lagres som feilet med vennlig melding", async () => {
  const job = await svetlana.newJob();
  const empty = await svetlana.upload(job.id, "tom.txt", "");
  assert.equal(empty.status, 201);
  assert.equal(empty.data.file.status, "failed");
  assert.equal(empty.data.file.message, "Filen er tom.");
  const scanned = await svetlana.upload(job.id, "skannet.pdf", textlessPdf());
  assert.equal(scanned.data.file.status, "failed");
  assert.match(scanned.data.file.message, /skannet/);
  const broken = await svetlana.upload(job.id, "ødelagt.docx", "ikke en zip");
  assert.equal(broken.data.file.status, "failed");
  assert.match(broken.data.file.message, /kunne ikke leses/);
  const start = await svetlana.post(`/api/jobs/${job.id}/start`);
  assert.equal(start.status, 400);
  assert.equal(start.data.error, "Legg til minst ett dokument som kan oversettes.");
  assert.ok((await eventTypes(job.id)).includes("file.analysis_failed"));
});

test("analysen gir samme tall som kjernen, og jobben summerer estimatet", async () => {
  const job = await svetlana.newJob();
  const files = { "a.txt": Buffer.from(paragraphs(40)), "b.docx": docx, "c.pdf": pdf };
  let estimate = 0;
  for (const [path, buf] of Object.entries(files)) {
    const res = await svetlana.upload(job.id, path, buf);
    const expected = await core.analyzeBuffer(buf, core.extOf(path));
    const f = res.data.file;
    assert.equal(f.status, "ready", path);
    assert.equal(f.message, "Klar");
    assert.deepEqual([f.segments, f.chars, f.batches], [expected.segments, expected.chars, expected.batches], path);
    assert.ok(f.estimateSeconds > 3, path);
    estimate += f.estimateSeconds;
  }
  const { job: view } = (await svetlana.get(`/api/jobs/${job.id}`)).data;
  assert.equal(view.status, "draft");
  assert.equal(view.fileCount, 3);
  assert.equal(view.totals.batches, 4);
  assert.ok(Math.abs(view.estimateSeconds - estimate) <= 2);
  assert.equal(view.eta, null);
  const types = await eventTypes(job.id);
  assert.deepEqual(types.filter((t) => t === "file.analyzed").length, 3);
});

let doneJob;

test("hel oversettelse via Workflow: riktig innhold, format og navn", async () => {
  const txt = Buffer.from("Hello there\n\nSecond line\twith tab\n");
  const inputs = { "Rapport æøå 😀.docx": docx, "notater/møte.txt": txt, "vær.pdf": pdf };
  const result = await svetlana.translate(inputs, { targetLanguage: "nynorsk" });
  doneJob = result;
  const { job, files } = result;
  assert.equal(job.status, "done");
  assert.equal(job.progress.percent, 100);
  assert.equal(job.eta, null);
  assert.equal(job.error, null);
  assert.ok(job.startedAt && job.finishedAt);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.outputName]), [
    ["notater/møte.txt", "done", "notater/møte.txt"],
    ["Rapport æøå 😀.docx", "done", "Rapport æøå 😀.docx"],
    ["vær.pdf", "done", "vær.docx"],
  ]);
  assert.ok(files.every((f) => f.message === "Ferdig" && f.progress.percent === 100 && f.outputBytes > 0));

  // Aldri betalt to ganger: ett kall per batch, og alt er registrert.
  const batches = files.reduce((n, f) => n + f.batches, 0);
  assert.equal(mock.state.calls, batches);
  assert.equal(job.usage.calls, batches);
  assert.ok(job.usage.inputTokens > 0 && job.usage.outputTokens > 0);
  const calls = await dev.sql("SELECT COUNT(*) AS n, SUM(ok) AS ok FROM grok_calls WHERE job_id = ?", job.id);
  assert.deepEqual(calls[0], { n: batches, ok: batches });
  assert.ok(mock.state.requests.every((r) => r.input.includes("norsk nynorsk") && r.model === "grok-4.6"));

  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  const dl = (f) => svetlana.get(`/api/jobs/${job.id}/files/${f.id}/download`);

  const t = await dl(byPath["notater/møte.txt"]);
  assert.equal(t.status, 200);
  assert.equal(t.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.deepEqual(t.data, await expectedOutput(txt, ".txt"));

  const d = await dl(byPath["Rapport æøå 😀.docx"]);
  assert.equal(d.headers.get("content-type"), DOCX_MIME);
  assert.equal(d.headers.get("cache-control"), "private, no-store");
  assert.equal(
    d.headers.get("content-disposition"),
    "attachment; filename=\"Rapport aeoa _.docx\"; filename*=UTF-8''Rapport%20%C3%A6%C3%B8%C3%A5%20%F0%9F%98%80.docx"
  );
  assert.equal(await documentXml(d.data), await documentXml(await expectedOutput(docx, ".docx")));
  assert.match(await documentXml(d.data), /NB:SECOND PARAGRAPH ÆØÅ/);

  const p = await dl(byPath["vær.pdf"]);
  assert.equal(p.headers.get("content-type"), DOCX_MIME);
  assert.match(p.headers.get("content-disposition"), /filename\*=UTF-8''v%C3%A6r\.docx$/);
  assert.equal(await documentXml(p.data), await documentXml(await expectedOutput(pdf, ".pdf")));

  const original = await svetlana.get(`/api/jobs/${job.id}/files/${byPath["vær.pdf"].id}/original`);
  assert.deepEqual(original.data, pdf);
  assert.equal(original.headers.get("content-type"), "application/pdf");

  const types = await eventTypes(job.id);
  for (const type of ["job.created", "file.uploaded", "file.analyzed", "job.queued", "job.started", "file.started", "file.done", "job.finished", "download.file", "download.original"]) {
    assert.ok(types.includes(type), type);
  }
  const finished = await dev.sql("SELECT data_json FROM events WHERE job_id = ? AND type = 'job.finished'", job.id);
  const data = JSON.parse(finished[0].data_json);
  assert.deepEqual([data.status, data.files, data.done, data.failed, data.calls], ["done", 3, 3, 0, batches]);
  assert.ok(data.inputTokens > 0 && Number.isFinite(data.estimateSeconds) && Number.isFinite(data.actualSeconds));
  assert.deepEqual(await dev.r2Keys(`work/${job.id}/`), [], "arbeidsfilene er ryddet bort");
});

test("zip med alle ferdige dokumenter beholder mapper og norske tegn", async () => {
  const res = await svetlana.get(`/api/jobs/${doneJob.job.id}/download.zip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/zip");
  assert.match(res.headers.get("content-disposition"), /^attachment; filename="InnNorsk-\d{4}-\d{2}-\d{2}-\d{4}\.zip"/);
  const zip = await JSZip.loadAsync(res.data);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  assert.deepEqual(names, ["Rapport æøå 😀.docx", "notater/møte.txt", "vær.docx"]);
  const txt = await zip.file("notater/møte.txt").async("string");
  assert.match(txt, /^NB:HELLO THERE/);
  assert.ok((await eventTypes(doneJob.job.id)).includes("download.zip"));
});

test("fremdrift og ETA oppdateres mens jobben går", async () => {
  mock.setMode("slow", 300);
  const job = await svetlana.newJob();
  await svetlana.upload(job.id, "lang.txt", paragraphs(200));
  const started = await svetlana.post(`/api/jobs/${job.id}/start`);
  assert.equal(started.status, 200);
  assert.ok(["queued", "running"].includes(started.data.job.status));
  assert.ok(started.data.job.eta && started.data.job.eta.secondsRemaining > 0);
  const seen = [];
  const final = await svetlana.waitFor(job.id, {
    until: (j, data) => {
      seen.push({ percent: j.progress.percent, eta: j.eta, current: j.currentFile, serverTime: data.serverTime });
      return ["done", "failed", "partial", "cancelled"].includes(j.status);
    },
  });
  assert.equal(final.job.status, "done");
  const middle = seen.filter((s) => s.percent > 0 && s.percent < 100);
  assert.ok(middle.length >= 1, `så fremdrift underveis: ${JSON.stringify(seen.map((s) => s.percent))}`);
  for (const s of middle) {
    assert.ok(s.eta && Number.isFinite(s.eta.secondsRemaining) && s.eta.finishAt && ["lav", "middels", "høy"].includes(s.eta.confidence));
    assert.equal(s.current && s.current.name, "lang.txt");
    assert.ok(s.serverTime);
  }
  const percents = seen.map((s) => s.percent);
  assert.deepEqual(percents, [...percents].sort((a, b) => a - b), "fremdriften går aldri bakover");
  const batches = await dev.sql("SELECT COUNT(*) AS n FROM batches WHERE job_id = ?", job.id);
  assert.equal(batches[0].n, final.files[0].batches);
});

test("dokumentlisten viser ferdige dokumenter, og sletting fjerner filene i R2", async () => {
  const docs = (await svetlana.get("/api/documents")).data.documents;
  const mine = docs.filter((d) => d.jobId === doneJob.job.id);
  assert.equal(mine.length, 3);
  const vaer = mine.find((d) => d.originalName === "vær.pdf");
  assert.deepEqual(
    { name: vaer.name, path: vaer.path, targetLanguage: vaer.targetLanguage },
    { name: "vær.docx", path: "vær.docx", targetLanguage: "nynorsk" }
  );
  assert.ok(vaer.finishedAt && vaer.outputBytes > 0 && vaer.fileId);
  assert.equal(mine.find((d) => d.originalName === "møte.txt").name, "møte.txt");

  const prefix = `u/${userId}/j/${doneJob.job.id}/f/${vaer.fileId}/`;
  assert.deepEqual((await dev.r2Keys(prefix)).sort(), [`${prefix}original`, `${prefix}output`]);
  assert.equal((await svetlana.del(`/api/jobs/${doneJob.job.id}/files/${vaer.fileId}`)).status, 204);
  assert.deepEqual(await dev.r2Keys(prefix), []);
  const gone = await svetlana.get(`/api/jobs/${doneJob.job.id}/files/${vaer.fileId}/download`);
  assert.equal(gone.status, 410);
  assert.equal(gone.data.error, "Dokumentet er slettet.");
  const after = (await svetlana.get("/api/documents")).data.documents.filter((d) => d.jobId === doneJob.job.id);
  assert.equal(after.length, 2);
  assert.ok((await eventTypes(doneJob.job.id)).includes("file.deleted"));
});

test("andres jobber finnes ikke for deg, men admin ser dem", async () => {
  const created = await admin.post("/api/admin/users", { username: "Nabo", role: "user", password: "nabo-passord-1" });
  assert.equal(created.status, 201);
  const nabo = await loggedIn(dev.url, "Nabo", "nabo-passord-1");
  const id = doneJob.job.id;
  const fileId = doneJob.files[0].id;
  for (const res of [
    await nabo.get(`/api/jobs/${id}`),
    await nabo.get(`/api/jobs/${id}/files/${fileId}/download`),
    await nabo.get(`/api/jobs/${id}/files/${fileId}/original`),
    await nabo.get(`/api/jobs/${id}/download.zip`),
    await nabo.del(`/api/jobs/${id}/files/${fileId}`),
    await nabo.post(`/api/jobs/${id}/cancel`),
    await nabo.del(`/api/jobs/${id}`),
  ]) {
    assert.equal(res.status, 404);
    assert.equal(res.data.error, "Fant ikke jobben.");
  }
  assert.equal((await nabo.get("/api/documents")).data.documents.length, 0);
  assert.equal((await nabo.get("/api/jobs")).data.jobs.length, 0);
  assert.equal((await admin.get(`/api/jobs/${id}`)).status, 200);
  assert.equal((await svetlana.get(`/api/jobs/${id}`)).status, 200);
});

test("avbryt stopper jobben, og Workflowen overskriver ikke statusen etterpå", async () => {
  mock.setMode("slow", 1500);
  const job = await svetlana.newJob();
  await svetlana.upload(job.id, "a.txt", paragraphs(200));
  await svetlana.upload(job.id, "b.txt", paragraphs(10, "Other"));
  assert.equal((await svetlana.post(`/api/jobs/${job.id}/start`)).status, 200);
  await svetlana.waitFor(job.id, { until: (j) => j.currentFile !== null });
  const cancelled = await svetlana.post(`/api/jobs/${job.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.job.status, "cancelled");
  const callsAtCancel = mock.state.calls;
  await new Promise((r) => setTimeout(r, 3500));
  const view = (await svetlana.get(`/api/jobs/${job.id}`)).data;
  assert.equal(view.job.status, "cancelled");
  assert.ok(view.job.finishedAt);
  assert.deepEqual(view.files.map((f) => [f.status, f.message]), [["cancelled", "Avbrutt"], ["cancelled", "Avbrutt"]]);
  assert.ok(mock.state.calls <= callsAtCancel + 2, "ingen nye kall etter avbrudd");
  const status = await dev.sql("SELECT status, cancel_requested FROM jobs WHERE id = ?", job.id);
  assert.deepEqual(status[0], { status: "cancelled", cancel_requested: 1 });
  assert.ok((await eventTypes(job.id)).includes("job.cancelled"));
  assert.equal((await svetlana.post(`/api/jobs/${job.id}/cancel`)).data.job.status, "cancelled", "avbryt to ganger er trygt");
  const draft = await svetlana.newJob();
  assert.equal((await svetlana.post(`/api/jobs/${draft.id}/cancel`)).status, 409);
});

test("avvist nøkkel (401) stopper hele jobben med norsk melding etter ett kall", async () => {
  mock.setMode("fail401");
  const { job, files } = await svetlana.translate({ "a.txt": "Hello a\n", "b.txt": "Hello b\n", "c.docx": docx });
  assert.equal(job.status, "failed");
  assert.equal(job.error, AUTH_MESSAGE);
  assert.deepEqual(files.map((f) => [f.status, f.message]), Array(3).fill(["failed", AUTH_MESSAGE]));
  assert.match(files[0].error, /^\[auth\] xAI avviste API-nøkkelen \(401\)/);
  assert.equal(mock.state.calls, 1, "ingen nye forsøk og ingen flere filer");
  const types = await eventTypes(job.id);
  assert.equal(types.filter((t) => t === "grok.error").length, 1);
  assert.equal(types.filter((t) => t === "file.failed").length, 1);
  assert.ok(types.includes("job.finished"));

  mock.setMode("fail403");
  mock.reset();
  const forbidden = await svetlana.translate({ "d.txt": "Hello d\n" });
  assert.equal(forbidden.job.status, "failed");
  assert.equal(forbidden.files[0].message, AUTH_MESSAGE);
  assert.match(forbidden.files[0].error, /^\[forbidden\].*voice/);
});

test("én fil som feiler gir «partial», de andre blir ferdige", async () => {
  const { job, files } = await svetlana.translate({
    "god.txt": "Hello good\n",
    "ond.txt": `This one breaks ${mockServer.FAIL_MARKER}\n`,
  });
  assert.equal(job.status, "partial");
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(byPath["god.txt"].status, "done");
  assert.equal(byPath["ond.txt"].status, "failed");
  assert.equal(byPath["ond.txt"].message, "Kunne ikke oversettes denne gangen. Prøv gjerne igjen litt senere.");
  assert.match(byPath["ond.txt"].error, /^\[bad_response\]/);
  const zip = await JSZip.loadAsync((await svetlana.get(`/api/jobs/${job.id}/download.zip`)).data);
  assert.deepEqual(Object.keys(zip.files), ["god.txt"]);
  assert.equal((await svetlana.get(`/api/jobs/${job.id}/files/${byPath["ond.txt"].id}/download`)).status, 404);
});

test("sletting av hel jobb fjerner alt i R2 og skjuler jobben", async () => {
  const { job } = await svetlana.translate({ "slett.txt": "Hello delete\n" });
  assert.equal((await dev.r2Keys(`u/${userId}/j/${job.id}/`)).length, 2);
  assert.ok((await svetlana.get("/api/jobs")).data.jobs.some((j) => j.id === job.id));
  assert.equal((await svetlana.del(`/api/jobs/${job.id}`)).status, 204);
  assert.deepEqual(await dev.r2Keys(`u/${userId}/j/${job.id}/`), []);
  assert.equal((await svetlana.get(`/api/jobs/${job.id}`)).status, 404);
  assert.ok(!(await svetlana.get("/api/jobs")).data.jobs.some((j) => j.id === job.id));
  assert.ok(!(await svetlana.get("/api/documents")).data.documents.some((d) => d.jobId === job.id));
  assert.equal((await svetlana.get(`/api/jobs/${job.id}/files/x/download`)).status, 404);
  assert.ok((await eventTypes(job.id)).includes("job.deleted"));
  const admView = await admin.get(`/api/admin/jobs/${job.id}`);
  assert.equal(admView.data.job.deleted, true);
});

test("jobblisten er nyest først og skjuler slettede", async () => {
  const jobs = (await svetlana.get("/api/jobs?limit=50")).data.jobs;
  assert.ok(jobs.length >= 5);
  const created = jobs.map((j) => j.createdAt);
  assert.deepEqual(created, [...created].sort().reverse());
  assert.ok(jobs.every((j) => !j.deleted && j.userId === userId && !("username" in j)));
  assert.equal((await svetlana.get("/api/jobs?limit=2")).data.jobs.length, 2);
});

test("hemmeligheter havner aldri i hendelser eller konsollutskrift", async () => {
  const res = await svetlana.post("/api/client-log", {
    level: "error",
    message: "Feil i nettleseren med Bearer xai-abcdefghijklmnop1234",
    stack: "Error: x\n    at app.js:1:1",
    url: "https://innnorsk.example/",
    context: { password: "hemmelig-passord-9", apiKey: "xai-abcdefghijklmnop1234", nested: { cookie: "innnorsk_sid=abc" }, ok: 1 },
  });
  assert.equal(res.status, 204);
  const rows = await dev.sql("SELECT type, message, data_json FROM events");
  const dump = JSON.stringify(rows);
  const logs = dev.logs();
  for (const secret of [V.XAI_API_KEY, V.ADMIN_PASSWORD, V.SEED_USER_PASSWORD, "hemmelig-passord-9", "xai-abcdefghijklmnop1234", "innnorsk_sid=abc"]) {
    assert.ok(!dump.includes(secret), `hendelser inneholder ${secret}`);
    assert.ok(!logs.includes(secret), `konsollen inneholder ${secret}`);
  }
  const client = rows.find((r) => r.type === "client.error");
  const data = JSON.parse(client.data_json);
  assert.deepEqual(data.context, { password: "[skjult]", apiKey: "[skjult]", nested: { cookie: "[skjult]" }, ok: 1 });
  assert.match(client.message, /Bearer \[skjult\]/);
  assert.ok(logs.includes('"type":"job.finished"'), "hendelsene skrives også som JSON-linjer");
});
