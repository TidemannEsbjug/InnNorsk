const { translateDocumentText } = require("../grok");
const { buildSimpleDocx } = require("./simple-docx");

async function extractPdfText(buffer) {
  const pdfParse = require("pdf-parse/lib/pdf-parse.js");
  const data = await pdfParse(buffer);
  return String(data.text || "").replace(/\n{3,}/g, "\n\n").trim();
}

async function translatePdfToDocx(buffer, ctx) {
  const text = await extractPdfText(buffer);
  if (!text.trim()) {
    throw new Error("Fant ingen tekst i PDF-en (kan være skannet uten OCR).");
  }
  const translated = await translateDocumentText({
    ...ctx,
    text,
  });
  const paragraphs = translated
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return buildSimpleDocx(paragraphs.length ? paragraphs : [translated]);
}

module.exports = { extractPdfText, translatePdfToDocx };
