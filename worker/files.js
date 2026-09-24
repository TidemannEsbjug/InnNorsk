// Filnavn, filtyper og R2: strømmer opp- og nedlastinger rett mellom forespørselen og R2 (ingen buffering).
// Nedlastingsnavn kommer alltid fra D1, aldri fra R2-nøklene.
import { fail } from "./http.js";
import { logEvent } from "./log.js";

// Samme liste og regler som SUPPORTED / isIgnoredName i src/core.js. Kjernen importeres ikke her,
// fordi den drar med seg tunge formatbiblioteker som Workeren ikke trenger.
export const SUPPORTED = [".docx", ".pptx", ".xlsx", ".pdf", ".txt", ".md", ".csv", ".html", ".htm", ".rtf"];

export const baseName = (p) => String(p || "").split("/").pop();

export function extOf(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

export function isIgnoredName(name) {
  const base = baseName(name);
  return base.startsWith("~$") || base.startsWith(".~lock") || /^(thumbs\.db|desktop\.ini|\.ds_store)$/i.test(base);
}

const MIME = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".rtf": "application/rtf",
};
const MAX_PATH = 240;

const mimeOf = (name) => MIME[extOf(name)] || "application/octet-stream";

// Relativ sti fra nettleseren → trygg sti: bare mappenavn og filnavn, aldri .., stasjonsbokstav eller kontrolltegn.
export function sanitizePath(input) {
  if (typeof input !== "string") return "";
  const parts = input
    .normalize("NFC")
    .replace(/\\/g, "/")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..");
  if (parts.length) parts[0] = parts[0].replace(/^[a-zA-Z]:/, "");
  const clean = parts.map((s) => s.replace(/[<>:"|?*]/g, "_")).filter(Boolean);
  while (clean.length > 1 && clean.join("/").length > MAX_PATH) clean.shift();
  const rel = clean.join("/");
  return rel.length > MAX_PATH ? "" : rel;
}

// RFC 6266/5987: ASCII-reserve for gamle klienter + UTF-8-navnet for alle andre.
export function contentDisposition(name) {
  const fallback = name
    .replace(/æ/g, "ae").replace(/Æ/g, "AE").replace(/ø/g, "o").replace(/Ø/g, "O")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/gu, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export const r2Key = (sendingId, fileId, kind) => `s/${sendingId}/${fileId}/${kind}`;

const fileKeys = (f) => [r2Key(f.sending_id, f.id, "original"), r2Key(f.sending_id, f.id, "result")];

// Sletter original og resultat for filradene (R2 tar maks 1000 nøkler per kall; manglende nøkler er ok).
export async function deleteObjects(env, files) {
  const keys = files.flatMap(fileKeys);
  for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000));
}

// Content-Length er påkrevd: da vet vi størrelsen før vi leser noe, og R2 kan ta imot strømmen direkte.
export function contentLength(c) {
  const raw = c.req.header("Content-Length");
  return raw != null && /^\d+$/.test(raw) ? Number(raw) : null;
}

// [status, melding] hvis størrelsen mangler, er 0 eller er for stor; ellers null.
export function sizeProblem(length, maxBytes, tooBig) {
  if (length == null) return [411, "Filstørrelsen mangler. Last opp filen på nytt."];
  if (length > maxBytes) return [413, tooBig];
  return length === 0 ? [400, "Filen er tom."] : null;
}

// Strømmer forespørselens kropp til R2 og returnerer antall byte som ble lagret. ctx er loggkonteksten.
export async function putBody(c, key, name, ctx) {
  try {
    return (await c.env.FILES.put(key, c.req.raw.body, { httpMetadata: { contentType: mimeOf(name) } })).size;
  } catch (err) {
    await logEvent(c.env, "warn", "upload.failed", `Opplastingen av ${name} ble avbrutt`, { error: String(err && err.message) }, ctx);
    return fail(400, "Opplastingen ble avbrutt. Prøv igjen.");
  }
}

export async function download(env, key, name) {
  const obj = await env.FILES.get(key);
  if (!obj) fail(410, "Filen finnes ikke lenger.");
  return new Response(obj.body, {
    headers: {
      "Content-Type": mimeOf(name),
      "Content-Disposition": contentDisposition(name),
      "Content-Length": String(obj.size),
      "Cache-Control": "private, no-store",
    },
  });
}
