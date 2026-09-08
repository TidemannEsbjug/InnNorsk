const { translateStrings } = require("../grok");
const { buildSimpleDocx } = require("./simple-docx");

async function extractPdfText(buffer) {
  const pdfParse = require("pdf-parse/lib/pdf-parse.js");
  const data = await pdfParse(buffer);
  return String(data.text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function visualBlocks(text) {
  const lines = String(text).split("\n");
  const blocks = [];
  let cur = [];
  const flush = () => {
    if (cur.length) {
      blocks.push({ type: "text", lines: cur });
      cur = [];
    }
  };
  for (const line of lines) {
    if (!line.trim()) {
      flush();
      if (!blocks.length || blocks[blocks.length - 1].type !== "blank") {
        blocks.push({ type: "blank" });
      }
    } else {
      cur.push(line.replace(/\s+$/g, ""));
    }
  }
  flush();
  return blocks;
}

async function translatePdfToDocx(buffer, ctx) {
  const text = await extractPdfText(buffer);
  if (!text.trim()) {
    throw new Error("Fant ingen tekst i PDF-en (kan være skannet uten OCR).");
  }

  const blocks = visualBlocks(text);
  const toTranslate = [];
  const map = [];
  blocks.forEach((b, i) => {
    if (b.type === "text") {
      map.push(i);
      toTranslate.push(b.lines.join("\n"));
    }
  });

  const translated = toTranslate.length
    ? await translateStrings({ ...ctx, strings: toTranslate })
    : [];

  const paragraphs = [];
  let t = 0;
  for (const block of blocks) {
    if (block.type === "blank") {
      paragraphs.push("");
      continue;
    }
    const srcLines = block.lines;
    const out = translated[t++] || "";
    const outLines = String(out).split("\n");
    if (outLines.length === srcLines.length) {
      outLines.forEach((line) => paragraphs.push(line));
    } else {
      srcLines.forEach((_, i) => {
        paragraphs.push(outLines[i] != null ? outLines[i] : i === 0 ? out : "");
      });
      if (outLines.length > srcLines.length) {
        const rest = outLines.slice(srcLines.length).join(" ");
        if (rest.trim()) {
          paragraphs[paragraphs.length - 1] =
            `${paragraphs[paragraphs.length - 1]} ${rest}`.trim();
        }
      }
    }
  }

  if (!paragraphs.some((p) => String(p).trim())) {
    paragraphs.push(translated.join("\n") || text);
  }

  return buildSimpleDocx(paragraphs, { compact: true });
}

module.exports = { extractPdfText, translatePdfToDocx };
