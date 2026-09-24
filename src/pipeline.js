const fs = require("fs");
const path = require("path");
const core = require("./core");

const { HANDLERS, SUPPORTED, isIgnoredName, translateBuffer } = core;

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
  ...core,
  scanFolder,
  translateFile,
  isInside,
};
