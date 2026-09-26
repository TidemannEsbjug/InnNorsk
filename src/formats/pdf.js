// PDF inn → PDF ut med samme oppsett. pdf.js (unpdf) leser hver tekstbit med posisjon, skrift, størrelse, farge og
// tegnerekkefølge, og grafikken (streker, bokser, bilder) som teksten ikke skal vokse inn i. Bitene settes sammen til
// linjer, kolonner/celler og avsnitt. pdf-lib fjerner så den opprinnelige teksten fra sidene (grafikken blir stående) og
// skriver oversettelsen på samme sted og i samme stil, med standardskriften som ligner mest (Helvetica, Times eller
// Courier; fet, kursiv, farge og understreking også for enkeltord). Tekst som ikke endres (tall, kulepunkter, navn)
// beholder de opprinnelige tegnene. Blir teksten lengre, brytes den innenfor avsnittets bredde, og avsnitt i samme
// spalte krympes likt om nødvendig. Låste (krypterte) eller ødelagte PDF-er kan ikke endres; da lages en ny PDF med
// samme sider og teksten på samme sted.
const { translateStrings } = require("../grok");

const SPACE_GAP = 0.2; // hull (andel av skriftstørrelsen) som betyr mellomrom mellom tekstbiter
const COLUMN_GAP = 1.25; // større hull enn dette deler linjen i kolonner/celler (unntatt blokkjusterte linjer)
const LINE_GAP_MAX = 1.75; // største linjeavstand (× skriftstørrelse) innenfor ett avsnitt
const SCALES = [1, 0.95, 0.9, 0.85, 0.8, 0.75];
const LAST_RESORT = [0.7, 0.65, 0.6];
const LEAD_IN_END = /[.:!?–—-]$/;
// Kulepunkt, avkrysningsboks eller nummerering foran et listepunkt (også Words Symbol/Wingdings-tegn i U+F0xx).
const MARKER = /^([•◦▪▫‣⁃●○■□►▸▹▶▷◆◇❖➢➤➔→✓✔✗✘☐☑☒❏❑–—\-*·§o\uf020-\uf0ff]|\(?\d{1,3}(\.\d{1,3})*[.)]|\(?[a-zA-Z][.)]|\(?(i{1,3}|iv|vi{0,3}|ix|x)[.)])$/;
// Linje som selv begynner med kulepunkt/nummer i samme tekstbit som teksten.
const LIST_PREFIX = /^(\(?\d{1,3}[.)]\s+\p{Lu}|[•◦▪‣●○■□►▸▶◆❖➢➤➔→✓✔✗✘☐☑☒]\s)/u;
const LETTER = /\p{L}/u;
const BLACK = "#000000";
const NO_TEXT = "Fant ingen tekst i PDF-en (kan være skannet uten OCR).";
const LOCKED = "PDF-en er passordbeskyttet. Fjern passordet og last opp på nytt.";
const FROZEN_ONLY = "Teksten i PDF-en står i skjemaobjekter som også tegnes i et skjult lag (valgfritt innhold), og kan ikke oversettes uten å endre laget.";
const TAG = /⟦(\/?)(\d+)⟧/g;
const MAX_TAGS = 6;
const EURO_PAD = 120;

const FONT_NAMES = {
  sans: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
  serif: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
  mono: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"],
};
const SERIF = /serif|times|georgia|garamond|cambria|minion|palatino|baskerville|caslon|merriweather|lora|charter|bookman|century|didot|bodoni|constantia|fraunces|playfair|crimson|tinos|antiqua|mincho|song/i;
const MONO = /mono|courier|consol|menlo|typewriter|code/i;
const BOLD = /bold|black|heavy|semibold|demi|extrabold|ultrabold/i;
const ITALIC = /italic|oblique/i;
// Tegn som standardskriftene (WinAnsi) mangler, men som har en god erstatning (også Words kulepunkter i U+F0xx).
const REPLACE = {
  "−": "-", "‐": "-", "‑": "-", "\u2007": " ", "\u2009": " ", "\u200a": " ", "\u202f": "\u00a0", "\u200b": "", "\u00ad": "",
  "\ufeff": "", "\u200d": "", "\ufe0f": "", "\t": " ", "\uf0b7": "•", "\uf0a7": "▪", "\uf0a8": "•", "\uf076": "❖", "\uf0d8": "➤",
  "\uf0fc": "✓", "\uf0e0": "→", "\uf06e": "■", "\uf06f": "☐", "\uf0fe": "☑", "◦": "o", "○": "o", "▫": "▪", "‣": "•", "⁃": "-",
};
// Avkrysningsbokser og små firkanter som ingen standardskrift har: tegnes som grafikk.
const VECTOR = new Set(["☐", "☑", "☒", "□", "▪"]);
// Kyrillisk som ikke er oversatt, skrives med latinske bokstaver i stedet for «?».
const CYRILLIC = Object.fromEntries(
  "а a б b в v г g д d е e ё jo ж sj з z и i й j к k л l м m н n о o п p р r с s т t у u ф f х kh ц ts ч tsj ш sj щ sjtsj ъ - ы y ь - э e ю ju я ja і i ї ji є je ґ g"
    .split(" ").reduce((pairs, v, i, all) => (i % 2 ? pairs : [...pairs, [all[i], all[i + 1] === "-" ? "" : all[i + 1]]]), [])
    .flatMap(([c, l]) => [[c, l], [c.toUpperCase(), l.charAt(0).toUpperCase() + l.slice(1)]])
);

// NFKC endrer ikke ren ASCII; den vanligste teksten slipper da normaliseringen (den kalles for hvert tegn).
const norm = (s) => {
  const str = String(s);
  for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) > 0x7f) return str.normalize("NFKC");
  return str;
};
const isSpace = (ch) => {
  const c = ch.charCodeAt(0);
  return c < 0x80 ? c === 32 || (c >= 9 && c <= 13) : /\s/.test(ch);
};

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
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// Minste/største verdi i en liste (valgfritt av f(v)), uten å spre lista som argumenter: Math.min(...liste) kaster
// RangeError når lista har mer enn rundt 100 000 elementer.
function minOf(list, f, start = Infinity) {
  let m = start;
  for (let k = 0; k < list.length; k++) {
    const v = f ? f(list[k]) : list[k];
    if (v < m) m = v;
  }
  return m;
}
function maxOf(list, f, start = -Infinity) {
  let m = start;
  for (let k = 0; k < list.length; k++) {
    const v = f ? f(list[k]) : list[k];
    if (v > m) m = v;
  }
  return m;
}

function boxOf(m, x0, y0, x1, y1) {
  // De fire hjørnene (samme regning som apply), uten mellomliggende lister.
  const ax = m[0] * x0 + m[2] * y0 + m[4];
  const ay = m[1] * x0 + m[3] * y0 + m[5];
  const bx = m[0] * x1 + m[2] * y0 + m[4];
  const by = m[1] * x1 + m[3] * y0 + m[5];
  const cx = m[0] * x0 + m[2] * y1 + m[4];
  const cy = m[1] * x0 + m[3] * y1 + m[5];
  const dx = m[0] * x1 + m[2] * y1 + m[4];
  const dy = m[1] * x1 + m[3] * y1 + m[5];
  return { x0: Math.min(ax, bx, cx, dx), y0: Math.min(ay, by, cy, dy), x1: Math.max(ax, bx, cx, dx), y1: Math.max(ay, by, cy, dy) };
}

// Rammen rundt hver delsti (pdf.js 6: [op, koordinater …]; 0 moveTo, 1 lineTo, 2 curveTo, 3 quadraticCurveTo, 4 closePath).
// `rect` på rammen: delstien er et rektangel med vannrette og loddrette sider (da er rammen nøyaktig det som males).
// Punktene til delstien som sjekkes, ligger i én gjenbrukt buffer (mange tusen flater per side ellers gir mye søppel).
const PTS = new Float64Array(12);
function subpaths(data) {
  const out = [];
  let cur = null;
  let np = 0;
  let curved = false;
  const close = () => {
    if (!cur) return;
    const n = np / 2;
    let rect = !curved && (n === 4 || n === 5);
    if (rect && n === 5) rect = Math.abs(PTS[8] - PTS[0]) < 1e-3 && Math.abs(PTS[9] - PTS[1]) < 1e-3;
    for (let k = 0; rect && k < 4; k++) {
      const x = PTS[2 * k];
      const y = PTS[2 * k + 1];
      const nx = PTS[(2 * k + 2) % 8];
      const ny = PTS[(2 * k + 3) % 8];
      const onEdge = (Math.abs(x - cur.x0) < 1e-3 || Math.abs(x - cur.x1) < 1e-3) && (Math.abs(y - cur.y0) < 1e-3 || Math.abs(y - cur.y1) < 1e-3);
      rect = onEdge && (Math.abs(x - nx) < 1e-3) !== (Math.abs(y - ny) < 1e-3);
    }
    cur.rect = rect;
  };
  for (let i = 0; i < data.length;) {
    const op = data[i++];
    const n = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 3 ? 4 : 0;
    if (op === 0 || !cur) {
      close();
      out.push((cur = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, rect: false }));
      np = 0;
      curved = false;
    }
    if (op === 2 || op === 3) curved = true;
    for (let k = 0; k + 1 < n; k += 2) {
      const x = data[i + k];
      const y = data[i + k + 1];
      if (x < cur.x0) cur.x0 = x;
      if (y < cur.y0) cur.y0 = y;
      if (x > cur.x1) cur.x1 = x;
      if (y > cur.y1) cur.y1 = y;
      if (op <= 1 && np < 12) {
        PTS[np++] = x;
        PTS[np++] = y;
      }
    }
    i += n;
  }
  close();
  return out.filter((b) => b.x0 <= b.x1);
}

// Står aksene i matrisen vannrett/loddrett (ingen skråstilling eller dreining utenom 90°)?
const axial = (m) => (Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9) || (Math.abs(m[0]) < 1e-9 && Math.abs(m[3]) < 1e-9);

// Klippet område: `rect` er en ramme som alt synlig ligger innenfor (null = hele siden); `odd` betyr at klippet ikke er
// et rett rektangel (runde hjørner, sirkel, skjemaobjekt dreid), så rammen er bare en øvre grense.
function clipWith(clip, box, exact) {
  const rect = clip.rect
    ? { x0: Math.max(clip.rect.x0, box.x0), y0: Math.max(clip.rect.y0, box.y0), x1: Math.min(clip.rect.x1, box.x1), y1: Math.min(clip.rect.y1, box.y1) }
    : { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 };
  return { rect, odd: clip.odd || !exact };
}

// Én gjennomgang av sidens tegneoperasjoner: farge, gjennomsiktighet, om teksten er usynlig (OCR-lag) og hvilken
// tekstoperator hvert synlig tegn kom fra; grafikk (streker, bokser, bilder) med posisjon og rekkefølge; og små figurer
// (tegnede kulepunkter). Tekst og grafikk i skjemaobjekter og merknader telles ikke med i sidens egen strøm.
// For hver tekstoperator regnes også hvor langt den flytter tekstposisjonen (som et TJ-tall), så en fjernet operator
// kan erstattes av en like lang forflytning og uendret tekst etter den blir stående på samme sted.
// Valgfritt innhold (lag, /OC): `ocState(gruppe)` gir false (laget er av og tegnes ikke), true (på) eller null (ukjent).
// Det som tegnes i et lag som er av, er ikke grafikk på siden (verken dekke eller hindring), og tegn i det får `hidden`.
// Tegnes noe i et lag med ukjent tilstand, får det `oc` og regnes aldri som et dekke over tekst.
function scanOps({ fnArray, argsArray }, OPS, fontOf = () => null, ocState = () => null) {
  const glyphs = [];
  const shapes = [];
  const graphics = [];
  const advances = [];
  const stack = [];
  // Alle bilder sidens operatorer viser (også de som er klippet bort eller ligger i et skjult lag): pdf.js dekoder dem.
  const imageIds = new Set();
  // Merket innhold (BMC/BDC … EMC): tilstanden til hvert nivå (false/true/null for /OC, undefined ellers).
  const marked = [];
  let ocHidden = 0;
  let ocUnknown = 0;
  // Skjemaobjektene i tegnerekkefølge (samme rekkefølge som «Do» i innholdsstrømmene, dybde først): om noe av teksten
  // i dem ligger i et skjult lag. `drawing`: skjemaobjektene som tegnes nå (innerst sist), med dybden av merket innhold
  // da det startet, så et BDC som ikke lukkes inne i skjemaobjektet, ikke gjelder resten av siden.
  const formDraws = [];
  const drawing = [];
  const popMarked = () => {
    const s = marked.pop();
    if (s === false) ocHidden--;
    else if (s === null) ocUnknown--;
  };
  // soft: myk maske (/SMask) eller en annen blandemodus enn Normal: det som tegnes, dekker ikke det som ligger under.
  // pattern: fyll med mønster eller fargeovergang (kan ha gjennomsiktige partier). clip: klippet område (se clipWith).
  let state = {
    color: BLACK, alpha: 1, soft: false, mode: 0, lw: 1, ctm: [1, 0, 0, 1, 0, 0], fs: 0, fm: 0.001, vertical: false, tc: 0, tw: 0, th: 1,
    smask: false, blend: false, pattern: false, clip: { rect: null, odd: false },
  };
  let forms = 0;
  let annots = 0;
  let shows = 0;
  let paths = 0;
  let pendingClip = false;
  // Mellomrom kan stå i en egen tekstoperator (Chrome tegner ofte ett tegn per operator); det gjelder neste tegn.
  let space = false;
  let nbsp = "";
  // Tekstposisjonen langs linjen (i tekstrommet, før Tm), så hullet foran et tegn kan måles også når tegnet står i en
  // egen operator (flyttet med Td, eller etter et TJ-tall sist i forrige operator). lastEnd null: ny linje / ukjent.
  let lineX = 0;
  let tx = 0;
  let lastEnd = null;
  const newLine = () => {
    lineX = 0;
    tx = 0;
    lastEnd = null;
  };
  const show = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
  const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const strokes = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const images = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintSolidColorImageMask]);
  const fillColors = new Set([OPS.setFillGray, OPS.setFillCMYKColor, OPS.setFillColor, OPS.setFillColorSpace]);
  // Den synlige delen av en ramme (innenfor klippet), eller null når alt er klippet bort.
  const visible = (b) => {
    const r = state.clip.rect;
    if (!r) return b;
    const c = { x0: Math.max(b.x0, r.x0), y0: Math.max(b.y0, r.y0), x1: Math.min(b.x1, r.x1), y1: Math.min(b.y1, r.y1) };
    return c.x1 < c.x0 || c.y1 < c.y0 ? null : c;
  };
  for (let k = 0; k < fnArray.length; k++) {
    const fn = fnArray[k];
    const args = argsArray[k];
    if (fn === OPS.beginAnnotation) annots++;
    else if (fn === OPS.endAnnotation) annots = Math.max(0, annots - 1);
    if (annots) continue;
    if (fn === OPS.beginMarkedContent || fn === OPS.beginMarkedContentProps) {
      let s;
      if (fn === OPS.beginMarkedContentProps && args && args[0] === "OC") {
        s = null;
        try {
          s = ocState(args[1]);
        } catch {
          s = null;
        }
        if (s === false) ocHidden++;
        else if (s !== true) ocUnknown++;
      }
      marked.push(s);
      continue;
    }
    if (fn === OPS.endMarkedContent) {
      // Et EMC inne i et skjemaobjekt lukker ikke merket innhold som ble åpnet utenfor det.
      if (marked.length > (drawing.length ? drawing[drawing.length - 1].depth : 0)) popMarked();
      continue;
    }
    if (fn === OPS.save) stack.push({ ...state });
    else if (fn === OPS.restore) state = stack.pop() || state;
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ...state });
      forms++;
      drawing.push({ index: formDraws.length, depth: marked.length });
      formDraws.push({ hidden: false });
      if (Array.isArray(args[0]) || ArrayBuffer.isView(args[0])) state.ctm = multiply(Array.from(args[0]), state.ctm);
      // Et skjemaobjekt klippes til sin /BBox.
      const bbox = args[1];
      if ((Array.isArray(bbox) || ArrayBuffer.isView(bbox)) && bbox.length === 4) {
        state.clip = clipWith(state.clip, boxOf(state.ctm, bbox[0], bbox[1], bbox[2], bbox[3]), axial(state.ctm));
      }
    } else if (fn === OPS.paintFormXObjectEnd) {
      state = stack.pop() || state;
      forms = Math.max(0, forms - 1);
      const d = drawing.pop();
      if (d) while (marked.length > d.depth) popMarked();
    } else if (fn === OPS.transform) state.ctm = multiply(args, state.ctm);
    else if (fn === OPS.setGState) {
      for (const [key, value] of args[0] || []) {
        if (key === "ca" && typeof value === "number") state.alpha = value;
        else if (key === "SMask") state.smask = Boolean(value);
        else if (key === "BM") state.blend = Boolean(value) && value !== "source-over" && value !== "normal";
      }
      state.soft = state.smask || state.blend;
    } else if (fn === OPS.setFillRGBColor) {
      state.color = hexOf(args) || state.color;
      state.pattern = false;
    } else if (fn === OPS.setFillColorN) {
      // Mønster (TilingPattern) eller fargeovergang (Shading) i stedet for en fast farge.
      state.pattern = !Array.isArray(args) || typeof args[0] === "string";
    } else if (fn === OPS.setFillTransparent) state.pattern = true;
    else if (fillColors.has(fn)) state.pattern = false;
    else if (fn === OPS.clip || fn === OPS.eoClip) pendingClip = true;
    else if (fn === OPS.setLineWidth) state.lw = args[0];
    else if (fn === OPS.setTextRenderingMode) state.mode = args[0];
    else if (fn === OPS.setFont) {
      const font = fontOf(args[0]);
      state.fs = typeof args[1] === "number" ? args[1] : 0;
      state.fm = font && font.fontMatrix && typeof font.fontMatrix[0] === "number" ? font.fontMatrix[0] : 0.001;
      state.vertical = Boolean(font && font.vertical);
    } else if (fn === OPS.setCharSpacing) state.tc = Number(args[0]) || 0;
    else if (fn === OPS.setWordSpacing) state.tw = Number(args[0]) || 0;
    else if (fn === OPS.setHScale) state.th = (Number(args[0]) || 100) / 100;
    else if (fn === OPS.beginText || fn === OPS.setTextMatrix || fn === OPS.nextLine) newLine();
    else if (fn === OPS.moveText || fn === OPS.setLeadingMoveText) {
      if (Math.abs(Number(args[1]) || 0) > 1e-6 || !Number.isFinite(Number(args[0]))) newLine();
      else {
        lineX += Number(args[0]);
        tx = lineX;
      }
    } else if (fn === OPS.constructPath) {
      const pop = forms ? -1 : paths++;
      const paint = args ? args[0] : undefined;
      const data = args ? args[1] : undefined;
      const minMax = args ? args[2] : undefined;
      // Noe som tegnes i et lag som er av, synes ikke (klippet gjelder likevel).
      const fill = !ocHidden && fills.has(paint);
      const stroke = !ocHidden && strokes.has(paint);
      const path = Array.isArray(data) ? data[0] : null;
      const boxes = path && (ArrayBuffer.isView(path) || Array.isArray(path)) ? subpaths(path)
        : minMax ? [{ x0: minMax[0], y0: minMax[1], x1: minMax[2], y1: minMax[3], rect: false }] : [];
      const lw = stroke ? Math.max(0.1, state.lw || 0) * Math.hypot(state.ctm[0], state.ctm[1]) : 0;
      const straight = axial(state.ctm);
      for (let n = 0; (fill || stroke) && n < boxes.length; n++) {
        const box = boxes[n];
        const b = boxOf(state.ctm, box.x0, box.y0, box.x1, box.y1);
        b.x0 -= lw / 2;
        b.y0 -= lw / 2;
        b.x1 += lw / 2;
        b.y1 += lw / 2;
        // Bare den synlige delen (innenfor klippet).
        const r = state.clip.rect;
        if (r) {
          if (r.x0 > b.x0) b.x0 = r.x0;
          if (r.y0 > b.y0) b.y0 = r.y0;
          if (r.x1 < b.x1) b.x1 = r.x1;
          if (r.y1 < b.y1) b.y1 = r.y1;
          if (b.x1 < b.x0 || b.y1 < b.y0) continue;
        }
        const w = b.x1 - b.x0;
        const h = b.y1 - b.y0;
        if (w >= 1.2 && h >= 1.2 && w <= 12 && h <= 12 && w / h > 0.5 && w / h < 2) {
          shapes.push({ cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, r: Math.min(w, h) / 2, color: state.color });
        }
        // rect: et rett rektangel (sidene vannrett/loddrett), så rammen er nøyaktig flaten som males. odd: klippet er
        // ikke et rett rektangel, så rammen er bare en øvre grense for det som synes.
        graphics.push({
          x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, fill, stroke, op: k, pop, parts: boxes.length, color: state.color, alpha: state.alpha,
          soft: state.soft, rect: box.rect && straight, pattern: state.pattern, odd: state.clip.odd, oc: ocUnknown > 0,
        });
      }
      // «W n»: klippet gjelder fra og med neste tegning. Bare et rett rektangel er et nøyaktig klipp.
      if (pendingClip) {
        pendingClip = false;
        if (!boxes.length) state.clip = { rect: state.clip.rect, odd: true };
        else {
          const union = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
          for (const box of boxes) {
            const b = boxOf(state.ctm, box.x0, box.y0, box.x1, box.y1);
            if (b.x0 < union.x0) union.x0 = b.x0;
            if (b.y0 < union.y0) union.y0 = b.y0;
            if (b.x1 > union.x1) union.x1 = b.x1;
            if (b.y1 > union.y1) union.y1 = b.y1;
          }
          state.clip = clipWith(state.clip, union, boxes.length === 1 && boxes[0].rect && straight);
        }
      }
    } else if (images.has(fn)) {
      // Maskebilder (stempel i én farge) og bilder med gjennomsiktighet dekker ikke det som ligger under.
      // Et beskåret bilde (klippet, f.eks. overflow:hidden i en nettleser) synes bare innenfor klippet; frame er hele
      // bildets ramme (brukes for å finne pikselen i et punkt).
      if (args && typeof args[0] === "string") imageIds.add(args[0]);
      if (ocHidden) continue;
      const m = state.ctm;
      const frame = boxOf(m, 0, 0, 1, 1);
      const b = visible(frame);
      if (!b) continue;
      const inline = fn === OPS.paintInlineImageXObject && args[0] && typeof args[0] === "object" ? args[0] : undefined;
      graphics.push({
        ...b, frame, image: true, op: k, pop: -1, id: typeof args[0] === "string" ? args[0] : null,
        mask: fn === OPS.paintImageMaskXObject || fn === OPS.paintSolidColorImageMask, alpha: state.alpha, soft: state.soft,
        flipX: m[0] < 0, flipY: m[3] < 0, skew: Math.abs(m[1]) + Math.abs(m[2]) > 1e-6 * (Math.abs(m[0]) + Math.abs(m[3])), data: inline,
        odd: state.clip.odd, oc: ocUnknown > 0,
      });
    } else if (show.has(fn)) {
      const sop = forms ? -1 : shows++;
      const invisible = state.mode === 3 || state.mode === 7 || state.alpha === 0;
      const list = (args || []).find(Array.isArray) || [];
      if (fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) newLine();
      // Forflytningen i tekstrommet (PDF: (w0·Tfs + Tc + Tw)·Th per tegn, −n/1000·Tfs per TJ-tall), uttrykt som TJ-tall.
      let adv = 0;
      let spacing = 0;
      // gap: hullet foran tegnet siden forrige tegn på samme linje, som andel av skriftstørrelsen (null = ukjent), fra
      // TJ-tall eller en flytting mellom to operatorer. I TeX er ordmellomrom slike hull, ikke mellomromstegn.
      const known = state.fs > 0 && !state.vertical;
      const hidden = ocHidden > 0;
      for (const g of list) {
        if (typeof g === "number") {
          adv += g;
          tx -= (g / 1000) * state.fs * state.th;
          continue;
        }
        if (!g || typeof g !== "object") continue;
        adv -= (g.width || 0) * state.fm * 1000;
        spacing += state.tc + (g.isSpace ? state.tw : 0);
        const start = tx;
        tx += ((g.width || 0) * state.fm * state.fs + state.tc + (g.isSpace ? state.tw : 0)) * state.th;
        const gap = known && lastEnd != null ? (start - lastEnd) / state.fs : null;
        lastEnd = known ? tx : null;
        if (!g.unicode) continue;
        if (g.unicode === "\u00a0" || g.unicode === "\u202f") {
          nbsp = g.unicode;
          continue;
        }
        let first = true;
        for (const ch of norm(g.unicode)) {
          if (isSpace(ch)) space = true;
          else {
            const form = drawing.length ? drawing[drawing.length - 1].index : -1;
            if (hidden && form >= 0) formDraws[form].hidden = true;
            glyphs.push({ ch, color: state.color, alpha: state.alpha, invisible, op: k, sop, space, nbsp, gap: first ? gap : 0, hidden, form });
            first = false;
            space = false;
            nbsp = "";
          }
        }
      }
      if (sop >= 0) advances[sop] = state.fs && !state.vertical ? adv - (spacing * 1000) / state.fs : NaN;
    }
  }
  if (graphics.length > 4000) {
    let n = 0;
    for (const g of graphics) if (n < 4000 && (g.x1 - g.x0 >= 3 || g.y1 - g.y0 >= 3)) graphics[n++] = g;
    graphics.length = n;
  }
  return {
    glyphs, shapes, graphics, shows, paths, advances: Float64Array.from(advances, (v) => (v === undefined ? NaN : v)), imageIds: [...imageIds],
    formDraws,
  };
}

