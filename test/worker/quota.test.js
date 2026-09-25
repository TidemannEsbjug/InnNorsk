// Tak mot uventet forbruk, mot ekte wrangler dev med en falsk xAI: tekst til oversettelse per døgn og per 30 dager
// (også «Sett i kø igjen»), at sletting ikke frigjør kvote, lagringstaket ved opplasting, admin-oversikten og cron.
const test = require("node:test");
const assert = require("node:assert/strict");
const workerDev = require("../helpers/worker-dev");
const { minimalDocx } = require("../helpers/fixtures");
const { eventually } = require("./client");

const DAY = 100;
const MONTH = 150;
const STORAGE_GB = 0.0001; // 107 374 byte
let dev;
let svetlana;
let admin;

test.before(async () => {
  dev = await workerDev.start({
    vars: { MAX_CHARS_PER_DAY: String(DAY), MAX_CHARS_PER_MONTH: String(MONTH), MAX_STORAGE_GB: String(STORAGE_GB) },
  });
  [svetlana, admin] = [await dev.login("svetlana"), await dev.login("eier")];
});

test.after(async () => {
  if (dev) await dev.stop();
});

const text = (n) => "a".repeat(n);

// Ny sending med én .docx med n tegn tekst. Returnerer { sending, fileId } uten å sende.
async function draftWith(n) {
  const sending = await svetlana.newSending();
  const res = await svetlana.upload(sending.id, `tekst-${n}.docx`, await minimalDocx([text(n)]));
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const [row] = await dev.sql("SELECT chars FROM files WHERE id = ?", res.data.file.id);
  assert.equal(row.chars, n);
  return { sending, fileId: res.data.file.id };
}

const send = (id) => svetlana.post(`/api/sendings/${id}/send`);
const used = async () => (await dev.sql("SELECT COALESCE(SUM(chars), 0) AS n FROM quota_usage"))[0].n;
const ageAll = (days) => dev.sql(`UPDATE quota_usage SET ts = strftime('%Y-%m-%dT%H:%M:%fZ', ts, '-${days} days')`);
const lastEvent = async (type) => (await dev.sql("SELECT message, data_json FROM events WHERE type = ? ORDER BY id DESC LIMIT 1", type))[0];
const done = (id) => eventually(async () => (await svetlana.get(`/api/sendings/${id}`)).data.sending.status === "done",
  { timeoutMs: 30000, what: "sendingen blir ferdig" });

test("døgntaket: sendingen som går over, avvises med en vennlig melding og blir liggende som utkast", async () => {
  const first = await draftWith(40);
  assert.equal((await send(first.sending.id)).status, 200);
  assert.equal(await used(), 40);

  const second = await draftWith(70);
  const res = await send(second.sending.id);
  assert.equal(res.status, 429);
  assert.equal(res.data.error, "Grensen for hvor mye som kan oversettes (ca. 1 side per døgn) er nådd. Prøv igjen i morgen, eller si fra til Jonas.");
  const after = (await svetlana.get(`/api/sendings/${second.sending.id}`)).data.sending;
  assert.deepEqual([after.status, after.files[0].status], ["draft", "draft"], "ingenting er startet");
  assert.equal(await used(), 40, "avvist sending reserverer ingenting");
  const event = await lastEvent("quota.translation");
  assert.equal(event.message, "Taket for oversettelse per døgn er nådd");
  assert.deepEqual(JSON.parse(event.data_json), { requestedChars: 70, usedChars: 40, capChars: DAY, setting: "MAX_CHARS_PER_DAY" });

  const tooBig = await draftWith(120);
  const big = await send(tooBig.sending.id);
  assert.equal(big.status, 429);
  assert.match(big.data.error, /^Disse filene har for mye tekst til å sendes på én gang \(grensen er ca\. 1 side per døgn\)/);
  await done(first.sending.id);
});

