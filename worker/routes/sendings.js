// Svetlanas side: lag en sending, legg til filer (analyseres og får et estimat), send til oversettelse, følg med og last ned.
import { Hono } from "hono";
import core from "../../src/core.js";
import { config } from "../config.js";
import { one, all, run, batch, nowIso, newId, parseJson } from "../db.js";
import { logEvent } from "../log.js";
import { fail, readJson, reqCtx, str } from "../http.js";
import { requireUser } from "../auth.js";
import { pushToAdmins } from "../apns.js";
import { predictFile, predictSending } from "../estimate.js";
import { estimatorParams } from "../xai.js";
import {
  SUPPORTED, baseName, extOf, isIgnoredName, sanitizePath, r2Key, deleteObjects, deleteWork, contentLength, sizeProblem, putObject,
  readBody, download,
} from "../files.js";
import {
  listSendings, sendingView, loadSending, loadFile, serializeFile, filesText, translatorName, startWorkflow, stopWorkflows,
} from "../sendings.js";

const LANGUAGES = ["bokmal", "nynorsk"];
const MAX_NOTE = 2000;
const ALREADY_SENT = "Denne sendingen er allerede sendt. Start en ny for å sende flere filer.";
const UNREADABLE = {
  ".docx": "Filen ser ut til å være skadet eller er ikke et gyldig Word-dokument.",
  ".pptx": "Filen ser ut til å være skadet eller er ikke en gyldig PowerPoint-fil.",
  ".xlsx": "Filen ser ut til å være skadet eller er ikke et gyldig Excel-ark.",
  ".pdf": "PDF-en ser ut til å være skadet og kan ikke leses.",
};

// Analysen ved opplasting (ingen nettverk): tekstbiter, tegn og batcher, eller en vennlig forklaring (reason) for
// henne og den tekniske feilen (error, details) for eieren.
async function analyze(bytes, ext) {
  try {
    const analysis = await core.analyzeBuffer(bytes, ext);
    return analysis.segments ? { analysis } : { reason: "Fant ingen tekst å oversette i denne filen.", error: "Ingen tekstbiter å oversette." };
  } catch (err) {
    const scanned = ext === ".pdf" && /ingen tekst/i.test(err.message);
    const reason = scanned ? "Denne PDF-en er et bilde uten tekst og kan ikke oversettes." : UNREADABLE[ext] || "Filen kunne ikke leses. Den kan være skadet.";
    return { reason, error: err.message, details: String(err.stack).slice(0, 4000) };
  }
}

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
  const bytes = await readBody(c, name, { ...ctx, fileId: id });
  const { analysis, reason, error, details } = await analyze(bytes, ext);
  const estimate = analysis ? predictFile(analysis.calls, await estimatorParams(env), cfg.concurrency) : null;
  await putObject(env, r2Key(s.id, id, "original"), name, bytes);
  // Bare hvis sendingen fortsatt er et utkast (den kan ha blitt sendt mens filen ble lastet opp).
  // En fil som ikke kan leses, beholdes som «failed» med forklaringen; hun kan fjerne den, og den hoppes over ved sending.
  const inserted = await run(
    env,
    `INSERT INTO files (id, sending_id, rel_path, name, ext, bytes, status, message, error, error_details, segments, chars, batches,
       plan_json, estimate_seconds, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sendings WHERE id = ? AND status = 'draft')`,
    id, s.id, relPath, name, ext, bytes.length, analysis ? "draft" : "failed", analysis ? "Klar" : reason, error, details,
    analysis && analysis.segments, analysis && analysis.chars, analysis && analysis.batches,
    analysis ? JSON.stringify(analysis.calls) : null, estimate, nowIso(), s.id
  );
  if (!inserted.meta.changes) {
    await deleteObjects(env, [{ id, sending_id: s.id }]);
    fail(409, ALREADY_SENT);
  }
  if (replaced.length) {
    await deleteObjects(env, replaced);
    await batch(env, replaced.map((f) => ["DELETE FROM files WHERE id = ?", f.id]));
  }
  const info = { path: relPath, bytes: bytes.length, ext };
  if (analysis) {
    const { segments, chars, batches } = analysis;
    await logEvent(env, "info", "file.uploaded", `${name} lastet opp`, { ...info, segments, chars, batches, estimateSeconds: Math.round(estimate) },
      { ...ctx, fileId: id });
  } else {
    await logEvent(env, "warn", "file.uploaded", `${name} lastet opp, men kan ikke oversettes: ${reason}`, { ...info, reason, error },
      { ...ctx, fileId: id });
  }
  return c.json({ file: serializeFile(await one(env, "SELECT * FROM files WHERE id = ?", id)) }, 201);
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