// Tekstbitene og tegnene kommer i samme rekkefølge; hver bit får stilen til sitt første tegn og vet hvilke tegn (og
// dermed tekstoperatorer) den består av. Returnerer om koblingen er nøyaktig for hele siden.
function assignStyles(items, glyphs) {
  let cursor = 0;
  let last = null;
  let exact = true;
  for (const it of items) {
    const chars = [...norm(it.str)].filter((ch) => !isSpace(ch));
    it.glyphs = null;
    if (chars.length) {
      let found = -1;
      const end = Math.min(glyphs.length, cursor + 200);
      for (let k = cursor; k < end; k++) {
        if (glyphs[k].ch === chars[0]) {
          found = k;
          break;
        }
      }
      if (found < 0) exact = false;
      else {
        const run = glyphs.slice(found, found + chars.length);
        if (found !== cursor || run.length !== chars.length || run.some((g, i) => g.ch !== chars[i])) exact = false;
        else {
          it.glyphs = run;
          it.gi = found;
        }
        last = glyphs[found];
        cursor = found + chars.length;
      }
    }
    const g = last || { color: BLACK, alpha: 1, invisible: false, op: 0 };
    const end = it.glyphs ? it.glyphs[it.glyphs.length - 1] : g;
    Object.assign(it, { color: g.color, alpha: g.alpha, invisible: g.invisible, op: g.op, opEnd: end.op });
  }
  return exact && cursor === glyphs.length;
}

// Tekstbiter uten sikker kobling (høyre-til-venstre-tekst som pdf.js snur, tekst utenfor siden som pdf.js utelater, og
// bitene rett etter): tegnene deres står blant tegnene mellom de nærmeste koblede bitene (hullet). it.loose sier hvor
// biten kan komme fra: fra sidens egen strøm (page: sidens synlige tegn i hullet kan stave den; ops: tekstoperatorene
// i hullet) og/eller fra skjemaobjekter (forms: tegningene der synlige tegn i hullet kan stave den). Se freezeForms.
// (pdf.js leser teksten i samme rekkefølge som operatorene, så tegnene til en bit står aldri utenfor hullet sitt.)
function looseSources(items, glyphs) {
  let from = 0;
  let pending = [];
  const settle = (to) => {
    if (!pending.length) return;
    const page = new Map();
    const forms = new Map();
    const hidden = new Map();
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = from; k < to; k++) {
      const g = glyphs[k];
      let m = page;
      if (g.hidden) m = hidden;
      else if (g.form >= 0) {
        if (!forms.has(g.form)) forms.set(g.form, new Map());
        m = forms.get(g.form);
      } else if (g.sop >= 0) {
        lo = Math.min(lo, g.sop);
        hi = Math.max(hi, g.sop);
      } else continue;
      m.set(g.ch, (m.get(g.ch) || 0) + 1);
    }
    for (const it of pending) {
      const need = new Map();
      for (const ch of norm(it.str)) if (!isSpace(ch)) need.set(ch, (need.get(ch) || 0) + 1);
      const fits = (m) => [...need].every(([ch, n]) => (m.get(ch) || 0) >= n);
      const inPage = page.size > 0 && fits(page);
      const inForms = [...forms].filter(([, m]) => fits(m)).map(([f]) => f);
      // Kan bare tegn i et skjult lag stave biten, er den skjult (se extractPages). Kan ingenting i hullet stave den, er
      // kilden ukjent: da regnes alle skjemaobjektene med synlige tegn der.
      const unknown = !inPage && !inForms.length;
      it.loose = { page: inPage, ops: lo <= hi ? [lo, hi] : null, forms: unknown ? [...forms.keys()] : inForms, unknown, hidden: unknown && fits(hidden) };
    }
    pending = [];
  };
  for (const it of items) {
    if (it.glyphs) {
      settle(it.gi);
      from = it.gi + it.glyphs.length;
    } else if (it.str.trim()) pending.push(it);
  }
  settle(glyphs.length);
}

// pdf.js setter inn mellomrom der tegnene står langt fra hverandre. Er nesten alle mellomrommene slike (sperret tekst:
// «S E R I E S A»), bygges teksten fra tegnene i stedet, med bare de ekte mellomrommene («SERIES A»). Hårde mellomrom
// (U+00A0/U+202F) i kilden tas også vare på, så «Mr. Smith» og «2 timer» ikke deles over to linjer.
function respace(it) {
  const g = it.glyphs;
  if (!g) {
    const tracked = /^\S( \S){2,}$/u.test(it.str);
    return { str: tracked ? it.str.replace(/ /g, "") : it.str, tracked };
  }
  const spaces = (norm(it.str).trim().match(/\s/g) || []).length;
  const real = g.filter((x, i) => i && x.space).length;
  // Sperret: pdf.js har satt inn mellomrom mellom (nesten) alle tegnparene som ikke har et ekte mellomrom. Ett
  // innsatt mellomrom i «I am» (TeX uten mellomromstegn) er et vanlig ordmellomrom.
  // Et par kan mangle mellomrommet der skriften kerner («O N LY»): da holder halvparten når alle bitene er på ett-to
  // tegn og uten små bokstaver (sperret tekst er versaler; «I am a» er vanlige ord).
  const pairs = g.length - 1 - real;
  const bits = norm(it.str).trim().split(/\s+/);
  const short = bits.length >= 3 && bits.every((b) => [...b].length <= 2) && !/\p{Ll}/u.test(it.str);
  if (g.length >= 2 && pairs >= 1 && spaces - real >= Math.max(1, pairs * (short ? 0.5 : 0.8))) {
    return { str: g.map((x, i) => (i && (x.space || x.nbsp) ? x.nbsp || " " : "") + x.ch).join(""), tracked: true };
  }
  if (!g.some((x) => x.nbsp)) return { str: it.str, tracked: false };
  let out = "";
  let gap = "";
  let k = 0;
  for (const ch of it.str) {
    if (isSpace(ch)) gap += ch;
    else {
      out += gap && g[k] && g[k].nbsp ? g[k].nbsp : gap;
      out += ch;
      gap = "";
      k += [...norm(ch)].filter((c) => !isSpace(c)).length;
    }
  }
  return { str: out + gap, tracked: false };
}

// Venter (høyst `ms`) til pdf.js har levert sidens egne bilder, så page.cleanup() kan frigjøre dem (med `shared` også
// bildene i fellesbufferen, så ingen kommer etter at den er tømt).
async function settleImages(page, imageIds, ms = 3000, shared = false) {
  const ids = imageIds.filter((id) => shared || !id.startsWith("g_"));
  if (!ids.length) return;
  let timer = null;
  try {
    await Promise.race([
      Promise.all(ids.map((id) => new Promise((resolve) => {
        try {
          (id.startsWith("g_") ? page.commonObjs : page.objs).get(id, resolve);
        } catch {
          resolve(null);
        }
      }))),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Bilder brukt på flere sider (pdf.js: g_-id i commonObjs) blir liggende dekodet i hovedtråden, og pdf.js-arbeideren
// sender dem ikke igjen når de brukes på nytt (den husker bare id-en). Etter hver side slippes bilder til de som er
// igjen, tar høyst `limit` (SHARED_IMAGES) til sammen, sidens egne bilder medregnet: først de som er brukt lengst
// siden, så sidens egne bilder som siden ikke trengte pikslene til (bakgrunner og bilder under teksten). Bilder siden
// trengte pikslene til (dekker de tekst?), blir liggende, så de kan sjekkes på neste side uten å lese den på nytt. Et
// sluppet bilde dekodes ikke igjen så lenge pikslene ikke trengs; se extractPages. (Workeren har 128 MB.)
const SHARED_IMAGES = 48e6;
function sharedImagePolicy(limit = SHARED_IMAGES) {
  // id → { n: siste side bildet ble brukt på, needed: pikslene trengtes der } (eldste først).
  const lastUse = new Map();
  return {
    // Bildene (id-er) siden n brukte, og de av dem siden trengte pikslene til.
    use(ids, n, needed = new Set()) {
      for (const id of ids) {
        if (!id.startsWith("g_")) continue;
        lastUse.delete(id);
        lastUse.set(id, { n, needed: needed.has(id) });
      }
    },
    // Bildene som skal slippes etter side n. `bytes(id)`: plassen bildet tar (0 når pdf.js ikke har levert det ennå:
    // det kan ikke slippes nå, men regnes med når det er levert).
    evict(n, bytes) {
      const size = new Map();
      let total = 0;
      for (const id of lastUse.keys()) {
        size.set(id, bytes(id));
        total += size.get(id);
      }
      const out = [];
      for (const own of [false, true]) {
        for (const [id, use] of lastUse) {
          if (total <= limit) break;
          if ((use.n >= n) !== own || (own && use.needed) || !size.get(id)) continue;
          out.push(id);
          total -= size.get(id);
        }
      }
      for (const id of out) lastUse.delete(id);
      return out;
    },
    // Fellesbufferen er tømt (pdf.cleanup): ingenting ligger igjen.
    reset() {
      lastUse.clear();
    },
  };
}

function sharedBytes(page, id) {
  try {
    if (!page.commonObjs.has(id)) return 0;
    const img = page.commonObjs.get(id);
    return img && img.data && img.data.length ? img.data.length : img && img.width && img.height ? img.width * img.height * 4 : 0;
  } catch {
    return 0;
  }
}

// Det dekodede bildet (pdf.js legger det i page.objs, eller commonObjs for bilder brukt på flere sider).
async function imageOf(page, g) {
  if (g.data) return g.data;
  if (!g.id) return null;
  const objs = g.id.startsWith("g_") ? page.commonObjs : page.objs;
  let timer = null;
  try {
    return await Promise.race([
      new Promise((resolve) => objs.get(g.id, resolve)),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 10000, null);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const channelsOf = (img) => (img && img.data && img.width && img.height ? img.data.length / (img.width * img.height) : 0);

// Er bildet ugjennomsiktig i punktet (x, y) på siden? Bilder uten alfakanal er det overalt.
function opaqueAt(img, g, x, y, min = 128) {
  if (channelsOf(img) !== 4) return true;
  if (g.skew) return false;
  const f = g.frame || g;
  let u = (x - f.x0) / Math.max(1e-6, f.x1 - f.x0);
  let v = (f.y1 - y) / Math.max(1e-6, f.y1 - f.y0);
  if (g.flipX) u = 1 - u;
  if (g.flipY) v = 1 - v;
  const px = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width)));
  const py = Math.min(img.height - 1, Math.max(0, Math.floor(v * img.height)));
  return img.data[(py * img.width + px) * 4 + 3] >= min;
}

// Bakgrunnsfargen i et skannet sidebilde, grovt rutenett (lyseste kvartil per rute, så teksten ikke teller med).
// Brukes til dekkfargen bak oversatt OCR-tekst, så farget bakgrunn (tabellhoder, bokser) ikke får hvite flekker.
// Gjennomsiktige piksler blandes med hvitt (siden under), så de ikke gir svart dekkfarge.
function backgroundOf(img, g) {
  const channels = channelsOf(img);
  if (channels !== 3 && channels !== 4) return null;
  const { data, width, height } = img;
  const cell = Math.max(4, Math.ceil(width / 150));
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const colors = new Uint8Array(cols * rows * 3);
  const lum = new Float64Array(Math.ceil(cell / 2) ** 2);
  const idx = new Uint32Array(lum.length);
  const order = [];
  const px = (i, k) => (channels === 4 ? Math.round(data[i + k] * (data[i + 3] / 255) + 255 * (1 - data[i + 3] / 255)) : data[i + k]);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let n = 0;
      for (let y = r * cell; y < Math.min(height, (r + 1) * cell); y += 2) {
        for (let x = c * cell; x < Math.min(width, (c + 1) * cell); x += 2) {
          const i = (y * width + x) * channels;
          lum[n] = px(i, 0) * 0.3 + px(i, 1) * 0.59 + px(i, 2) * 0.11;
          idx[n++] = i;
        }
      }
      order.length = n;
      for (let k = 0; k < n; k++) order[k] = k;
      order.sort((a, b) => lum[a] - lum[b]);
      const i = idx[order[Math.floor(n * 0.75)]];
      colors.set([px(i, 0), px(i, 1), px(i, 2)], (r * cols + c) * 3);
    }
  }
  const f = g.frame || g;
  return { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1, cols, rows, colors };
}

// Bakgrunnsfargen under rammen (median av rutene), som #rrggbb.
function colorAround(bg, box) {
  if (!bg) return "#ffffff";
  const cw = (bg.x1 - bg.x0) / bg.cols;
  const ch = (bg.y1 - bg.y0) / bg.rows;
  const c0 = Math.floor((box.x0 - bg.x0) / cw);
  const c1 = Math.floor((box.x1 - bg.x0) / cw);
  const r0 = Math.floor((bg.y1 - box.y1) / ch);
  const r1 = Math.floor((bg.y1 - box.y0) / ch);
  const picked = [[], [], []];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (r < 0 || c < 0 || r >= bg.rows || c >= bg.cols) continue;
      for (let k = 0; k < 3; k++) picked[k].push(bg.colors[(r * bg.cols + c) * 3 + k]);
    }
  }
  if (!picked[0].length) return "#ffffff";
  return `#${picked.map((v) => v.sort((a, b) => a - b)[v.length >> 1].toString(16).padStart(2, "0")).join("")}`;
}

function familyOf(name, cssFamily) {
  const clean = String(name || "").replace(/^[A-Z]{6}\+/, "");
  if (MONO.test(clean) || cssFamily === "monospace") return "mono";
  if (SERIF.test(clean) && !/sans/i.test(clean)) return "serif";
  if (cssFamily === "serif" && !/sans/i.test(clean)) return "serif";
  return "sans";
}

async function extractPages(buffer, opts = {}) {
  const { getDocumentProxy, OPS } = await loadPdfjs();
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer), { useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  } catch (err) {
    if (err && err.name === "PasswordException") throw new Error(LOCKED);
    throw err;
  }
  const pages = [];
  // Antall tekstbiter som er tatt ut fordi de er dekket (se under; ikke tekst i skjulte lag).
  let covered = 0;
  // Bilder brukt på flere sider (pdf.js: g_-id i commonObjs) blir liggende dekodet til dokumentet lukkes, om de ikke
  // slippes (se sharedImagePolicy). `dropped`: bildene som er sluppet siden fellesbufferen sist ble tømt.
  const shared = sharedImagePolicy(opts.sharedImages);
  const dropped = new Set();
  // Lag (valgfritt innhold): tilstanden er bare kjent for grupper som finnes i dokumentets /OCProperties.
  let ocConfig = null;
  try {
    ocConfig = typeof pdf.getOptionalContentConfig === "function" ? await pdf.getOptionalContentConfig() : null;
  } catch {
    ocConfig = null;
  }
  // Et uttrykk (/VE) med And, Or og Not regnes ut med de kjente gruppene (som pdf.js gjør); en gruppe som ikke finnes i
  // /OCGs, eller en del pdf.js har kuttet bort (for dypt), er ukjent (null). And med en gruppe som er av, er av, og Or
  // med en som er på, er på, uansett resten.
  const known = (x) => typeof x === "string" && ocConfig.getGroup(x);
  const evaluate = (e, depth = 0) => {
    if (!Array.isArray(e) || e.length < 2 || depth > 20 || !["And", "Or", "Not"].includes(e[0])) return null;
    const vals = e.slice(1).map((x) => (Array.isArray(x) ? evaluate(x, depth + 1) : known(x) ? Boolean(known(x).visible) : null));
    if (e[0] === "Not") return vals[0] == null ? null : !vals[0];
    if (e[0] === "And") return vals.includes(false) ? false : vals.includes(null) ? null : true;
    return vals.includes(true) ? true : vals.includes(null) ? null : false;
  };
  // Kan uttrykket ikke regnes ut, men bruker det en kjent gruppe som er av, regnes laget som av: teksten står da urørt
  // (heller det enn en synlig oversettelse av noe som er skjult).
  const offIn = (e, depth = 0) => Array.isArray(e) && depth <= 20
    && e.slice(1).some((x) => (Array.isArray(x) ? offIn(x, depth + 1) : known(x) && !known(x).visible));
  const ocState = (group) => {
    if (!ocConfig || !group || typeof ocConfig.getGroup !== "function") return null;
    if (group.type === "OCG") return ocConfig.getGroup(group.id) ? Boolean(ocConfig.isVisible(group)) : null;
    if (group.type === "OCMD" && group.expression) {
      const state = evaluate(group.expression);
      return state != null ? state : offIn(group.expression) ? false : null;
    }
    if (group.type === "OCMD" && Array.isArray(group.ids) && group.ids.length
      && group.ids.every((id) => ocConfig.getGroup(id))) return Boolean(ocConfig.isVisible(group));
    return null;
  };
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      // Operatorlisten og tekstinnholdet slippes så snart de er lest (let … = null): ellers kan de bli liggende i minnet
      // til neste side er lest (to operatorlister samtidig; kart og tette vektorsider har titusener av stier).
      let opList = await page.getOperatorList();
      let content = await page.getTextContent();
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
      let items = [];
      for (const it of content.items) {
        if (typeof it.str !== "string" || !it.str) continue;
        const tr = it.transform || [1, 0, 0, 1, 0, 0];
        const fontName = realName(it.fontName);
        const css = (content.styles[it.fontName] || {}).fontFamily;
        // Høyden gir skriftstørrelsen; bredden kan være strukket (Tz, f.eks. OCR-lag som tilpasser ordbredden).
        const sx = Math.hypot(tr[0], tr[1]);
        const sy = Math.hypot(tr[2], tr[3]);
        const size = sy || sx || 11;
        // Skråstilt tekst: aksene står ikke vinkelrett. Rotert tekst er ikke kursiv.
        const skew = sx && sy ? Math.abs(tr[0] * tr[2] + tr[1] * tr[3]) / (sx * sy) : 0;
        items.push({
          str: it.str,
          x: tr[4],
          y: tr[5],
          w: it.width || 0,
          size,
          angle: Math.atan2(tr[1], tr[0]),
          style: {
            family: familyOf(fontName, css),
            bold: BOLD.test(fontName),
            italic: ITALIC.test(fontName) || skew > 0.1,
            size: Math.round(size * 10) / 10,
            font: fontName,
          },
        });
      }
      const fontOf = (id) => {
        try {
          return page.commonObjs.get(id);
        } catch {
          return null;
        }
      };
      const scan = scanOps(opList, OPS, fontOf, ocState);
      opList = null;
      content = null;
      const exact = assignStyles(items, scan.glyphs);
      if (!exact) looseSources(items, scan.glyphs);
      // Pikslene til et bilde (se imageOf). Et bilde som er sluppet (se sharedImagePolicy), sender pdf.js ikke igjen: da
      // tømmes fellesbufferen (arbeideren glemmer bildene) og operatorene leses på nytt, så bildene dekodes igjen med nye
      // id-er i samme rekkefølge.
      const needed = new Set();
      const load = async (g) => {
        if (g.id && dropped.has(g.id)) {
          await settleImages(page, scan.imageIds.filter((id) => !dropped.has(id)), 3000, true);
          await pdf.cleanup();
          dropped.clear();
          shared.reset();
          const again = scanOps(await page.getOperatorList(), OPS, fontOf, ocState).imageIds;
          const map = new Map(again.length === scan.imageIds.length ? scan.imageIds.map((id, k) => [id, again[k]]) : []);
          for (const x of scan.graphics) if (x.id) x.id = map.get(x.id) || null;
          scan.imageIds = again;
          const before = [...needed];
          needed.clear();
          for (const id of before) if (map.get(id)) needed.add(map.get(id));
        }
        if (g.id) needed.add(g.id);
        return imageOf(page, g);
      };
      // Tekst i et lag som er av (valgfritt innhold), synes ikke: den oversettes ikke og tegnes ikke, og tekstoperatorene
      // står urørt i laget (hiddenOps; skjemaobjekter med slik tekst endres ikke, se writePdf). Bare tekstbiter der alle
      // tegnene sikkert ligger i et skjult lag, regnes med, og biter uten sikker kobling som bare tegn i et skjult lag kan
      // stave (se looseSources). Dette gjelder også når dekk ikke tas ut (noCover): at et lag er av, er ikke en gjetning.
      const hiddenOps = [];
      if (scan.glyphs.some((g) => g.hidden)) {
        const kept = [];
        for (const it of items) {
          if (it.glyphs && it.glyphs.every((g) => g.hidden)) {
            for (let s = it.glyphs[0].sop; s >= 0 && s <= it.glyphs[it.glyphs.length - 1].sop; s++) hiddenOps.push(s);
          } else if (!(it.loose && it.loose.hidden)) kept.push(it);
        }
        items = kept;
      }
      for (const it of items) {
        const { str, tracked } = respace(it);
        it.str = str;
        it.style.tracked = tracked;
        it.style.color = it.color;
        if (it.alpha < 1) it.style.alpha = Math.round(it.alpha * 100) / 100;
        const g = it.glyphs;
        it.nbspBefore = Boolean(g && g[0].nbsp);
        it.sops = g ? [g[0].sop, g[g.length - 1].sop] : null;
        // Skjemaobjektene (tegnenummer i scan.formDraws) tekstbiten er tegnet i; null når koblingen er usikker.
        it.forms = g ? [...new Set(g.map((x) => x.form).filter((f) => f >= 0))] : null;
        it.gi = undefined;
        // Bindestrek sist med mellomrom foran (pdf.js setter inn mellomrom ved hull): orddeling bare når det ikke er et
        // mellomromstegn og hullet ikke er et ordmellomrom. I TeX er « -» med et hull på et ordmellomrom (TJ-tall eller en
        // flytting med Td) en tankestrek; en orddelingsstrek tegnet for seg (LibreOffice) har et lite hull foran. Er hullet
        // ukjent (ny tekstlinje), regnes det som orddeling. En egen tekstbit avgjøres etter hullet i segmentsOf.
        const last = g && g[g.length - 1];
        if (last && last.ch === "-" && g.length > 1 && /\s-$/.test(it.str.trimEnd())) it.softHyphen = !last.space && (last.gap == null || last.gap < 0.2);
        else if (last && it.str.trim() === "-") it.softHyphen = last.space ? false : "gap";
        it.glyphs = undefined;
      }
      const [x0, y0, x1, y1] = page.view;
      const width = x1 - x0;
      const height = y1 - y0;
      // Tekst som et senere, stort og ugjennomsiktig bilde dekker (skannet side med OCR-tekst under bildet), er i
      // praksis usynlig. Vannmerker og stempler med gjennomsiktighet (alfa, maske, ca < 1, myk maske) skjuler ikke teksten,
      // og heller ikke et bilde som er klippet til noe annet enn et rektangel. Et beskåret bilde teller bare med den
      // synlige delen.
      const big = scan.graphics.filter((g) => g.image && (g.x1 - g.x0) * (g.y1 - g.y0) >= 0.25 * width * height);
      const images = new Map();
      for (const g of big.filter((b) => !b.mask && (b.alpha ?? 1) >= 0.99 && !b.soft && !b.odd && !b.oc)) {
        const under = items.filter((it) => !it.invisible && g.op > it.op && it.x + it.w / 2 > g.x0 && it.x + it.w / 2 < g.x1
          && it.y + it.size * 0.3 > g.y0 && it.y + it.size * 0.3 < g.y1);
        if (!under.length) continue;
        if (!images.has(g)) images.set(g, await load(g));
        const img = images.get(g);
        for (const it of under) {
          const y = it.y + it.size * 0.3;
          const hits = [0.25, 0.5, 0.75].filter((f) => opaqueAt(img, g, it.x + it.w * f, y)).length;
          if (hits >= 2) it.invisible = true;
        }
      }
      // Tekst som en senere tegnet, ugjennomsiktig flate eller et mindre bilde dekker nesten helt (overmaling i en
      // PDF-redigerer, klistrelapp, sladding), synes ikke i originalen. Den tas ut før oppsettet: den oversettes ikke og
      // tegnes ikke (tekstoperatoren fjernes, eller står urørt under dekket når den deles med uendret tekst).
      // Bare det som sikkert dekker, teller: et rett rektangel eller et bilde uten skråstilling, med fast farge (ikke
      // mønster), helt ugjennomsiktig, uten myk maske eller blandemodus, og ikke klippet til noe annet enn et rektangel
      // (klippet regnes med), og ikke i et lag med ukjent tilstand. Er det tvil, blir teksten stående. Blir det ingen synlig
      // tekst igjen på siden, tas ingenting ut.
      const covers = opts.noCover ? [] : scan.graphics.filter((g) => !big.includes(g) && !g.soft && !g.odd && !g.oc && (g.alpha ?? 1) >= 0.999
        && (g.image ? !g.mask && !g.skew : g.fill && g.rect && g.parts === 1 && !g.pattern) && g.x1 - g.x0 > 2 && g.y1 - g.y0 > 2);
      const first = covers.length ? minOf(items, (it) => it.op ?? Infinity) : Infinity;
      const later = covers.filter((g) => g.op > first);
      if (later.length) {
        // Rutenett over siden: et dekke som dekker minst 90 % av tegnrammen, dekker også midten av den, så bare dekkene i
        // ruten der midten ligger, må sjekkes (i tegnerekkefølge, fra det første som er tegnet etter teksten).
        const cell = Math.max(24, Math.max(width, height) / 32);
        const grid = new Map();
        const wide = [];
        for (const g of later) {
          const c0 = Math.floor((g.x0 - x0) / cell);
          const c1 = Math.floor((g.x1 - x0) / cell);
          const r0 = Math.floor((g.y0 - y0) / cell);
          const r1 = Math.floor((g.y1 - y0) / cell);
          if ((c1 - c0 + 1) * (r1 - r0 + 1) > 256) {
            wide.push(g);
            continue;
          }
          for (let c = c0; c <= c1; c++) {
            for (let r = r0; r <= r1; r++) {
              const key = `${c},${r}`;
              if (!grid.has(key)) grid.set(key, []);
              grid.get(key).push(g);
            }
          }
        }
        const after = (list, op) => {
          let lo = 0;
          let hi = list.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid].op <= op) lo = mid + 1;
            else hi = mid;
          }
          return lo;
        };
        for (const it of items) {
          if (it.invisible || Math.abs(it.angle) >= 0.01 || !it.str.trim() || !(it.w > 0)) continue;
          const box = { x0: it.x, x1: it.x + it.w, y0: it.y - it.size * 0.2, y1: it.y + it.size * 0.75 };
          const area = (box.x1 - box.x0) * (box.y1 - box.y0);
          const key = `${Math.floor(((box.x0 + box.x1) / 2 - x0) / cell)},${Math.floor(((box.y0 + box.y1) / 2 - y0) / cell)}`;
          const opEnd = it.opEnd ?? it.op;
          for (const list of [grid.get(key) || [], wide]) {
            for (let n = after(list, opEnd); n < list.length && !it.covered; n++) {
              const g = list[n];
              const w = Math.min(g.x1, box.x1) - Math.max(g.x0, box.x0);
              const h = Math.min(g.y1, box.y1) - Math.max(g.y0, box.y0);
              if (w <= 0 || h <= 0 || w * h < 0.9 * area) continue;
              if (g.image) {
                // Bilde med gjennomsiktighet: ugjennomsiktig over hele tegnrammen.
                if (!images.has(g)) images.set(g, await load(g));
                const img = images.get(g);
                if (!img) continue;
                let solid = true;
                for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
                  for (const fy of [0.2, 0.5, 0.8]) {
                    if (solid && !opaqueAt(img, g, box.x0 + (box.x1 - box.x0) * fx, box.y0 + (box.y1 - box.y0) * fy, 250)) solid = false;
                  }
                }
                if (!solid) continue;
              }
              it.covered = true;
            }
          }
        }
        if (items.some((it) => it.covered)) {
          if (items.some((it) => !it.covered && !it.invisible && it.str.trim())) {
            covered += items.filter((it) => it.covered).length;
            items = items.filter((it) => !it.covered);
          } else for (const it of items) it.covered = undefined;
        }
      }
      // Usynlig OCR-lag oppå ekte tekst: den synlige teksten gjelder.
      if (items.some((it) => it.invisible) && items.some((it) => !it.invisible)) {
        const buckets = new Map();
        for (const v of items) {
          if (v.invisible || !v.str.trim()) continue;
          const key = Math.round(v.y / 4);
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(v);
        }
        const hidden = (it) => [-1, 0, 1].some((d) => (buckets.get(Math.round(it.y / 4) + d) || []).some((v) =>
          Math.abs(v.y - it.y) < 0.5 * Math.max(v.size, it.size) && v.x < it.x + it.w && v.x + v.w > it.x));
        items = items.filter((it) => !it.invisible || !hidden(it));
      }
      // Dekkfargen bak OCR-tekst trengs bare når PDF-en skrives (ikke ved telling og innsamling av tekst).
      let bg = null;
      if (!opts.collect && items.some((it) => it.invisible)) {
        const scanImage = big.filter((g) => g.id || g.data).sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
        if (scanImage) bg = backgroundOf(images.has(scanImage) ? images.get(scanImage) : await load(scanImage), scanImage);
      }
      images.clear();
      for (const g of scan.graphics) if (g.data) g.data = undefined;
      // pdf.js leverer de dekodede bildene etter operatorlisten. Kommer et bilde først etter page.cleanup(), blir det
      // liggende i minnet til hele dokumentet er lest (skannede sider: flere MB per side). Derfor ventes det på sidens
      // bilder (med en øvre tidsgrense) før siden ryddes.
      await settleImages(page, scan.imageIds);
      const result = {
        view: [x0, y0, x1, y1], width, height, rotate: page.rotate || 0, items, shapes: scan.shapes, graphics: scan.graphics,
        exact, shows: scan.shows, paths: scan.paths, advances: scan.advances, bg, hiddenOps, formDraws: scan.formDraws,
      };
      // Legges siden ut med én gang, kan grafikken og tegnene slippes før neste side leses (mindre minne).
      if (opts.onPage) await opts.onPage(result, n - 1);
      pages.push(result);
      page.cleanup();
      shared.use(scan.imageIds.filter((id) => !dropped.has(id)), n, needed);
      const evict = shared.evict(n, (id) => sharedBytes(page, id));
      if (evict.length && typeof page.commonObjs.delete !== "function") {
        await pdf.cleanup();
        shared.reset();
      } else for (const id of evict) if (page.commonObjs.delete(id)) dropped.add(id);
    }
  } finally {
    // De dekodede bildene i fellesbufferen slippes før dokumentet lukkes (ellers blir de liggende til neste PDF åpnes),
    // også når en side ikke kunne leses.
    try {
      if (typeof pdf.cleanup === "function") await pdf.cleanup();
    } finally {
      // Nyere pdf.js lukker dokumentet gjennom lastejobben (PDFDocumentProxy har ikke destroy lenger).
      if (typeof pdf.destroy === "function") await pdf.destroy();
      else if (pdf.loadingTask && typeof pdf.loadingTask.destroy === "function") await pdf.loadingTask.destroy();
    }
  }
  pages.covered = covered;
  return pages;
}

