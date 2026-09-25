// PDF inn → PDF ut med samme oppsett. pdf.js (unpdf) leser hver tekstbit med posisjon, skrift, størrelse og farge;
// bitene settes sammen til linjer, kolonner/celler og avsnitt. pdf-lib fjerner så den opprinnelige teksten fra sidene
// (bilder, streker, bakgrunner og annen grafikk blir stående) og skriver oversettelsen på samme sted og i samme stil,
// med standardskriften som ligner mest (Helvetica, Times eller Courier; fet/kursiv som originalen).
// Blir teksten lengre, brytes den innenfor avsnittets bredde og krympes litt om nødvendig.
// Låste (krypterte) eller ødelagte PDF-er kan ikke endres; da lages en ny PDF med samme sider og teksten på samme sted.
const { translateStrings } = require("../grok");

const SPACE_GAP = 0.2; // hull (andel av skriftstørrelsen) som betyr mellomrom mellom tekstbiter
const COLUMN_GAP = 1.25; // større hull enn dette deler linjen i kolonner/celler
const LINE_GAP_MAX = 1.75; // største linjeavstand (× skriftstørrelse) innenfor ett avsnitt
const SCALES = [1, 0.95, 0.9, 0.85, 0.8, 0.75];
const LEAD_IN_END = /[.:!?–—-]$/;
// Kulepunkt eller nummerering foran et listepunkt.
const BULLET = /^([•◦▪▫‣⁃●○■□►▸–—\-*·✓✔]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])$/;
// Sperret tekst: pdf.js setter inn mellomrom mellom hver bokstav («P A R E N T»).
const SPACED_OUT = /^\S( \S){2,}$/u;
const LETTER = /\p{L}/u;
const BLACK = "#000000";
const NO_TEXT = "Fant ingen tekst i PDF-en (kan være skannet uten OCR).";

const FONT_NAMES = {
  sans: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
  serif: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
  mono: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"],
};
const SERIF = /serif|times|georgia|garamond|cambria|minion|palatino|baskerville|caslon|merriweather|lora|charter|bookman|century|didot|bodoni|constantia|fraunces|playfair|crimson|tinos|antiqua|mincho|song/i;
const MONO = /mono|courier|consol|menlo|typewriter|code/i;
const BOLD = /bold|black|heavy|semibold|demi|extrabold|ultrabold/i;
const ITALIC = /italic|oblique/i;
// Tegn som standardskriftene (WinAnsi) mangler, men som har en god erstatning.
const REPLACE = { "−": "-", "‐": "-", "‑": "-", " ": " ", " ": " ", " ": " ", "​": "", "­": "", "﻿": "", "\t": " " };

const norm = (s) => String(s).normalize("NFKC");

// ---- Lesing (pdf.js) ----

async function loadPdfjs() {
  const unpdf = await import("unpdf");
  const { OPS } = await unpdf.getResolvedPDFJS();
  return { getDocumentProxy: unpdf.getDocumentProxy, OPS };
}