// Melding og/eller språk på utkastet; bare feltene som er med, endres (filene trenger ingen ny analyse).
api.post("/sendings/:id/note", requireUser, async (c) => {
  const s = await loadSending(c, c.req.param("id"), { write: true });
  if (s.status !== "draft") fail(409, "Denne sendingen er allerede sendt.");
  const body = await readJson(c);
  if (body.targetLanguage !== undefined && !LANGUAGES.includes(body.targetLanguage)) fail(400, "Velg bokmål eller nynorsk.");
  const note = "note" in body ? str(body.note, MAX_NOTE).trim() || null : s.note;
  await run(c.env, "UPDATE sendings SET note = ?, target_language = ? WHERE id = ?", note, body.targetLanguage ?? s.target_language, s.id);
  return c.json({ sending: await sendingView(c.env, s.id) });
});

// Filene som kunne leses, går i kø; en ny Workflow-instans oversetter dem. Filer som ikke kan leses, hoppes over.
api.post("/sendings/:id/send", requireUser, async (c) => {
  const env = c.env;
  const s = await loadSending(c, c.req.param("id"), { write: true });
  if (s.status !== "draft") fail(409, "Denne sendingen er allerede sendt.");
  const files = await all(env, "SELECT id, name, bytes, status, plan_json FROM files WHERE sending_id = ? ORDER BY rel_path", s.id);
  if (!files.length) fail(400, "Legg til minst én fil før du sender.");
  const ready = files.filter((f) => f.status === "draft");
  if (!ready.length) fail(400, "Ingen av filene kan oversettes. Fjern dem og legg til andre.");
  if (!env.XAI_API_KEY) fail(503, `Oversettelsen er ikke satt opp ennå. Si fra til ${await translatorName(env)}.`);
  const estimate = predictSending(ready.map((f) => parseJson(f.plan_json, [])), await estimatorParams(env), config(env).concurrency);
  const [res] = await batch(env, [
    ["UPDATE sendings SET status = 'sent', sent_at = ?, estimate_seconds = ? WHERE id = ? AND status = 'draft'", nowIso(), estimate, s.id],
    ["UPDATE files SET status = 'sent', message = NULL WHERE sending_id = ? AND status = 'draft'", s.id],
  ]);
  if (!res.meta.changes) fail(409, "Denne sendingen er allerede sendt.");
  const ctx = reqCtx(c, { sendingId: s.id });
  try {
    await startWorkflow(env, s.id, s.workflow_id);
  } catch (err) {
    await batch(env, [
      ["UPDATE sendings SET status = 'draft', sent_at = NULL WHERE id = ?", s.id],
      ["UPDATE files SET status = 'draft', message = 'Klar' WHERE sending_id = ? AND status = 'sent'", s.id],
    ]);
    await logEvent(env, "error", "sending.start_failed", "Oversettelsen kunne ikke startes", { error: String(err && err.message) }, ctx);
    fail(503, "Oversettelsen kunne ikke startes akkurat nå. Prøv igjen om litt.");
  }
  const user = c.get("user");
  await logEvent(env, "info", "sending.sent", `${user.displayName} sendte ${filesText(ready.length)}`, {
    files: ready.length, skipped: files.length - ready.length, bytes: ready.reduce((n, f) => n + (f.bytes || 0), 0),
    targetLanguage: s.target_language, note: Boolean(s.note), estimateSeconds: Math.round(estimate),
  }, ctx);
  const message = { ...sentMessage(user.displayName, ready.map((f) => f.name), s.note), sendingId: s.id };
  c.executionCtx.waitUntil(pushToAdmins(env, message, ctx));
  return c.json({ sending: await sendingView(env, s.id) });
});

// Slettes i D1 først, så stopper oversettelsen, og til slutt fjernes filene fra R2: et steg som likevel
// rekker å lagre noe etterpå, ser at filen er slettet og rydder etter seg.
api.delete("/sendings/:id", requireUser, async (c) => {
  const env = c.env;
  const s = await loadSending(c, c.req.param("id"), { write: true });
  const files = await all(env, "SELECT id, sending_id FROM files WHERE sending_id = ?", s.id);
  const now = nowIso();
  await batch(env, [
    ["UPDATE sendings SET status = 'deleted', deleted_at = ? WHERE id = ?", now, s.id],
    ["UPDATE files SET deleted_at = ? WHERE sending_id = ?", now, s.id],
  ]);
  const sent = s.status !== "draft";
  if (sent) await stopWorkflows(env, s);
  await deleteObjects(env, files);
  if (sent) for (const f of files) await deleteWork(env, f.id);
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
