// Svetlanas side: lag en sending, legg til filer (strømmes rett til R2), send, følg med og last ned.
import { Hono } from "hono";
import { config } from "../config.js";
import { one, all, run, batch, nowIso, newId } from "../db.js";
import { logEvent } from "../log.js";
import { fail, readJson, reqCtx, str } from "../http.js";
import { requireUser } from "../auth.js";
import { pushToAdmins } from "../apns.js";
import {
  SUPPORTED, baseName, extOf, isIgnoredName, sanitizePath, r2Key, deleteObjects, contentLength, sizeProblem, putBody, download,
} from "../files.js";
import { listSendings, sendingView, loadSending, loadFile, serializeFile, filesText } from "../sendings.js";

const LANGUAGES = ["bokmal", "nynorsk"];
const MAX_NOTE = 2000;
const ALREADY_SENT = "Denne sendingen er allerede sendt. Start en ny for å sende flere filer.";

// Push-teksten når Svetlana sender: «Nye filer fra Svetlana» / «3 filer: søknad.docx og 2 til».
function sentMessage(displayName, names, note) {
  const [first] = names;
  const files = `${filesText(names.length)}: ${first}${names.length > 1 ? ` og ${names.length - 1} til` : ""}`;
  return { title: `Nye filer fra ${displayName}`, body: note ? `${files}\n«${note.slice(0, 120)}»` : files };
}

// Hver rute har requireUser selv: appen monteres på /api, og ukjente API-stier skal gi 404, ikke 401.
const api = new Hono();

api.post("/sendings", requireUser, async (c) => {
  const body = await readJson(c);
  if (!LANGUAGES.includes(body.targetLanguage)) fail(400, "Velg bokmål eller nynorsk.");
  const id = newId();
  await run(
    c.env,
    "INSERT INTO sendings (id, user_id, status, target_language, note, created_at) VALUES (?, ?, 'draft', ?, ?, ?)",
    id, c.get("user").id, body.targetLanguage, str(body.note, MAX_NOTE).trim() || null, nowIso()
  );
  await logEvent(c.env, "info", "sending.created", "Ny sending påbegynt", { targetLanguage: body.targetLanguage }, reqCtx(c, { sendingId: id }));
  return c.json({ sending: await sendingView(c.env, id) }, 201);
});

api.get("/sendings", requireUser, async (c) => c.json(await listSendings(c.env, { userId: c.get("user").id })));

api.get("/sendings/:id", requireUser, async (c) => {
  const s = await loadSending(c, c.req.param("id"));
  return c.json({ sending: await sendingView(c.env, s.id, c.get("user").role === "admin") });
});

api.put("/sendings/:id/files", requireUser, async (c) => {
  const env = c.env;
  const cfg = config(env);
  const s = await loadSending(c, c.req.param("id"), { write: true });
  const rawPath = c.req.query("path");
  const ctx = reqCtx(c, { sendingId: s.id });
  const reject = async (status, message) => {
    await logEvent(env, "warn", "file.rejected", message, { path: String(rawPath || "").slice(0, 300) }, ctx);
    fail(status, message);
  };
  if (s.status !== "draft") fail(409, ALREADY_SENT);
  const tooBig = `Filen er for stor (maks ${cfg.maxFileMb} MB).`;
  const sizeIssue = sizeProblem(contentLength(c), cfg.maxFileMb * 1024 * 1024, tooBig);
  if (sizeIssue) await reject(...sizeIssue);
  const relPath = sanitizePath(rawPath);
  if (!relPath) await reject(400, "Filnavnet mangler eller er ugyldig.");
  const name = baseName(relPath);
  if (isIgnoredName(name)) await reject(400, "Dette er en midlertidig låsefil, ikke et dokument.");
  const ext = extOf(name);
  if (!SUPPORTED.includes(ext)) await reject(415, ext ? `Filtypen ${ext} støttes ikke.` : "Filer uten filendelse støttes ikke.");

  // Samme sti lastet opp på nytt erstatter den forrige.
  const existing = await all(env, "SELECT id, sending_id, rel_path FROM files WHERE sending_id = ?", s.id);
  const replaced = existing.filter((f) => f.rel_path.toLowerCase() === relPath.toLowerCase());
  if (existing.length - replaced.length >= cfg.maxFilesPerSending) {
    await reject(400, `Du kan sende maks ${cfg.maxFilesPerSending} filer om gangen.`);
  }
  const id = newId();
  const bytes = await putBody(c, r2Key(s.id, id, "original"), name, { ...ctx, fileId: id });
  // Bare hvis sendingen fortsatt er et utkast (den kan ha blitt sendt mens filen ble lastet opp).
  const inserted = await run(
    env,
    `INSERT INTO files (id, sending_id, rel_path, name, ext, bytes, status, created_at)
     SELECT ?, ?, ?, ?, ?, ?, 'draft', ? WHERE EXISTS (SELECT 1 FROM sendings WHERE id = ? AND status = 'draft')`,
    id, s.id, relPath, name, ext, bytes, nowIso(), s.id
  );
  if (!inserted.meta.changes) {
    await deleteObjects(env, [{ id, sending_id: s.id }]);
    fail(409, ALREADY_SENT);
  }
  if (replaced.length) {
    await deleteObjects(env, replaced);
    await batch(env, replaced.map((f) => ["DELETE FROM files WHERE id = ?", f.id]));
  }
  await logEvent(env, "info", "file.uploaded", `${name} lastet opp`, { path: relPath, bytes, ext }, { ...ctx, fileId: id });
  return c.json({ file: serializeFile(await one(env, "SELECT * FROM files WHERE id = ?", id), false) }, 201);
});

