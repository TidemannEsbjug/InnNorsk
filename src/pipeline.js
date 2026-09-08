const fs = require("fs");
const path = require("path");
const { translateDocxBuffer } = require("./formats/docx");
const { translatePptxBuffer } = require("./formats/pptx");
const { translateXlsxBuffer } = require("./formats/xlsx");
const { translatePdfToDocx } = require("./formats/pdf");
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
        if (SUPPORTED.includes(ext)) files.push(full);
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
  const translated = await handler.run(buffer, {
    apiKey,
    model,
    targetLanguage,
    onProgress,
  });

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, translated);
  return { dest, skipped: false };
}

module.exports = {
  SUPPORTED,
  scanFolder,
  translateFile,
  isInside,
};