test("sletting frigjør ikke kvote, og månedstaket gjelder når døgnet er over", async () => {
  const [row] = await dev.sql("SELECT sending_id FROM quota_usage");
  assert.equal((await svetlana.del(`/api/sendings/${row.sending_id}`)).status, 204);
  assert.equal(await used(), 40, "det som er sendt, er betalt");

  await ageAll(2); // døgnet er over, men de 40 tegnene teller fortsatt i 30 dager
  const ok = await draftWith(90);
  assert.equal((await send(ok.sending.id)).status, 200);
  await done(ok.sending.id);

  await ageAll(2);
  const over = await draftWith(30);
  const res = await send(over.sending.id);
  assert.equal(res.status, 429);
  assert.equal(res.data.error,
    "Grensen for hvor mye som kan oversettes (ca. 1 side per 30 dager) er nådd. Prøv igjen senere, eller si fra til Jonas.");
  assert.equal(JSON.parse((await lastEvent("quota.translation")).data_json).setting, "MAX_CHARS_PER_MONTH");
});

test("«Sett i kø igjen» i admin teller også, og eieren får en teknisk forklaring", async () => {
  const [{ file_id: fileId }] = await dev.sql(
    "SELECT f.id AS file_id FROM files f WHERE f.status = 'done' AND f.deleted_at IS NULL AND f.chars = 90"
  );
  const res = await admin.post(`/api/admin/files/${fileId}/status`, { status: "sent" });
  assert.equal(res.status, 429);
  assert.equal(res.data.error, "Taket for oversettelse er nådd (130 + 90 tegn > MAX_CHARS_PER_MONTH = 150). Hev MAX_CHARS_PER_MONTH i wrangler.jsonc om nødvendig.");
  const [file] = await dev.sql("SELECT status FROM files WHERE id = ?", fileId);
  assert.equal(file.status, "done", "filen er urørt");

  await dev.sql("DELETE FROM quota_usage");
  assert.equal((await admin.post(`/api/admin/files/${fileId}/status`, { status: "sent" })).status, 200);
  assert.equal(await used(), 90);
  await eventually(async () => (await dev.sql("SELECT status FROM files WHERE id = ?", fileId))[0].status === "done",
    { timeoutMs: 30000, what: "filen blir ferdig igjen" });
});

test("admin-oversikten viser forbruk mot takene", async () => {
  const { data } = await admin.get("/api/admin/overview");
  assert.deepEqual(data.limits.day, { used: 90, cap: DAY });
  assert.deepEqual(data.limits.month, { used: 90, cap: MONTH });
  assert.equal(data.limits.storage.cap, Math.round(STORAGE_GB * 1024 ** 3));
  assert.ok(data.limits.storage.used > 0);
});

test("cron fjerner forbruk eldre enn 31 dager", async () => {
  await ageAll(32);
  await dev.cron();
  assert.equal(await used(), 0);
});

test("lagringstaket: opplasting som ville gå over, avvises; sletting gir plassen tilbake", async () => {
  const sending = await svetlana.newSending();
  const [{ n: before }] = await dev.sql("SELECT COALESCE(SUM(bytes), 0) + COALESCE(SUM(output_bytes), 0) AS n FROM files WHERE deleted_at IS NULL");
  const room = Math.round(STORAGE_GB * 1024 ** 3) - before;
  const half = Buffer.alloc(Math.ceil(room / 2) + 10, "a");
  assert.equal((await svetlana.upload(sending.id, "første.txt", half)).status, 201);
  const res = await svetlana.upload(sending.id, "andre.txt", half);
  assert.equal(res.status, 507);
  assert.equal(res.data.error, "Lagringsplassen er full. Slett gamle sendinger under «Mine filer», eller si fra til Jonas.");
  assert.equal(JSON.parse((await lastEvent("quota.storage")).data_json).requestedBytes, half.length);

  assert.equal((await svetlana.del(`/api/sendings/${sending.id}`)).status, 204);
  const again = await svetlana.newSending();
  assert.equal((await svetlana.upload(again.id, "andre.txt", half)).status, 201);
});