api.delete("/sendings/:id/files/:fileId", requireUser, async (c) => {
  const s = await loadSending(c, c.req.param("id"), { write: true });
  if (s.status !== "draft") fail(409, "Filen er allerede sendt og kan ikke fjernes.");
  const f = await one(c.env, "SELECT * FROM files WHERE id = ? AND sending_id = ?", c.req.param("fileId"), s.id);
  if (!f) fail(404, "Fant ikke filen.");
  await deleteObjects(c.env, [f]);
  await run(c.env, "DELETE FROM files WHERE id = ?", f.id);
  await logEvent(c.env, "info", "file.removed", `${f.name} fjernet før sending`, { path: f.rel_path }, reqCtx(c, { sendingId: s.id, fileId: f.id }));
  return c.body(null, 204);
});

api.post("/sendings/:id/note", requireUser, async (c) => {
  const s = await loadSending(c, c.req.param("id"), { write: true });
  if (s.status !== "draft") fail(409, "Denne sendingen er allerede sendt.");
  const note = str((await readJson(c)).note, MAX_NOTE).trim() || null;
  await run(c.env, "UPDATE sendings SET note = ? WHERE id = ?", note, s.id);
  return c.json({ sending: await sendingView(c.env, s.id) });
});

api.post("/sendings/:id/send", requireUser, async (c) => {
  const env = c.env;
  const s = await loadSending(c, c.req.param("id"), { write: true });
  if (s.status !== "draft") fail(409, "Denne sendingen er allerede sendt.");
  const files = await all(env, "SELECT name, bytes FROM files WHERE sending_id = ? ORDER BY rel_path", s.id);
  if (!files.length) fail(400, "Legg til minst én fil før du sender.");
  const now = nowIso();
  const [res] = await batch(env, [
    ["UPDATE sendings SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'draft'", now, s.id],
    ["UPDATE files SET status = 'sent' WHERE sending_id = ? AND status = 'draft'", s.id],
  ]);
  if (!res.meta.changes) fail(409, "Denne sendingen er allerede sendt.");
  const user = c.get("user");
  const ctx = reqCtx(c, { sendingId: s.id });
  await logEvent(env, "info", "sending.sent", `${user.displayName} sendte ${filesText(files.length)}`, {
    files: files.length, bytes: files.reduce((n, f) => n + (f.bytes || 0), 0), targetLanguage: s.target_language, note: Boolean(s.note),
  }, ctx);
  const message = { ...sentMessage(user.displayName, files.map((f) => f.name), s.note), sendingId: s.id };
  c.executionCtx.waitUntil(pushToAdmins(env, message, ctx));
  return c.json({ sending: await sendingView(env, s.id) });
});

api.delete("/sendings/:id", requireUser, async (c) => {
  const env = c.env;
  const s = await loadSending(c, c.req.param("id"), { write: true });
  const files = await all(env, "SELECT id, sending_id FROM files WHERE sending_id = ?", s.id);
  await deleteObjects(env, files);
  const now = nowIso();
  await batch(env, [
    ["UPDATE sendings SET status = 'deleted', deleted_at = ? WHERE id = ?", now, s.id],
    ["UPDATE files SET deleted_at = ?, lease_until = NULL WHERE sending_id = ?", now, s.id],
  ]);
  await logEvent(env, "info", "sending.deleted", "Sendingen ble slettet", { status: s.status, files: files.length }, reqCtx(c, { sendingId: s.id }));
  return c.body(null, 204);
});

async function sendFile(c, kind) {
  const f = await loadFile(c, c.req.param("fileId"));
  if (kind === "result" && f.status !== "done") fail(404, "Oversettelsen er ikke ferdig ennå.");
  const name = kind === "result" ? f.output_name : f.name;
  const res = await download(c.env, r2Key(f.sending_id, f.id, kind), name);
  await logEvent(c.env, "info", `download.${kind}`, `${name} lastet ned`, { name, bytes: Number(res.headers.get("Content-Length")) },
    reqCtx(c, { sendingId: f.sending_id, fileId: f.id }));
  return res;
}

api.get("/files/:fileId/result", requireUser, (c) => sendFile(c, "result"));
api.get("/files/:fileId/original", requireUser, (c) => sendFile(c, "original"));

export default api;
