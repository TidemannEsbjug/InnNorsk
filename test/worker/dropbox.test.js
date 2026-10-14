// Fildropp mot ekte wrangler dev: Svetlana sender hvilke som helst filer rett til eieren (med melding og push), ser hva
// hun har sendt, og eieren lister, laster ned og sletter for godt. Andre brukere og ikke-admin slipper ikke til.
const test = require("node:test");
const assert = require("node:assert/strict");
const workerDev = require("../helpers/worker-dev");
const { eventually } = require("./client");

const PHONE = "f6".repeat(32);
let dev;
let svetlana;
let admin;
let ola;

test.before(async () => {
  dev = await workerDev.start({
    users: { ...workerDev.DEFAULT_USERS, ola: { username: "ola", displayName: "Ola", role: "user", password: "ola-testpassord-123" } },
  });
  [svetlana, admin, ola] = [await dev.login("svetlana"), await dev.login("eier"), await dev.login("ola")];
  assert.equal((await admin.post("/api/admin/devices", { token: PHONE, env: "sandbox", name: "Eierens iPhone" })).status, 200);
});

test.after(async () => {
  if (dev) await dev.stop();
});

const putFile = (dropId, path, content) => svetlana.put(`/api/dropbox/${dropId}/files?path=${encodeURIComponent(path)}`, content);

test("fildropp: send filer med melding, eieren får varsel, ser, laster ned og sletter", async () => {
  const created = await svetlana.post("/api/dropbox", {});
  assert.equal(created.status, 201);
  const dropId = created.data.drop.id;

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  assert.equal((await putFile(dropId, "skjermbilde.png", png)).status, 201);
  const doc = await putFile(dropId, "Mappe/søknad (norsk).docx", Buffer.from("ikke en ekte docx"));
  assert.equal(doc.status, 201, JSON.stringify(doc.data));
  assert.equal(doc.data.file.name, "søknad (norsk).docx");
  assert.equal((await putFile(dropId, "tom.txt", Buffer.alloc(0))).status, 400);

  // Eieren ser filene allerede før hun trykker Send (merket «ikke sendt»), men hun ser dem ikke i sin egen liste ennå.
  const early = (await admin.get("/api/admin/drops")).data.drops;
  assert.deepEqual(early.map((d) => [d.id, d.sentAt]), [[dropId, null]]);
  assert.deepEqual((await svetlana.get("/api/dropbox")).data.drops, []);

  dev.apns.reset();
  const sent = await svetlana.post(`/api/dropbox/${dropId}/send`, { note: "Tabellen forsvant" });
  assert.deepEqual(sent.data, { ok: true, files: 2 });
  assert.equal((await svetlana.post(`/api/dropbox/${dropId}/send`, {})).status, 409);
  assert.equal((await putFile(dropId, "sent.txt", Buffer.from("x"))).status, 409);

  const push = await eventually(() => dev.apns.pushes[0], { what: "push til eieren" });
  assert.equal(push.payload.aps.alert.title, "Fildropp fra Svetlana");
  assert.match(push.payload.aps.alert.body, /^2 filer: .+ og 1 til\n«Tabellen forsvant»$/);

  const mine = (await svetlana.get("/api/dropbox")).data;
  assert.equal(mine.drops.length, 1);
  assert.equal(mine.maxFileMb, 100);

  const [drop] = (await admin.get("/api/admin/drops")).data.drops;
  assert.equal(drop.note, "Tabellen forsvant");
  assert.ok(drop.sentAt);
  assert.deepEqual(drop.files.map((f) => [f.path, f.bytes]), [["Mappe/søknad (norsk).docx", 17], ["skjermbilde.png", 7]]);

  const pngFile = drop.files.find((f) => f.name === "skjermbilde.png");
  const dl = await admin.get(`/api/admin/drop-files/${pngFile.id}`);
  assert.equal(dl.status, 200);
  assert.deepEqual(dl.data, png);
  assert.match(dl.headers.get("content-disposition"), /^attachment;/);

  // Lagringen teller med i taket og i admin-oversikten.
  assert.equal((await admin.get("/api/admin/overview")).data.limits.storage.used, 24);

  // Bare admin.
  assert.equal((await svetlana.get("/api/admin/drops")).status, 403);
  assert.equal((await svetlana.get(`/api/admin/drop-files/${pngFile.id}`)).status, 403);

  assert.equal((await admin.del(`/api/admin/drops/${dropId}`)).status, 204);
  assert.deepEqual((await admin.get("/api/admin/drops")).data.drops, []);
  assert.equal((await admin.get(`/api/admin/drop-files/${pngFile.id}`)).status, 404);
  assert.equal((await admin.get("/api/admin/overview")).data.limits.storage.used, 0);
  const types = (await dev.sql("SELECT type FROM events WHERE type LIKE 'dropbox.%' OR type = 'download.drop' ORDER BY id")).map((e) => e.type);
  assert.deepEqual(types, ["dropbox.file", "dropbox.file", "dropbox.rejected", "dropbox.sent", "download.drop", "dropbox.deleted"]);
});

test("fildropp: en annen bruker ser ikke droppet, og send uten filer avvises", async () => {
  const { data } = await svetlana.post("/api/dropbox", {});
  assert.equal((await svetlana.post(`/api/dropbox/${data.drop.id}/send`, {})).status, 400);
  assert.equal((await ola.put(`/api/dropbox/${data.drop.id}/files?path=a.txt`, Buffer.from("a"))).status, 404);
  assert.equal((await ola.post(`/api/dropbox/${data.drop.id}/send`, {})).status, 404);
  assert.equal((await svetlana.put("/api/dropbox/finnesikke/files?path=a.txt", Buffer.from("a"))).status, 404);
  assert.equal((await svetlana.put(`/api/dropbox/${data.drop.id}/files`, Buffer.from("a"))).status, 400);
});