// ---- Oppsett: linjer → biter (kolonner/celler) → avsnitt ----

const styleKey = (s) => `${s.family}|${s.bold}|${s.italic}|${Math.round(s.size * 2) / 2}|${Boolean(s.tracked)}`;
// Det som synes: brukes for uthevede ord inne i avsnitt.
const lookKey = (s) => `${s.family}|${s.bold}|${s.italic}|${Math.round(s.size * 2) / 2}|${s.color}|${s.alpha ?? 1}|${Boolean(s.underline)}|${s.sup || ""}`;
const fullKey = (s) => `${styleKey(s)}|${lookKey(s)}`;

// Stilen med flest tegn (like stiler fra ulike tekstbiter telles sammen).
function dominant(runs) {
  const weight = new Map();
  for (const r of runs) {
    const key = fullKey(r.style);
    const w = weight.get(key) || { style: r.style, n: 0 };
    w.n += r.text.trim().length;
    weight.set(key, w);
  }
  let best = null;
  for (const w of weight.values()) if (!best || w.n > best.n) best = w;
  return best.style;
}

function pushRun(runs, text, style, x, xEnd) {
  const last = runs[runs.length - 1];
  if (last && (fullKey(last.style) === fullKey(style) || !text.trim())) {
    last.text += text;
    if (xEnd != null) last.xEnd = Math.max(last.xEnd ?? xEnd, xEnd);
  } else if (last && !last.text.trim()) runs[runs.length - 1] = { text: last.text + text, style, x, xEnd };
  else runs.push({ text, style, x, xEnd });
}

// Grafikk som hindringer: tynne streker (linjer, tabellkanter, understreking), kantene til bokser og bilder, og boksene
// selv (bakgrunner og celler teksten kan ligge i). Rotert oppsett får grafikken dreid inn i sin egen ramme.
function geometryOf(page, graphics, turn) {
  const h = [];
  const v = [];
  const boxes = [];
  for (const g0 of graphics) {
    const g = turn ? boxOf(turn, g0.x0, g0.y0, g0.x1, g0.y1) : g0;
    const w = g.x1 - g.x0;
    const hh = g.y1 - g.y0;
    if (hh <= 2 && w >= 4) h.push({ x0: g.x0, x1: g.x1, y: (g.y0 + g.y1) / 2, thin: true, g: g0 });
    else if (w <= 2 && hh >= 4) v.push({ y0: g.y0, y1: g.y1, x: (g.x0 + g.x1) / 2, thin: true, g: g0 });
    else if (w > 2 && hh > 2 && !(w >= page.width * 0.95 && hh >= page.height * 0.95)) {
      const box = { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, fill: g0.fill || g0.image, g: g0 };
      boxes.push(box);
      h.push({ x0: g.x0, x1: g.x1, y: g.y0, box }, { x0: g.x0, x1: g.x1, y: g.y1, box });
      v.push({ y0: g.y0, y1: g.y1, x: g.x0, box }, { y0: g.y0, y1: g.y1, x: g.x1, box });
    }
  }
  h.sort((a, b) => a.y - b.y);
  boxes.sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0));
  return { h, v, boxes };
}

// Vannrette kanter med y i (lo, hi), fra den sorterte listen.
function edgesIn(h, lo, hi) {
  let a = 0;
  let b = h.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (h[m].y <= lo) a = m + 1;
    else b = m;
  }
  const out = [];
  for (let k = a; k < h.length && h[k].y < hi; k++) out.push(h[k]);
  return out;
}

// Grunnlinjer: biter med omtrent samme y. Svært ulike størrelser må stå nesten nøyaktig på linje (ellers blir en
// stor initial eller et stort tall ved siden av en tabellrad en egen linje). Små hevede/senkede biter (fotnotetall)
// flyttes etterpå inn i linjen de står ved.
function linesOf(items) {
  const flat = items.filter((it) => Math.abs(it.angle) < 0.01).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of flat) {
    const inked = Boolean(it.str.trim());
    let best = null;
    for (let j = lines.length - 1; j >= 0 && j >= lines.length - 6; j--) {
      const L = lines[j];
      const small = Math.min(L.size, it.size);
      const tol = Math.max(L.size, it.size) > small * 1.5 ? Math.max(1, small * 0.15) : Math.max(1.6, small * 0.32);
      const dy = Math.abs(L.y - it.y);
      if (dy <= tol && (!best || dy < Math.abs(best.y - it.y))) best = L;
    }
    if (best) best.items.push(it);
    else if (inked) lines.push({ y: it.y, size: it.size, items: [it] });
  }
  lines.forEach((L, i) => {
    const inked = L.items.filter((it) => it.str.trim());
    // Hevet/senket skrift er kort (fotnotetall, «TM», «2» i CO2); en hel setning ved siden av en stor bokstav er det ikke.
    if (!inked.length || inked.length > 3 || inked.reduce((n, it) => n + it.str.trim().length, 0) > 5) return;
    for (let j = Math.max(0, i - 4); j < Math.min(lines.length, i + 5); j++) {
      const T = lines[j];
      if (T === L || !T.items.length || T.size < L.size * 1.25 || L.size < T.size * 0.45) continue;
      const rise = L.y - T.y;
      const sup = rise > 0.12 * T.size && rise < 0.55 * T.size ? "sup" : rise < -0.05 * T.size && rise > -0.35 * T.size ? "sub" : null;
      if (!sup) continue;
      const near = (s) => T.items.some((a) => a.str.trim() && (Math.abs(a.x + a.w - s.x) <= 0.4 * T.size || Math.abs(s.x + s.w - a.x) <= 0.4 * T.size));
      if (!inked.every(near)) continue;
      for (const s of L.items) {
        s.style.sup = sup;
        // Den opprinnelige hevingen (i punkter), så teksten tegnes like høyt etter oversettelsen.
        s.style.rise = Math.round(rise * 100) / 100;
        T.items.push(s);
      }
      L.items = [];
      break;
    }
  });
  return lines.filter((L) => L.items.length);
}

// På hvor mange linjer over og under (høyst fire hver vei) står hullet (a, b) åpent, med tekst på begge sider? To eller
// flere: en spalteskiller (gutter) eller en tabellkolonne, ikke et ordmellomrom.
function gutterAt(lines, i, a, b, size) {
  const minW = Math.max(2.5, size * 0.5);
  const run = (dir) => {
    let lo = a;
    let hi = b;
    let n = 0;
    let prevY = lines[i].y;
    for (let j = i + dir; j >= 0 && j < lines.length && n < 4; j += dir) {
      const L = lines[j];
      // Bare linjer i samme tekst (tett linjeavstand, omtrent samme størrelse), ikke en tabell eller overskrift like ved.
      if (Math.abs(prevY - L.y) > 2.2 * size || L.size < size * 0.8 || L.size > size * 1.25) break;
      prevY = L.y;
      let left = -Infinity;
      let right = Infinity;
      let blocked = false;
      for (const it of L.inked) {
        const end = it.x + it.w;
        if (end <= lo + 0.5) left = Math.max(left, end);
        else if (it.x >= hi - 0.5) right = Math.min(right, it.x);
        else if (it.x <= lo && end < hi) lo = end;
        else if (it.x > lo && end >= hi) hi = it.x;
        else blocked = true;
      }
      // En ekte spalte har en rett kant på minst én side (ikke en tilfeldig «elv» av ordmellomrom).
      const edge = Math.abs(right - b) <= 1.5 || Math.abs(left - a) <= 1.5;
      if (blocked || left === -Infinity || right === Infinity || !edge || hi - lo < minW) break;
      n++;
    }
    return n;
  };
  return run(-1) + run(1);
}

// Hvor linjen skal deles: loddrette streker og spalteskillere alltid; store hull bare når linjen ikke er
// blokkjustert (like brede ordmellomrom); i tillegg der skriftstørrelsen skifter kraftig.
function cutsOf(lines, i, geo) {
  const line = lines[i];
  const all = line.items.slice().sort((a, b) => a.x - b.x);
  const inked = all.filter((it) => it.str.trim());
  const gaps = [];
  let end = -Infinity;
  let spaced = false;
  let k = 0;
  for (const it of all) {
    if (!it.str.trim()) {
      if (k && it.x <= end + 0.5) spaced = Math.max(spaced || 0, it.x + it.w);
      continue;
    }
    if (k) {
      const a = inked[k - 1];
      const size = Math.min(a.size, it.size);
      // Kode i fast bredde: hullet er fylt av noen få hele mellomrom (innrykk/justering), ikke en kolonne.
      const n = (it.x - end) / (0.6 * size);
      const mono = a.style.family === "mono" && it.style.family === "mono" && spaced >= it.x - 0.5 && n <= 8 && Math.abs(n - Math.round(n)) < 0.12;
      const big = Math.max(a.size, it.size) > 1.5 * size && !a.style.sup && !it.style.sup;
      gaps.push({ k, a: end, b: it.x, gap: it.x - end, size, big, mono });
    }
    end = Math.max(end, it.x + it.w);
    spaced = false;
    k++;
  }
  const cuts = new Set();
  const y = line.y;
  for (const g of gaps) {
    if (g.gap <= 0) continue;
    g.rule = geo.v.some((e) => e.x > g.a - 0.5 && e.x < g.b + 0.5 && e.y0 <= y + g.size * 0.3 && e.y1 >= y
      && (e.thin || g.gap >= g.size * 0.5));
    g.open = !g.rule && !g.mono && g.gap >= Math.max(2.5, g.size * 0.5) ? gutterAt(lines, i, g.a, g.b, g.size) : 0;
    g.gutter = g.open >= 2;
  }
  // I blokkjustert tekst kan et ordmellomrom tilfeldigvis stå over/under samme hull på et par nabolinjer (samme ord
  // først på flere linjer). Er hullet like stort som et nabomellomrom på samme linje som ikke selv er en spalteskiller,
  // og står det åpent over få linjer, er det et vanlig ordmellomrom. (I en tabell står alle hullene på linje, og en
  // ekte spalteskiller går gjennom mange linjer, så der gjelder ikke dette.)
  gaps.forEach((g, n) => {
    if (!g.gutter || g.open >= 4 || g.gap >= 2.5 * g.size) return;
    const like = (h) => h && !h.gutter && !h.rule && h.gap > 0.15 * h.size && Math.abs(h.gap - g.gap) <= Math.max(1, 0.2 * g.gap);
    if (like(gaps[n - 1]) || like(gaps[n + 1])) g.gutter = false;
  });
  for (const g of gaps) {
    if (g.rule || g.gutter) {
      g.hard = true;
      cuts.add(g.k);
    }
  }
  // Blokkjustert linje: like store ordmellomrom, og høyre kant på linje med nabolinjen i samme spalte.
  const even = (seg) => {
    const words = seg.filter((g) => g.gap > 0.15 * g.size);
    const sizes = words.map((g) => g.gap);
    if (!(words.length >= 2 && maxOf(sizes) - minOf(sizes) <= Math.max(1, 0.12 * words[0].size)
      && maxOf(sizes) <= 4 * words[0].size)) return false;
    const from = inked[seg[0].k - 1].x;
    const to = seg[seg.length - 1].b + inked[seg[seg.length - 1].k].w;
    // Nærmeste linje over/under med tekst i samme spalte (linjer i nabospalten kan ha grunnlinjer imellom).
    const nearest = (dir) => {
      for (let j = i + dir; j >= 0 && j < lines.length && Math.abs(lines[j].y - line.y) <= 2 * words[0].size; j += dir) {
        const near = lines[j].inked.filter((it) => it.x < to && it.x + it.w > from);
        if (near.length) return near;
      }
      return null;
    };
    return [-1, 1].some((dir) => {
      const near = nearest(dir);
      return near && Math.abs(maxOf(near, (it) => it.x + it.w) - to) <= 1.5;
    });
  };
  const flush = () => {
    // Et hull mye større enn de andre ordmellomrommene (ofte mellom to spalter på avsnittets korte siste linje) deler
    // linjen; delene vurderes hver for seg.
    const words = seg.filter((g) => g.gap > 0.15 * g.size).map((g) => g.gap).sort((a, b) => a - b);
    const median = words.length >= 3 ? words[words.length >> 1] : Infinity;
    let part = [];
    const done = () => {
      if (part.length && !even(part)) for (const g of part) if (!g.mono && g.gap > COLUMN_GAP * g.size) cuts.add(g.k);
      part = [];
    };
    for (const g of seg) {
      if (!g.mono && g.gap > COLUMN_GAP * g.size && g.gap > 2.5 * median) {
        cuts.add(g.k);
        done();
      } else part.push(g);
    }
    done();
  };
  let seg = [];
  for (const g of gaps) {
    if (g.hard) {
      if (seg.length) flush();
      seg = [];
    } else seg.push(g);
  }
  if (seg.length) flush();
  for (const g of gaps) if (g.big && g.gap > SPACE_GAP * g.size) cuts.add(g.k);
  return cuts;
}

// Tekstbiter på samme grunnlinje → biter delt ved kolonner, tabellceller og etter kulepunkt/nummer.
function fragmentsOf(lines, geo) {
  for (const L of lines) L.inked = L.items.filter((it) => it.str.trim()).sort((a, b) => a.x - b.x);
  const fragments = [];
  lines.forEach((line, li) => {
    const cuts = cutsOf(lines, li, geo);
    let cur = null;
    let pending = false;
    let k = 0;
    for (const it of line.items.slice().sort((a, b) => a.x - b.x)) {
      if (!it.str.trim()) {
        if (cur) pending = true;
        continue;
      }
      const gap = cur ? it.x - cur.xEnd : 0;
      const size = cur ? Math.min(cur.size, it.size) : it.size;
      const text = cur ? cur.runs.map((r) => r.text).join("").trim() : "";
      const marker = cur && cur.items.length === 1 && MARKER.test(text) && (gap > size * SPACE_GAP || pending)
        && (!/^[o\-]$/.test(text) || gap > size * 0.5);
      if (cur && (cuts.has(k) || marker || Boolean(it.invisible) !== cur.invisible)) {
        fragments.push(cur);
        cur = null;
      }
      if (!cur) {
        cur = { x: it.x, xEnd: it.x + it.w, y: it.y, size: it.size, runs: [], chars: 0, items: [], invisible: Boolean(it.invisible) };
      } else if (!/\s$/.test(cur.runs[cur.runs.length - 1].text) && !/^\s/.test(it.str)
        && (gap > size * SPACE_GAP || pending || (it.nbspBefore && gap > size * 0.1))) {
        pushRun(cur.runs, it.nbspBefore ? "\u00a0" : " ", it.style);
      }
      pushRun(cur.runs, it.str, it.style, it.x, it.x + it.w);
      cur.items.push(it);
      cur.xEnd = Math.max(cur.xEnd, it.x + it.w);
      if (!it.style.sup && it.str.trim().length > cur.chars) {
        cur.chars = it.str.trim().length;
        cur.y = it.y;
        cur.size = it.size;
      }
      pending = false;
      k++;
    }
    if (cur) fragments.push(cur);
  });
  for (const f of fragments) {
    f.runs = f.runs.map((r) => ({ ...r, text: r.text.replace(/[ \t\r\n]+/g, " ") }));
    f.runs[0].text = f.runs[0].text.replace(/^ /, "");
    f.runs[f.runs.length - 1].text = f.runs[f.runs.length - 1].text.replace(/ $/, "");
    f.runs = f.runs.filter((r) => r.text);
    if (f.runs.length) f.style = dominant(f.runs);
  }
  return fragments.filter((f) => f.runs.length);
}

// Ligger en strek eller kant (tabellrad, skyggelagt celle) mellom to linjer? Da hører de ikke til samme avsnitt.
function separated(geo, upper, lower) {
  const lo = lower.y + lower.size * 0.6;
  const hi = upper.y - upper.size * 0.05;
  if (hi <= lo) return false;
  const x0 = Math.min(upper.x, lower.x);
  const x1 = Math.max(upper.xEnd, lower.xEnd);
  const need = 0.5 * Math.min(upper.xEnd - upper.x, lower.xEnd - lower.x);
  return edgesIn(geo.h, lo, hi).some((e) => Math.min(e.x1, x1) - Math.max(e.x0, x0) >= need);
}

function canJoin(block, f, geo) {
  if (f.listStart || f.bullet || block.lines[0].bullet || block.invisible !== Boolean(f.invisible)) return false;
  const last = block.lines[block.lines.length - 1];
  const size = Math.max(last.size, f.size);
  const dy = last.y - f.y;
  if (dy < size * 0.5 || dy > size * LINE_GAP_MAX) return false;
  if (block.lines.length > 1 && Math.abs(dy - block.gap) > size * 0.25) return false;
  if (block.invisible && geo.pitch && dy > geo.pitch * 1.15) return false;
  // OCR-lag har ujevne størrelser per linje; der teller bare geometrien.
  if (Math.abs(last.size - f.size) > (block.invisible ? size * 0.15 : 0.6)) return false;
  // Avsnittets stil, ikke bare ordene ved linjeskiftet: et kursivt ord først på linjen deler ikke avsnittet.
  if (!block.invisible && styleKey(last.style) !== styleKey(f.style)
    && styleKey(last.runs[last.runs.length - 1].style) !== styleKey(f.runs[0].style)) return false;
  if (f.x >= block.right + size || f.xEnd <= block.left - size) return false;
  if (separated(geo, last, f)) return false;
  const tol = Math.max(3, size * 0.6);
  const sameLeft = Math.abs(f.x - block.left) <= tol;
  const indentedFirst = block.lines.length === 1 && !block.lines[0].listStart && f.x < last.x && last.x - f.x <= size * 3;
  // Initial: linjene ved siden av bokstaven står på linje med hverandre, linjene under den på bokstavens venstrekant.
  const underDrop = block.drop && (Math.abs(f.x - block.drop.x) <= tol || Math.abs(f.x - last.x) <= tol);
  const sameCenter = Math.abs((f.x + f.xEnd) / 2 - (last.x + last.xEnd) / 2) <= tol;
  const sameRight = Math.abs(f.xEnd - last.xEnd) <= 2;
  return sameLeft || indentedFirst || underDrop || sameCenter || sameRight;
}

// Stor initial (drop cap): én stor bokstav til venstre for avsnittets første linjer. Den festes til avsnittet, så
// ordet («T» + «he ferry») oversettes helt, og tegnes igjen som stor initial. Bare to tilfeller godtas: linjen ved
// siden av fortsetter ordet med liten bokstav, eller den begynner i versaler som fortsetter ordet direkte («O» +
// «NCE UPON A TIME»: ingen luft på størrelse med et mellomrom mellom bokstaven og linjen) og avsnittet går over
// minst to linjer ved siden av bokstaven. En stor «Q»/«A» foran et spørsmål og svar er en etikett, også når teksten
// begynner med «I», «A» eller en forkortelse («PDF», «GDPR»): der står teksten et godt stykke fra bokstaven.
function attachDropCaps(fragments) {
  const out = [];
  const textOf = (f) => f.runs.map((r) => r.text).join("").trim();
  for (const d of fragments) {
    const text = textOf(d);
    const beside = (f) => f !== d && f.size * 2 <= d.size && f.x >= d.xEnd - 1 && f.x - d.xEnd <= f.size * 2;
    const first = /^\p{Lu}$/u.test(text) && fragments.find((f) => beside(f) && f.y > d.y && f.y <= d.y + d.size * 1.2
      && !fragments.some((g) => g !== f && g !== d && g.size * 2 <= d.size && g.y > f.y && g.y <= d.y + d.size * 1.2 && Math.abs(g.x - f.x) <= 2));
    const lead = first ? textOf(first) : "";
    // Neste linje i samme avsnitt, også ved siden av bokstaven (grunnlinjen når ned mot initialens grunnlinje).
    const second = first && fragments.some((g) => beside(g) && Math.abs(g.x - first.x) <= 2 && g.y < first.y
      && first.y - g.y <= first.size * LINE_GAP_MAX && Math.abs(g.size - first.size) <= 0.6 && g.y + g.size * 0.7 > d.y - d.size * 0.05);
    // Versaler som fortsetter ordet: første ord uten små bokstaver, og linjen står helt inntil bokstaven.
    const caps = first && second && /^\p{Lu}[^\s\p{Ll}]*(\s|$)/u.test(lead) && first.x - d.xEnd < first.size * SPACE_GAP;
    if (first && (/^\p{Ll}/u.test(lead) || caps)) {
      first.drop = { text, style: d.runs[0].style, x: d.x, y: d.y, size: d.size, items: d.items };
    } else out.push(d);
  }
  return out;
}

