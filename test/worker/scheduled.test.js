// Daglig opprydding (cron) via wrangler dev --test-scheduled: /__scheduled kjører scheduled().
const test = require("node:test");
const assert = require("node:assert/strict");
const workerDev = require("../helpers/worker-dev");
const mockServer = require("../helpers/mock-xai-server");
const { loggedIn } = require("./client");

const { DEFAULT_VARS: V } = workerDev;
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

let dev;
let mock;

test.before(async () => {
  mock = await mockServer.start({ mode: "upper" });
  dev = await workerDev.start({ mockUrl: mock.url, vars: { RETENTION_DAYS: "30", EVENT_RETENTION_DAYS: "180" } });
});

test.after(async () => {
  if (dev) await dev.stop();
  if (mock) await mock.close();
});

async function runSweep() {
  const res = await fetch(`${dev.url}/__scheduled?cron=${encodeURIComponent("17 3 * * *")}`);
  assert.equal(res.status, 200);
  const [row] = await dev.sql("SELECT data_json FROM events WHERE type = 'retention.sweep' ORDER BY id DESC LIMIT 1");
  return JSON.parse(row.data_json);
}

test("oppryddingen sletter gamle dokumenter, utkast, logger, økter og hengende jobber — og bare dem", async () => {
  const svetlana = await loggedIn(dev.url, "Svetlana", V.SEED_USER_PASSWORD);
  const uid = (await svetlana.get("/api/auth/me")).data.user.id;
  const old = await svetlana.translate({ "gammel.txt": "Hello old\n" });
  const fresh = await svetlana.translate({ "ny.txt": "Hello new\n" });
  const oldDraft = await svetlana.newJob();
  await svetlana.upload(oldDraft.id, "utkast.txt", "Hello draft\n");
  const newDraft = await svetlana.newJob();
  await svetlana.upload(newDraft.id, "utkast.txt", "Hello draft\n");

  // Flytt tiden bakover og legg inn rester som oppryddingen skal ta.
  await dev.sql("UPDATE jobs SET finished_at = ? WHERE id = ?", ago(40), old.job.id);
  await dev.sql("UPDATE jobs SET created_at = ? WHERE id = ?", ago(3), oldDraft.id);
  for (const [id, when] of [["hengerigjen00001", ago(1)], ["startetnettopp01", ago(0)]]) {
    await dev.sql(
      "INSERT INTO jobs (id, user_id, status, target_language, created_at, queued_at, started_at, workflow_id) VALUES (?, ?, 'running', 'bokmal', ?, ?, ?, ?)",
      id, uid, when, when, when, `mangler-${id}`
    );
    await dev.sql(
      "INSERT INTO files (id, job_id, rel_path, name, ext, status, plan_json, created_at) VALUES (?, ?, 'x.txt', 'x.txt', '.txt', 'working', '[[10]]', ?)",
      `f-${id}`, id, when
    );
  }
  await dev.sql("INSERT INTO events (ts, level, type, message) VALUES (?, 'info', 'test.gammel', 'gammel'), (?, 'info', 'test.nyere', 'nyere')", ago(200), ago(10));
  await dev.sql("INSERT INTO login_attempts (key, ts) VALUES ('ip:10.0.0.1', ?), ('ip:10.0.0.2', ?)", ago(2), ago(0));
  await dev.sql(
    "INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES ('utlopt-okt', ?, ?, ?, ?)",
    uid, ago(80), ago(70), ago(40)
  );
  await dev.r2Put(`work/${fresh.job.id}/x/b-0.json`, "[]");
  await dev.r2Put("work/startetnettopp01/x/b-0.json", "[]");

  const counts = await runSweep();
  assert.deepEqual(
    { stuckJobs: counts.stuckJobs, drafts: counts.drafts, documents: counts.documents, workObjects: counts.workObjects },
    { stuckJobs: 1, drafts: 1, documents: 1, workObjects: 1 }
  );
  assert.ok(counts.events >= 1 && counts.loginAttempts === 1 && counts.sessions === 1);

  // Dokumenter eldre enn RETENTION_DAYS er borte, også i R2; nyere ligger igjen.
  assert.deepEqual(await dev.r2Keys(`u/${uid}/j/${old.job.id}/`), []);
  const oldFile = old.files[0];
  assert.equal((await svetlana.get(`/api/jobs/${old.job.id}/files/${oldFile.id}/download`)).status, 410);
  const docs = (await svetlana.get("/api/documents")).data.documents.map((d) => d.name);
  assert.deepEqual(docs, ["ny.txt"]);
  assert.equal((await svetlana.get(`/api/jobs/${fresh.job.id}/files/${fresh.files[0].id}/download`)).status, 200);

  // Gamle utkast slettes helt; nye blir.
  assert.equal((await dev.sql("SELECT COUNT(*) AS n FROM jobs WHERE id = ?", oldDraft.id))[0].n, 0);
  assert.equal((await dev.sql("SELECT COUNT(*) AS n FROM files WHERE job_id = ?", oldDraft.id))[0].n, 0);
  assert.deepEqual(await dev.r2Keys(`u/${uid}/j/${oldDraft.id}/`), []);
  assert.equal((await svetlana.get(`/api/jobs/${newDraft.id}`)).status, 200);

  // Hengende jobb (> 30 min, Workflow finnes ikke) feiler med norsk melding; en helt ny får være.
  const stuck = (await svetlana.get("/api/jobs/hengerigjen00001")).data;
  assert.equal(stuck.job.status, "failed");
  assert.equal(stuck.job.error, "Jobben stoppet uventet. Prøv igjen.");
  assert.equal(stuck.files[0].status, "failed");
  assert.equal((await svetlana.get("/api/jobs/startetnettopp01")).data.job.status, "running");
  const failedEvents = await dev.sql("SELECT data_json FROM events WHERE type = 'job.failed' AND job_id = 'hengerigjen00001'");
  assert.equal(JSON.parse(failedEvents[0].data_json).workflowStatus, "unknown");

  // Logger, forsøk og økter.
  const types = (await dev.sql("SELECT type FROM events WHERE type LIKE 'test.%'")).map((e) => e.type);
  assert.deepEqual(types, ["test.nyere"]);
  assert.equal((await dev.sql("SELECT COUNT(*) AS n FROM login_attempts"))[0].n, 1);
  assert.equal((await dev.sql("SELECT COUNT(*) AS n FROM sessions WHERE id = 'utlopt-okt'"))[0].n, 0);
  assert.equal((await svetlana.get("/api/auth/me")).status, 200, "aktive økter berøres ikke");

  // Arbeidsfiler for ferdige jobber ryddes, aktive jobber beholder sine.
  assert.deepEqual(await dev.r2Keys("work/"), ["work/startetnettopp01/x/b-0.json"]);

  // Andre kjøring finner ingenting nytt å gjøre.
  const again = await runSweep();
  assert.deepEqual([again.stuckJobs, again.drafts, again.documents, again.workObjects], [0, 0, 0, 0]);
});
