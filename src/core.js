// Formatkjernen: felles for skyappen (Cloudflare Worker) og Windows-appen (Electron).
// Ingen filsystem her — bare buffere inn og ut.
const { translateDocxBuffer } = require("./formats/docx");
const { translatePptxBuffer } = require("./formats/pptx");
const { translateXlsxBuffer } = require("./formats/xlsx");
const { translatePdfToDocx } = require("./formats/pdf");
const { validateOutput } = require("./validate");
const { planBatches } = require("./grok");
const {
  translatePlain,
  translateCsv,
  translateHtml,
  translateRtfToDocx,
} = require("./formats/text");

const HANDLERS = {
  ".docx": { outExt: ".docx", run: (buf, ctx) => translateDocxBuffer(buf, ctx) },
  ".pptx": { outExt: ".pptx", run: (buf, ctx) => translatePptxBuffer(buf, ctx) },
  ".xlsx": { outExt: ".xlsx", run: (buf, ctx) => translateXlsxBuffer(buf, ctx) },
  ".pdf": { outExt: ".docx", run: (buf, ctx) => translatePdfToDocx(buf, ctx) },
  ".txt": { outExt: ".txt", run: (buf, ctx) => translatePlain(buf, ctx) },
  ".md": { outExt: ".md", run: (buf, ctx) => translatePlain(buf, ctx) },
  ".csv": { outExt: ".csv", run: (buf, ctx) => translateCsv(buf, ctx) },
  ".html": { outExt: ".html", run: (buf, ctx) => translateHtml(buf, ctx) },
  ".htm": { outExt: ".html", run: (buf, ctx) => translateHtml(buf, ctx) },
  ".rtf": { outExt: ".docx", run: (buf, ctx) => translateRtfToDocx(buf, ctx) },
};

const SUPPORTED = Object.keys(HANDLERS);

function baseName(name) {
  return String(name || "").split(/[\\/]/).pop();
}

function extOf(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function handlerFor(ext) {
  const handler = HANDLERS[String(ext || "").toLowerCase()];
  if (!handler) throw new Error(`Filtypen ${ext || "(ukjent)"} støttes ikke.`);
  return handler;
}

// Word-/LibreOffice-låsefiler og systemfiler er ikke dokumenter.
function isIgnoredName(name) {
  const base = baseName(name);
  return (
    base.startsWith("~$") ||
    base.startsWith(".~lock") ||
    /^(thumbs\.db|desktop\.ini|\.ds_store)$/i.test(base)
  );
}

function outputNameFor(relPath) {
  const ext = extOf(relPath);
  const handler = HANDLERS[ext];
  if (!handler) return relPath;
  return relPath.slice(0, relPath.length - ext.length) + handler.outExt;
}

// To innfiler kan gi samme utfil (x.pdf og x.docx -> x.docx). Filen som allerede har
// utformatet beholder navnet; de andre får kildeformatet i navnet: "x (pdf).docx".
function assignOutputNames(relPaths) {
  const taken = new Set();
  const out = new Map();
  const keepsExt = (p) => (HANDLERS[extOf(p)] || {}).outExt === extOf(p);
  const ordered = [...relPaths].sort(
    (a, b) => (keepsExt(a) ? 0 : 1) - (keepsExt(b) ? 0 : 1) || a.localeCompare(b, "nb")
  );
  for (const rel of ordered) {
    let name = outputNameFor(rel);
    if (taken.has(name.toLowerCase())) {
      const ext = extOf(rel);
      const outExt = HANDLERS[ext] ? HANDLERS[ext].outExt : ext;
      const stem = rel.slice(0, rel.length - ext.length);
      name = `${stem} (${ext.slice(1)})${outExt}`;
      for (let n = 2; taken.has(name.toLowerCase()); n++) {
        name = `${stem} (${ext.slice(1)} ${n})${outExt}`;
      }
    }
    taken.add(name.toLowerCase());
    out.set(rel, name);
  }
  return out;
}

async function validated(output, outExt) {
  const check = await validateOutput(output, outExt);
  if (!check.ok) {
    const err = new Error("Den oversatte filen ble ugyldig og er ikke lagret. Feilen er logget.");
    err.code = "invalid_output";
    err.details = check.errors;
    throw err;
  }
  return output;
}

function warningSink(ctx) {
  const warnings = [];
  const onWarning = (w) => {
    warnings.push(w);
    if (ctx && ctx.onWarning) ctx.onWarning(w);
  };
  return { warnings, onWarning };
}

// Hele oversettelsen i én operasjon (Windows-appen).
async function translateBuffer(buffer, ext, ctx) {
  const handler = handlerFor(ext);
  const { warnings, onWarning } = warningSink(ctx);
  const output = await handler.run(buffer, { ...ctx, onWarning });
  return { buffer: await validated(output, handler.outExt), outExt: handler.outExt, warnings };
}

// Steg 1 i skyjobben: hent ut alle tekstbiter, ingen nettverk.
// Returnerer ett element per translateStrings-kall i handleren, i fast rekkefølge.
async function collectStrings(buffer, ext) {
  const handler = handlerFor(ext);
  const collect = [];
  await handler.run(buffer, { collect, apiKey: "" });
  return collect.map((c) => c.strings);
}

// Estimat uten API-kall: tekstbiter, tegn og batcher per kall.
async function analyzeBuffer(buffer, ext) {
  const collected = await collectStrings(buffer, ext);
  const calls = collected.map((strings) => planBatches(strings).map((b) => b.chars));
  return {
    calls,
    segments: collected.reduce((n, strings) => n + strings.filter((s) => s.trim()).length, 0),
    chars: calls.reduce((n, c) => n + c.reduce((a, b) => a + b, 0), 0),
    batches: calls.reduce((n, c) => n + c.length, 0),
  };
}

// Siste steg i skyjobben: skriv ferdige oversettelser inn i originalen.
// translatedCalls har samme form som collectStrings-resultatet.
async function applyTranslations(buffer, ext, translatedCalls, ctx = {}) {
  const handler = handlerFor(ext);
  const { warnings, onWarning } = warningSink(ctx);
  const apply = translatedCalls.map((c) => c.slice());
  const output = await handler.run(buffer, { ...ctx, apply, apiKey: "", onWarning });
  if (apply.length) throw new Error("Dokumentet endret seg under oversettelsen. Prøv igjen.");
  return { buffer: await validated(output, handler.outExt), outExt: handler.outExt, warnings };
}

module.exports = {
  HANDLERS,
  SUPPORTED,
  extOf,
  isIgnoredName,
  outputNameFor,
  assignOutputNames,
  translateBuffer,
  collectStrings,
  analyzeBuffer,
  applyTranslations,
};
