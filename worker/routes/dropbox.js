// Fildropp for Svetlana: lag et dropp, last opp filene (alle filtyper, strømmes rett til R2) og send. Eieren får et
// varsel og ser filene under Admin → Fildropp.
import { Hono } from "hono";
import { one, all, run, nowIso, newId } from "../db.js";
import { logEvent } from "../log.js";
import { fail, readJson, reqCtx, str } from "../http.js";
import { requireUser } from "../auth.js";
import { pushToAdmins } from "../apns.js";
import { checkStorage } from "../quota.js";
import { baseName, sanitizePath, contentLength, sizeProblem, putBody } from "../files.js";
import { filesText, translatorName } from "../sendings.js";
import { DROP_MAX_MB, MAX_DROP_FILES, MAX_DROP_NOTE, dropKey, listDrops, serializeDropFile } from "../dropbox.js";

const ALREADY_SENT = "Disse filene er allerede sendt. Start på nytt for å sende flere.";

// Bare hennes egne dropp (admin: alle).
async function loadDrop(c, id) {
  const user = c.get("user");
  const d = await one(c.env, "SELECT * FROM drops WHERE id = ? AND deleted_at IS NULL", String(id || ""));
  if (!d || (d.user_id !== user.id && user.role !== "admin")) fail(404, "Fant ikke fildroppet.");
  return d;
}

const dropbox = new Hono();

dropbox.get("/", requireUser, async (c) => c.json({
  drops: await listDrops(c.env, { userId: c.get("user").id, sentOnly: true, limit: 10 }),
  maxFileMb: DROP_MAX_MB,
  maxFiles: MAX_DROP_FILES,
  to: await translatorName(c.env),
}));

dropbox.post("/", requireUser, async (c) => {
  const id = newId();
  await run(c.env, "INSERT INTO drops (id, user_id, created_at) VALUES (?, ?, ?)", id, c.get("user").id, nowIso());
  return c.json({ drop: { id } }, 201);
});

dropbox.put("/:id/files", requireUser, async (c) => {
  const env = c.env;
  const d = await loadDrop(c, c.req.param("id"));
  const rawPath = c.req.query("path");
  const ctx = reqCtx(c);
  const reject = async (status, message) => {
    await logEvent(env, "warn", "dropbox.rejected", message, { dropId: d.id, path: String(rawPath || "").slice(0, 300) }, ctx);
    fail(status, message);
  };
  if (d.sent_at) fail(409, ALREADY_SENT);
  const length = contentLength(c);
  const sizeIssue = sizeProblem(length, DROP_MAX_MB * 1024 * 1024, `Filen er for stor (maks ${DROP_MAX_MB} MB).`);
  if (sizeIssue) await reject(...sizeIssue);
  await checkStorage(env, length, ctx);
  const relPath = sanitizePath(rawPath);
  if (!relPath) await reject(400, "Filnavnet mangler eller er ugyldig.");
  const { n } = await one(env, "SELECT COUNT(*) AS n FROM drop_files WHERE drop_id = ? AND deleted_at IS NULL", d.id);
  if (n >= MAX_DROP_FILES) await reject(400, `Du kan sende maks ${MAX_DROP_FILES} filer om gangen.`);

  const id = newId();
  const name = baseName(relPath);
  const bytes = await putBody(c, dropKey(d.id, id), name, ctx);
  const inserted = await run(
    env,
    `INSERT INTO drop_files (id, drop_id, name, rel_path, bytes, created_at)
     SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM drops WHERE id = ? AND sent_at IS NULL AND deleted_at IS NULL)`,
    id, d.id, name, relPath, bytes, nowIso(), d.id
  );
  if (!inserted.meta.changes) {
    await env.FILES.delete(dropKey(d.id, id));
    fail(409, ALREADY_SENT);
  }
  await logEvent(env, "info", "dropbox.file", `${name} lagt i fildroppet`, { dropId: d.id, dropFileId: id, path: relPath, bytes }, ctx);
  return c.json({ file: serializeDropFile(await one(env, "SELECT * FROM drop_files WHERE id = ?", id)) }, 201);
});

// Ferdig: meldingen lagres, og eieren får varsel.
dropbox.post("/:id/send", requireUser, async (c) => {
  const env = c.env;
  const d = await loadDrop(c, c.req.param("id"));
  const body = await readJson(c);
  if (d.sent_at) fail(409, ALREADY_SENT);
  const files = await all(env, "SELECT name, bytes FROM drop_files WHERE drop_id = ? AND deleted_at IS NULL ORDER BY rel_path", d.id);
  if (!files.length) fail(400, "Legg til minst én fil før du sender.");
  const note = str(body.note, MAX_DROP_NOTE).trim() || null;
  const res = await run(env, "UPDATE drops SET note = ?, sent_at = ? WHERE id = ? AND sent_at IS NULL", note, nowIso(), d.id);
  if (!res.meta.changes) fail(409, ALREADY_SENT);
  const user = c.get("user");
  const ctx = reqCtx(c);
  const names = files.map((f) => f.name);
  await logEvent(env, "info", "dropbox.sent", `${user.displayName} sendte ${filesText(files.length)} i fildroppet`, {
    dropId: d.id, files: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0), names: names.slice(0, 50),
    note: note && note.slice(0, 500),
  }, ctx);
  const list = `${filesText(names.length)}: ${names[0]}${names.length > 1 ? ` og ${names.length - 1} til` : ""}`;
  c.executionCtx.waitUntil(pushToAdmins(env, {
    title: `Fildropp fra ${user.displayName}`,
    body: note ? `${list}\n«${note.slice(0, 120)}»` : list,
  }, ctx));
  return c.json({ ok: true, files: files.length });
});

export default dropbox;
