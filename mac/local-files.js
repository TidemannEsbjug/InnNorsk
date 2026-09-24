// Lokale kopier på Mac-en: ~/InnNorsk/<yyyy-mm-dd> <navn>/<undermappe>/<fil>.
const fs = require("node:fs");
const path = require("node:path");

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const safeSegment = (s) => String(s).replace(/[\u0000-\u001f/\\:]/g, "_").trim() || "_";

// Stien fra nettstedet brukes aldri rått: ingen «..», ingen absolutte stier.
function safeRelPath(rel) {
  const parts = String(rel || "")
    .split(/[\\/]+/)
    .filter((p) => p && p !== "." && p !== "..")
    .map(safeSegment);
  return parts.length ? parts : ["dokument"];
}

// "Rapport.pdf" + ".docx" -> "Rapport (norsk).docx"
function norskName(file, outExt) {
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)} (norsk)${outExt}`;
}

// Overskriver aldri noe: identisk innhold gjenbrukes, ellers " (2)", " (3)" …
function saveCopy(target, buffer) {
  const ext = path.extname(target);
  const stem = target.slice(0, target.length - ext.length);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? target : `${stem} (${n})${ext}`;
    if (!fs.existsSync(candidate)) {
      fs.writeFileSync(candidate, buffer);
      return candidate;
    }
    if (fs.readFileSync(candidate).equals(buffer)) return candidate;
  }
}

module.exports = { localDate, safeSegment, safeRelPath, norskName, saveCopy };
