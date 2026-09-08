const { translateDocumentText, translateStrings } = require("../grok");
const { buildSimpleDocx } = require("./simple-docx");

function stripRtf(rtf) {
  return String(rtf)
    .replace(/\{\*?\\[^{}]+}|[{}]|\\[A-Za-z]+\n?(?:-?\d+)?[ ]?/g, "")
    .replace(/\\'[0-9a-fA-F]{2}/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function translatePlain(buffer, ctx) {
  const text = buffer.toString("utf8");
  const translated = await translateDocumentText({ ...ctx, text });
  return Buffer.from(translated, "utf8");
}

async function translateCsv(buffer, ctx) {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const cells = [];
  const map = [];

  lines.forEach((line, row) => {
    // Keep it simple: split on commas not inside quotes.
    const parts = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        q = !q;
        cur += ch;
      } else if (ch === "," && !q) {
        parts.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    parts.push(cur);
    parts.forEach((cell, col) => {
      const raw = cell.replace(/^"|"$/g, "").replace(/""/g, '"');
      if (raw.trim() && /[A-Za-zÀ-ÿ]/.test(raw)) {
        map.push({ row, col, quoted: cell.trim().startsWith('"') });
        cells.push(raw);
      }
    });
    lines[row] = parts;
  });

  if (!cells.length) return buffer;

  const translated = await translateStrings({ ...ctx, strings: cells });
  map.forEach((m, i) => {
    const value = translated[i].replace(/"/g, '""');
    lines[m.row][m.col] = m.quoted || /[",\n]/.test(value) ? `"${value}"` : value;
  });

  const out = lines.map((parts) => (Array.isArray(parts) ? parts.join(",") : parts)).join("\n");
  return Buffer.from(out.endsWith("\n") ? out : `${out}\n`, "utf8");
}

async function translateHtml(buffer, ctx) {
  const html = buffer.toString("utf8");
  const blocks = [];
  const re = />([^<]{3,})</g;
  let m;
  const slots = [];
  while ((m = re.exec(html))) {
    const raw = m[1];
    if (!raw.trim() || !/[A-Za-zÀ-ÿ]/.test(raw)) continue;
    slots.push({ start: m.index + 1, end: m.index + 1 + raw.length, raw });
    blocks.push(raw);
  }
  if (!blocks.length) {
    const translated = await translateDocumentText({ ...ctx, text: html });
    return Buffer.from(translated, "utf8");
  }
  const translated = await translateStrings({ ...ctx, strings: blocks });
  let out = html;
  for (let i = slots.length - 1; i >= 0; i--) {
    const s = slots[i];
    out = out.slice(0, s.start) + translated[i] + out.slice(s.end);
  }
  return Buffer.from(out, "utf8");
}

async function translateRtfToDocx(buffer, ctx) {
  const text = stripRtf(buffer.toString("utf8"));
  const translated = await translateDocumentText({ ...ctx, text });
  const paragraphs = translated.replace(/\r\n/g, "\n").split("\n");
  return buildSimpleDocx(paragraphs.length ? paragraphs : [translated], { compact: true });
}

module.exports = {
  translatePlain,
  translateCsv,
  translateHtml,
  translateRtfToDocx,
};
