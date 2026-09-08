const { translateStrings } = require("../grok");
const { buildSimpleDocx } = require("./simple-docx");

function fontSizeOf(item) {
  const tr = item.transform || [1, 0, 0, 1, 0, 0];
  const a = Math.hypot(tr[0], tr[1]);
  const d = Math.hypot(tr[2], tr[3]);
  return a || d || 11;
}

function clusterLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    const tol = Math.max(1.6, item.fontSize * 0.32);
    if (last && Math.abs(last.y - item.y) <= tol) {
      last.items.push(item);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }
  return lines.map((line) => {
    line.items.sort((a, b) => a.x - b.x);
    let text = "";
    line.items.forEach((it, i) => {
      if (i > 0) {
        const prev = line.items[i - 1];
        const gap = it.x - (prev.x + prev.width);
        if (gap > it.fontSize * 0.22) text += " ";
      }
      text += it.str;
    });
    const names = line.items.map((i) => i.fontName).join(" ");
    const sizes = line.items.map((i) => i.fontSize).sort((a, b) => a - b);
    const main = line.items.reduce((a, b) => (a.str.length >= b.str.length ? a : b));
    return {
      text: text.replace(/[ \t]+$/g, ""),
      fontSize: sizes[Math.floor(sizes.length / 2)],
      fontName: main.fontName,
      bold: /bold|black|heavy|semibold|demi/i.test(names),
      italic: /italic|oblique/i.test(names),
      x: line.items[0].x,
      y: line.y,
      xEnd:
        line.items[line.items.length - 1].x +
        (line.items[line.items.length - 1].width || 0),
    };
  }).filter((l) => l.text.length);
}

function linesToParagraphs(lines, pageWidth) {
  const paras = [];
  let cur = [];
  const flush = (spaceBefore) => {
    if (!cur.length) return;
    const main = cur.reduce((a, b) => (a.text.length >= b.text.length ? a : b));
    const left = Math.min(...cur.map((l) => l.x));
    const right = Math.max(...cur.map((l) => l.xEnd));
    const mid = (left + right) / 2;
    let align = "left";
    if (Math.abs(mid - pageWidth / 2) < pageWidth * 0.1 && left > pageWidth * 0.16) {
      align = "center";
    } else if (left > pageWidth * 0.48) {
      align = "right";
    }
    const avgSize = cur.reduce((s, l) => s + l.fontSize, 0) / cur.length;
    paras.push({
      text: cur.map((l) => l.text).join("\n"),
      fontSize: main.fontSize,
      fontName: main.fontName,
      bold: main.bold,
      italic: main.italic,
      align,
      spaceBefore: spaceBefore || 0,
      spaceAfter: 0,
      lineTwips: Math.round(avgSize * 20 * 1.15),
    });
    cur = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!cur.length) {
      cur.push(line);
      continue;
    }
    const prev = cur[cur.length - 1];
    const gap = prev.y - line.y;
    const sameSize = Math.abs(prev.fontSize - line.fontSize) < 0.9;
    const sameWeight = prev.bold === line.bold;
    if (gap > prev.fontSize * 1.55 || !sameSize || !sameWeight) {
      const extra = gap > prev.fontSize * 2.2 ? Math.round((gap - prev.fontSize) * 10) : 0;
      flush(0);
      cur.push(line);
      if (extra) paras[paras.length - 1].spaceAfter = extra;
    } else {
      cur.push(line);
    }
  }
  flush(0);
  return paras;
}

async function extractPdfLayout(buffer) {
  const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
  const data = new Uint8Array(buffer);
  const loading = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  const pdf = await loading.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = [];
    for (const it of content.items) {
      if (!it.str) continue;
      const tr = it.transform || [1, 0, 0, 1, 0, 0];
      items.push({
        str: it.str,
        x: tr[4],
        y: tr[5],
        width: it.width || 0,
        fontSize: fontSizeOf(it),
        fontName: it.fontName || "",
      });
    }
    pages.push({
      width: viewport.width,
      height: viewport.height,
      lines: clusterLines(items),
    });
  }
  return pages;
}

async function translatePdfToDocx(buffer, ctx) {
  const pages = await extractPdfLayout(buffer);
  const styled = [];
  pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) styled.push({ text: "", spaceBefore: 240 });
    styled.push(...linesToParagraphs(page.lines, page.width));
  });

  if (!styled.some((p) => String(p.text || "").trim())) {
    throw new Error("Fant ingen tekst i PDF-en (kan være skannet uten OCR).");
  }

  const strings = styled.map((p) => p.text);
  const translated = await translateStrings({ ...ctx, strings });
  const paragraphs = styled.map((p, i) => ({
    ...p,
    text: translated[i] != null ? translated[i] : p.text,
  }));

  const first = pages[0] || { width: 595, height: 842 };
  const xs = pages.flatMap((p) => p.lines.map((l) => l.x));
  const marginPt = xs.length ? Math.max(36, Math.min(90, Math.round(Math.min(...xs)))) : 56;

  return buildSimpleDocx(paragraphs, {
    compact: true,
    page: {
      widthPt: first.width,
      heightPt: first.height,
      marginPt,
    },
  });
}

module.exports = { translatePdfToDocx };