function hexOf(args) {
  const [first] = args || [];
  if (typeof first === "string" && /^#[0-9a-f]{6}$/i.test(first)) return first.toLowerCase();
  if (args && args.length >= 3 && args.slice(0, 3).every((n) => typeof n === "number")) {
    return `#${args.slice(0, 3).map((n) => Math.round(n <= 1 ? n * 255 : n).toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

const multiply = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];

// Én gjennomgang av sidens tegneoperasjoner: fyllfarge og om teksten er usynlig (OCR-lag) per synlig tegn, i den
// rekkefølgen de tegnes, og små figurer (tegnede kulepunkter) med posisjon på siden.
function scanOps({ fnArray, argsArray }, OPS) {
  const out = [];
  const shapes = [];
  const stack = [];
  let state = { color: BLACK, mode: 0, ctm: [1, 0, 0, 1, 0, 0] };
  const show = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
  for (let k = 0; k < fnArray.length; k++) {
    const fn = fnArray[k];
    const args = argsArray[k];
    if (fn === OPS.save) stack.push({ ...state });
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ...state });
      if (Array.isArray(args[0]) || ArrayBuffer.isView(args[0])) state.ctm = multiply(Array.from(args[0]), state.ctm);
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) state = stack.pop() || state;
    else if (fn === OPS.transform) state.ctm = multiply(args, state.ctm);
    else if (fn === OPS.constructPath && args[2] && args[2].length === 4) {
      const [x0, y0, x1, y1] = args[2];
      const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [
        state.ctm[0] * x + state.ctm[2] * y + state.ctm[4], state.ctm[1] * x + state.ctm[3] * y + state.ctm[5],
      ]);
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      if (w >= 1.2 && h >= 1.2 && w <= 9 && h <= 9 && w / h > 0.5 && w / h < 2) {
        shapes.push({ cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 });
      }
    }
    else if (fn === OPS.setFillRGBColor) state.color = hexOf(args) || state.color;
    else if (fn === OPS.setTextRenderingMode) state.mode = args[0];
    else if (show.has(fn)) {
      const glyphs = (args || []).find(Array.isArray) || [];
      for (const g of glyphs) {
        if (!g || typeof g !== "object" || !g.unicode) continue;
        for (const ch of norm(g.unicode)) {
          if (!/\s/.test(ch)) out.push({ ch, color: state.color, invisible: state.mode === 3 || state.mode === 7 });
        }
      }
    }
  }
  return { glyphs: out, shapes };
}

// Tekstbitene og tegnene kommer i samme rekkefølge; hver bit får fargen til sitt første tegn.
function assignStyles(items, glyphs) {
  let cursor = 0;
  let last = { color: BLACK, invisible: false };
  for (const it of items) {
    const chars = [...norm(it.str)].filter((ch) => !/\s/.test(ch));
    if (chars.length) {
      const end = Math.min(glyphs.length, cursor + 200);
      for (let k = cursor; k < end; k++) {
        if (glyphs[k].ch === chars[0]) {
          last = glyphs[k];
          cursor = k + chars.length;
          break;
        }
      }
    }
    it.color = last.color;
    it.invisible = last.invisible;
  }
}

function familyOf(name, cssFamily) {
  const clean = String(name || "").replace(/^[A-Z]{6}\+/, "");
  if (MONO.test(clean) || cssFamily === "monospace") return "mono";
  if (SERIF.test(clean) && !/sans/i.test(clean)) return "serif";
  if (cssFamily === "serif" && !/sans/i.test(clean)) return "serif";
  return "sans";
}

async function extractPages(buffer) {
  const { getDocumentProxy, OPS } = await loadPdfjs();
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const opList = await page.getOperatorList();
    const content = await page.getTextContent();
    // Fontenes ekte navn (f.eks. "ABCDEF+Calibri-Bold") finnes først etter at siden er tolket.
    const realNames = new Map();
    const realName = (id) => {
      if (!realNames.has(id)) {
        let name = "";
        try {
          const font = page.commonObjs.get(id);
          name = (font && (font.name || font.loadedName)) || "";
        } catch {
          /* ukjent font: fall tilbake til pdf.js sin id */
        }
        realNames.set(id, name || id || "");
      }
      return realNames.get(id);
    };
    const items = [];
    for (const it of content.items) {
      if (typeof it.str !== "string" || !it.str) continue;
      const tr = it.transform || [1, 0, 0, 1, 0, 0];
      const fontName = realName(it.fontName);
      const css = (content.styles[it.fontName] || {}).fontFamily;
      const size = Math.hypot(tr[0], tr[1]) || Math.hypot(tr[2], tr[3]) || 11;
      const spaced = SPACED_OUT.test(it.str);
      items.push({
        str: spaced ? it.str.replace(/ /g, "") : it.str,
        x: tr[4],
        y: tr[5],
        w: it.width || 0,
        size,
        angle: Math.atan2(tr[1], tr[0]),
        style: {
          family: familyOf(fontName, css),
          bold: BOLD.test(fontName),
          italic: ITALIC.test(fontName) || Math.abs(tr[2]) > Math.abs(tr[3]) * 0.1,
          size: Math.round(size * 10) / 10,
          tracked: spaced,
        },
      });
    }
    const { glyphs, shapes } = scanOps(opList, OPS);
    assignStyles(items, glyphs);
    for (const it of items) it.style.color = it.color;
    const [x0, y0, x1, y1] = page.view;
    pages.push({ view: [x0, y0, x1, y1], width: x1 - x0, height: y1 - y0, items, shapes });
    page.cleanup();
  }
  if (typeof pdf.destroy === "function") await pdf.destroy();
  return pages;
}

// ---- Oppsett: linjer → biter (kolonner/celler) → avsnitt ----

const styleKey = (s) => `${s.family}|${s.bold}|${s.italic}|${Math.round(s.size * 2) / 2}|${Boolean(s.tracked)}`;
const fullKey = (s) => `${styleKey(s)}|${s.color}`;

function dominant(runs) {
  const weight = new Map();
  for (const r of runs) weight.set(r.style, (weight.get(r.style) || 0) + r.text.trim().length);
  let best = runs[0].style;
  for (const [style, n] of weight) if (n > (weight.get(best) || 0)) best = style;
  return best;
}

function pushRun(runs, text, style) {
  const last = runs[runs.length - 1];
  if (last && (fullKey(last.style) === fullKey(style) || !text.trim())) last.text += text;
  else if (last && !last.text.trim()) runs[runs.length - 1] = { text: last.text + text, style };
  else runs.push({ text, style });
}

// Tekstbiter på samme grunnlinje → biter delt ved store hull (kolonner, tabellceller).
function fragmentsOf(items) {
  const flat = items.filter((it) => Math.abs(it.angle) < 0.01).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of flat) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - it.y) <= Math.max(1.6, it.size * 0.32)) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  const fragments = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let cur = null;
    for (const it of line.items) {
      const gap = cur ? it.x - cur.xEnd : 0;
      if (cur && gap > Math.max(cur.size, it.size) * COLUMN_GAP && it.str.trim()) {
        fragments.push(cur);
        cur = null;
      }
      if (!it.str.trim()) {
        // Mellomrom-biter fra pdf.js kan dekke hele hullet til neste kolonne; de teller ikke som tekst.
        if (cur) pushRun(cur.runs, " ", it.style);
        continue;
      }
      if (!cur) {
        cur = { x: it.x, xEnd: it.x + it.w, y: it.y, size: it.size, runs: [], chars: 0 };
      } else if (gap > it.size * SPACE_GAP && !/\s$/.test(cur.runs[cur.runs.length - 1].text) && !/^\s/.test(it.str)) {
        pushRun(cur.runs, " ", it.style);
      }
      pushRun(cur.runs, it.str, it.style);
      cur.xEnd = Math.max(cur.xEnd, it.x + it.w);
      if (it.str.trim().length > cur.chars) {
        cur.chars = it.str.trim().length;
        cur.y = it.y;
        cur.size = it.size;
      }
      if (it.invisible) cur.invisible = true;
    }
    if (cur) fragments.push(cur);
  }
  for (const f of fragments) {
    f.runs = f.runs.map((r) => ({ ...r, text: r.text.replace(/\s+/g, " ") }));
    f.runs[0].text = f.runs[0].text.replace(/^ /, "");
    f.runs[f.runs.length - 1].text = f.runs[f.runs.length - 1].text.replace(/ $/, "");
    f.runs = f.runs.filter((r) => r.text);
    f.style = dominant(f.runs);
  }
  return fragments.filter((f) => f.runs.length);
}

function canJoin(block, f) {
  if (f.listStart || f.bullet) return false;
  const last = block.lines[block.lines.length - 1];
  const size = Math.max(last.size, f.size);
  const dy = last.y - f.y;
  if (dy < size * 0.5 || dy > size * LINE_GAP_MAX) return false;
  if (block.lines.length > 1 && Math.abs(dy - block.gap) > size * 0.25) return false;
  if (Math.abs(last.size - f.size) > 0.6 || block.invisible !== Boolean(f.invisible)) return false;
  if (styleKey(last.runs[last.runs.length - 1].style) !== styleKey(f.runs[0].style)) return false;
  if (f.x >= block.right + size || f.xEnd <= block.left - size) return false;
  const tol = Math.max(3, size * 0.6);
  const sameLeft = Math.abs(f.x - block.left) <= tol;
  const indentedFirst = block.lines.length === 1 && f.x < last.x && last.x - f.x <= size * 3;
  const sameCenter = Math.abs((f.x + f.xEnd) / 2 - (last.x + last.xEnd) / 2) <= tol;
  const sameRight = Math.abs(f.xEnd - last.xEnd) <= 2;
  return sameLeft || indentedFirst || sameCenter || sameRight;
}

function alignmentOf(block, page) {
  const { lines, left, right } = block;
  if (lines.length === 1) {
    const [l] = lines;
    const mid = (l.x + l.xEnd) / 2;
    const center = page.view[0] + page.width / 2;
    if (Math.abs(mid - center) < page.width * 0.05 && l.x - page.view[0] > page.width * 0.16) return "center";
    if (l.x - page.view[0] > page.width * 0.5 && page.contentRight - l.xEnd < 4) return "right";
    return "left";
  }
  const range = (vals) => Math.max(...vals) - Math.min(...vals);
  const body = lines.slice(1);
  const lefts = body.map((l) => l.x);
  const nonLast = lines.slice(0, -1);
  if (range(lefts) <= 2 && nonLast.length >= 2 && nonLast.every((l) => right - l.xEnd <= 1.5)) return "justify";
  if (range(lines.map((l) => (l.x + l.xEnd) / 2)) <= 2 && range(lines.map((l) => l.x)) > 2) return "center";
  if (range(lines.map((l) => l.xEnd)) <= 1.5 && range(lines.map((l) => l.x)) > 2) return "right";
  return "left";
}

// Avsnittets tekst til oversettelse: myke linjeskift blir mellomrom, orddeling fjernes, korte linjer midt i
// (adresser, lister) beholdes som harde linjeskift. En kort fet/farget innledning («Fersk konto.») oversettes for seg.
function segmentsOf(block) {
  const runs = [];
  block.lines.forEach((line, i) => {
    if (i > 0) {
      const prev = block.lines[i - 1];
      const lastRun = runs[runs.length - 1];
      const short = block.align !== "center" && block.right - prev.xEnd > Math.max(block.size * 4, (block.right - block.left) * 0.2);
      if (short) lastRun.text += "\n";
      else if (/\p{L}-$/u.test(lastRun.text) && /^\p{Ll}/u.test(line.runs[0].text)) lastRun.text = lastRun.text.slice(0, -1);
      else lastRun.text += " ";
    }
    for (const r of line.runs) pushRun(runs, r.text, r.style);
  });
  const total = runs.reduce((n, r) => n + r.text.trim().length, 0);
  const [head, ...rest] = runs;
  const segments = [];
  if (rest.length && LEAD_IN_END.test(head.text.trim()) && head.text.trim().length < total / 2
      && rest.every((r) => fullKey(r.style) !== fullKey(head.style))) {
    segments.push({ text: head.text.trim(), style: head.style });
    segments.push({ text: rest.map((r) => r.text).join("").trim(), style: dominant(rest) });
  } else {
    segments.push({ text: runs.map((r) => r.text).join("").trim(), style: dominant(runs) });
  }
  return segments.filter((s) => s.text);
}

function layoutPage(page) {
  const inked = page.items.filter((it) => it.str.trim());
  page.contentRight = inked.reduce((m, it) => Math.max(m, it.x + it.w), page.view[0]);
  page.contentLeft = inked.reduce((m, it) => Math.min(m, it.x), page.view[2]);
  const blocks = [];
  const fragments = fragmentsOf(page.items);
  // Teksten rett etter et kulepunkt/nummer på samme linje starter et nytt listepunkt (og et nytt avsnitt).
  for (const b of fragments) {
    if (!BULLET.test(b.runs.map((r) => r.text).join("").trim())) continue;
    b.bullet = true;
    const next = fragments.find((f) => f !== b && Math.abs(f.y - b.y) <= b.size * 0.5 && f.x > b.x && f.x - b.xEnd <= b.size * 3);
    if (next) next.listStart = true;
  }
  // Kulepunkter tegnet som små figurer (vanlig fra nettlesere og Word) rett til venstre for linjen.
  for (const f of fragments) {
    if ((page.shapes || []).some((s) => s.cx < f.x - f.size * 0.2 && s.cx > f.x - f.size * 3 && s.cy > f.y - f.size * 0.1 && s.cy < f.y + f.size * 0.8)) {
      f.listStart = true;
    }
  }
  for (const f of fragments) {
    const open = blocks.filter((b) => canJoin(b, f));
    const target = open.sort((a, b) => a.lines[a.lines.length - 1].y - b.lines[b.lines.length - 1].y)[0];
    if (target) {
      if (target.lines.length === 1) target.gap = target.lines[0].y - f.y;
      target.lines.push(f);
      target.left = Math.min(target.left, f.x);
      target.right = Math.max(target.right, f.xEnd);
    } else {
      blocks.push({ lines: [f], left: f.x, right: f.xEnd, size: f.size, gap: f.size * 1.2, invisible: Boolean(f.invisible) });
    }
  }
  for (const b of blocks) {
    b.align = alignmentOf(b, page);
    b.top = b.lines[0].y + b.size * 0.8;
    b.bottom = b.lines[b.lines.length - 1].y - b.size * 0.25;
    b.segments = segmentsOf(b);
  }
  // Plass å vokse i: mot høyre til neste bit på samme linje (enkeltlinjer), og nedover til neste avsnitt.
  for (const b of blocks) {
    const overlapsX = (o) => o.left < b.right && o.right > b.left;
    const below = blocks.filter((o) => o !== b && o.top < b.bottom && overlapsX(o)).map((o) => o.top);
    b.freeBelow = Math.max(0, Math.min(b.bottom - page.view[1] - 24, ...below.map((top) => b.bottom - top - b.size * 0.2)));
    const band = blocks.filter((o) => o !== b && o.top > b.bottom && o.bottom < b.top);
    const pageRight = Math.max(page.contentRight, page.view[2] - (page.contentLeft - page.view[0]));
    b.maxRight = Math.min(pageRight, ...band.filter((o) => o.left >= b.right - 1).map((o) => o.left - b.size * 0.5));
    b.minLeft = Math.max(page.contentLeft, ...band.filter((o) => o.right <= b.left + 1).map((o) => o.right + b.size * 0.5));
  }
  // Rotert tekst: hver bit for seg, på samme sted og i samme vinkel.
  for (const it of page.items) {
    if (Math.abs(it.angle) < 0.01 || !it.str.trim()) continue;
    blocks.push({
      rotated: it.angle, x: it.x, y: it.y, w: it.w, size: it.size, invisible: Boolean(it.invisible),
      segments: [{ text: it.str.trim(), style: it.style }],
    });
  }
  return blocks;
}

// ---- Skriving (pdf-lib) ----

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function skipString(src, i) {
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === 0x5c) i++;
    else if (c === 0x28) depth++;
    else if (c === 0x29 && --depth === 0) return i + 1;
  }
  return src.length;
}

function skipInlineImage(src, i) {
  let j = i;
  while (j < src.length - 2 && !(src[j] === 0x49 && src[j + 1] === 0x44 && WS.has(src[j - 1]) && WS.has(src[j + 2]))) j++;
  for (j += 3; j < src.length - 1; j++) {
    if (src[j] === 0x45 && src[j + 1] === 0x49 && WS.has(src[j - 1]) && (j + 2 >= src.length || WS.has(src[j + 2]) || DELIM.has(src[j + 2]))) {
      return j + 2;
    }
  }
  return src.length;
}

// Fjerner alle tekstoperatorer (Tj, TJ, ', ") fra en innholdsstrøm; alt annet (grafikk, bilder, tilstand) står igjen.
// Returnerer også hvor mange q som står åpne til slutt, så tegningen vår ikke arver en endret koordinattransform.
function stripText(src) {
  const cuts = [];
  let i = 0;
  let depth = 0;
  let operands = -1;
  let open = 0;
  const operand = (pos) => {
    if (operands < 0) operands = pos;
  };
  while (i < src.length) {
    const c = src[i];
    if (WS.has(c)) {
      i++;
    } else if (c === 0x25) {
      while (i < src.length && src[i] !== 10 && src[i] !== 13) i++;
    } else if (c === 0x28) {
      operand(i);
      i = skipString(src, i);
    } else if (c === 0x3c) {
      operand(i);
      if (src[i + 1] === 0x3c) {
        depth++;
        i += 2;
      } else {
        while (i < src.length && src[i] !== 0x3e) i++;
        i++;
      }
    } else if (c === 0x3e) {
      if (src[i + 1] === 0x3e) i++;
      depth = Math.max(0, depth - 1);
      i++;
    } else if (c === 0x5b) {
      operand(i);
      depth++;
      i++;
    } else if (c === 0x5d) {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (c === 0x7b || c === 0x7d || c === 0x29) {
      i++;
    } else {
      const start = i;
      if (c === 0x2f) i++;
      while (i < src.length && !WS.has(src[i]) && !DELIM.has(src[i])) i++;
      if (c === 0x2f || depth > 0) {
        operand(start);
        continue;
      }
      const tok = String.fromCharCode(...src.subarray(start, Math.min(i, start + 8)));
      if (/^[+\-.\d]/.test(tok) || tok === "true" || tok === "false" || tok === "null") {
        operand(start);
        continue;
      }
      const from = operands < 0 ? start : operands;
      if (tok === "Tj" || tok === "TJ") cuts.push([from, i, ""]);
      else if (tok === "'" || tok === '"') cuts.push([from, i, "T*"]);
      else if (tok === "q") open++;
      else if (tok === "Q") open = Math.max(0, open - 1);
      else if (tok === "BI") i = skipInlineImage(src, i);
      operands = -1;
    }
  }
  const parts = [];
  let pos = 0;
  for (const [from, to, replacement] of cuts) {
    parts.push(src.subarray(pos, from), Buffer.from(replacement, "latin1"));
    pos = to;
  }
  parts.push(src.subarray(pos));
  return { bytes: Buffer.concat(parts.map((p) => Buffer.from(p))), open, removed: cuts.length };
}

function streamBytes(lib, stream) {
  if (stream instanceof lib.PDFRawStream) return lib.decodePDFRawStream(stream).decode();
  if (typeof stream.getUnencodedContents === "function") return stream.getUnencodedContents();
  throw new Error("Ukjent strømtype");
}

// Tekst i skjemaobjekter (Form XObjects, f.eks. topp- og bunntekst) fjernes også, ett nivå om gangen.
function stripForms(lib, context, resources, seen) {
  const xobjects = resources && resources.lookupMaybe(lib.PDFName.of("XObject"), lib.PDFDict);
  if (!xobjects) return;
  for (const [, ref] of xobjects.entries()) {
    if (!(ref instanceof lib.PDFRef) || seen.has(ref.toString())) continue;
    seen.add(ref.toString());
    const stream = context.lookup(ref);
    if (!stream || !stream.dict || stream.dict.lookup(lib.PDFName.of("Subtype")) !== lib.PDFName.of("Form")) continue;
    const { bytes, removed } = stripText(streamBytes(lib, stream));
    stripForms(lib, context, stream.dict.lookupMaybe(lib.PDFName.of("Resources"), lib.PDFDict), seen);
    if (!removed) continue;
    const fresh = context.flateStream(bytes);
    for (const [key, value] of stream.dict.entries()) {
      if (!["/Filter", "/DecodeParms", "/Length"].includes(key.toString())) fresh.dict.set(key, value);
    }
    context.assign(ref, fresh);
  }
}

function stripPage(lib, doc, page, seen) {
  const { context } = doc;
  const contents = page.node.Contents();
  const streams = contents instanceof lib.PDFArray
    ? contents.asArray().map((ref) => context.lookup(ref))
    : contents ? [contents] : [];
  const joined = Buffer.concat(streams.map((s) => Buffer.from(streamBytes(lib, s))).flatMap((b) => [b, Buffer.from("\n")]));
  const { bytes, open } = stripText(joined);
  const wrapped = Buffer.concat([Buffer.from("q\n"), bytes, Buffer.from(`\n${"Q\n".repeat(open + 1)}`)]);
  page.node.set(lib.PDFName.of("Contents"), context.register(context.flateStream(wrapped)));
  stripForms(lib, context, page.node.Resources(), seen);
}

function fontCache(lib, doc) {
  const fonts = new Map();
  return async (style) => {
    const name = FONT_NAMES[style.family][(style.bold ? 1 : 0) + (style.italic ? 2 : 0)];
    if (!fonts.has(name)) {
      const font = await doc.embedFont(lib.StandardFonts[name]);
      fonts.set(name, { font, chars: new Set(font.getCharacterSet()) });
    }
    return fonts.get(name);
  };
}

// Tegn standardskriften ikke har: god erstatning, ellers uten aksent, ellers «?».
function encodable(text, chars, missing) {
  let out = "";
  for (const ch of text) {
    if (chars.has(ch.codePointAt(0))) out += ch;
    else if (ch in REPLACE) out += REPLACE[ch];
    else {
      const base = ch.normalize("NFKD").replace(/\p{M}/gu, "");
      const ok = base && [...base].every((b) => chars.has(b.codePointAt(0)));
      out += ok ? base : "?";
      if (!ok) missing.add(ch);
    }
  }
  return out;
}

const colorOf = (lib, hex) => {
  const n = parseInt(String(hex || BLACK).slice(1), 16);
  return lib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

// Ord med stil; "\n" gir linjeskift. Mellom to deler (innledning + resten) er det alltid mellomrom.
function wordsOf(segments) {
  const words = [];
  segments.forEach((seg) => {
    String(seg.text).split(/(\n)/).forEach((part) => {
      if (part === "\n") words.push({ br: true });
      else for (const w of part.split(/[ \t ]+/)) if (w) words.push({ text: w, style: seg.style });
    });
  });
  return words;
}

function wrap(words, measure, width, indent) {
  const lines = [[]];
  let used = indent;
  for (const w of words) {
    const line = lines[lines.length - 1];
    if (w.br) {
      line.hard = true;
      lines.push([]);
      used = 0;
      continue;
    }
    const need = (line.length ? measure.space(w.style) : 0) + measure.word(w);
    if (line.length && used + need > width + 0.5) {
      lines.push([w]);
      used = measure.word(w);
    } else {
      line.push(w);
      used += need;
    }
  }
  return lines.filter((l, i) => l.length || l.hard || i === 0);
}

async function drawBlock(lib, page, block, getFont, cover, missing) {
  const words = wordsOf(block.segments);
  if (!words.some((w) => w.text)) return;
  const prepared = new Map();
  for (const w of words) {
    if (!w.text) continue;
    if (!prepared.has(w.style)) prepared.set(w.style, await getFont(w.style));
    const { font, chars } = prepared.get(w.style);
    w.font = font;
    w.clean = encodable(w.text, chars, missing);
  }
  // Sperret tekst: finn sperringen som gir originalens bredde med originalteksten, og bruk den samme på oversettelsen.
  let tracking = 0;
  if (block.lines && block.lines.length === 1 && block.segments.some((s) => s.style.tracked)) {
    const w = words.find((x) => x.text);
    const source = encodable(block.segments.map((s) => s.source).join(" "), prepared.get(w.style).chars, new Set());
    const natural = w.font.widthOfTextAtSize(source, w.style.size);
    tracking = Math.max(0, (block.right - block.left - natural) / Math.max(1, source.length - 1));
  }
  const measureAt = (scale) => ({
    word: (w) => w.font.widthOfTextAtSize(w.clean, w.style.size * scale) + tracking * scale * w.clean.length,
    space: (style) => prepared.get(style).font.widthOfTextAtSize(" ", style.size * scale) + tracking * scale,
  });

  if (block.rotated != null) {
    const w = words.find((x) => x.text);
    const text = words.filter((x) => x.text).map((x) => x.clean).join(" ");
    const natural = w.font.widthOfTextAtSize(text, w.style.size);
    const size = w.style.size * Math.max(0.6, Math.min(1, block.w > 0 ? block.w / natural : 1));
    page.drawText(text, { x: block.x, y: block.y, size, font: w.font, color: colorOf(lib, w.style.color), rotate: lib.radians(block.rotated) });
    return;
  }

  const first = block.lines[0];
  const indent = block.lines.length > 1 && first.x > block.left + 2 ? first.x - block.left : 0;
  const single = block.lines.length === 1;
  let left = block.left;
  let width = block.right - block.left;
  // En enkelt linje kan vokse inn i ledig plass på samme linje (mot høyre, venstre eller begge veier).
  if (single) {
    const growRight = Math.max(0, block.maxRight - block.right);
    const growLeft = Math.max(0, block.left - block.minLeft);
    if (block.align === "left") width += growRight;
    else if (block.align === "right") {
      left -= growLeft;
      width += growLeft;
    } else if (block.align === "center") {
      const grow = Math.min(growLeft, growRight);
      left -= grow;
      width += 2 * grow;
    }
  }

  let scale = SCALES[SCALES.length - 1];
  let lines;
  for (const s of SCALES) {
    lines = wrap(words, measureAt(s), width, indent);
    const allowed = block.lines.length + Math.floor(block.freeBelow / (block.gap * s));
    if (lines.length <= allowed) {
      scale = s;
      break;
    }
  }
  lines = wrap(words, measureAt(scale), width, indent);
  const measure = measureAt(scale);

  if (cover) {
    page.drawRectangle({
      x: block.left - 1, y: block.bottom - 1, width: block.right - block.left + 2, height: block.top - block.bottom + 2,
      color: lib.rgb(1, 1, 1),
    });
  }

  lines.forEach((line, k) => {
    if (!line.length) return;
    const y = first.y - k * block.gap * scale;
    const x0 = left + (k === 0 ? indent : 0);
    const avail = width - (k === 0 ? indent : 0);
    const natural = line.reduce((n, w, i) => n + measure.word(w) + (i ? measure.space(w.style) : 0), 0);
    const lastLine = k === lines.length - 1 || line.hard;
    let x = x0;
    let extra = 0;
    if (block.align === "center") x = x0 + (avail - natural) / 2;
    else if (block.align === "right") x = x0 + avail - natural;
    else if (block.align === "justify" && !lastLine && line.length > 1) extra = Math.max(0, (avail - natural) / (line.length - 1));
    // Ord med samme stil tegnes samlet (færre operatorer); med blokkjustering tegnes hvert ord for seg.
    let i = 0;
    while (i < line.length) {
      let j = i + 1;
      if (!extra) while (j < line.length && line[j].style === line[i].style) j++;
      const text = line.slice(i, j).map((w) => w.clean).join(" ");
      const { style, font } = line[i];
      if (tracking) page.pushOperators(lib.setCharacterSpacing(tracking * scale));
      page.drawText(text, { x, y, size: style.size * scale, font, color: colorOf(lib, style.color) });
      if (tracking) page.pushOperators(lib.setCharacterSpacing(0));
      x += font.widthOfTextAtSize(text, style.size * scale) + tracking * scale * text.length
        + (j < line.length ? measure.space(line[j].style) + extra : 0);
      i = j;
    }
  });
}

async function writePdf(buffer, pages, blocksPerPage, ctx) {
  const lib = require("pdf-lib");
  const warn = (code, message) => ctx.onWarning && ctx.onWarning({ code, message });
  let doc = null;
  try {
    doc = await lib.PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true });
    if (doc.isEncrypted || doc.getPageCount() !== pages.length) doc = null;
  } catch {
    doc = null;
  }
  const editable = Boolean(doc);
  if (!editable) {
    warn("pdf_rebuilt", "PDF-en er låst eller skadet og kunne ikke endres direkte. Oversettelsen er lagt i en ny PDF med samme sider og tekstplassering, men uten bilder og grafikk.");
    doc = await lib.PDFDocument.create();
    for (const p of pages) {
      const page = doc.addPage([p.width, p.height]);
      page.setMediaBox(p.view[0], p.view[1], p.width, p.height);
    }
  }
  const getFont = fontCache(lib, doc);
  const missing = new Set();
  const seen = new Set();
  for (let n = 0; n < pages.length; n++) {
    const page = doc.getPage(n);
    let cover = false;
    if (editable && blocksPerPage[n].length) {
      try {
        stripPage(lib, doc, page, seen);
      } catch (err) {
        cover = true;
        warn("pdf_cover", `Side ${n + 1}: den opprinnelige teksten kunne ikke fjernes (${err.message}); oversettelsen er lagt over med hvit bakgrunn.`);
      }
    }
    for (const block of blocksPerPage[n]) await drawBlock(lib, page, block, getFont, cover || block.invisible, missing);
  }
  if (missing.size) {
    warn("pdf_glyphs", `Noen tegn finnes ikke i standardskriften og ble erstattet med «?»: ${[...missing].slice(0, 20).join(" ")}`);
  }
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

// ---- Oversettelse ----

async function translatePdf(buffer, ctx) {
  const pages = await extractPages(buffer);
  const blocksPerPage = pages.map(layoutPage);
  const segments = blocksPerPage.flat().flatMap((b) => b.segments);
  for (const s of segments) s.source = s.text;
  const toTranslate = segments.filter((s) => LETTER.test(s.text) && !BULLET.test(s.text));
  if (!toTranslate.length) throw new Error(NO_TEXT);

  const translated = await translateStrings({ ...ctx, strings: toTranslate.map((s) => s.text) });
  if (ctx.collect) return Buffer.alloc(0);
  toTranslate.forEach((s, i) => {
    if (translated[i] != null && String(translated[i]).trim()) s.text = String(translated[i]);
  });
  return writePdf(buffer, pages, blocksPerPage, ctx);
}

module.exports = { translatePdf, extractPages, layoutPage, stripText };