function alignmentOf(block, page, blocks, justified, paragraphs = blocks.filter((b) => b.lines.length > 1)) {
  const { lines, left, right } = block;
  const range = (vals) => maxOf(vals) - minOf(vals);
  if (lines.length > 1) {
    const lefts = lines.slice(1).map((l, k) => (block.drop && k + 1 < block.dropLines ? left : l.x));
    const nonLast = lines.slice(0, -1);
    // Fast bredde (kode, søkeord) er aldri blokkjustert: mellomrommene er hele tegn.
    const mono = block.style.family === "mono";
    // Strukket linje: ordene står som egne biter med tydelig bredere mellomrom enn skriftens vanlige mellomrom.
    const stretched = (l) => {
      const words = l.items.filter((it) => it.str.trim()).sort((a, b) => a.x - b.x);
      const gaps = words.slice(1).map((it, i) => it.x - (words[i].x + words[i].w));
      return gaps.length >= 2 && gaps.every((g) => g > l.size * 0.35);
    };
    // Få linjer kan ende likt ved en tilfeldighet; da kreves også at kanten er tekstens høyremarg (eller at et
    // lengre blokkjustert avsnitt på siden har samme kant), eller at ordene er strukket.
    // (I en tabellcelle er tekstens høyrekant ofte sidens ytterste tekst uten at cellen er blokkjustert.)
    const edge = (nonLast.length === 2 && nonLast.every((l) => right - l.xEnd <= 0.75) && Math.abs(right - page.contentRight) <= 1 && !block.cell)
      || justified.some((r) => Math.abs(r - right) <= 1) || nonLast.every(stretched);
    if (!mono && lefts.every((x) => Math.abs(x - left) <= 2) && nonLast.every((l) => right - l.xEnd <= 1.5) && (nonLast.length >= 3 || edge)) return "justify";
    if (range(lines.map((l) => (l.x + l.xEnd) / 2)) <= 2 && range(lines.map((l) => l.x)) > 2) return "center";
    if (range(lines.map((l) => l.xEnd)) <= 1.5 && range(lines.map((l) => l.x)) > 2) return "right";
    return "left";
  }
  // Én linje: se på naboene over og under (tabellkolonne, liste, bildetekst), boksen den står i og til slutt siden.
  const [l] = lines;
  const mid = (l.x + l.xEnd) / 2;
  const size = block.size;
  const near = blocks.filter((o) => o !== block && o.lines && o.left <= right + 2 && o.right >= left - 2
    && ((o.bottom >= block.top && o.bottom - block.top <= 3 * size) || (block.bottom >= o.top && block.bottom - o.top <= 3 * size)));
  const oMid = (o) => (o.left + o.right) / 2;
  // Venstrekant felles med en nabo, med tekstens venstremarg eller med et avsnitt på siden: venstrejustert, selv om
  // en nabo tilfeldigvis slutter på samme x.
  if (near.some((o) => Math.abs(o.left - left) <= 2)) return "left";
  const margin = Math.abs(left - page.contentLeft) <= 1 || (block.box && Math.abs(left - block.box.x0) <= 1)
    || paragraphs.some((o) => o !== block && o.align !== "right" && o.align !== "center" && Math.abs(o.left - left) <= 1);
  if (!margin && near.some((o) => Math.abs(o.right - right) <= 1.5 && Math.abs(o.left - left) > 2)) return "right";
  if (!margin && near.some((o) => Math.abs(oMid(o) - mid) <= 2 && Math.abs(o.left - left) > 2)) return "center";
  const box = block.box;
  if (box && box.x1 - box.x0 > right - left + 4) {
    const gl = left - box.x0;
    const gr = box.x1 - right;
    if (Math.abs(gl - gr) <= Math.max(3, size * 0.5) && gl > size * 0.6) return "center";
    // Høyre kant like langt inn som boksens venstre marg (tekst ellers i boksen).
    const pad = minOf(blocks.filter((o) => o !== block && o.box === box), (o) => o.left - box.x0);
    if ((gr <= 8 || Math.abs(gr - pad) <= 2) && gl - gr > 4) return "right";
  }
  // Bildetekst midtstilt under/over et bilde eller en boks: like store marger på begge sider (ikke tekst som står i
  // flukt med boksens venstrekant).
  const pics = page.geo.boxes.filter((b) => b.x1 - b.x0 > right - left + 4 && b.x0 <= left + 1 && b.x1 >= right - 1
    && left - b.x0 > Math.max(3, size * 0.6)
    && ((b.y0 >= block.top - 1 && b.y0 - block.top <= 3 * size) || (b.y1 <= block.bottom + 1 && block.bottom - b.y1 <= 3 * size)));
  if (pics.some((b) => Math.abs((b.x0 + b.x1) / 2 - mid) <= 2)) return "center";
  const alone = !blocks.some((o) => o !== block && o.top > block.bottom && o.bottom < block.top);
  const tol = Math.max(3, page.width * 0.015);
  const pageMid = page.view[0] + page.width / 2;
  const contentMid = (page.contentLeft + page.contentRight) / 2;
  if (alone && l.x - page.contentLeft > size * 2 && (Math.abs(mid - pageMid) <= tol || Math.abs(mid - contentMid) <= tol)) return "center";
  // I høyre halvdel og i flukt med tekstens høyremarg (sidens ytterste tekst eller kanten til blokkjusterte avsnitt):
  // høyrejustert (sidetall, dato i en bunntekst).
  const edges = [page.contentRight, ...justified];
  if (l.x - page.view[0] > page.width * 0.5 && edges.some((r) => Math.abs(r - l.xEnd) < 1.5)) return "right";
  return "left";
}

// Er linjeskiftet etter `prev` et ekte (hardt) skift? Første ord på neste linje må ha fått god plass på den, og linjen
// må være tydelig kort: en nesten full linje kan være brutt av et program med litt større bredde (og midt i en
// setning, med liten bokstav videre, er det nesten alltid et mykt skift).
function hardBreak(block, prev, line) {
  const text = line.runs.map((r) => r.text).join("").trim();
  const word = text.split(/\s/)[0] || "";
  // Snittbredden per tegn undervurderer brede bokstaver (W, M), så ordet må ha god plass.
  const charW = (line.xEnd - line.x) / Math.max(1, text.length);
  const need = (word.length + 1) * charW * 1.4 + line.size * 0.3;
  const width = block.right - block.left;
  const room = block.align === "right" ? prev.x - block.left
    : block.align === "center" ? width - (prev.xEnd - prev.x) : block.right - prev.xEnd;
  return room > need && room >= width * (/^\p{Ll}/u.test(text) ? 0.4 : 0.15);
}

// Uthevede ord (annen stil enn avsnittets) sendes som ⟦1⟧…⟦/1⟧ og tegnes med sin stil etter oversettelsen.
function tagged(runs, base) {
  const styles = [];
  let text = "";
  for (const r of runs) {
    if (lookKey(r.style) === lookKey(base) || !/[\p{L}\p{N}]/u.test(r.text)) {
      text += r.text;
      continue;
    }
    let n = styles.findIndex((s) => lookKey(s) === lookKey(r.style));
    if (n < 0) n = styles.push(r.style) - 1;
    const [, lead, core, tail] = r.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    text += `${lead}⟦${n + 1}⟧${core}⟦/${n + 1}⟧${tail}`;
  }
  if (styles.length > MAX_TAGS) return { text: runs.map((r) => r.text).join(""), styles: [] };
  return { text, styles };
}

// Oversatt tekst med ⟦n⟧-merker → biter med stil. Ubalanserte merker: alt i avsnittets stil.
function untag(text, base, styles) {
  const parts = [];
  let pos = 0;
  let open = null;
  let ok = true;
  for (const m of String(text).matchAll(TAG)) {
    const n = Number(m[2]);
    if (m[1] ? open !== n : open !== null || !styles[n - 1]) ok = false;
    parts.push({ text: text.slice(pos, m.index), style: open ? styles[open - 1] : base });
    open = m[1] ? null : n;
    pos = m.index + m[0].length;
  }
  parts.push({ text: text.slice(pos), style: base });
  if (!ok || open !== null) return [{ text: String(text).replace(TAG, ""), style: base }];
  return parts.filter((p) => p.text);
}

// Avsnittets tekst til oversettelse: myke linjeskift blir mellomrom, orddeling fjernes, harde skift (adresser,
// signaturer, lister, kode) beholdes. En kort fet/farget innledning («Fersk konto.», «Navn:») oversettes for seg.
function segmentsOf(block) {
  const runs = [];
  const avail = block.align === "right" ? block.right - block.minLeft
    : block.align === "center" ? block.maxRight - block.minLeft : block.maxRight - block.left;
  // Smal blokk (adresse, signatur): alle skift beholdes. Men en smal spalte der minst tre linjer er fulle og setningene
  // fortsetter på neste linje (liten bokstav), er et vanlig avsnitt.
  const width = block.right - block.left;
  const full = block.lines.slice(0, -1);
  const lower = block.lines.slice(1).filter((l) => /^\p{Ll}/u.test(l.runs.map((r) => r.text).join("").trim())).length;
  const flowing = full.length >= 3 && full.every((l) => l.xEnd - l.x >= 0.9 * width) && lower * 2 >= block.lines.length - 1;
  const narrow = block.align !== "justify" && !flowing && width < 0.5 * avail;
  // Kode i fast bredde beholder linjene sine.
  const mono = block.style.family === "mono" && block.lines.some((l) => /[=;{}<>]/.test(l.runs.map((r) => r.text).join("")));
  block.lines.forEach((line, i) => {
    if (i > 0) {
      const prev = block.lines[i - 1];
      const lastRun = runs[runs.length - 1];
      // Orddeling: bokstav + bindestrek sist på linjen og liten bokstav videre. Med mellomrom foran er bindestreken en
      // tankestrek («good -» / «but»), også når mellomrommet bare er et hull på størrelse med et ordmellomrom (TeX), og
      // ordene limes ikke sammen. Unntaket er et lite hull uten mellomromstegn (orddelingsstrek tegnet for seg).
      const tail = prev.items.reduce((a, it) => (it.str.trim() && (!a || it.x > a.x) ? it : a), null);
      let soft = tail && tail.softHyphen === true;
      if (tail && tail.softHyphen === "gap") {
        const before = prev.items.filter((it) => it !== tail && it.str.trim() && it.x < tail.x).reduce((a, it) => (!a || it.x + it.w > a.x + a.w ? it : a), null);
        soft = Boolean(before) && tail.x - (before.x + before.w) < 0.2 * tail.size;
      }
      const hyphen = /\p{L}-$/u.test(lastRun.text) || (/\p{L}\s-$/u.test(lastRun.text) && soft);
      if (hyphen && /^\p{Ll}/u.test(line.runs[0].text)) lastRun.text = lastRun.text.replace(/\s?-$/, "");
      else if (narrow || mono || hardBreak(block, prev, line)) lastRun.text += "\n";
      else lastRun.text += " ";
    }
    for (const r of line.runs) pushRun(runs, r.text, r.style, r.x, r.xEnd);
  });
  if (block.drop) runs[0] = { ...runs[0], text: block.drop.text + runs[0].text.replace(/^\s+/, "") };
  const total = runs.reduce((n, r) => n + r.text.trim().length, 0);
  const [head, ...rest] = runs;
  const headText = head.text.trim();
  const restText = rest.map((r) => r.text).join("");
  const segments = [];
  if (rest.length && !block.drop && rest.every((r) => fullKey(r.style) !== fullKey(head.style))
    && (LEAD_IN_END.test(headText) || /^\s*[–—:-]/.test(restText))
    && (headText.length < total / 2 || /:$/.test(headText))) {
    segments.push({ text: headText, style: head.style });
    const base = dominant(rest);
    const trimmed = rest.map((r) => ({ ...r }));
    trimmed[0].text = trimmed[0].text.replace(/^\s+/, "");
    const { text, styles } = tagged(trimmed, base);
    // Stor avstand mellom innledning og resten (tabulator, skjemafelt): resten starter på sin opprinnelige x.
    const x = rest[0].x != null && head.xEnd != null && rest[0].x - head.xEnd > block.size * 0.6 && block.lines.length === 1 ? rest[0].x : null;
    segments.push({ text: text.trim(), style: base, styles, x });
  } else {
    const base = dominant(runs);
    const { text, styles } = tagged(runs, base);
    segments.push({ text: text.trim(), style: base, styles });
  }
  return segments.filter((s) => s.text);
}

// Den laveste streken eller kanten under blokken (innenfor x0–x1, som standard blokkens bredde).
function floorUnder(b, geo, x0 = b.left, x1 = b.right) {
  let floor = -Infinity;
  for (const e of edgesIn(geo.h, -Infinity, b.bottom + 0.5)) {
    if (Math.min(e.x1, x1) - Math.max(e.x0, x0) > Math.min(4, (x1 - x0) / 2)) floor = Math.max(floor, e.y);
  }
  return floor;
}

// Ledig plass under blokken (ned mot tekst under den, en strek eller kant under den, eller sidens bunn). Litt av luften
// over neste avsnitt/overskrift beholdes: minst 0,6 linjeavstand, og mer jo større åpningen er (halvparten først ved
// en åpning på omtrent fem linjer). `skip`: blokker som ikke teller (avsnitt i samme flyt, som flyttes med). x0–x1:
// bredden blokken kan få når den settes (se spanOf), som standard den opprinnelige.
// (Avsnitt i en flyt bruker i tillegg clearUnder: de skyves aldri inn i en åpning under seg, se linkStacks.)
function freeUnder(b, blocks, page, floor, skip = null, x0 = b.left, x1 = b.right) {
  // Plassen vokser med avstanden, så den nærmeste blokken under avgjør.
  let top = -Infinity;
  for (let k = 0; k < blocks.length; k++) {
    const o = blocks[k];
    if (o.top > top && o !== b && o.top < b.bottom && o.left < x1 && o.right > x0 && !(skip && skip.has(o))) top = o.top;
  }
  // Over en strek eller kant under blokken beholdes minst en halv linjeavstand av luften (eller hele luften hvis den
  // var mindre), målt fra underlengdene (0,22 × størrelsen; blokkens nedre kant regnes 0,25 × størrelsen under
  // grunnlinjen).
  let free = Math.min(b.bottom - page.view[1] - 24, b.bottom - floor - Math.max(b.size * 0.25, Math.min(b.bottom - floor, b.gap * 0.5 - b.size * 0.03)));
  if (top > -Infinity) free = Math.min(free, b.bottom - top - endReserve(b, b.bottom - top));
  return Math.max(0, free);
}

// Luften som beholdes over noe som står langt under (se freeUnder): minst 0,6 linjeavstand, halvparten ved en åpning
// på omtrent fem linjer.
const endReserve = (b, gap) => Math.max(b.size * 0.2, Math.min(gap * 0.5, Math.max(b.gap * 0.6, gap - b.gap * 2.5)));

// Den hvite luften under blokken i originalen: ned til nærmeste tekst, strek eller kant (også en boks' kant) under
// den, eller til sidens bunn (clear). `own` er luften over det som står under, slik den var i originalen: den minste
// avstanden fra det til tekst over det (en nabospalte kan stå nærmere enn blokken selv). `skip`, x0–x1 som i freeUnder.
// `below`: blokken som står under (null når det er en strek/kant eller sidens bunn).
// `end`: luften er slutten av teksten på siden (eller i boksen), ikke luft over noe som hører til teksten:
// "bottom" (ingenting under), "footer" (bare en løpende bunntekst eller en strek i sidens bunnmarg under) eller "box"
// (bunnkanten til boksen blokken står i).
function clearUnder(b, blocks, page, floor, geo, skip = null, x0 = b.left, x1 = b.right) {
  let below = null;
  for (let k = 0; k < blocks.length; k++) {
    const o = blocks[k];
    if ((!below || o.top > below.top) && o !== b && o.top < b.bottom && o.left < x1 && o.right > x0 && !(skip && skip.has(o))) below = o;
  }
  const edge = b.bottom - floor;
  const toBlock = below ? b.bottom - below.top : Infinity;
  const clear = Math.max(0, Math.min(b.bottom - page.view[1], edge, toBlock));
  // Det som står under: blokken, eller streken/kanten (dens bredde), eller sidens bunn.
  let tx0 = null;
  let tx1 = null;
  let top = null;
  let end = null;
  // Sidens bunnmarg: nederste 12 % av siden. En løpende bunntekst står der, med god luft over seg.
  const zone = page.view[1] + 0.12 * page.height;
  const margin = clear >= 1.5 * b.gap;
  if (toBlock <= edge && below) {
    tx0 = below.left;
    tx1 = below.right;
    top = below.top;
    // En fotnote eller annen tekst over bunnteksten er ikke bunnmarg: bunnteksten er det nederste på siden.
    if (margin && below.top <= zone && below.lines.length <= 3
      && (styleKey(below.style) !== styleKey(b.style) || below.size < b.size - 0.5)
      && !blocks.some((o) => o !== below && o.top < below.bottom && o.left < below.right && o.right > below.left)) end = "footer";
  } else if (edge < Infinity && geo) {
    for (const e of edgesIn(geo.h, floor - 1e-6, floor + 1e-6)) {
      if (Math.min(e.x1, x1) - Math.max(e.x0, x0) > 0) {
        tx0 = tx0 == null ? e.x0 : Math.min(tx0, e.x0);
        tx1 = tx1 == null ? e.x1 : Math.max(tx1, e.x1);
        const g = e.box;
        if (g && Math.abs(g.y0 - floor) < 1e-3 && g.x0 <= b.left + 1 && g.x1 >= b.right - 1 && g.y1 >= b.top - 1) end = "box";
      }
    }
    if (margin && floor <= zone) end = "footer";
    top = floor;
  } else end = "bottom";
  let own = clear;
  if (tx0 != null && clear < b.bottom - page.view[1]) {
    for (let k = 0; k < blocks.length; k++) {
      const p = blocks[k];
      if (p === b || p === below || (skip && skip.has(p)) || p.bottom <= top || p.left >= tx1 || p.right <= tx0) continue;
      own = Math.min(own, p.bottom - top);
    }
  }
  return { clear, own: Math.max(0, own), below: toBlock <= edge ? below : null, end };
}

// Rammen rundt blokken som den kan vokse i: vegger fra streker og bokser, tekst ved siden av og under, sidekanten.
function spaceAround(b, blocks, page, geo, obstacles, floors) {
  const size = b.size;
  const midY = (b.top + b.bottom) / 2;
  let x0 = -Infinity;
  let x1 = Infinity;
  let floor = -Infinity;
  // Cellen: loddrette streker eller boksekanter på begge sider som går langs hele blokken (tabellcelle, boks).
  let cl = -Infinity;
  let cr = Infinity;
  for (const e of geo.v) {
    if (e.y0 > midY + size * 0.3 || e.y1 < midY - size * 0.3) continue;
    const along = e.y0 <= b.bottom + size * 0.5 && e.y1 >= b.top - size * 0.5;
    if (e.x <= b.left + 0.5) {
      x0 = Math.max(x0, e.x);
      if (along) cl = Math.max(cl, e.x);
    } else if (e.x >= b.right - 0.5) {
      x1 = Math.min(x1, e.x);
      if (along) cr = Math.min(cr, e.x);
    }
  }
  // Med liten indre marg (ikke en ramme rundt hele siden); høyremargen regnes like stor som venstremargen.
  const inset = b.left - cl;
  b.cell = cl > -Infinity && cr < Infinity && cl >= x0 - 0.5 && cr <= x1 + 0.5 && inset <= Math.max(10, size * 1.5)
    ? { x0: cl, x1: cr, inner: cr - Math.max(1, inset) } : null;
  // Vannrett strek på samme linje (skjemafelt etter «E-post:»): teksten vokser ikke inn i den.
  let field = Infinity;
  for (const e of edgesIn(geo.h, b.bottom - size * 0.3, b.top)) {
    if (!e.thin) continue;
    if (e.x0 >= b.right - 0.5) field = Math.min(field, e.x0);
    else if (e.x1 <= b.left + 0.5) x0 = Math.max(x0, e.x1);
  }
  x1 = Math.min(x1, field);
  floor = floorUnder(b, geo);
  b.box = geo.boxes.find((g) => g.x0 <= b.left + 1 && g.x1 >= b.right - 1 && g.y0 <= b.bottom + 1 && g.y1 >= b.top - 1) || null;
  for (const o of obstacles) {
    if (o.y1 < b.bottom || o.y0 > b.top) continue;
    if (o.x1 <= b.left + 0.5) x0 = Math.max(x0, o.x1);
    else if (o.x0 >= b.right - 0.5) x1 = Math.min(x1, o.x0);
  }
  floors.set(b, floor);
  b.freeBelow = freeUnder(b, blocks, page, floor);
  const pad = (gap) => Math.min(Math.max(0, gap), size * 0.35, 4);
  const pageRight = Math.min(page.view[2] - 4, Math.max(page.contentRight, page.view[2] - (page.contentLeft - page.view[0])));
  const pageLeft = Math.max(page.view[0] + 4, page.contentLeft);
  b.wallRight = Math.min(pageRight, x1 - pad(x1 - b.right));
  b.fieldRule = field < Infinity && field <= x1 + 0.5;
  b.wallLeft = Math.max(pageLeft, x0 + pad(b.left - x0));
}

// Sidens (eller en rotert rammes) blokker. `turn` dreier grafikken inn i rammen.
function layoutFrame(page, items, turn) {
  const inked = items.filter((it) => it.str.trim());
  if (!inked.length) return [];
  page.contentRight = inked.reduce((m, it) => Math.max(m, it.x + it.w), -Infinity);
  page.contentLeft = inked.reduce((m, it) => Math.min(m, it.x), Infinity);
  const geo = geometryOf(page, page.graphics || [], turn);
  page.geo = geo;
  const lines = linesOf(items);
  // Vanlig linjeavstand på siden: i OCR-lag skiller større avstand listepunkter og avsnitt (kulepunktene er bare piksler).
  const pitches = lines.slice(1).map((L, k) => lines[k].y - L.y).filter((dy, k) => dy > 0 && dy <= 2 * lines[k + 1].size).sort((a, b) => a - b);
  geo.pitch = pitches.length ? pitches[pitches.length >> 1] : 0;
  markUnderlines(lines, geo);
  let fragments = fragmentsOf(lines, geo);
  // Teksten rett etter et kulepunkt/nummer på samme linje starter et nytt listepunkt (og et nytt avsnitt).
  // Et nummer uten punktum i en annen skrift enn teksten ved siden av («2  Beskytter mot …») er også nummerering.
  for (const b of fragments) {
    const text = b.runs.map((r) => r.text).join("").trim();
    if (!MARKER.test(text) && !/^\d{1,2}$/.test(text)) continue;
    const next = fragments.find((f) => f !== b && Math.abs(f.y - b.y) <= Math.max(b.size, f.size) * 0.5 && f.x > b.x
      && f.x - b.xEnd <= Math.max(b.size, f.size) * 3);
    if (!MARKER.test(text) && !(next && styleKey(next.style) !== styleKey(b.style))) continue;
    // «1) Utvid …» midt i et blokkjustert avsnitt: neste linje fortsetter fra nummerets x, uten hengende innrykk.
    // Da er nummeret en del av teksten.
    const below = next && fragments.find((f) => f !== b && f !== next && b.y - f.y > b.size * 0.5 && b.y - f.y <= b.size * 1.6
      && Math.abs(f.x - b.x) <= 2 && !MARKER.test(f.runs.map((r) => r.text).join("").trim()) && styleKey(f.style) === styleKey(next.style));
    if (below && next.xEnd >= below.xEnd - 2 && Math.abs(below.x - next.x) > 2) {
      pushRun(b.runs, " ", next.style);
      for (const r of next.runs) pushRun(b.runs, r.text, r.style, r.x, r.xEnd);
      for (const it of next.items) b.items.push(it);
      b.xEnd = next.xEnd;
      Object.assign(b, { y: next.y, size: next.size, style: dominant(b.runs), merged: true });
      next.gone = true;
      continue;
    }
    b.bullet = true;
    if (next) next.listStart = true;
  }
  fragments = fragments.filter((f) => !f.gone);
  const shapes = turn ? [] : page.shapes || [];
  for (const f of fragments) {
    if (!f.bullet && LIST_PREFIX.test(f.runs.map((r) => r.text).join(""))) f.listStart = true;
    // Kulepunkter tegnet som små figurer (vanlig fra nettlesere og Word) rett til venstre for linjen.
    if (shapes.some((s) => s.cx < f.x - f.size * 0.2 && s.cx > f.x - f.size * 3 && s.cy > f.y - f.size * 0.1 && s.cy < f.y + f.size * 0.8)) {
      f.listStart = true;
    }
  }
  fragments = attachDropCaps(fragments);
  const blocks = [];
  let active = [];
  for (const f of fragments) {
    active = active.filter((b) => b.lines[b.lines.length - 1].y - f.y <= b.size * LINE_GAP_MAX + 2);
    const target = active.filter((b) => canJoin(b, f, geo)).sort((a, b) => a.lines[a.lines.length - 1].y - b.lines[b.lines.length - 1].y)[0];
    if (target) {
      target.lines.push(f);
      target.gap = (target.lines[0].y - f.y) / (target.lines.length - 1);
      target.left = Math.min(target.left, f.x);
      target.right = Math.max(target.right, f.xEnd);
    } else {
      const b = { lines: [f], left: f.x, right: f.xEnd, size: f.size, gap: f.size * 1.2, invisible: Boolean(f.invisible), drop: f.drop };
      if (f.drop) b.left = Math.min(b.left, f.drop.x);
      blocks.push(b);
      active.push(b);
    }
  }
  for (const b of blocks) {
    b.style = dominant(b.lines.flatMap((l) => l.runs));
    b.top = Math.max(b.lines[0].y + b.size * 0.8, b.drop ? b.drop.y + b.drop.size * 0.7 : -Infinity);
    b.bottom = Math.min(b.lines[b.lines.length - 1].y - b.size * 0.25, b.drop ? b.drop.y - b.drop.size * 0.05 : Infinity);
    b.items = b.lines.flatMap((l) => l.items).concat(b.drop ? b.drop.items : []);
    b.op = minOf(b.items, (it) => it.op ?? Infinity);
    if (b.drop) {
      // Linjene ved siden av initialen: de innrykkede først i avsnittet (ellers de som når opp til initialens grunnlinje).
      const indented = b.lines.findIndex((l) => l.x <= b.left + 2);
      b.dropLines = indented > 0 ? indented : indented < 0 ? b.lines.length
        : b.lines.filter((l) => l.y + l.size * 0.7 > b.drop.y - b.drop.size * 0.05).length;
    }
  }
  const obstacles = [];
  if (!turn) {
    // Rotert tekst (loddrette etiketter, vannmerker) er også hindringer for vannrett tekst.
    for (const it of page.items) {
      if (Math.abs(it.angle) < 0.01 || !it.str.trim()) continue;
      const m = [Math.cos(it.angle), Math.sin(it.angle), -Math.sin(it.angle), Math.cos(it.angle), it.x, it.y];
      obstacles.push(boxOf(m, 0, -it.size * 0.25, it.w, it.size * 0.8));
    }
  }
  // Streken eller kanten rett under hver blokk (bare under oppsettet).
  const floors = new Map();
  for (const b of blocks) spaceAround(b, blocks, page, geo, obstacles, floors);
  // Tabellrad: celler side om side (felles strek mellom dem) med samme topp. Raden er allerede så høy som den høyeste
  // cellen, så den nederste blokken i hver celle kan bruke plassen ned til den laveste teksten i raden. En blokk med
  // mer tekst under seg i samme celle (tittel over tekst, innledning over punkter) beholder sin egen plass.
  const celled = blocks.filter((b) => b.cell).sort((a, b) => b.top - a.top || a.cell.x0 - b.cell.x0);
  const byTop = blocks.filter((b) => !b.angle).sort((a, b) => b.top - a.top);
  const inside = (o, c) => o.left >= c.x0 - 0.5 && o.right <= c.x1 + 0.5;
  for (let i = 0; i < celled.length;) {
    let j = i + 1;
    while (j < celled.length && Math.abs(celled[j].top - celled[i].top) <= Math.max(2, celled[i].size * 0.3)) j++;
    const band = celled.slice(i, j).sort((a, b) => a.cell.x0 - b.cell.x0);
    for (let k = 0; k < band.length;) {
      let end = band[k].cell.x1;
      let m = k + 1;
      while (m < band.length && band[m].cell.x0 <= end + 1.5) end = Math.max(end, band[m++].cell.x1);
      const row = band.slice(k, m);
      const top = maxOf(row, (o) => o.top) + Math.max(2, row[0].size * 0.3);
      // Radens blokker: også de som begynner lenger ned i en av cellene, men før radens laveste tekst (i synkende
      // rekkefølge etter topp, så radens laveste tekst bare kan flytte seg nedover).
      const members = [];
      let lowest = minOf(row, (o) => o.bottom);
      let n = 0;
      for (let hi = byTop.length; n < hi;) {
        const mid = (n + hi) >> 1;
        if (byTop[mid].top > top) n = mid + 1;
        else hi = mid;
      }
      for (; n < byTop.length && byTop[n].top > lowest; n++) {
        const o = byTop[n];
        if (!row.some((r) => inside(o, r.cell))) continue;
        members.push(o);
        lowest = Math.min(lowest, o.bottom);
      }
      for (const r of row) {
        const own = members.filter((o) => inside(o, r.cell) && !o.lines[0].bullet);
        const last = own.reduce((a, o) => (!a || o.bottom < a.bottom - 0.5 ? o : a), null);
        if (last) {
          last.freeBelow = Math.max(last.freeBelow, last.bottom - lowest);
          last.rowFree = last.bottom - lowest;
        }
      }
      k = m;
    }
    i = j;
  }
  // Blokkjusterte høyrekanter (fra avsnitt med minst tre linjer) avgjør om korte avsnitt også er blokkjustert.
  const justified = blocks.filter((b) => b.lines.length >= 3 && alignmentOf(b, page, blocks, []) === "justify").map((b) => b.right);
  // Avsnitt først: enkeltlinjer ser på om et avsnitt har samme venstrekant.
  const paragraphs = blocks.filter((b) => b.lines.length > 1);
  for (const b of paragraphs) b.align = alignmentOf(b, page, blocks, justified, paragraphs);
  for (const b of blocks) if (b.lines.length === 1) b.align = alignmentOf(b, page, blocks, justified, paragraphs);
  // Plass å vokse i sideveis: til neste tekst på samme høyde (delt på midten hvis den også kan vokse mot oss).
  for (const b of blocks) {
    const band = blocks.filter((o) => o !== b && o.top > b.bottom && o.bottom < b.top);
    b.maxRight = minOf(band.filter((o) => o.left >= b.right - 1),
      (o) => (o.align === "left" || o.align === "justify" ? o.left - b.size * 0.5 : (b.right + o.left) / 2), b.wallRight);
    b.minLeft = maxOf(band.filter((o) => o.right <= b.left + 1),
      (o) => (o.align === "right" ? o.right + b.size * 0.5 : (o.right + b.left) / 2), b.wallLeft);
    // En blokk i en spalte (overskrift, tabellcelle, adresse) vokser ikke forbi spaltens høyrekant når det står
    // tekst ved siden av.
    if (band.some((o) => o.left >= b.right - 1)) {
      const col = paragraphs.filter((o) => o !== b && Math.abs(o.left - b.left) <= 2 && o.right > b.right).map((o) => o.right);
      if (col.length) b.maxRight = Math.min(b.maxRight, maxOf(col) + 1);
    }
    b.maxRight = Math.max(b.maxRight, b.right);
    b.minLeft = Math.min(b.minLeft, b.left);
    // Spaltens bredde: det bredeste avsnittet med samme venstrekant (grensen for adresser o.l. som får vokse).
    const column = paragraphs.filter((o) => o !== b && Math.abs(o.left - b.left) <= 2 && (o.align === "left" || o.align === "justify"))
      .map((o) => o.right);
    b.colRight = column.length ? maxOf(column, null, b.right) : null;
  }
  for (const b of blocks) {
    b.segments = segmentsOf(b);
    if (b.lines[0].bullet) for (const s of b.segments) s.fixed = true;
    b.lower = /^\p{Ll}/u.test(b.lines[0].runs[0].text);
  }
  linkStacks(blocks, geo, page, floors, obstacles);
  return blocks;
}

