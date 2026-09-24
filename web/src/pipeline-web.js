import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

import docxMod from "../../src/formats/docx.js";
import pptxMod from "../../src/formats/pptx.js";
import xlsxMod from "../../src/formats/xlsx.js";
import pdfMod from "../../src/formats/pdf.js";
import textMod from "../../src/formats/text.js";

const { translateDocxBuffer } = docxMod;
const { translatePptxBuffer } = pptxMod;
const { translateXlsxBuffer } = xlsxMod;
const { translatePdfToDocx } = pdfMod;
const { translatePlain, translateCsv, translateHtml, translateRtfToDocx } = textMod;

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

export const SUPPORTED = Object.keys(HANDLERS);

export function extOf(name) {
  const m = String(name).toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m ? m[1] : "";
}

export function outputName(name, outExt) {
  return name.replace(/\.[^.]+$/, "") + outExt;
}

export async function translateUpload(file, { targetLanguage = "bokmal", onProgress } = {}) {
  const ext = extOf(file.name);
  const handler = HANDLERS[ext];
  if (!handler) {
    throw new Error(`Filtypen ${ext || "ukjent"} støttes ikke.`);
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const translated = await handler.run(buf, {
    model: "grok-4.6",
    targetLanguage,
    onProgress,
  });
  const bytes = translated instanceof Uint8Array ? translated : new Uint8Array(translated);
  const mime =
    handler.outExt === ".docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : handler.outExt === ".pptx"
        ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        : handler.outExt === ".xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "application/octet-stream";
  return {
    name: outputName(file.name, handler.outExt),
    blob: new Blob([bytes], { type: mime }),
    ext: handler.outExt,
  };
}
