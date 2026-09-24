const fs = require("fs");
const path = require("path");
const { translateDocxBuffer } = require("./formats/docx");
const { translatePptxBuffer } = require("./formats/pptx");
const { translateXlsxBuffer } = require("./formats/xlsx");
const { translatePdfToDocx } = require("./formats/pdf");
const { validateOutput } = require("./validate");
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

// Word-/LibreOffice-låsefiler og systemfiler er ikke dokumenter.
function isIgnoredName(name) {
  const base = path.basename(String(name || ""));
  return (
    base.startsWith("~$") ||
    base.startsWith(".~lock") ||
    /^(thumbs\.db|desktop\.ini)$/i.test(base)
  );
}

function extOf(name) {
  return path.extname(String(name || "")).toLowerCase();
}

function outputNameFor(relPath) {
  const ext = extOf(relPath);
  const handler = HANDLERS[ext];
  if (!handler) return relPath;
  return relPath.slice(0, relPath.length - ext.length) + handler.outExt;
}

// To innfiler kan gi samme utfil (x.pdf og x.docx -> x.docx). Den første beholder
// navnet, de neste får kildeformatet i navnet: "x (pdf).docx".
function assignOutputNames(relPaths) {
  const taken = new Set();
  const out = new Map();
  const ordered = [...relPaths].sort((a, b) => {
    const sa = extOf(a) === HANDLERS[extOf(a)]?.outExt ? 0 : 1;
    const sb = extOf(b) === HANDLERS[extOf(b)]?.outExt ? 0 : 1;
    return sa - sb || a.localeCompare(b, "nb");
  });
  for (const rel of ordered) {
    let name = outputNameFor(rel);
    if (taken.has(name.toLowerCase())) {
      const ext = extOf(rel);
      const outExt = HANDLERS[ext] ? HANDLERS[ext].outExt : ext;
      const stem = rel.slice(0, rel.length - ext.length);
      name = `${stem} (${ext.slice(1)})${outExt}`;
      let n = 2;
      while (taken.has(name.toLowerCase())) {
        name = `${stem} (${ext.slice(1)} ${n++})${outExt}`;
      }
    }
    taken.add(name.toLowerCase());
    out.set(rel, name);
  }
  return out;
}

async function translateBuffer(buffer, ext, ctx) {
  const key = String(ext || "").toLowerCase();
  const handler = HANDLERS[key];
  if (!handler) throw new Error(`Filtypen ${key} støttes ikke.`);
  const warnings = [];
  const onWarning = (w) => {
    warnings.push(w);
    if (ctx && ctx.onWarning) ctx.onWarning(w);
  };
  const output = await handler.run(buffer, { ...ctx, onWarning });
  const check = await validateOutput(output, handler.outExt);
  if (!check.ok) {
    const err = new Error(
      "Den oversatte filen ble ugyldig og er ikke lagret. Feilen er logget."
    );
    err.code = "invalid_output";
    err.details = check.errors;
    throw err;
  }
  return { buffer: output, outExt: handler.outExt, warnings };
}

async function analyzeBuffer(buffer, ext) {
  const key = String(ext || "").toLowerCase();
  const handler = HANDLERS[key];
  if (!handler) throw new Error(`Filtypen ${key} støttes ikke.`);
  const calls = [];
  let segments = 0;
  let chars = 0;
  await handler.run(buffer, {
    dryRun: true,
    apiKey: "",
    onPlan: (p) => {
      calls.push(p.batches);
      segments += p.segments;
      chars += p.chars;
    },
  });
  return {
    calls,
    segments,
    chars,
    batches: calls.reduce((n, c) => n + c.length, 0),
  };
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function listDocuments(inputFolder, outputFolder) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (outputFolder && path.resolve(full) === path.resolve(outputFolder)) continue;
        if (entry.name.toLowerCase() === "oversatt") continue;
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED.includes(ext) && !isIgnoredName(entry.name)) files.push(full);
      }
    }
  };
  walk(inputFolder);
  return files.sort((a, b) => a.localeCompare(b, "nb"));
}

function outputPathFor(file, inputFolder, outputFolder, outExt) {
  const rel = path.relative(inputFolder, file);
  const parsed = path.parse(rel);
  const destRel = path.join(parsed.dir, `${parsed.name}${outExt}`);
  return path.join(outputFolder, destRel);
}

function scanFolder({ inputFolder, outputFolder }) {
  if (!inputFolder || !fs.existsSync(inputFolder)) {
    return { files: [], error: "Inn-mappen finnes ikke." };
  }
  const files = listDocuments(inputFolder, outputFolder);
  return {
    files: files.map((file) => {
      const ext = path.extname(file).toLowerCase();
      const handler = HANDLERS[ext];
      const dest = outputPathFor(file, inputFolder, outputFolder, handler.outExt);
      return {
        path: file,
        name: path.relative(inputFolder, file),
        ext,
        bytes: fs.statSync(file).size,
        dest,
        alreadyTranslated: fs.existsSync(dest),
      };
    }),
  };
}

async function translateFile(file, { inputFolder, outputFolder, skipExisting, apiKey, model, targetLanguage, onProgress }) {
  const ext = path.extname(file).toLowerCase();
  const handler = HANDLERS[ext];
  if (!handler) throw new Error(`Filtypen ${ext} støttes ikke.`);

  const dest = outputPathFor(file, inputFolder, outputFolder, handler.outExt);
  if (skipExisting && fs.existsSync(dest)) {
    return { dest, skipped: true };
  }

  const buffer = fs.readFileSync(file);
  const { buffer: translated, warnings } = await translateBuffer(buffer, ext, {
    apiKey,
    model,
    targetLanguage,
    onProgress,
  });

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, translated);
  return { dest, skipped: false, warnings };
}

module.exports = {
  HANDLERS,
  SUPPORTED,
  isIgnoredName,
  outputNameFor,
  assignOutputNames,
  translateBuffer,
  analyzeBuffer,
  scanFolder,
  translateFile,
  isInside,
};