// Avslutningen i et brev (hilsen foran plass til underskrift).
const CLOSING = /^((med )?(vennlig|vennleg|venlig|beste|hjertelig|kjærlig)?\s*(hilsen|helsing|hilsner)|mvh\b|vh\b|(yours|sincerely|respectfully|cordially|cordialement|atentamente)\b|((kind|best|warm|warmest) )?regards\b|(with )?best wishes|mit freundlichen grüßen|viele grüße|(med )?vänliga hälsningar|с уважением)/i;

// Avsnitt i samme spalte eller boks med samme stil som står rett under hverandre (vanlig avsnittsavstand, ingenting
// imellom): b.below er neste avsnitt. Slike avsnitt settes som én flyt når oversettelsen skrives (se stackPlans). Et
// enkelt avsnitt over flere linjer (b.solo, ikke i en tabellcelle) settes etter de samme reglene, så like avsnitt på
// samme side får samme behandling.
// Flyten flytter bare avsnitt inn i plass som sikkert er ledig. Alle mål gjelder hele bredden avsnittet kan få når det
// settes (spanOf), ikke bare den opprinnelige:
// - stackFree: hvor langt avsnittet kan skyves ned. Det er plassen under det når de andre avsnittene i flyten ikke
//   teller (de flyttes med; skyves et bredt avsnitt ned forbi et smalere siste avsnitt, må det ha plass også ved siden
//   av). Luften ned mot det som hører til teksten under (tekst, strek, boks, fotnote, overskrift, plass til
//   underskrift) blir aldri mindre enn i originalen; av mer enn fire linjer kan det som er utover fire linjer, brukes.
//   Luften der teksten slutter (ingenting under, bare en løpende bunntekst i sidens bunnmarg, eller bunnen av boksen
//   teksten står i) kan brukes som ledig plass: der beholdes bare en bunnmarg (endReserve). I en tabellcelle kan
//   plassen ned til radens laveste tekst brukes (rowFree).
// - stackLoose: det samme, men halvparten av luften (minst en halv linjeavstand) beholdes. Brukes bare når flyten
//   ellers måtte fått tettere linjer eller mindre skrift, og da bare så mye som trengs (se stackPlans).
// - stackUp: hvor langt avsnittet kan trekkes opp når avsnittene over blir kortere. Står noe annet i området over det
//   (en stor initial, et ikon, tekst ved siden av avsnittet over, en strek), holdes minst den opprinnelige avstanden
//   til det.
// - endFree/endLoose: det samme når avsnittet er det siste som flyttes.
// - flowWhite: den ledige plassen der teksten slutter under flyten og følgerne, utover bunnmargen (se stackPlans).
// Et kort siste avsnitt (én linje) hører til flyten, men ikke en avslutning i et brev (se closing): den står fast.
// Står noe annet rett under flyten i samme spalte (en overskrift, en merknad, neste flyt), er det en følger
// (b.follow): den skyves ned som den er når flyten trenger plassen, så luften over den blir som før.
function linkStacks(blocks, geo, page, floors, obstacles = []) {
  const body = (b) => !b.invisible && !b.lines[0].bullet && !b.lines[0].listStart && (b.align === "left" || b.align === "justify");
  const sameCell = (a, b) => (a.cell && b.cell ? Math.abs(a.cell.x0 - b.cell.x0) <= 1 && Math.abs(a.cell.x1 - b.cell.x1) <= 1 : !a.cell && !b.cell);
  const last = (b) => b.lines[b.lines.length - 1];
  const lineText = (l) => l.runs.map((r) => r.text).join("").trim();
  const order = blocks.filter(body).sort((a, b) => b.top - a.top);
  const all = blocks.slice().sort((a, b) => b.top - a.top);
  // Avslutning i et brev: én kort linje som slutter med komma eller er en vanlig hilsen, eller som har mye mer luft
  // under seg enn over seg og et kort navn under seg (plass til underskrift). Slutten av teksten er ikke en avslutning.
  const closing = (c, above) => {
    if (c.lines.length !== 1) return false;
    const text = lineText(c.lines[0]);
    if (text.length > 60) return false;
    if (/,$/.test(text) || CLOSING.test(text)) return true;
    const { clear, below, end } = clearUnder(c, blocks, page, floors.get(c), geo);
    return !end && Boolean(below) && clear > 1.5 * Math.max(above, c.size * 0.5) && below.size <= c.size * 1.15
      && lineText(below.lines[0]).length <= 40;
  };
  order.forEach((a, n) => {
    const width = a.right - a.left;
    let best = null;
    for (let k = n + 1; k < order.length; k++) {
      const b = order[k];
      if (b.top < last(a).y - a.gap * 3) break;
      const d = last(a).y - b.lines[0].y;
      if (d > a.gap * 3 || b.above || b.drop || b.top >= a.bottom || Math.abs(b.left - a.left) > 2 || d < a.gap * 0.9) continue;
      if (styleKey(b.style) !== styleKey(a.style) || b.box !== a.box || !sameCell(a, b)) continue;
      // Samme bredde; en enkelt linje (kort siste avsnitt) kan være smalere, men ikke bredere enn spalten.
      const multi = [a, b].filter((x) => x.lines.length > 1);
      if (!multi.length) continue;
      if (multi.length === 2 ? Math.abs(b.right - a.right) > Math.max(6, 0.15 * width)
        : (a.lines.length > 1 ? b.right > a.right + 2 : a.right > b.right + 2)) continue;
      best = b;
      break;
    }
    if (!best) return;
    const x0 = Math.min(a.left, best.left);
    const x1 = Math.max(a.right, best.right);
    // Ingen annen tekst eller strek imellom (blokkene med topp mellom de to ligger samlet i den sorterte listen).
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid].top > a.top) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < all.length && all[k].top > best.top; k++) {
      const o = all[k];
      if (o !== a && o.left < x1 && o.right > x0 && o.bottom < a.bottom) return;
    }
    // Et kort siste avsnitt med noe ved siden av seg innenfor spaltens bredde (hilsen med sted og dato på samme linje)
    // hører ikke til flyten.
    if (best.right < a.right - 2 && blocks.some((o) => o !== a && o !== best && o.top > best.bottom && o.bottom < best.top
      && o.left < a.right && o.right > best.right)) return;
    if (edgesIn(geo.h, best.top - 0.5, a.bottom + 0.5).some((e) => Math.min(e.x1, x1) - Math.max(e.x0, x0) > 4)) return;
    if (closing(best, a.bottom - best.top)) return;
    a.below = best;
    best.above = a;
  });
  // Plassen under avsnittet innenfor bredden x0–x1: `skip` er flyten (avsnittene under flyttes med), eller null når
  // avsnittet er det siste som flyttes (også når neste avsnitt i flyten står urørt fordi teksten ikke er endret).
  const allow = (b, skipSet, [x0, x1]) => {
    const floor = x0 === b.left && x1 === b.right ? floors.get(b) : floorUnder(b, geo, x0, x1);
    const free = Math.max(freeUnder(b, blocks, page, floor, skipSet, x0, x1), skipSet ? 0 : b.rowFree || 0);
    const { clear, own, end } = clearUnder(b, blocks, page, floor, geo, skipSet, x0, x1);
    // Luften over det som står under, blir ikke mindre enn den var (står en nabospalte lavere over det samme, kan
    // avsnittet komme ned dit), og av mer enn fire linjer beholdes fire. Der teksten slutter, beholdes en bunnmarg.
    // Over en løpende bunntekst beholdes minst en linjeavstand (eller hele luften hvis den var mindre).
    const reserve = end === "footer" ? Math.max(endReserve(b, clear), Math.min(clear, b.gap))
      : end === "box" ? endReserve(b, clear) : Math.min(own, 4 * b.gap);
    const strict = Math.min(free, Math.max(b.rowFree || 0, clear - reserve));
    // Før linjene blir tettere enn 5 % eller skriften mindre: halvparten av luften, og minst en halv linjeavstand
    // (eller hele luften hvis den var mindre), beholdes.
    const keep = Math.max(own * 0.5, Math.min(own, b.gap * 0.5));
    const loose = Math.max(strict, Math.min(free, clear - Math.min(4 * b.gap, keep)));
    // Siste utvei før skriften blir mindre (se stackPlans): minst en halv linjeavstand, målt fra underlengdene som i
    // freeUnder (eller hele luften hvis den var mindre), beholdes.
    const urgent = Math.max(loose, Math.min(free, clear - Math.min(4 * b.gap, own, b.gap * 0.5 - b.size * 0.03)));
    return { strict, loose, urgent, end };
  };
  const chains = [];
  for (const head of blocks) {
    if (!head.below || head.above) continue;
    const chain = [];
    for (let b = head; b && !chain.includes(b); b = b.below) chain.push(b);
    chains.push(chain);
  }
  for (const b of blocks) {
    if (b.below || b.above || !body(b) || b.lines.length < 2 || b.cell) continue;
    b.solo = true;
    chains.push([b]);
  }
  // Følger: det som står rett under en flyts siste avsnitt, innenfor spalten (eller i samme boks), og ikke et
  // listepunkt, en initial eller en avslutning: en overskrift, en merknad eller neste flyt. Den hører til den samme
  // spalteflyten (unit: følgeren og, er den første avsnitt i en flyt, resten av den flyten) og skyves ned som den er når
  // flyten over trenger plassen (se stackPlans). Ingenting annet står ved siden av noe i den.
  const follower = (e, [x0, x1]) => {
    const under = clearUnder(e, blocks, page, floorUnder(e, geo, x0, x1), geo, null, x0, x1);
    const f = under.end ? null : under.below;
    if (!f || f.invisible || f.lines[0].bullet || f.lines[0].listStart || f.drop || f.above || f.leader || f.angle) return null;
    // Følgeren begynner under det siste avsnittet (innenfor dets egen bredde), ikke i en nabospalte.
    if (f.box !== e.box || !sameCell(e, f) || e.bottom - f.top > 3 * e.gap || f.left < x0 - 2 || f.left >= e.right - 1) return null;
    if (f.right > x1 + Math.max(2, 0.1 * (x1 - x0)) && !(f.box && e.box === f.box)) return null;
    if (closing(f, e.bottom - f.top)) return null;
    const unit = units.get(f) || [f];
    const c0 = Math.min(x0, minOf(unit, (m) => m.left));
    const c1 = Math.max(x1, maxOf(unit, (m) => m.right));
    const beside = (m) => blocks.some((o) => o !== e && !unit.includes(o) && o.top > m.bottom && o.bottom < m.top && o.left < c1 && o.right > c0);
    return unit.some(beside) ? null : unit;
  };
  // Flytene (og enkeltavsnittene) etter hverandre i spalten: hver enhets siste blokk kan ha en følger.
  const units = new Map(chains.map((c) => [c[0], c]));
  for (const chain of chains) {
    // Et kort avsnitt i flyten blir ikke bredere enn spalten (flytens bredeste avsnitt eller det bredeste avsnittet med
    // samme venstrekant på siden).
    if (chain.length > 1) {
      const col = maxOf(chain.filter((b) => b.lines.length > 1), (b) => b.right);
      for (const b of chain) if (b.lines.length === 1) b.growRight = Math.max(col, b.colRight ?? -Infinity);
    }
  }
  const queue = chains.slice();
  for (let k = 0; k < queue.length; k++) {
    const tail = queue[k][queue[k].length - 1];
    const unit = follower(tail, spanOf(tail));
    if (!unit) continue;
    tail.follow = unit[0];
    unit[0].leader = tail;
    if (!units.has(unit[0])) {
      units.set(unit[0], unit);
      queue.push(unit);
    }
  }
  // Alt som flyttes med når enheten skyves ned: enheten selv og følgerne under den.
  const flowOf = (unit) => {
    const out = new Set(unit);
    for (let t = unit[unit.length - 1].follow; t && units.has(t) && !out.has(t); t = units.get(t)[units.get(t).length - 1].follow) {
      for (const m of units.get(t)) out.add(m);
    }
    return out;
  };
  for (const unit of units.values()) {
    const skip = flowOf(unit);
    const tail = unit[unit.length - 1];
    unit.forEach((b, k) => {
      const span = spanOf(b);
      const end = allow(b, null, span);
      [b.endFree, b.endLoose, b.endUrgent] = [end.strict, end.loose, end.urgent];
      const mid = k === unit.length - 1 && !tail.follow ? end : allow(b, skip, span);
      [b.stackFree, b.stackLoose, b.stackUrgent] = [mid.strict, mid.loose, mid.urgent];
      b.stackUp = k ? roomAbove(b, unit, skip, blocks, geo, obstacles, span) : 0;
    });
    // Ledig plass lenger ned i spalten som flyten kan nå: luften der teksten slutter under flytens siste følger (ikke
    // plass til underskrift, som står fast), utover bunnmargen.
    let end = tail;
    for (const seen = new Set(); end.follow && units.has(end.follow) && !seen.has(end.follow);) {
      seen.add(end.follow);
      const u = units.get(end.follow);
      end = u[u.length - 1];
    }
    const cu = clearUnder(end, blocks, page, floors.get(end), geo);
    unit[0].flowWhite = !cu.end ? 0 : cu.end === "bottom" ? cu.clear - Math.min(cu.own, 4 * end.gap)
      : cu.clear - Math.max(endReserve(end, cu.clear), cu.end === "footer" ? Math.min(cu.clear, end.gap) : 0);
  }
}

// Hvor langt et avsnitt i en flyt kan trekkes opp (se linkStacks): mot det nærmeste som ikke hører til flyten og står
// over avsnittet, innenfor flytens høyde og bredden avsnittet kan få (x0–x1), minus den opprinnelige luften over det.
function roomAbove(b, chain, skip, blocks, geo, obstacles, [x0, x1] = [b.left, b.right]) {
  const head = chain[0].top;
  let low = Infinity;
  const hit = (bottom) => {
    if (bottom < low) low = bottom;
  };
  const across = (a0, a1) => Math.min(a1, x1) - Math.max(a0, x0) > 0.5;
  // Rammer som omslutter avsnittet (bakgrunnen det står på, tabellcellen), er ikke i veien.
  const around = (g) => g.x0 <= x0 + 1 && g.x1 >= x1 - 1 && g.y0 <= b.bottom + 1 && g.y1 >= b.top - 1;
  for (let k = 0; k < blocks.length; k++) {
    const o = blocks[k];
    if (!skip.has(o) && o.top > b.top && o.bottom < head && across(o.left, o.right)) hit(o.bottom);
  }
  // Stor initial i et avsnitt over (den står fast når teksten ved siden av blir kortere).
  for (const o of chain) {
    if (o === b || !o.drop) continue;
    const bottom = o.drop.y - o.drop.size * 0.05;
    const right = o.lines.find((l) => l.x > o.drop.x + 2)?.x ?? o.drop.x + o.drop.size * 0.7;
    if (o.drop.y + o.drop.size * 0.7 <= b.top || !across(o.drop.x, right)) continue;
    hit(bottom);
  }
  for (const e of edgesIn(geo.h, b.top, head)) {
    if (!(e.box && around(e.box)) && Math.min(e.x1, x1) - Math.max(e.x0, x0) > 4) hit(e.y);
  }
  for (const e of geo.v) {
    if (e.x > x0 + 0.5 && e.x < x1 - 0.5 && e.y1 > b.top && e.y0 < head && !(e.box && around(e.box))) hit(Math.max(b.top, e.y0));
  }
  for (const list of [geo.boxes, obstacles]) {
    for (let k = 0; k < list.length; k++) {
      const g = list[k];
      if (g.y1 > b.top && g.y0 < head && across(g.x0, g.x1) && !around(g)) hit(Math.max(b.top, g.y0));
    }
  }
  if (low === Infinity) return Infinity;
  const white = Math.max(b.above ? b.above.bottom - b.top : 0, b.size * 0.2);
  return Math.max(0, low - b.top - white);
}

// Etter oppsettet trengs verken grafikkens kanter, tekstbitene per linje eller stilbitene (de er blitt til segmenter).
// Ved innsamling av tekst trengs heller ikke tekstbitene og grafikken. Ved skriving trengs bare fyll, bilder og
// understreking, og for hver blokk bare hvilke tekstoperatorer den består av (b.ops, b.gaps) og om alle er kjent
// (b.exact); understrekingen vet hvilke blokker den hører til (g.owners).
function release(page, blocks, collect) {
  page.geo = undefined;
  for (const b of blocks) {
    for (const l of b.lines) {
      l.runs = undefined;
      l.items = undefined;
    }
  }
  // Tekstoperatorene og skjemaobjektene hver blokk består av. Ved innsamling trengs de bare på sider som tegner
  // skjemaobjekter (se freezeForms: ellers kan ingen tekst der stå urørt).
  const light = collect && !(page.formDraws && page.formDraws.length);
  const owner = new Map();
  for (const b of blocks) {
    if (light) {
      b.ops = b.gaps = b.forms = [];
      b.items = undefined;
      if (b.drop) b.drop.items = undefined;
      continue;
    }
    const ops = new Set();
    const gaps = new Map();
    const forms = new Set();
    for (const it of b.items) {
      if (!collect) owner.set(it, b);
      // En bit uten sikker kobling: hullet den står i (se looseSources).
      const loose = it.sops ? null : it.loose;
      if (it.sops) for (let n = Math.max(0, it.sops[0]); n <= it.sops[1]; n++) ops.add(n);
      else if (loose && loose.page && loose.ops) gaps.set(loose.ops.join(), loose.ops);
      for (const f of it.forms || (loose && loose.forms) || []) forms.add(f);
    }
    // Tekstoperatorene i sidens strøm (b.ops) og hullene med operatorer der tekst uten sikker kobling kan stå (b.gaps:
    // [første, siste]).
    b.ops = [...ops];
    b.gaps = [...gaps.values()];
    // Skjemaobjektene blokkens tekst er tegnet i, eller kan være tegnet i (tegnenummer i scan.formDraws).
    b.forms = [...forms];
    b.exact = b.items.every((it) => it.sops && it.sops[0] >= 0);
    // Det er kjent hvor teksten står, så den kan stå urørt: i et skjemaobjekt eller i kjente tekstoperatorer i sidens
    // strøm (for en bit uten sikker kobling: operatorene i hullet, eller skjemaobjekter som kan stave den).
    b.keepable = b.items.every((it) => (it.forms && it.forms.length) || (it.sops && it.sops[0] >= 0)
      || (!it.sops && it.loose && !it.loose.unknown && (it.loose.page ? Boolean(it.loose.ops) : it.loose.forms.length > 0)));
    // Noe av teksten står (eller kan stå) i sidens egen strøm, ikke i et skjemaobjekt.
    b.pagePart = b.items.some((it) => (it.sops ? !(it.forms && it.forms.length)
      : !it.loose || it.loose.page || it.loose.unknown || !it.loose.forms.length));
    b.items = undefined;
    if (b.drop) b.drop.items = undefined;
  }
  if (collect) {
    page.items = [];
    page.graphics = [];
    page.shapes = [];
    page.advances = null;
    return;
  }
  page.graphics = (page.graphics || []).filter((g) => g.fill || g.image || g.under);
  for (const g of page.graphics) {
    if (!g.under) continue;
    g.owners = g.under.every((it) => owner.has(it)) ? [...new Set(g.under.map((it) => owner.get(it)))] : null;
    g.under = true;
  }
  page.items = [];
}

// Understreking tegnet som strek rett under teksten: ordene får stilen `underline`, og streken er ikke en hindring.
function markUnderlines(lines, geo) {
  const thin = geo.h.filter((e) => e.thin);
  if (!thin.length) return;
  const used = new Set();
  for (const L of lines) {
    const items = L.items.filter((it) => it.str.trim());
    for (const r of edgesIn(thin, L.y - L.size * 0.3, L.y - L.size * 0.02)) {
      // Et tegn som bare så vidt når inn på streken (punktum eller komma rett etter de understrekede ordene), er ikke
      // understreket og hindrer ikke at streken fjernes.
      const overlap = (it) => Math.min(r.x1, it.x + it.w) - Math.max(r.x0, it.x);
      const touched = items.filter((it) => overlap(it) > Math.max(0.5, Math.min(1, 0.25 * it.w)));
      if (!touched.length) continue;
      const from = minOf(touched, (it) => it.x);
      const to = maxOf(touched, (it) => it.x + it.w);
      if (r.x0 < from - 1.5 || r.x1 > to + 1.5) continue;
      used.add(r);
      const full = touched.filter((it) => overlap(it) >= 0.6 * it.w);
      for (const it of full) it.style.underline = true;
      if (full.length === touched.length && r.g.pop >= 0) r.g.under = full;
    }
  }
  geo.h = geo.h.filter((e) => !used.has(e));
}

function layoutPage(page) {
  const groups = new Map();
  for (const it of page.items) {
    const key = Math.abs(it.angle) < 0.01 ? 0 : Math.round((it.angle * 180) / Math.PI * 2) / 2;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const blocks = layoutFrame(page, groups.get(0) || [], null);
  // Rotert tekst: dreies inn i sin egen ramme, legges ut som vanlig tekst og tegnes dreid tilbake.
  for (const [deg, items] of groups) {
    if (!deg || !items.some((it) => it.str.trim())) continue;
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const turn = [c, -s, s, c, 0, 0];
    const turned = items.map((it) => {
      const [x, y] = apply(turn, it.x, it.y);
      return { ...it, x, y, angle: 0 };
    });
    const right = Math.abs(deg % 90) < 0.01;
    const view = boxOf(turn, page.view[0], page.view[1], page.view[2], page.view[3]);
    const frame = {
      view: [view.x0, view.y0, view.x1, view.y1], width: view.x1 - view.x0, height: view.y1 - view.y0,
      items: turned, graphics: right ? page.graphics : [], shapes: [],
    };
    const turnedBlocks = layoutFrame(frame, turned, right ? turn : [1, 0, 0, 1, 0, 0]);
    for (const b of turnedBlocks) {
      b.angle = a;
      // Enkeltstående etiketter og vannmerker krympes heller enn å brytes.
      if (turnedBlocks.length <= 3 && b.lines.length === 1) b.freeBelow = 0;
      blocks.push(b);
    }
  }
  return blocks;
}

// ---- Skriving (pdf-lib) ----

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const PATH_OPS = new Set(["m", "l", "c", "v", "y", "h", "re"]);
const PAINT_OPS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);

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

// Fjerner tekstoperatorene (Tj, TJ, ', ") fra en innholdsstrøm; alt annet (grafikk, bilder, tilstand) står igjen.
// `keep` er tekstoperatorer (nummerert i rekkefølge) som skal stå (uendret tekst), `cutPaths` stier (nummerert etter
// maleoperator) som skal bort (understreking som tegnes på nytt under oversettelsen).
// Returnerer også hvor mange q som står åpne til slutt, så tegningen vår ikke arver en endret koordinattransform.
// `advances[n]` er forflytningen til tekstoperator n (som TJ-tall): en fjernet operator som står foran en beholdt
// operator på samme linje (uten ny posisjonering imellom), erstattes av `[n] TJ`, så den beholdte teksten ikke flytter seg.
function stripText(src, { keep, cutPaths, advances } = {}) {
  const cuts = [];
  let pending = [];
  let i = 0;
  let depth = 0;
  let operands = -1;
  let open = 0;
  let shows = 0;
  let paints = 0;
  let pathStart = -1;
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
      if (tok === "Tj" || tok === "TJ" || tok === "'" || tok === '"') {
        const line = tok === "'" || tok === '"';
        // ' og " flytter først til neste linje (relativt til linjestarten), så de avhenger ikke av tidligere tekst.
        if (line) pending = [];
        if (!(keep && keep.has(shows))) {
          let replacement = line ? "T*" : "";
          if (tok === '"') {
            // aw ac (tekst) " setter også ord- og tegnavstand; det gjelder videre for teksten som står igjen.
            const m = /^\s*([-+]?[\d.]+)\s+([-+]?[\d.]+)/.exec(Buffer.from(src.subarray(from, i)).toString("latin1"));
            if (m) replacement = `${m[1]} Tw ${m[2]} Tc T*`;
          }
          cuts.push([from, i, replacement, shows]);
          pending.push(cuts[cuts.length - 1]);
        } else {
          for (const cut of pending) {
            const n = advances ? advances[cut[3]] : NaN;
            if (Number.isFinite(n) && Math.abs(n) > 0.005) cut[2] += ` [${num(n)}] TJ`;
          }
          pending = [];
        }
        shows++;
      } else if (tok === "Td" || tok === "TD" || tok === "Tm" || tok === "T*" || tok === "BT" || tok === "ET") {
        pending = [];
      } else if (PATH_OPS.has(tok)) {
        if (pathStart < 0) pathStart = from;
      } else if (PAINT_OPS.has(tok)) {
        if (cutPaths && cutPaths.has(paints) && pathStart >= 0) cuts.push([pathStart, i, tok === "n" ? "n" : ""]);
        paints++;
        pathStart = -1;
      } else if (tok === "q") open++;
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
  return { bytes: Buffer.concat(parts.map((p) => Buffer.from(p))), open, removed: cuts.length, shows, paints };
}

function streamBytes(lib, stream) {
  if (stream instanceof lib.PDFRawStream) return lib.decodePDFRawStream(stream).decode();
  if (typeof stream.getUnencodedContents === "function") return stream.getUnencodedContents();
  throw new Error("Ukjent strømtype");
}

// Navnene på XObjects som tegnes med «Do» i en innholdsstrøm, i rekkefølge.
function doNames(src) {
  const names = [];
  let name = null;
  let depth = 0;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (WS.has(c)) i++;
    else if (c === 0x25) {
      while (i < src.length && src[i] !== 10 && src[i] !== 13) i++;
    } else if (c === 0x28) {
      i = skipString(src, i);
      name = null;
    } else if (c === 0x3c) {
      if (src[i + 1] === 0x3c) {
        depth++;
        i += 2;
      } else {
        while (i < src.length && src[i] !== 0x3e) i++;
        i++;
      }
      name = null;
    } else if (c === 0x3e) {
      if (src[i + 1] === 0x3e) i++;
      depth = Math.max(0, depth - 1);
      i++;
    } else if (c === 0x5b) {
      depth++;
      i++;
    } else if (c === 0x5d) {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (c === 0x7b || c === 0x7d || c === 0x29) i++;
    else {
      const start = i;
      if (c === 0x2f) i++;
      while (i < src.length && !WS.has(src[i]) && !DELIM.has(src[i])) i++;
      if (depth > 0) continue;
      const tok = c === 0x2f ? Buffer.from(src.subarray(start, i)).toString("latin1") : String.fromCharCode(...src.subarray(start, Math.min(i, start + 8)));
      if (c === 0x2f) name = tok.slice(1).replace(/#([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
      else if (/^[+\-.\d]/.test(tok) || tok === "true" || tok === "false" || tok === "null") name = null;
      else {
        if (tok === "Do" && name != null) names.push(name);
        else if (tok === "BI") i = skipInlineImage(src, i);
        name = null;
      }
    }
  }
  return names;
}

// Skjemaobjektene (Form XObjects) en innholdsstrøm tegner, også inni hverandre, dybde først i tegnerekkefølge: samme
// rekkefølge som i pdf.js sin operatorliste (se scanOps). Hver tegning gir referansens nøkkel (null: ikke en referanse).
function formDrawsOf(lib, context, src, resources, out = [], path = []) {
  const xobjects = resources && resources.lookupMaybe(lib.PDFName.of("XObject"), lib.PDFDict);
  if (!xobjects) return out;
  for (const name of doNames(src)) {
    const raw = xobjects.get(lib.PDFName.of(name));
    const stream = raw instanceof lib.PDFRef ? context.lookup(raw) : raw;
    if (!stream || !stream.dict || stream.dict.lookup(lib.PDFName.of("Subtype")) !== lib.PDFName.of("Form")) continue;
    const key = raw instanceof lib.PDFRef ? raw.toString() : null;
    if (key && path.includes(key)) continue;
    out.push(key);
    const inner = stream.dict.lookupMaybe(lib.PDFName.of("Resources"), lib.PDFDict) || resources;
    formDrawsOf(lib, context, streamBytes(lib, stream), inner, out, [...path, key]);
  }
  return out;
}

// Alle skjemaobjekter som kan nås fra ressursene (nøkler).
function formsIn(lib, context, resources, out = new Set()) {
  const xobjects = resources && resources.lookupMaybe(lib.PDFName.of("XObject"), lib.PDFDict);
  if (!xobjects) return out;
  for (const [, ref] of xobjects.entries()) {
    if (!(ref instanceof lib.PDFRef) || out.has(ref.toString())) continue;
    const stream = context.lookup(ref);
    if (!stream || !stream.dict || stream.dict.lookup(lib.PDFName.of("Subtype")) !== lib.PDFName.of("Form")) continue;
    out.add(ref.toString());
    formsIn(lib, context, stream.dict.lookupMaybe(lib.PDFName.of("Resources"), lib.PDFDict), out);
  }
  return out;
}

// Hvilke skjemaobjekter teksten kan fjernes fra: bare de som tegnes, og ikke de med tekst i et skjult lag (på noen
// side; den står da urørt i laget). Tegningene fra pdf.js (meta.formDraws) kobles til referansene i samme rekkefølge.
// Stemmer ikke antallet, og har siden skjult tekst i et skjemaobjekt, står alle sidens skjemaobjekter urørt.
// `pages[n]`: { refs (referanse per tegning, eller null når koblingen er usikker), all (alle skjemaobjekter siden når) }.
function planForms(lib, doc, pages) {
  const untouched = new Set();
  const out = pages.map((meta, n) => {
    const page = doc.getPage(n);
    const draws = meta.formDraws || [];
    let refs = null;
    let all = new Set();
    try {
      const resources = page.node.Resources();
      all = formsIn(lib, doc.context, resources);
      if (all.size) refs = formDrawsOf(lib, doc.context, contentOf(lib, doc.context, page), resources);
    } catch {
      refs = null;
    }
    if (refs && refs.length !== draws.length) refs = null;
    if (refs) draws.forEach((d, i) => d.hidden && refs[i] && untouched.add(refs[i]));
    else if (draws.some((d) => d.hidden)) for (const key of all) untouched.add(key);
    return { refs, all, uncertain: !refs && draws.some((d) => d.hidden) };
  });
  return { pages: out, untouched };
}

// Tekst som står urørt fordi den ligger i et skjemaobjekt som ikke kan endres (tekst i et skjult lag), avgjøres for
// hele dokumentet før teksten samles inn, så den verken sendes til oversettelse eller tegnes på nytt (b.frozen), og
// så et skjemaobjekt bare får teksten fjernet når alt som tegnes fra det, tegnes på nytt:
// - et skjemaobjekt med tekst i et skjult lag står urørt (planForms);
// - en blokk med tekst fra et skjemaobjekt som står urørt, står urørt. For tekst uten sikker kobling (se looseSources)
//   regnes bare skjemaobjekter som tegnes synlig på siden og har tegn i hullet som kan stave teksten; et vannmerke i et
//   skjult lag eller et skjema med annen tekst er ikke kilden;
// - blokker som deler tekstoperatorer (eller et hull med usikker tekst) med en urørt blokk, står også urørt;
// - alle skjemaobjektene en urørt blokk har (eller kan ha) tekst fra, står da urørt (er det ukjent hvilke, alle siden
//   når), og det kan igjen gjøre blokker på andre sider urørte;
// - den delen av en urørt blokk som står i sidens egen strøm, beholdes (tekstoperatorene, se writePdf). Bare når det
//   er umulig (antallet tekstoperatorer stemmer ikke med det pdf.js så, eller det er ukjent hvor teksten står), står
//   hele siden urørt (pages[n].frozen): ingen tekst fjernes og ingenting tegnes på nytt der.
// Returnerer skjemaobjektene som står urørt (nøkler), eller null når ingenting står urørt.
function freezeForms(lib, doc, pages, blocksPerPage) {
  const forms = planForms(lib, doc, pages);
  const untouched = forms.untouched;
  if (!untouched.size) return null;
  const showsOk = new Map();
  const matched = (n) => {
    if (!showsOk.has(n)) {
      let ok = false;
      try {
        ok = stripText(contentOf(lib, doc.context, doc.getPage(n))).shows === pages[n].shows;
      } catch {
        ok = false;
      }
      showsOk.set(n, ok);
    }
    return showsOk.get(n);
  };
  const add = (keys) => {
    let grew = false;
    for (const k of keys) {
      if (k != null && !untouched.has(k)) {
        untouched.add(k);
        grew = true;
      }
    }
    return grew;
  };
  for (let grew = true; grew;) {
    grew = false;
    blocksPerPage.forEach((blocks, n) => {
      const { refs, all } = forms.pages[n];
      // Skjemaobjektene blokkens tekst kommer (eller kan komme) fra (null: ukjent, et av dem siden når).
      const sources = (b) => (refs ? b.forms.map((f) => refs[f]) : null);
      const hit = (b) => {
        if (!b.forms.length) return false;
        const src = sources(b);
        return src ? src.some((k) => k == null || untouched.has(k)) : [...all].some((k) => untouched.has(k));
      };
      let changed = false;
      for (const b of blocks) {
        if (!b.frozen && (pages[n].frozen || hit(b))) b.frozen = changed = true;
      }
      if (!changed) return;
      for (let again = true; again;) {
        again = false;
        const held = new Set();
        for (const b of blocks) {
          if (!b.frozen) continue;
          for (const s of b.ops) held.add(s);
          for (const [lo, hi] of b.gaps) for (let s = lo; s <= hi; s++) held.add(s);
        }
        const inGap = ([lo, hi]) => {
          for (let s = lo; s <= hi; s++) if (held.has(s)) return true;
          return false;
        };
        for (const b of blocks) {
          if (!b.frozen && (b.ops.some((s) => held.has(s)) || b.gaps.some(inGap))) b.frozen = again = true;
        }
      }
      for (const b of blocks) {
        if (!b.frozen) continue;
        if (add(sources(b) || all)) grew = true;
        if (b.pagePart && !(b.keepable && matched(n)) && !pages[n].frozen) {
          pages[n].frozen = true;
          for (const o of blocks) o.frozen = true;
          add(refs || all);
          grew = true;
        }
      }
    });
  }
  return untouched;
}

// Tekst i skjemaobjekter (Form XObjects, f.eks. topp- og bunntekst) fjernes også, ett nivå om gangen, men bare fra
// dem `strip(nøkkel)` godtar. `seen`: skjemaobjekter som allerede er behandlet (for hele dokumentet); `visited`:
// skjemaobjekter som er gått gjennom fra denne siden (ressursene kan peke tilbake til seg selv).
function stripForms(lib, context, resources, seen, strip = () => true, visited = new Set()) {
  const xobjects = resources && resources.lookupMaybe(lib.PDFName.of("XObject"), lib.PDFDict);
  if (!xobjects) return;
  for (const [, ref] of xobjects.entries()) {
    if (!(ref instanceof lib.PDFRef) || visited.has(ref.toString())) continue;
    visited.add(ref.toString());
    const stream = context.lookup(ref);
    if (!stream || !stream.dict || stream.dict.lookup(lib.PDFName.of("Subtype")) !== lib.PDFName.of("Form")) continue;
    const ok = !seen.has(ref.toString()) && strip(ref.toString());
    if (ok) seen.add(ref.toString());
    stripForms(lib, context, stream.dict.lookupMaybe(lib.PDFName.of("Resources"), lib.PDFDict), seen, strip, visited);
    if (!ok) continue;
    const { bytes, removed } = stripText(streamBytes(lib, stream));
    if (!removed) continue;
    const fresh = context.flateStream(bytes);
    for (const [key, value] of stream.dict.entries()) {
      if (!["/Filter", "/DecodeParms", "/Length"].includes(key.toString())) fresh.dict.set(key, value);
    }
    context.assign(ref, fresh);
  }
}

// Sidens innholdsstrømmer satt sammen.
function contentOf(lib, context, page) {
  const contents = page.node.Contents();
  const streams = contents instanceof lib.PDFArray
    ? contents.asArray().map((ref) => context.lookup(ref))
    : contents ? [contents] : [];
  return Buffer.concat(streams.map((s) => Buffer.from(streamBytes(lib, s))).flatMap((b) => [b, Buffer.from("\n")]));
}

// Sidens innhold uten teksten (bortsett fra tekst som beholdes). Stemmer ikke antallet tekst- og maleoperatorer med
// det pdf.js så, er koblingen usikker: da fjernes all tekst og ingen streker. `cutPaths(stay)` gir strekene som skal bort.
// Er ikke alle tekstbitene koblet (meta.exact), men antallet tekstoperatorer stemmer, beholdes bare `held`: teksten i
// blokker som står urørt (se freezeForms).
function stripPage(lib, doc, page, seen, meta, keep, cutPaths, stripForm, held = null) {
  const { context } = doc;
  const joined = contentOf(lib, context, page);
  const probe = stripText(joined);
  const textOk = meta.exact && probe.shows === meta.shows;
  const heldOk = !textOk && Boolean(held && held.size) && probe.shows === meta.shows;
  const pathsOk = probe.paints === meta.paths;
  const result = textOk || pathsOk || heldOk
    ? stripText(joined, {
      keep: textOk ? keep : heldOk ? held : null,
      cutPaths: pathsOk ? cutPaths(textOk ? "kept" : heldOk ? "held" : null) : null,
      advances: textOk || heldOk ? meta.advances : null,
    })
    : probe;
  const wrapped = Buffer.concat([Buffer.from("q\n"), result.bytes, Buffer.from(`\n${"Q\n".repeat(result.open + 1)}`)]);
  stripForms(lib, context, page.node.Resources(), seen, stripForm);
  return { ref: context.register(context.flateStream(wrapped)), textOk, pathsOk };
}

function fontCache(lib, doc) {
  const fonts = new Map();
  const load = async (name) => {
    if (!fonts.has(name)) {
      const font = await doc.embedFont(lib.StandardFonts[name]);
      // Bredde uten kerning: pdf-lib regner med AFM-kerning, men Tj i PDF kerner ikke. €-tegnet i leserens
      // erstatningsskrift er bredere enn standardmålet, så det får litt ekstra luft etter seg (se show).
      const cache = new Map();
      const euro = /^(Helvetica|Times)/.test(font.name) ? EURO_PAD / 1000 : 0;
      if (euro) cache.set("€", font.widthOfTextAtSize("€", 1) + euro);
      const width = (text) => {
        let n = 0;
        for (const ch of text) {
          if (!cache.has(ch)) cache.set(ch, font.widthOfTextAtSize(ch, 1));
          n += cache.get(ch);
        }
        return n;
      };
      fonts.set(name, { font, chars: new Set(font.getCharacterSet()), space: width(" "), width });
    }
    return fonts.get(name);
  };
  const get = (style) => load(FONT_NAMES[style.family][(style.bold ? 1 : 0) + (style.italic ? 2 : 0)]);
  get.symbols = async () => [await load("Symbol"), await load("ZapfDingbats")];
  return get;
}

// Tekst → deler per skrift. Tegn standardskriften mangler: god erstatning, Symbol/ZapfDingbats, tegnet som grafikk,
// latinske bokstaver for kyrillisk, uten aksent, ellers «?». Emoji utelates.
function partsOf(text, main, symbols, report) {
  const parts = [];
  const add = (font, s) => {
    const last = parts[parts.length - 1];
    if (last && last.font === font) last.text += s;
    else parts.push({ font, text: s });
  };
  const put = (ch, depth = 0) => {
    const cp = ch.codePointAt(0);
    if (main.chars.has(cp)) return add(main, ch);
    if (ch in REPLACE && depth < 2) {
      for (const r of REPLACE[ch]) put(r, depth + 1);
      return undefined;
    }
    if (VECTOR.has(ch)) return parts.push({ vector: ch });
    const sym = symbols.find((f) => f.chars.has(cp));
    if (sym) return add(sym, ch);
    if (/\p{Extended_Pictographic}/u.test(ch)) return report.dropped.add(ch);
    if (ch in CYRILLIC) {
      report.translit++;
      return add(main, CYRILLIC[ch]);
    }
    const base = ch.normalize("NFKD").replace(/\p{M}/gu, "");
    if (base && base !== ch && [...base].every((b) => main.chars.has(b.codePointAt(0)))) return add(main, base);
    report.missing.set(ch, (report.missing.get(ch) || 0) + 1);
    return add(main, "?");
  };
  for (const ch of text) put(ch);
  return parts;
}

const colorOf = (hex) => {
  const n = parseInt(String(hex || BLACK).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round((c / 255) * 1000) / 1000).join(" ");
};
const num = (n) => String(Math.round(n * 1000) / 1000);

// Ordpar som ikke skal deles over to linjer: tall med mellomrom (412 000, 1 874 000), telefonnumre (+47 55 12 34 56,
// 800 12 345), valuta foran tall (€ 40 000, kr 400) og enhet etter tall (61 %, 400 kr).
const GLUE = [
  [/^[-+−]?\d{1,3}$/, /^\d{3}(\D|$)/],
  [/^(\+\d{1,3}|\(?\d{2,3}\)?)$/, /^\d{2,3}[.,;:)]?$/],
  [/^([€$£¥§]|kr\.?|NOK|EUR|USD|SEK|DKK)$/i, /^[-+−]?\d/],
  [/\d$/, /^(%|‰|°[CF]?|kr\.?|NOK|EUR|USD)[.,;:)]?$/],
];

// Ord med biter i hver sin stil; "\n" gir linjeskift. Mellom to deler (innledning + resten) er det alltid mellomrom.
// Biter uten mellomrom mellom seg (⟦1⟧61⟦/1⟧ %) henger sammen som ett ord. Tall med mellomrom (1 874) brytes ikke.
function wordsOf(segments) {
  const words = [];
  let cur = null;
  let anchor = null;
  const flush = () => {
    if (cur) words.push(cur);
    cur = null;
  };
  segments.forEach((seg, si) => {
    if (si > 0) flush();
    anchor = seg.x ?? null;
    for (const span of untag(seg.text, seg.style, seg.styles || [])) {
      for (const tok of span.text.split(/([ \t\n]+)/)) {
        if (!tok) continue;
        if (/^[ \t\n]+$/.test(tok)) {
          flush();
          for (let n = (tok.match(/\n/g) || []).length; n > 0; n--) words.push({ br: true });
          continue;
        }
        if (!cur) {
          cur = { pieces: [], x: anchor };
          anchor = null;
        }
        cur.pieces.push({ text: tok, style: span.style });
      }
    }
  });
  flush();
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (!w.br && prev && !prev.br) {
      const a = prev.pieces.map((p) => p.text).join("");
      const b = w.pieces.map((p) => p.text).join("");
      w.glue = GLUE.some(([x, y]) => x.test(a) && y.test(b));
    }
  });
  return words;
}

// Bryter ordene i linjer. `box(k)` gir linje k sin start (fra venstre kant) og bredde. Ord med `xRel` (verdien i et
// skjemafelt etter «Navn:») starter tidligst der på første linje. `split(w, bredde)` deler et ord som ikke får plass
// på en hel linje (siste utvei). Resultatet har `over`: hvor langt den lengste linjen går forbi bredden.
// Ord som henger sammen (glue: 412 000, 55 12 34 56) flyttes samlet til neste linje når de ikke får plass; bare en
// gruppe som er bredere enn en hel linje, brytes inni.
function wrap(words, measure, box, split) {
  const lines = [[]];
  let used = box(0).x;
  let over = 0;
  let loose = false;
  let queue = words.slice();
  for (let i = 0; i < queue.length; i++) {
    const w = queue[i];
    let line = lines[lines.length - 1];
    if (w.br) {
      line.hard = true;
      lines.push([]);
      used = box(lines.length - 1).x;
      continue;
    }
    let k = lines.length - 1;
    let { x, width } = box(k);
    let at = line.length ? used + measure.space(w) : used;
    if (k === 0 && w.xRel != null) at = Math.max(at, w.xRel);
    let need = measure.word(w);
    if (!w.glue) {
      loose = false;
      for (let j = i + 1; j < queue.length && queue[j].glue; j++) need += measure.space(queue[j]) + measure.word(queue[j]);
      // Gruppen får ikke plass på en hel linje (denne, hvis den er tom, ellers neste): den brytes som vanlige ord.
      if (need > measure.word(w) && need > box(line.length ? k + 1 : k).width * 1.01 + 0.5) {
        loose = true;
        need = measure.word(w);
      }
    }
    if (line.length && (!w.glue || loose) && at + need > x + width * 1.01 + 0.5) {
      lines.push((line = []));
      k++;
      ({ x, width } = box(k));
      at = x;
    }
    if (split && !line.length && measure.word(w) > width * 1.01 + 0.5) {
      const parts = split(w, width);
      if (parts.length > 1) {
        queue = queue.slice(0, i).concat(parts, queue.slice(i + 1));
        i--;
        continue;
      }
    }
    line.push(w);
    used = at + measure.word(w);
    over = Math.max(over, used - (x + width * 1.01 + 0.5));
  }
  const out = lines.filter((l, i) => l.length || l.hard || i === 0);
  out.over = over;
  return out;
}

// Deler et ord i biter som hver får plass på `maxW` (tegn for tegn, med samme mål som `measureAt`).
function splitWord(w, maxW, s, tracking) {
  const units = [];
  for (const p of w.pieces) {
    for (const q of p.parts) {
      if (q.vector) units.push({ p, q, ch: null, w1: 0.8 });
      else for (const ch of q.text) units.push({ p, q, ch, w1: q.font.width(ch) });
    }
  }
  const chunks = [];
  let cur = [];
  let used = 0;
  for (const u of units) {
    const uw = (u.w1 * u.p.fit * u.p.style.size + tracking) * s;
    if (cur.length && used + uw > maxW) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(u);
    used += uw;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((chunk) => {
    const pieces = [];
    for (const u of chunk) {
      let piece = pieces[pieces.length - 1];
      if (!piece || piece.src !== u.p) pieces.push((piece = { ...u.p, src: u.p, text: "", parts: [], w1: 0, n: 0 }));
      const last = piece.parts[piece.parts.length - 1];
      if (u.ch == null) piece.parts.push({ vector: u.q.vector });
      else if (last && !last.vector && last.font === u.q.font) last.text += u.ch;
      else piece.parts.push({ font: u.q.font, text: u.ch });
      piece.text += u.ch ?? u.q.vector;
      piece.n++;
      piece.w1 += u.w1 * u.p.fit;
    }
    return { pieces, x: null };
  });
}

// Hvor mye smalere originalskriften er enn standardskriften (per originalfont, for hele dokumentet). Brukes som
// vannrett skalering (Tz), så samme tekst får samme bredde og samme linjeskift som i originalen. Tekstbitene telles
// side for side mens dokumentet leses (så de kan slippes), og `fit(stil)` gir forholdet til slutt.
async function fitCounter() {
  const lib = require("pdf-lib");
  let getFont = fontCache(lib, await lib.PDFDocument.create());
  const sums = new Map();
  const keyOf = (style) => `${style.font}|${style.family}|${style.bold}|${style.italic}`;
  return {
    // Etter lesingen trengs bare summene; skriftene og måledokumentet slippes. Merk: pdf-lib (@pdf-lib/standard-fonts)
    // holder målene til standardskriftene i et eget mellomlager på modulnivå så lenge prosessen lever (høyst 14
    // skrifter, rundt 3,5 MB), så det meste av minnet blir ikke frigjort her. Det er bevisst ikke omgått: writePdf
    // trenger de samme målene, og i Workeren er prosessen kortlivet.
    done() {
      getFont = null;
    },
    async add(items) {
      for (const it of items) {
        if (it.style.tracked || Math.abs(it.angle) >= 0.01 || it.str.trim().length < 2 || !it.w) continue;
        const key = keyOf(it.style);
        const { width, chars } = await getFont(it.style);
        const text = [...it.str].filter((ch) => chars.has(ch.codePointAt(0))).join("");
        if (text.length < it.str.length * 0.9) continue;
        const s = sums.get(key) || [0, 0];
        s[0] += it.w;
        s[1] += width(text) * it.size;
        sums.set(key, s);
      }
    },
    fit(style) {
      const s = sums.get(keyOf(style));
      return s && s[1] > 0 ? Math.max(0.82, Math.min(1, s[0] / s[1])) : 1;
    },
  };
}

// Bredden blokken settes i (se planBlock). En enkelt linje kan vokse inn i ledig plass på samme linje (mot høyre,
// venstre eller begge veier), men et kort avsnitt i en flyt ikke forbi flytens spalte (growRight). Et avsnitt med bare
// harde linjeskift (adresse, signatur) kan også bli bredere, men ikke bredere enn spalten det står i. Andre avsnitt
// beholder sin opprinnelige bredde.
function widthOf(block) {
  let left = block.left;
  let width = block.right - block.left;
  const single = block.lines.length === 1;
  const hard = block.segments.reduce((n, s) => n + (String(s.source ?? s.text).match(/\n/g) || []).length, 0) >= block.lines.length - 1;
  const hardBlock = !single && hard && block.align !== "justify";
  if (single || hardBlock) {
    let maxRight = hardBlock && block.colRight != null ? Math.min(block.maxRight, Math.max(block.right, block.colRight)) : block.maxRight;
    if (block.growRight != null) maxRight = Math.min(maxRight, Math.max(block.right, block.growRight));
    const growRight = Math.max(0, maxRight - block.right);
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
  return { left, width, single, hardBlock };
}

// Tekst i en tabellcelle eller boks kan bruke cellens indre bredde (se planBlock); -Infinity ellers.
const cellRightOf = (block, single, hardBlock) => (!single && !hardBlock && block.cell && (block.align === "left" || block.align === "justify")
  ? Math.min(block.maxRight, block.cell.inner) : -Infinity);

// Det vannrette området blokken kan fylle når den settes: den opprinnelige bredden, eller mer (widthOf, cellRightOf).
function spanOf(block) {
  const { left, width, single, hardBlock } = widthOf(block);
  return [Math.min(block.left, left), Math.max(block.right, left + width, cellRightOf(block, single, hardBlock))];
}

// Klargjør en blokk: ord, skrifter og mål. Bestemmer så størrelse og linjeavstand som får plass.
async function planBlock(block, getFont, report) {
  const words = wordsOf(block.segments).filter((w) => w.br || w.pieces.some((p) => p.text));
  if (!words.some((w) => w.pieces)) return null;
  const symbols = await getFont.symbols();
  let drop = null;
  if (block.drop) {
    const first = words.find((w) => w.pieces);
    const letter = first && first.pieces[0].text.match(/^\p{L}/u);
    if (letter) {
      first.pieces[0].text = first.pieces[0].text.slice(letter[0].length);
      if (!first.pieces[0].text) first.pieces.shift();
      drop = { ...block.drop, text: letter[0] };
      const main = await getFont(drop.style);
      drop.parts = partsOf(drop.text, main, symbols, report);
      drop.main = main;
    }
  }
  for (const w of words) {
    if (!w.pieces) continue;
    for (const p of w.pieces) {
      const main = await getFont(p.style);
      p.main = main;
      p.parts = partsOf(p.text, main, symbols, report);
      p.fit = p.style.fit || 1;
      p.w1 = p.parts.reduce((n, q) => n + (q.vector ? 0.8 : q.font.width(q.text)), 0) * p.fit;
      p.n = p.parts.reduce((n, q) => n + (q.vector ? 1 : q.text.length), 0);
    }
    w.pieces = w.pieces.filter((p) => p.n);
  }
  const live = words.filter((w) => w.br || w.pieces.length);
  if (!live.some((w) => w.pieces)) return null;
  // Sperret tekst: finn sperringen som gir originalens bredde med originalteksten, og bruk den samme på oversettelsen.
  let tracking = 0;
  if (block.lines.length === 1 && block.segments.some((s) => s.style.tracked)) {
    const style = block.segments[0].style;
    const main = await getFont(style);
    const source = block.segments.map((s) => String(s.source).replace(TAG, "")).join(" ");
    const parts = partsOf(source, main, symbols, { dropped: new Set(), missing: new Map(), translit: 0 });
    const natural = parts.reduce((n, q) => n + (q.vector ? 0.8 : q.font.width(q.text) * style.size), 0) * (style.fit || 1);
    tracking = Math.max(0, (block.right - block.left - natural) / Math.max(1, source.length - 1));
  }
  const measureAt = (s) => ({
    word: (w) => w.pieces.reduce((n, p) => n + p.w1 * p.style.size * s + tracking * s * p.n, 0),
    space: (w) => {
      const p = w.pieces[0];
      return p.main.space * p.style.size * s * p.fit + tracking * s;
    },
  });

  const first = block.lines[0];
  const indent = block.lines.length > 1 && (block.align === "left" || block.align === "justify") && first.x > block.left + 2 && !block.drop
    ? first.x - block.left : 0;
  const { left, width, single, hardBlock } = widthOf(block);
  for (const w of live) if (w.x != null) w.xRel = w.x - left;
  const dropW = drop ? Math.max(0, block.lines.find((l) => l.x > block.left + 2)?.x - block.left || 0) : 0;
  const dropLines = drop ? block.dropLines || 0 : 0;
  // Linjene får plass fra første grunnlinje ned til den opprinnelige siste linjen pluss ledig plass under.
  const height = (block.lines.length - 1) * block.gap + block.freeBelow;
  // En ledetekst på én linje foran et skjemafelt («Beskrivelse av problemet:», «E-post:») krympes heller enn å brytes;
  // en vanlig setning som tilfeldigvis slutter med kolon, brytes som annen tekst.
  const source = block.segments.map((s) => String(s.source ?? s.text)).join(" ").trim();
  const label = single && (block.fieldRule || (/:$/.test(source) && source.split(/\s+/).length <= 4 && source.length <= 40));
  const planAt = (width) => {
    const box = (k) => (k < dropLines ? { x: dropW, width: width - dropW } : { x: k === 0 ? indent : 0, width: width - (k === 0 ? indent : 0) });
    const fits = (s, lead, split) => {
      const lines = wrap(live, measureAt(s), box, split ? (w, maxW) => splitWord(w, maxW, s, tracking) : null);
      const gap = block.gap * lead;
      const tall = lines.length <= Math.floor((height + 0.01) / (gap * s)) + 1;
      return { lines, ok: tall && lines.over <= 0, gap, split };
    };
    const attempt = (split) => {
      // Først litt strammere linjeavstand (ikke under 0,931 av originalen, også når skriften er mindre), så mindre
      // skrift; bare når ingen størrelse får plass slik, inntil 10 % tettere linjer.
      let plan = null;
      const ALL = [...SCALES, ...LAST_RESORT];
      for (const [s, lead] of [...ALL.flatMap((s) => [[s, 1], [s, Math.min(1, 0.931 / s)]]), ...ALL.map((s) => [s, 0.9])]) {
        if (plan && plan.ok) break;
        if (lead < 1 && block.gap * lead < block.size * 1.05) continue;
        plan = { ...fits(s, lead, split), scale: s };
      }
      return plan;
    };
    let plan = null;
    if (label) {
      for (const s of SCALES) {
        const f = fits(s, 1, false);
        if (f.ok && f.lines.length === 1) {
          plan = { ...f, scale: s };
          break;
        }
      }
    }
    // Ord som er bredere enn linjen, deles bare når ingenting annet hjelper.
    if (!plan) plan = attempt(false);
    if (!plan.ok) plan = attempt(true);
    return { width, box, fits, ...plan };
  };
  let plan = planAt(width);
  // Tekst i en tabellcelle eller boks beholder bredden sin når den får plass, men får bruke cellens indre bredde (med
  // like stor marg til høyre som til venstre) før den krympes.
  const cellRight = cellRightOf(block, single, hardBlock);
  if ((!plan.ok || plan.scale < 1) && cellRight > left + width + 1) {
    const wide = planAt(cellRight - left);
    const score = (p) => (p.ok ? 1 : 0) + p.scale / 10 + (p.gap >= block.gap - 1e-9 ? 0.001 : 0);
    if (score(wide) > score(plan) + 1e-9) plan = wide;
  }
  return { block, words: live, measureAt, tracking, left, drop, ...plan };
}

// Skriver én blokk som innholdsstrøm-operatorer (tekst, understreking, avkrysningsbokser, dekkfarge for OCR).
function renderBlock(plan, res, cover, bg) {
  const { block, lines, scale, gap, tracking, left, width, box, drop } = plan;
  const measure = plan.measureAt(scale);
  // dy: hvor langt blokken er skjøvet ned (avsnitt over i samme spalte trengte flere linjer).
  const dy = plan.dy || 0;
  const out = ["q"];
  if (block.angle) {
    const c = Math.cos(block.angle);
    const s = Math.sin(block.angle);
    out.push(`${num(c)} ${num(s)} ${num(-s)} ${num(c)} 0 0 cm`);
  }
  const first = block.lines[0];
  const topY = first.y - dy;
  const bottomY = topY - (lines.length - 1) * gap * scale;
  // Plassering av hver linje: start-x og ekstra ordmellomrom (blokkjustering).
  const placed = lines.map((line, k) => {
    const { x: bx, width: avail } = box(k);
    const natural = line.reduce((n, w, i) => n + measure.word(w) + (i ? measure.space(w) : 0), 0);
    const lastLine = k === lines.length - 1 || line.hard;
    let x = left + bx;
    let extra = 0;
    // Blokkjustert: mellomrommene fylles ut til bredden. En linje som (innenfor brytingens toleranse) er litt for
    // lang, får litt trangere mellomrom i stedet for å gå forbi kanten.
    if (line.length > 1 && ((block.align === "justify" && !lastLine) || natural > avail)) {
      extra = Math.max(-0.35 * measure.space(line[1]), (avail - natural) / (line.length - 1));
      if (block.align !== "justify" || lastLine) extra = Math.min(0, extra);
    }
    const span = natural + extra * Math.max(0, line.length - 1);
    if (block.align === "center") x += (avail - span) / 2;
    else if (block.align === "right") x += avail - span;
    return { x, extra, end: x + span };
  });
  if (cover) {
    const pad = block.size * 0.12;
    const used = placed.filter((p, k) => lines[k].length);
    const x0 = minOf(used, (p) => p.x, block.left) - pad;
    const x1 = maxOf(used, (p) => p.end, block.right) + pad;
    const y0 = Math.min(block.bottom, bottomY - block.size * scale * 0.3) - 1;
    const fill = block.angle ? "#ffffff" : colorAround(bg, { x0: block.left, y0: block.bottom, x1: block.right, y1: block.top });
    out.push(`${colorOf(fill)} rg ${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(block.top + block.size * 0.1 - y0 + 1)} re f`);
  }
  const text = [];
  const vectors = [];
  const rules = [];
  let state = {};
  const set = (key, value, op) => {
    if (state[key] !== value) {
      text.push(`${value} ${op}`);
      state[key] = value;
    }
  };
  const show = (p, q, x, y) => {
    const size = p.style.size * scale;
    set("font", `${res.font(q.font.font)} ${num(size)}`, "Tf");
    set("color", colorOf(p.style.color), "rg");
    const alpha = p.style.alpha ?? 1;
    if (alpha !== 1 || state.alpha != null) set("alpha", res.gs(alpha), "gs");
    set("tz", num(p.fit * 100), "Tz");
    set("tc", num((tracking * scale) / p.fit), "Tc");
    const hex = (t) => q.font.font.encodeText(t).toString();
    const shown = q.text.includes("€") && q.font.width("€") > q.font.font.widthOfTextAtSize("€", 1)
      ? `[${q.text.split("€").map(hex).join(` ${hex("€")} -${EURO_PAD} `)}] TJ` : `${hex(q.text)} Tj`;
    text.push(`1 0 0 1 ${num(x)} ${num(y)} Tm ${shown}`);
  };
  const drawWord = (w, x, y) => {
    for (const p of w.pieces) {
      const rise = !p.style.sup ? 0 : p.style.rise != null ? p.style.rise * scale
        : p.style.sup === "sup" ? block.size * scale * 0.33 : -block.size * scale * 0.12;
      const start = x;
      for (const q of p.parts) {
        const size = p.style.size * scale;
        if (q.vector) {
          vectors.push({ ch: q.vector, x, y: y + rise, size, color: p.style.color });
          x += 0.8 * size + tracking * scale;
        } else {
          show(p, q, x, y + rise);
          x += q.font.width(q.text) * size * p.fit + tracking * scale * q.text.length;
        }
      }
      if (p.style.underline) rules.push({ x0: start, x1: x, y: y + rise, size: p.style.size * scale, color: p.style.color });
    }
    return x;
  };
  if (drop) {
    let x = drop.x;
    for (const q of drop.parts) {
      if (q.vector) continue;
      show({ style: drop.style, fit: drop.style.fit || 1 }, q, x, drop.y - dy);
      x += q.font.width(q.text) * drop.style.size * scale;
    }
  }
  lines.forEach((line, k) => {
    if (!line.length) return;
    const y = topY - k * gap * scale;
    let { x } = placed[k];
    const { extra } = placed[k];
    line.forEach((w, i) => {
      if (i) x += measure.space(w) + extra;
      if (k === 0 && w.xRel != null && (block.align === "left" || block.align === "justify")) x = Math.max(x, left + w.xRel);
      const end = drawWord(w, x, y);
      // Understreking fortsetter over mellomrommet mellom to understrekede ord.
      const u = rules[rules.length - 1];
      const next = line[i + 1];
      if (u && next && w.pieces[w.pieces.length - 1].style.underline && next.pieces[0].style.underline) u.x1 = end + measure.space(next) + extra;
      x = end;
    });
  });
  if (text.length) {
    out.push("BT");
    for (const t of text) out.push(t);
    out.push("ET");
  }
  for (const u of rules) {
    out.push(`${colorOf(u.color)} rg ${num(u.x0)} ${num(u.y - u.size * 0.11)} ${num(u.x1 - u.x0)} ${num(Math.max(0.5, u.size * 0.06))} re f`);
  }
  for (const v of vectors) {
    const s = v.size * 0.7;
    const x = v.x + v.size * 0.05;
    const y = v.y - v.size * 0.02;
    const lw = Math.max(0.4, v.size * 0.07);
    if (v.ch === "▪") out.push(`${colorOf(v.color)} rg ${num(x + s * 0.3)} ${num(y + s * 0.3)} ${num(s * 0.4)} ${num(s * 0.4)} re f`);
    else {
      out.push(`${colorOf(v.color)} RG ${num(lw)} w ${num(x)} ${num(y)} ${num(s)} ${num(s)} re S`);
      if (v.ch === "☑") out.push(`${num(x + s * 0.2)} ${num(y + s * 0.5)} m ${num(x + s * 0.42)} ${num(y + s * 0.22)} l ${num(x + s * 0.82)} ${num(y + s * 0.85)} l S`);
      if (v.ch === "☒") out.push(`${num(x + s * 0.2)} ${num(y + s * 0.2)} m ${num(x + s * 0.8)} ${num(y + s * 0.8)} l ${num(x + s * 0.2)} ${num(y + s * 0.8)} m ${num(x + s * 0.8)} ${num(y + s * 0.2)} l S`);
    }
  }
  out.push("Q");
  return out.join("\n");
}

// Parallelle beholdere på samme rad: naboceller i en tabell (felles strek mellom dem) eller like store kort (bokser).
function parallel(a, b) {
  if (a.cell && b.cell && (Math.abs(a.cell.x1 - b.cell.x0) <= 1.5 || Math.abs(b.cell.x1 - a.cell.x0) <= 1.5)) return true;
  const A = a.box;
  const B = b.box;
  if (!A || !B || A === B) return false;
  const near = (x, y) => Math.abs(x - y) <= Math.max(2, 0.1 * Math.max(Math.abs(x), Math.abs(y)));
  return Math.abs(A.y1 - B.y1) <= 2 && near(A.y1 - A.y0, B.y1 - B.y0) && near(A.x1 - A.x0, B.x1 - B.x0);
}

// Avsnitt som står rett under hverandre (b.below) er én flyt, satt med samme skriftstørrelse: den største som får plass.
// Et enkelt avsnitt over flere linjer (b.solo) settes etter de samme reglene, så like avsnitt på samme side blir like.
// Avstanden mellom avsnittene er som i originalen: trenger et avsnitt flere linjer, skyves de neste ned (dy), men bare
// så langt stackFree tillater (se linkStacks); blir det kortere, flyttes de neste like mye opp, men bare så langt
// stackUp tillater. Det som følger under i samme spalte (b.follow: en overskrift, en merknad, neste flyt, med sin egen
// plan), skyves ned som det er når flyten trenger plassen, men aldri opp: luften foran hver følger brukes først så langt
// nivået under tillater, og den siste følgeren må ha plassen under seg (der teksten slutter, er det ledig plass). En
// følger som selv er en flyt, har skjøvet sine egne følgere; det skyvet regnes med (push er hele forflytningen). En
// overskrift som følger beholder luften mot det som står under den: står det fast (en tabell, en liste), skyves den ikke.
// For hver størrelse prøves, i denne rekkefølgen:
//  1. original linjeavstand, med luften under flyten som i originalen;
//  2. inntil 5 % tettere linjer, likt i hele flyten (den største faktoren som får plass);
//  3. halve luften under flyten (stackLoose), med original linjeavstand og så inntil 5 % tettere linjer;
//  4. i tillegg så lite som mulig av halvparten av luften mellom avsnittene utover vanlig linjeavstand (likt
//     fordelt: de neste avsnittene trekkes opp), med original linjeavstand, så inntil 5 % og til slutt inntil 7 %
//     tettere linjer;
//  5. som 4, men luften under flyten ned til en halv linjeavstand (stackUrgent);
// og først da ett trinn mindre skrift. Linjeavstanden blir høyst 7 % mindre enn originalens, også når skriften er
// mindre; har avsnittene i mindre skrift like mange linjer som før (eller færre), beholder de originalens linjeavstand.
// Mangler flyten mindre enn en linje og er det ledig plass lenger ned i spalten som flyten kan nå (flowWhite,
// se linkStacks; ikke plass til underskrift), blir skriften ikke mindre: da brukes luften under flyten ned til en halv
// linjeavstand, inntil tre firedeler av luften mellom avsnittene utover vanlig linjeavstand, og til slutt inntil 10 %
// tettere linjer. Et ord som er bredere enn spalten, krymper bare sitt eget avsnitt (eller deles), ikke hele flyten.
// Returnerer planene som fikk felles plan i en flyt med flere avsnitt.
function stackPlans(plans) {
  const planOf = new Map(plans.filter((p) => !p.block.angle).map((p) => [p.block, p]));
  const done = new Set();
  const handled = new Set();
  const ALL = [...SCALES, ...LAST_RESORT];
  const H = (b) => (b.lines.length - 1) * b.gap;
  // Hvor langt en blokk er flyttet ned av sin egen plan (dyOwn) og ved å bli høyere.
  const ownMove = (q) => (q.dyOwn || 0) + (q.lines.length - 1) * q.gap * q.scale - H(q.block);
  // En følger som er én linje (overskrift, merknad), eller en overskrift over to-tre linjer (fet eller større enn
  // teksten `base` i flyten over), ikke et avsnitt i en flyt.
  const heading = (unit, base) => {
    const b = unit[0].block;
    if (unit.length !== 1 || b.below) return false;
    return b.lines.length === 1 || (b.lines.length <= 3 && (b.size > base.size + 0.5 || (b.style.bold && !base.style.bold)));
  };
  const run = (p) => {
    if (handled.has(p)) return;
    handled.add(p);
    const stack = [p];
    for (let b = p.block.below; b && planOf.has(b) && !stack.some((q) => q.block === b); b = b.below) stack.push(planOf.get(b));
    const n = stack.length;
    // Følgerne under (hver med sin egen plan først), så langt alt i dem tegnes på nytt.
    const units = [];
    const seen = new Set(stack.map((q) => q.block));
    for (let f = stack[n - 1].block.below ? null : stack[n - 1].block.follow; f && !seen.has(f);) {
      const unit = [];
      for (let b = f; b && !seen.has(b); b = b.below) {
        unit.push(b);
        seen.add(b);
      }
      if (!unit.every((b) => planOf.has(b))) break;
      run(planOf.get(f));
      units.push(unit.map((b) => planOf.get(b)));
      f = unit[unit.length - 1].follow;
    }
    // Et avsnitt i en flyt der de andre står urørt, settes etter de samme reglene som et enkelt avsnitt.
    if (n < 2 && !p.block.solo && !p.block.above && !p.block.below) return;
    const blocks = stack.map((q) => q.block);
    const last = (b) => b.lines[b.lines.length - 1].y;
    // Høyden fra første til siste grunnlinje og hvor mye av luften mellom avsnittene utover vanlig linjeavstand som
    // kan brukes.
    const spare = blocks.map((b, i) => (i < n - 1 ? Math.max(0, last(b) - blocks[i + 1].lines[0].y - b.gap) * 0.5 : 0));
    // Plassen under hvert avsnitt (0 strict, 1 loose, 2 urgent): det siste har plassen under seg som siste avsnitt
    // (se linkStacks), eller forbi følgerne når de kan skyves ned. `endOf`: plassen mot det som står rett under.
    const pick = (b, kind, end) => {
      const v = end ? [b.endFree, b.endLoose, b.endUrgent] : [b.stackFree, b.stackLoose, b.stackUrgent];
      const strict = v[0] ?? b.freeBelow;
      const loose = Math.max(strict, v[1] ?? strict);
      return kind === 0 ? strict : kind === 1 ? loose : Math.max(loose, v[2] ?? loose);
    };
    const freeOf = [0, 1, 2].map((kind) => blocks.map((b, i) => pick(b, kind, i === n - 1 && !units.length)));
    const endOf = (b, kind) => pick(b, kind, true);
    const up = blocks.map((b, i) => (i ? b.stackUp ?? 0 : 0));
    const cache = new Map();
    const fitsAt = (i, s, lead, split) => {
      const key = `${i}|${s}|${lead}|${split}`;
      if (!cache.has(key)) cache.set(key, stack[i].fits(s, lead, split));
      return cache.get(key);
    };
    // Største størrelse der hvert avsnitt får plass i bredden (null: et ord er bredere enn linjen selv i minste størrelse).
    const own = stack.map((q, i) => ALL.find((s) => fitsAt(i, s, 1, false).lines.over <= 0) ?? null);
    // Tettest tillatte linjeavstand per avsnitt (0,9 av originalen, men ikke under 1,05 × skriftstørrelsen).
    const lmin = blocks.map((b) => Math.min(1, Math.max(0.9, (b.size * 1.05) / b.gap)));
    // lead: linjeavstanden i alle avsnittene (faktor, men ikke tettere enn lmin); f: hvor mye av luften mellom
    // avsnittene som kan brukes; kind: hvor mye av luften under som kan brukes. Med `measure` gir layout hvor mye
    // plass som mangler (0 når alt får plass) i stedet for null.
    const layout = (s, lead, f, kind, measure = false) => {
      const free = freeOf[kind];
      const res = [];
      const dy = [];
      let shift = 0;
      let short = 0;
      let moved = 0;
      for (let i = 0; i < n; i++) {
        const si = own[i] == null ? s : Math.min(s, own[i]);
        const r = fitsAt(i, si, 1, own[i] == null);
        if (r.lines.over > 0) return measure ? Infinity : null;
        const gap = blocks[i].gap * Math.max(lead, lmin[i]);
        // Opp bare inn i plass som sikkert er ledig.
        if (shift < -up[i]) shift = -up[i];
        moved = shift + (r.lines.length - 1) * gap * si - H(blocks[i]);
        if (moved > free[i] + 0.01 && !measure) return null;
        short = Math.max(short, moved - free[i]);
        dy.push(shift);
        res.push({ r: { ...r, gap }, si });
        // Luften mellom avsnittene (f) tar opp det avsnittet over har vokst, eller trekker de neste opp.
        shift = moved - f * spare[i];
      }
      // Følgerne skyves ned så langt luften over dem ikke rekker. push[k]: hele forflytningen til enhet k (utover dens
      // egen plan), også det en flyt lenger opp i kjeden allerede har skjøvet den: enhetens siste blokk flytter seg
      // push + sin egen forflytning (ownMove), og det som ikke får plass i luften under den, skyver neste enhet.
      // En følgende flyt har planlagt sine egne følgere med sitt eget trinn (kindUsed); luften under den og alt under
      // den brukes minst så mye som der. En overskrift (enhet med én linje) beholder luften mot det som står under
      // den (sitt eget innhold): den skyves bare ned når innholdet under også kan skyves.
      const push = [];
      let over = moved - endOf(blocks[n - 1], kind);
      let kk = kind;
      for (const unit of units) {
        const x = Math.max(0, over);
        push.push(x);
        const t = unit[unit.length - 1];
        kk = Math.max(kk, unit[0].kindUsed ?? 0);
        over = x + ownMove(t) - endOf(t.block, heading(unit, blocks[n - 1]) ? 0 : kk);
      }
      if (units.length && over > 0.01) {
        if (!measure) return null;
        short = Math.max(short, over);
      }
      return measure ? short : { res, dy, push, s, kind, lead, f };
    };
    // Linjene blir ikke tettere enn nødvendig: den største faktoren (mellom floor og 1) som får plass.
    const tightest = (s, floor, f, kind) => {
      let best = layout(s, floor, f, kind);
      if (!best) return null;
      let lo = floor;
      let hi = 1;
      for (let k = 0; k < 7; k++) {
        const mid = (lo + hi) / 2;
        const got = layout(s, mid, f, kind);
        if (got) {
          best = got;
          lo = mid;
        } else hi = mid;
      }
      return best;
    };
    // Luften mellom avsnittene brukes ikke mer enn nødvendig: den minste andelen (høyst fmax) som får plass.
    const leastAir = (s, fmax, kind) => {
      let best = layout(s, 1, fmax, kind);
      if (!best) return null;
      let lo = 0;
      let hi = fmax;
      for (let k = 0; k < 7; k++) {
        const mid = (lo + hi) / 2;
        const got = layout(s, 1, mid, kind);
        if (got) {
          best = got;
          hi = mid;
        } else lo = mid;
      }
      return best;
    };
    const f5 = (s) => Math.min(1, 0.95 / s);
    const f7 = (s) => Math.min(1, 0.931 / s);
    // [kind, floor, f]: floor 1 og f > 0 betyr original linjeavstand og minst mulig av luften mellom avsnittene.
    // Til slutt, før skriften blir mindre: luften under ned til en halv linjeavstand (stackUrgent), med original
    // linjeavstand, så inntil 5 % og 7 % tettere linjer (det tettest tillatte som ikke er siste utvei).
    const tiers = (s) => [[0, 1, 0], [0, f5(s), 0], [1, 1, 0], [1, f5(s), 0], [1, 1, 1], [1, f5(s), 1], [1, f7(s), 1],
      [2, 1, 1], [2, f5(s), 1], [2, f7(s), 1]];
    const tryTiers = (s, list) => {
      for (const [kind, floor, f] of list) {
        const got = floor < 1 ? tightest(s, floor, f, kind) : f > 0 ? leastAir(s, f, kind) : layout(s, 1, 0, kind);
        if (got) return got;
      }
      return null;
    };
    const line = blocks[n - 1].gap;
    const cliff = (s) => (blocks[0].flowWhite ?? 0) > 0.25 * line && layout(s, f7(s), 1, 2, true) < line * s;
    let found = null;
    for (const s of ALL) {
      found = tryTiers(s, tiers(s)) || (cliff(s) ? tryTiers(s, [[2, 1, 1.5], [2, f7(s), 1.5], [2, 0.9, 1.5]]) : null);
      if (found) break;
    }
    // Får flyten ikke plass i noen størrelse slik, brukes inntil 10 % tettere linjer.
    for (let k = 0; !found && k < ALL.length; k++) found = tryTiers(ALL[k], [[1, 0.9, 1]]);
    if (!found) return;
    // Mindre skrift med like mange linjer som i originalen (eller færre) beholder originalens linjeavstand: da står
    // hver linje innenfor avsnittets opprinnelige høyde.
    if (found.s < 1 && found.res.every(({ r }, i) => r.lines.length <= blocks[i].lines.length)) {
      found = layout(found.s, 1 / found.s, found.f, found.kind) || found;
    }
    stack.forEach((q, i) => {
      const { r, si } = found.res[i];
      Object.assign(q, r, { scale: si, dy: found.dy[i], dyOwn: found.dy[i], ok: true, kindUsed: found.kind });
      if (n > 1) done.add(q);
    });
    units.forEach((unit, k) => {
      for (const q of unit) q.dy = (q.dyOwn || 0) + found.push[k];
    });
  };
  for (const p of planOf.values()) {
    if (p.block.above && planOf.has(p.block.above)) continue;
    run(p);
  }
  return done;
}

// Blokkens ytre ramme på siden (for tegnerekkefølge).
function pageBox(block) {
  const m = block.angle ? [Math.cos(block.angle), Math.sin(block.angle), -Math.sin(block.angle), Math.cos(block.angle), 0, 0] : [1, 0, 0, 1, 0, 0];
  return boxOf(m, block.left, block.bottom, block.right, block.top);
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
      if (p.rotate) page.setRotation(lib.degrees(p.rotate));
    }
  }
  const getFont = fontCache(lib, doc);
  for (const blocks of blocksPerPage) {
    for (const b of blocks) {
      for (const seg of b.segments) for (const style of [seg.style, ...(seg.styles || [])]) style.fit = ctx.fits ? ctx.fits.fit(style) : 1;
      if (b.drop) b.drop.style.fit = ctx.fits ? ctx.fits.fit(b.drop.style) : 1;
    }
  }
  const report = { missing: new Map(), dropped: new Set(), translit: 0, overflow: [] };
  const seen = new Set();
  const gsRefs = new Map();
  // Skjemaobjekter med tekst i et skjult lag, og alt som hører sammen med dem, står urørt (se freezeForms; avgjort
  // før teksten ble samlet inn). Ellers får bare skjemaobjekter som tegnes på siden, teksten fjernet (planForms).
  const forms = editable ? planForms(lib, doc, pages) : null;
  const untouchedForms = pages.untouched || (forms && forms.untouched) || new Set();
  if (editable && blocksPerPage.some((blocks, n) => pages[n].frozen || blocks.some((b) => b.frozen))) {
    warn("pdf_hidden_layer", "Noe av teksten står i et skjemaobjekt som også tegnes i et skjult lag (valgfritt innhold). Den er ikke oversatt og står som i originalen.");
  }
  for (let n = 0; n < pages.length; n++) {
    const page = doc.getPage(n);
    const meta = pages[n];
    const blocks = editable && meta.frozen ? [] : blocksPerPage[n];
    page.node.normalize();
    // Uendrede blokker beholder de opprinnelige tegnene, så sant alle tekstoperatorene deres bare har slik tekst.
    const changed = (b) => b.segments.some((s) => s.text !== s.source);
    const owners = new Map();
    for (const b of blocks) {
      for (const s of b.ops) {
        if (!owners.has(s)) owners.set(s, new Set());
        owners.get(s).add(b);
      }
    }
    const opsOf = (b) => b.ops;
    // Tekst fra et skjemaobjekt som står urørt, tegnes ikke på nytt (den står der allerede); blokken står som den er,
    // også den delen av den som står i sidens egen strøm.
    const frozen = new Set(editable ? blocks.filter((b) => b.frozen) : []);
    const formPage = forms && forms.pages[n];
    const kept = new Set(blocks.filter((b) => (frozen.has(b) ? b.keepable : !changed(b) && b.exact)));
    for (let again = true; again;) {
      again = false;
      for (const b of kept) {
        if (!frozen.has(b) && opsOf(b).some((s) => [...owners.get(s)].some((o) => !kept.has(o)))) {
          kept.delete(b);
          again = true;
        }
      }
    }
    const keep = new Set([...kept].flatMap(opsOf));
    // Tekst i et skjult lag står urørt (den er ikke med i noen blokk).
    for (const s of meta.hiddenOps || []) if (!owners.has(s)) keep.add(s);
    // Er ikke alle tekstbitene koblet, beholdes bare teksten i urørte blokker (og i hullene med usikker tekst de står i).
    const heldBlocks = new Set([...frozen].filter((b) => b.keepable));
    const held = new Set();
    for (const b of heldBlocks) {
      for (const s of b.ops) held.add(s);
      for (const [lo, hi] of b.gaps || []) for (let s = lo; s <= hi; s++) held.add(s);
    }
    if (held.size) for (const s of meta.hiddenOps || []) if (!owners.has(s)) held.add(s);
    // Understreking under tekst som tegnes på nytt, fjernes og tegnes under oversettelsen (all tekst tegnes på nytt
    // hvis tekstoperatorene ikke kunne kobles).
    // En sti med flere deler fjernes bare når alle delene er understreking under tekst som tegnes på nytt.
    const underlined = new Map();
    for (const g of meta.graphics || []) {
      if (!g.under) continue;
      if (!underlined.has(g.pop)) underlined.set(g.pop, []);
      underlined.get(g.pop).push(g);
    }
    const cutPaths = (stay) => new Set([...underlined].filter(([, parts]) => parts.length === parts[0].parts
      && parts.every((g) => g.owners && g.owners.every((b) => !(stay === "kept" ? kept : stay === "held" ? heldBlocks : new Set()).has(b))))
      .map(([pop]) => pop));
    let cover = false;
    let strip = { textOk: false, pathsOk: false, ref: null };
    if (editable && blocks.length) {
      try {
        // Teksten fjernes bare fra skjemaobjekter som tegnes på siden og ikke står urørt.
        const stripForm = (key) => !untouchedForms.has(key) && (!formPage.refs || formPage.refs.includes(key));
        strip = stripPage(lib, doc, page, seen, meta, keep, cutPaths, stripForm, held);
      } catch (err) {
        cover = true;
        warn("pdf_cover", `Side ${n + 1}: den opprinnelige teksten kunne ikke fjernes (${err.message}); oversettelsen er lagt over med hvit bakgrunn.`);
      }
    }
    const fontKeys = new Map();
    const gsKeys = new Map();
    const res = {
      font: (font) => {
        if (!fontKeys.has(font)) fontKeys.set(font, page.node.newFontDictionary(font.name, font.ref).toString());
        return fontKeys.get(font);
      },
      gs: (alpha) => {
        const a = Math.round(alpha * 100) / 100;
        if (!gsKeys.has(a)) {
          if (!gsRefs.has(a)) gsRefs.set(a, doc.context.register(doc.context.obj({ Type: "ExtGState", ca: a, CA: a })));
          gsKeys.set(a, page.node.newExtGState("GS", gsRefs.get(a)).toString());
        }
        return gsKeys.get(a);
      },
    };
    // Plan for hver blokk, så felles størrelse for avsnitt med samme stil i samme spalte.
    const plans = [];
    // Urørte blokker tegnes aldri på nytt (freezeForms har sørget for at teksten deres står igjen).
    for (const b of blocks) {
      if (frozen.has(b) || (strip.textOk && kept.has(b))) continue;
      const plan = await planBlock(b, getFont, report);
      if (plan) plans.push(plan);
    }
    // Avsnitt rett under hverandre i samme spalte/boks (b.below) settes som én flyt med felles størrelse.
    const stacked = stackPlans(plans);
    // Ellers felles størrelse bare for blokker som står parallelt i samme struktur, med samme stil: punkter i samme
    // liste (samme venstrekant, rett etter hverandre, i samme boks) og naboceller i en tabellrad eller like kort på
    // samme rad. Spalter med løpende tekst er ikke parallelle. En blokk trekkes høyst to trinn ned av de andre.
    const multi = plans.filter((p) => (p.block.lines.length > 1 || p.block.lines[0].listStart) && !p.block.angle && !stacked.has(p));
    const siblings = (a, b) => styleKey(a.style) === styleKey(b.style) && (
      (a.lines[0].listStart && b.lines[0].listStart && Math.abs(a.left - b.left) <= 2 && a.box === b.box
        && Math.min(Math.abs(a.bottom - b.top), Math.abs(b.bottom - a.top)) <= 2.5 * Math.max(a.gap, b.gap))
      || (Math.abs(a.top - b.top) <= Math.max(2, a.size * 0.3) && (a.right <= b.left || b.right <= a.left) && parallel(a, b)));
    const group = new Map(multi.map((p) => [p, p]));
    const root = (p) => (group.get(p) === p ? p : root(group.get(p)));
    for (let i = 0; i < multi.length; i++) {
      for (let j = i + 1; j < multi.length; j++) {
        if (siblings(multi[i].block, multi[j].block)) group.set(root(multi[j]), root(multi[i]));
      }
    }
    const least = new Map();
    for (const p of multi) least.set(root(p), Math.min(least.get(root(p)) ?? 1, p.scale));
    for (const p of multi) {
      const scale = Math.max(least.get(root(p)), p.scale - 0.1);
      if (scale < p.scale - 1e-9) {
        const again = p.fits(scale, 1, p.split);
        Object.assign(p, again.ok || p.block.gap * 0.9 < p.block.size * 1.05 ? again : p.fits(scale, 0.9, p.split), { scale });
      }
    }
    // Mindre skrift med like mange linjer som i originalen (eller færre) beholder originalens linjeavstand: hver linje
    // står da innenfor blokkens opprinnelige høyde. Gjelder hele gruppen av parallelle blokker eller ingen av dem, og
    // ikke blokker som er satt i en flyt eller skjøvet av en (stackPlans har planlagt dem).
    const pitchOk = new Map();
    for (const p of multi) {
      const free = p.kindUsed === undefined && p.dy === undefined;
      const ok = free && (p.scale < 1 ? p.ok && p.lines.length <= p.block.lines.length : p.gap >= p.block.gap - 1e-9);
      pitchOk.set(root(p), (pitchOk.get(root(p)) ?? true) && ok);
    }
    for (const p of multi) {
      if (p.scale >= 1 || !pitchOk.get(root(p)) || p.gap * p.scale >= p.block.gap - 1e-9) continue;
      const again = p.fits(p.scale, 1 / p.scale, p.split);
      if (again.ok) Object.assign(p, again);
    }
    for (const p of plans) {
      if (!p.ok) report.overflow.push(p.words.filter((w) => w.pieces).slice(0, 4).map((w) => w.pieces.map((q) => q.text).join("")).join(" "));
    }
    // Tegnerekkefølge som i originalen: tekst som grafikk senere ble tegnet over, legges under sidens innhold, men bare
    // når ingenting som ble tegnet før teksten (bakgrunn, celleskygge, bilde) ligger under den; ellers ville det dekke
    // oversettelsen. Da tegnes teksten over alt: synlig tekst er viktigere enn et ikon som lå over den.
    const paints = (meta.graphics || []).filter((g) => g.fill || g.image);
    const hits = (g, bb) => Math.min(g.x1, bb.x1) - Math.max(g.x0, bb.x0) > 1 && Math.min(g.y1, bb.y1) - Math.max(g.y0, bb.y0) > 1;
    const under = [];
    const over = [];
    for (const plan of plans.sort((a, b) => a.block.op - b.block.op)) {
      const b = plan.block;
      const bb = pageBox(b);
      const below = editable && !b.invisible && !cover && paints.some((g) => g.op > b.op && hits(g, bb))
        && !paints.some((g) => g.op < b.op && hits(g, bb));
      (below ? under : over).push(renderBlock(plan, res, cover || b.invisible, meta.bg));
    }
    if (!editable) {
      for (const s of meta.shapes || []) {
        const k = 0.5523 * s.r;
        const { cx, cy, r } = s;
        over.push(`q ${colorOf(s.color)} rg ${num(cx + r)} ${num(cy)} m ${num(cx + r)} ${num(cy + k)} ${num(cx + k)} ${num(cy + r)} ${num(cx)} ${num(cy + r)} c ${num(cx - k)} ${num(cy + r)} ${num(cx - r)} ${num(cy + k)} ${num(cx - r)} ${num(cy)} c ${num(cx - r)} ${num(cy - k)} ${num(cx - k)} ${num(cy - r)} ${num(cx)} ${num(cy - r)} c ${num(cx + k)} ${num(cy - r)} ${num(cx + r)} ${num(cy - k)} ${num(cx + r)} ${num(cy)} c f Q`);
      }
    }
    const stream = (parts) => doc.context.register(doc.context.flateStream(Buffer.from(`\n${parts.join("\n")}\n`, "latin1")));
    const refs = [];
    if (under.length) refs.push(stream(under));
    if (strip.ref) refs.push(strip.ref);
    else {
      const c = page.node.get(lib.PDFName.of("Contents"));
      const direct = c && doc.context.lookup(c);
      if (direct instanceof lib.PDFArray) for (const r of direct.asArray()) refs.push(r);
      else if (c instanceof lib.PDFRef) refs.push(c);
      else if (direct) refs.push(doc.context.register(direct));
    }
    if (over.length) refs.push(stream(over));
    page.node.set(lib.PDFName.of("Contents"), doc.context.obj(refs));
  }
  if (report.missing.size || report.dropped.size || report.translit) {
    const count = [...report.missing.values()].reduce((a, b) => a + b, 0);
    const list = [...report.missing.keys()].slice(0, 12).map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}${/[\p{L}\p{N}\p{P}\p{S}]/u.test(ch) && !/[\ue000-\uf8ff]/.test(ch) ? ` «${ch}»` : ""}`);
    const parts = [];
    if (count) parts.push(`${count} tegn finnes ikke i standardskriften og ble erstattet med «?»: ${list.join(", ")}`);
    if (report.translit) parts.push(`${report.translit} kyrilliske tegn ble skrevet med latinske bokstaver`);
    if (report.dropped.size) parts.push(`emoji ble utelatt (${[...report.dropped].join(" ")})`);
    warn("pdf_glyphs", `${parts.join(". ")}.`);
  }
  if (report.overflow.length) {
    warn("pdf_overflow", `${report.overflow.length} tekstblokk(er) fikk ikke plass selv i minste størrelse og kan overlappe annen tekst, f.eks. «${report.overflow[0]}».`);
  }
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

// ---- Oversettelse ----

// Avsnitt som fortsetter i neste spalte eller på neste side: siste avsnitt i spalten slutter uten punktum, og
// første avsnitt i neste spalte har samme stil og bredde og begynner med liten bokstav.
function continuations(blocksPerPage) {
  const pairs = [];
  const text = (b) => b.segments.map((x) => x.text).join(" ");
  const body = (b, lines = 2) => !b.frozen && !b.angle && !b.lines[0].bullet && b.lines.length >= lines && (b.align === "left" || b.align === "justify");
  const same = (a, b) => styleKey(a.style) === styleKey(b.style);
  const overlaps = (a, b) => a.left < b.right && a.right > b.left;
  // Avsnittet rett over/under i samme spalte (vanlig avsnittsavstand), med samme stil. Et avsnitt over hele
  // sidebredden over to spalter hører ikke til spalten.
  const column = (o, b) => overlaps(o, b) && Math.abs(o.left - b.left) <= 3 && o.right - o.left <= 1.3 * (b.right - b.left) + 3;
  const near = (list, b, dir) => list.find((o) => o !== b && same(o, b) && column(o, b)
    && (dir < 0 ? o.bottom >= b.top && o.bottom - b.top <= 2.5 * b.gap : b.bottom >= o.top && b.bottom - o.top <= 2.5 * b.gap));
  blocksPerPage.forEach((blocks, n) => {
    for (const a of blocks) {
      if (!body(a) || /[.!?:;…"»”)\]]\s*$/.test(text(a)) || a.segments.length !== 1 || near(blocks, a, 1)) continue;
      const width = a.right - a.left;
      // Fortsettelsen kan være én kort linje (avsnittets siste linje).
      const fits = (b) => b !== a && body(b, 1) && same(a, b) && b.segments.length === 1 && !b.lines[0].listStart
        && (b.lines.length === 1 ? b.right - b.left <= width + 2 : Math.abs(b.right - b.left - width) <= width * 0.1)
        && b.lower && !pairs.some((p) => p[1] === b);
      const first = (list, b) => !near(list, b, -1);
      let top = a;
      for (let up = near(blocks, a, -1); up; up = near(blocks, up, -1)) top = up;
      // Neste spalte på samme side (den som starter nærmest samme høyde), ellers første spalte på neste side.
      const cands = blocks.filter((o) => fits(o) && o.left > a.right && o.top >= a.bottom && first(blocks, o));
      const col = minOf(cands, (o) => o.left);
      let b = cands.filter((o) => o.left <= col + 3).sort((x, y) => Math.abs(x.top - top.top) - Math.abs(y.top - top.top))[0];
      if (!b && !blocks.some((o) => o !== a && same(o, a) && o.left > a.right) && blocksPerPage[n + 1]) {
        const next = blocksPerPage[n + 1];
        const col = minOf(next.filter((o) => body(o, 1) && same(a, o)), (o) => o.left);
        b = next.filter((o) => fits(o) && Math.abs(o.left - col) <= 3 && first(next, o))[0];
      }
      if (b) pairs.push([a, b]);
    }
  });
  return pairs;
}

// Oversettelsen av et sammenslått avsnitt deles igjen ved et mellomrom, i samme forhold som originalen.
function splitJoined(text, share) {
  const plain = text.replace(TAG, "");
  const target = plain.length * share;
  let best = -1;
  let bestPlain = 0;
  let open = 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const m = text.slice(i).match(/^⟦(\/?)\d+⟧/);
    if (m) {
      open += m[1] ? -1 : 1;
      i += m[0].length - 1;
      continue;
    }
    if (text[i] === " " && !open && (best < 0 || Math.abs(count - target) < Math.abs(bestPlain - target))) {
      best = i;
      bestPlain = count;
    }
    count++;
  }
  if (best < 0) return [text, ""];
  return [text.slice(0, best), text.slice(best + 1)];
}

// Leser dokumentet og legger ut sidene. Gir blokkene per side, tekstbitene som skal oversettes (avsnitt delt over
// spalter eller sider er slått sammen) og målene for skriftbredden.
async function readPdf(buffer, collect, noCover) {
  const blocksPerPage = [];
  const fits = collect ? null : await fitCounter();
  const pages = await extractPages(buffer, {
    collect,
    noCover,
    onPage: async (page) => {
      const blocks = layoutPage(page);
      if (fits) await fits.add(page.items);
      release(page, blocks, collect);
      blocksPerPage.push(blocks);
    },
  });
  // Målingen trenger ikke lenger skriftene (og dokumentet de ligger i).
  if (fits) fits.done();
  // Tekst i skjemaobjekter som står urørt (tekst i et skjult lag), avgjøres her, likt ved innsamling og skriving:
  // den oversettes ikke (og betales ikke) og tegnes ikke på nytt (se freezeForms).
  if (pages.some((p) => (p.formDraws || []).some((d) => d.hidden))) {
    const lib = require("pdf-lib");
    let doc = null;
    try {
      doc = await lib.PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true });
      if (doc.isEncrypted || doc.getPageCount() !== pages.length) doc = null;
    } catch {
      doc = null;
    }
    if (doc) pages.untouched = freezeForms(lib, doc, pages, blocksPerPage) || undefined;
  }
  // Ved innsamling trengs ikke tekstoperatorene lenger.
  if (collect) for (const b of blocksPerPage.flat()) b.ops = b.gaps = b.forms = undefined;
  const segments = blocksPerPage.flat().flatMap((b) => b.segments);
  for (const s of segments) s.source = s.text;
  // Et avsnitt delt over spalter eller sider oversettes som én setning og deles etterpå. En kjede (spalte 1 → 2 → 3)
  // blir én streng, så også siste del blir oversatt.
  const joined = new Map();
  const pairs = continuations(blocksPerPage);
  const next = new Map(pairs);
  const targets = new Set(pairs.map((p) => p[1]));
  for (const [head] of pairs) {
    if (targets.has(head)) continue;
    const chain = [head];
    for (let b = next.get(head); b && !chain.includes(b); b = next.get(b)) chain.push(b);
    const parts = chain.map((b) => b.segments[0]);
    const styles = [];
    const texts = parts.map((sg) => {
      const offset = styles.length;
      for (const st of sg.styles || []) styles.push(st);
      return offset ? sg.text.replace(TAG, (m, close, n) => `⟦${close}${Number(n) + offset}⟧`) : sg.text;
    });
    joined.set(parts[0], { parts, text: texts.join(" "), styles, lengths: parts.map((sg) => sg.text.replace(TAG, "").length) });
    for (const sg of parts.slice(1)) sg.fixed = true;
  }
  for (const b of blocksPerPage.flat()) if (b.frozen) for (const s of b.segments) s.fixed = true;
  const toTranslate = segments.filter((s) => !s.fixed && LETTER.test(s.text.replace(TAG, "")));
  return { pages, blocksPerPage, fits, joined, toTranslate };
}

async function translatePdf(buffer, ctx) {
  const collect = Boolean(ctx.collect);
  let doc = await readPdf(buffer, collect, false);
  // Ble all tekst som kan oversettes, regnet som overmalt, er det heller dekket som er feiltolket: da tas ingenting ut.
  if (!doc.toTranslate.length && doc.pages.covered) doc = await readPdf(buffer, collect, true);
  const { pages, blocksPerPage, fits, joined, toTranslate } = doc;
  if (!toTranslate.length) throw new Error(blocksPerPage.some((blocks) => blocks.some((b) => b.frozen)) ? FROZEN_ONLY : NO_TEXT);

  const translated = await translateStrings({ ...ctx, strings: toTranslate.map((s) => (joined.has(s) ? joined.get(s).text : s.text)) });
  if (ctx.collect) return Buffer.alloc(0);
  toTranslate.forEach((s, i) => {
    if (translated[i] == null || !String(translated[i]).trim()) return;
    const j = joined.get(s);
    if (!j) s.text = String(translated[i]);
    else if (String(translated[i]) !== j.text) {
      let rest = String(translated[i]);
      j.parts.forEach((part, k) => {
        const remaining = j.lengths.slice(k).reduce((a, n) => a + n, 0);
        const [head, tail] = k < j.parts.length - 1 ? splitJoined(rest, j.lengths[k] / Math.max(1, remaining)) : [rest, ""];
        part.text = head;
        part.styles = j.styles;
        rest = tail;
      });
    }
  });
  return writePdf(buffer, pages, blocksPerPage, { ...ctx, fits });
}

module.exports = { translatePdf, extractPages, layoutPage, stripText, wordsOf, untag, sharedImagePolicy };
