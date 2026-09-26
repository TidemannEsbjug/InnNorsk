const test = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const mock = require("./helpers/mock-grok");
const { minimalDocx, minimalPdf } = require("./helpers/fixtures");
const { translateStrings, planBatches, GrokError } = require("../src/grok");
const core = require("../src/core");
const { extractPages, layoutPage, stripText, wordsOf, untag } = require("../src/formats/pdf");

const ctx = (extra = {}) => ({ apiKey: "test", model: "grok-4.6", retryDelayMs: 1, ...extra });

test.before(() => mock.install());
test.after(() => mock.uninstall());
test.beforeEach(() => {
  mock.setMode("upper");
  mock.reset();
});

test("oversetter og bevarer linjeskift, tabulatorer og tomme strenger", async () => {
  const out = await translateStrings(ctx({ strings: ["Hello\tthere\nfriend", "", "  ", "Bye"] }));
  assert.deepEqual(out, ["NB:HELLO\tTHERE\nFRIEND", "", "  ", "NB:BYE"]);
});

test("feil antall i svaret deles opp i stedet for å velte filen", async () => {
  mock.setMode("mismatch");
  const strings = Array.from({ length: 40 }, (_, i) => `Line ${i}`);
  const out = await translateStrings(ctx({ strings }));
  assert.deepEqual(out, strings.map((s) => mock.transform(s)));
});

test("429 og 503 prøves på nytt", async () => {
  for (const mode of ["flaky429", "flaky500"]) {
    mock.setMode(mode);
    mock.reset();
    const out = await translateStrings(ctx({ strings: ["One", "Two"] }));
    assert.deepEqual(out, ["NB:ONE", "NB:TWO"]);
    assert.equal(mock.state.calls, 2);
  }
});

test("401 og 403 gir norsk feil uten nye forsøk", async () => {
  mock.setMode("fail401");
  await assert.rejects(translateStrings(ctx({ strings: ["x"] })), (err) => {
    assert.ok(err instanceof GrokError);
    assert.equal(err.code, "auth");
    assert.match(err.message, /API-nøkkelen/);
    return true;
  });
  assert.equal(mock.state.calls, 1);
  mock.setMode("fail403");
  await assert.rejects(translateStrings(ctx({ strings: ["x"] })), /chat-\/modelltilgang/);
});

test("manglende nøkkel og avbrudd", async () => {
  await assert.rejects(translateStrings({ strings: ["x"], apiKey: "" }), (e) => e.code === "no_key");
  mock.setMode("slow");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(translateStrings(ctx({ strings: ["x"], signal: ac.signal })), (e) => e.code === "cancelled");
});

test("parallelle batcher beholder rekkefølgen og rapporterer onBatch/onCall", async () => {
  const strings = Array.from({ length: 100 }, (_, i) => `Sentence number ${i} `.repeat(10));
  const batches = [];
  const calls = [];
  const out = await translateStrings(
    ctx({ strings, concurrency: 3, onBatch: (b) => batches.push(b), onCall: (c) => calls.push(c) })
  );
  assert.deepEqual(out, strings.map((s) => mock.transform(s)));
  const planned = planBatches(strings);
  assert.equal(batches.length, planned.length);
  assert.equal(
    batches.reduce((n, b) => n + b.chars, 0),
    planned.reduce((n, b) => n + b.chars, 0)
  );
  assert.ok(calls.every((c) => c.ok && c.usage && c.usage.output_tokens > 0));
});

test("collect + apply gir samme resultat som direkte oversettelse", async () => {
  const docx = await minimalDocx(["Hello world", "Second paragraph æøå"]);
  const cases = [
    [Buffer.from("Hello\n\nWorld\nline two\n"), ".txt"],
    [Buffer.from('name,comment\n"Ola","Good morning"\n'), ".csv"],
    [Buffer.from("<html><body><p>Hello there</p></body></html>"), ".html"],
    [docx, ".docx"],
    [minimalPdf(), ".pdf"],
  ];
  for (const [buf, ext] of cases) {
    mock.reset();
    const collected = await core.collectStrings(buf, ext);
    assert.equal(mock.state.calls, 0, `${ext}: collect må ikke kalle API`);
    const translatedCalls = collected.map((strings) => strings.map((s) => (s.trim() ? mock.transform(s) : s)));
    const applied = await core.applyTranslations(buf, ext, translatedCalls);
    const direct = await core.translateBuffer(buf, ext, ctx());
    assert.equal(applied.buffer.length > 0, true);
    if (ext === ".docx") {
      const a = await (await JSZip.loadAsync(applied.buffer)).file("word/document.xml").async("string");
      const d = await (await JSZip.loadAsync(direct.buffer)).file("word/document.xml").async("string");
      assert.equal(a, d);
      assert.match(a, /NB:SECOND PARAGRAPH ÆØÅ/);
      assert.match(a, /<w:b\/>/);
    } else if (ext === ".pdf") {
      const text = async (b) => (await extractPages(b)).flatMap((p) => p.items.map((i) => `${i.str}@${Math.round(i.x)},${Math.round(i.y)}`)).join("|");
      assert.equal(await text(applied.buffer), await text(direct.buffer));
      assert.match(await text(applied.buffer), /NB:WEATHER REPORT/);
    } else {
      assert.equal(applied.buffer.toString(), direct.buffer.toString(), ext);
    }
  }
});

test("apply med feil form avvises", async () => {
  const buf = Buffer.from("Hello\n\nWorld\n");
  await assert.rejects(core.applyTranslations(buf, ".txt", [["bare én"]]), /endret seg/);
});

test("analyzeBuffer teller uten API-kall", async () => {
  const buf = Buffer.from("One\n\nTwo\n\nThree\n");
  const a = await core.analyzeBuffer(buf, ".txt");
  assert.deepEqual(a, { calls: [[11]], segments: 3, chars: 11, batches: 1 });
  assert.equal(mock.state.calls, 0);
});

test("PDF inn gir PDF ut: samme side, teksten oversatt på samme sted og i samme stil, originalteksten fjernet", async () => {
  const pdf = minimalPdf();
  const a = await core.analyzeBuffer(pdf, ".pdf");
  assert.equal(a.segments, 2, "overskrift + ett avsnitt (to linjer som flyter sammen)");
  const out = await core.translateBuffer(pdf, ".pdf", ctx());
  assert.equal(out.outExt, ".pdf");
  const [page] = await extractPages(out.buffer);
  assert.deepEqual([Math.round(page.width), Math.round(page.height)], [595, 842]);
  const texts = page.items.filter((i) => i.str.trim());
  assert.ok(!texts.some((i) => /Weather|Bergen\./.test(i.str)), "originalteksten er borte");
  const heading = texts.find((i) => i.str.startsWith("NB:WEATHER REPORT"));
  assert.ok(heading, JSON.stringify(texts.map((i) => i.str)));
  assert.deepEqual([Math.round(heading.x), Math.round(heading.y), Math.round(heading.size), heading.style.bold], [72, 780, 18, true]);
  const body = texts.filter((i) => i.style.size < 12).map((i) => i.str).join(" ");
  assert.match(body, /NB:THIS IS THE FIRST LINE ABOUT BERGEN\. AND THIS IS THE SECOND LINE\./);
  const first = texts.find((i) => i.str.startsWith("NB:THIS"));
  assert.deepEqual([Math.round(first.x), Math.round(first.y), first.style.bold], [72, 750, false]);
});

test("PDF: bare tekstoperatorene fjernes; grafikk, tilstand og innebygde bilder står igjen", () => {
  const src = Buffer.from("q 1 0 0 rg 0 0 10 10 re f BT /F1 12 Tf 10 10 Td (Hei \\) (på) deg) Tj [(A) -20 (B)] TJ (x) ' 1 2 (y) \" ET BI /W 1 /H 1 /CS /G /BPC 8 ID \u0000Tj( EI q 0.5 g", "latin1");
  const { bytes, open, removed } = stripText(src);
  const out = bytes.toString("latin1");
  assert.equal(removed, 4);
  assert.equal(out, "q 1 0 0 rg 0 0 10 10 re f BT /F1 12 Tf 10 10 Td   T* 1 Tw 2 Tc T* ET BI /W 1 /H 1 /CS /G /BPC 8 ID \u0000Tj( EI q 0.5 g", "\" beholder ord- og tegnavstanden");
  assert.equal(open, 2, "to q uten Q: tegningen vår lukker dem");
});

test("utfilnavn kolliderer ikke, låsefiler ignoreres", () => {
  const names = core.assignOutputNames(["a/x.pdf", "a/x.docx", "a/X.rtf", "b.htm", "b.html"]);
  assert.equal(names.get("a/x.docx"), "a/x.docx");
  assert.equal(names.get("a/x.pdf"), "a/x.pdf", "PDF blir PDF");
  assert.equal(names.get("a/X.rtf"), "a/X.rtf", "RTF blir RTF");
  assert.equal(names.get("b.html"), "b.html");
  assert.equal(names.get("b.htm"), "b (htm).html");
  assert.ok(core.isIgnoredName("mappe/~$Rapport.docx"));
  assert.ok(core.isIgnoredName(".~lock.Rapport.docx#"));
  assert.ok(!core.isIgnoredName("Rapport.docx"));
});

test("egen transport (Grok CLI) brukes i stedet for HTTP, med kostnad og nye forsøk", async () => {
  const { GrokError } = require("../src/grok");
  let n = 0;
  const calls = [];
  const transport = async (input) => {
    n++;
    if (n === 1) throw new GrokError("server", "CLI krasjet");
    const i = input.indexOf("\n\n[");
    const arr = JSON.parse(input.slice(i + 2, input.lastIndexOf("]") + 1));
    return { text: "Her er svaret:\n" + JSON.stringify(arr.map(mock.transform)), costUsd: 0.0012, usage: { input_tokens: 10 } };
  };
  const out = await translateStrings({ strings: ["Hello", "World"], transport, retryDelayMs: 1, onCall: (c) => calls.push(c) });
  assert.deepEqual(out, ["NB:HELLO", "NB:WORLD"]);
  assert.equal(mock.state.calls, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].ok, false);
  assert.equal(calls[1].costUsd, 0.0012);
  await assert.rejects(
    translateStrings({ strings: ["x"], transport: async () => { throw new GrokError("auth", "Ikke logget inn i Grok."); } }),
    (e) => e.code === "auth"
  );
});

// ---- PDF → PDF: små PDF-er bygget i kode ----

// Sider med egne innholdsstrømmer. Fonter: F1 Helvetica, F2 Helvetica-Bold, F3 Georgia (ikke innebygd), F4 Courier.
function pdfOf(streams, { width = 595, height = 842 } = {}) {
  const fonts = "<< /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >>";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${streams.map((_, i) => `${7 + i * 2} 0 R`).join(" ")}] /Count ${streams.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /TrueType /BaseFont /Georgia /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
  ];
  streams.forEach((stream, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${8 + i * 2} 0 R /Resources << /Font ${fonts} >> >>`);
    objs.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const line = (font, size, x, y, text) => `BT /${font} ${size} Tf ${x} ${y} Td (${text}) Tj ET`;
const pdfStrings = async (pdf) => (await core.collectStrings(pdf, ".pdf")).flat();
const textItems = async (buf, n = 0) => (await extractPages(buf))[n].items.filter((i) => i.str.trim());

test("PDF: Word-liste – nummeret er eget, og fortsettelseslinjen hører til sitt punkt", async () => {
  const pdf = pdfOf([[
    line("F1", 11, 90, 700, "1."), line("F1", 11, 108, 700, "Replace the lighting in the two main warehouses, including"),
    line("F1", 11, 108, 685, "motion sensors in all aisles."),
    line("F1", 11, 90, 670, "2."), line("F1", 11, 108, 670, "Introduce the revised framework."),
  ].join("\n")]);
  assert.deepEqual(await pdfStrings(pdf), [
    "Replace the lighting in the two main warehouses, including motion sensors in all aisles.",
    "Introduce the revised framework.",
  ]);
});

test("PDF: tabellrader med strek mellom slås ikke sammen", async () => {
  const rows = [line("F1", 11, 95, 700, "Net revenue"), line("F1", 11, 95, 686, "Operating profit")];
  const ruled = pdfOf([[rows[0], "0.5 w 90 696 m 300 696 l S", rows[1], line("F1", 11, 72, 600, "A long paragraph line that sets the text width of this page.")].join("\n")]);
  assert.deepEqual((await pdfStrings(ruled)).slice(0, 2), ["Net revenue", "Operating profit"]);
});

test("PDF: uthevet ord midt i et avsnitt sendes merket og tegnes fet igjen", async () => {
  const pdf = pdfOf(["BT /F1 11 Tf 72 700 Td (The year was marked by ) Tj /F2 11 Tf (steady growth) Tj /F1 11 Tf ( in all areas.) Tj ET"]);
  assert.deepEqual(await pdfStrings(pdf), ["The year was marked by ⟦1⟧steady growth⟦/1⟧ in all areas."]);
  const out = await core.translateBuffer(pdf, ".pdf", ctx());
  const items = await textItems(out.buffer);
  const bold = items.filter((i) => i.style.bold).map((i) => i.str.trim()).join(" ");
  assert.equal(bold, "STEADY GROWTH");
  assert.ok(!items.some((i) => /⟦|⟧/.test(i.str)), "merkene tegnes ikke");
});

test("PDF: rotert etikett er én streng og tegnes rett (ikke kursiv)", async () => {
  const pdf = pdfOf([[
    line("F1", 11, 72, 700, "Body text on the page."),
    "BT /F1 12 Tf 0 1 -1 0 500 300 Tm (INTERNAL) Tj ET",
    "BT /F1 12 Tf 0 1 -1 0 500 363 Tm (DRAFT) Tj ET",
  ].join("\n")]);
  assert.deepEqual(await pdfStrings(pdf), ["Body text on the page.", "INTERNAL DRAFT"]);
  const out = await core.translateBuffer(pdf, ".pdf", ctx());
  const rotated = (await textItems(out.buffer)).filter((i) => Math.abs(i.angle) > 0.1);
  assert.ok(rotated.length && rotated.every((i) => !i.style.italic && /NB:INTERNAL DRAFT/.test(i.str)), JSON.stringify(rotated.map((i) => i.str)));
});

test("PDF: uendret tekst (tall) beholder de opprinnelige tegnene og skriften", async () => {
  const pdf = pdfOf([[line("F1", 11, 72, 700, "Net revenue"), line("F3", 11, 300, 700, "412.0")].join("\n")]);
  assert.deepEqual(await pdfStrings(pdf), ["Net revenue"]);
  const out = await core.translateBuffer(pdf, ".pdf", ctx());
  const items = await textItems(out.buffer);
  const number = items.find((i) => i.str.trim() === "412.0");
  assert.ok(number && /Georgia/.test(number.style.font), JSON.stringify(items.map((i) => [i.str, i.style.font])));
  assert.ok(items.some((i) => i.str.includes("NB:NET REVENUE") && /Helvetica/.test(i.style.font)));
});

test("PDF: to spalter med smal spalteavstand (10 pt) holdes adskilt", async () => {
  // Courier: hvert tegn er 0,6 × størrelsen, så venstre spalte slutter nøyaktig 10 pt før høyre.
  const left = ["Harbour ferries now run more", "often during the busy summer", "season and the early autumn.", "Tickets are sold on board as"];
  const right = ["Residents take turns behind", "the counter and the shelves", "are restocked twice a week.", "Fresh bread arrives Friday."];
  const x2 = 40 + 28 * 0.6 * 9.5 + 10;
  const pdf = pdfOf([left.flatMap((t, k) => [line("F4", 9.5, 40, 700 - k * 12, t), line("F4", 9.5, x2, 700 - k * 12, right[k])]).join("\n")]);
  assert.deepEqual(await pdfStrings(pdf), [left.join(" "), right.join(" ")]);
});

test("PDF: adresselinjer beholder linjeskiftene", async () => {
  const pdf = pdfOf([[
    "BT /F1 11 Tf 72 700 Td (Ms Jane Doe) Tj 0 -13 Td (45 Hillside Road) Tj 0 -13 Td (5003 Bergen) Tj ET",
    line("F1", 11, 72, 600, "Thank you for visiting us. As agreed, we have prepared a treatment plan."),
  ].join("\n")]);
  assert.equal((await pdfStrings(pdf))[0], "Ms Jane Doe\n45 Hillside Road\n5003 Bergen");
});

test("PDF: usynlig OCR-lag oppå ekte tekst gir ikke dobbel tekst", async () => {
  const pdf = pdfOf([[line("F1", 11, 72, 700, "Basic rent"), "BT 3 Tr /F1 11 Tf 72 700 Td (Basic rent) Tj ET"].join("\n")]);
  assert.deepEqual(await pdfStrings(pdf), ["Basic rent"]);
});

test("PDF: avsnitt som fortsetter på neste side oversettes samlet og deles igjen", async () => {
  const para = (y, a, b) => `BT /F1 11 Tf 72 ${y} Td (${a}) Tj 0 -14 Td (${b}) Tj ET`;
  const pdf = pdfOf([
    para(120, "Staff turnover remained stable at around nine per cent, which is", "mostly due to relocation rather than dissatisfaction with working"),
    para(760, "conditions. Nevertheless, the management team has decided to", "introduce a structured mentoring scheme for all new employees."),
  ]);
  const strings = await pdfStrings(pdf);
  assert.equal(strings.length, 1);
  assert.match(strings[0], /with working conditions\. Nevertheless/);
  const out = await core.translateBuffer(pdf, ".pdf", ctx());
  const pages = await extractPages(out.buffer);
  const text = (n) => pages[n].items.map((i) => i.str).join(" ");
  assert.match(text(0), /NB:STAFF TURNOVER/);
  assert.match(text(1), /EMPLOYEES\./);
  assert.ok(!/EMPLOYEES/.test(text(0)) && !/STAFF/.test(text(1)));
});

test("PDF: stilmerker tolkes, ubalanserte merker gir vanlig tekst, tall med mellomrom holdes sammen", () => {
  const base = { family: "sans", size: 11 };
  const bold = { family: "sans", size: 11, bold: true };
  assert.deepEqual(untag("A ⟦1⟧b c⟦/1⟧ d", base, [bold]).map((p) => [p.text, p.style === bold]), [["A ", false], ["b c", true], [" d", false]]);
  assert.deepEqual(untag("A ⟦1⟧b c d", base, [bold]), [{ text: "A b c d", style: base }]);
  const words = wordsOf([{ text: "Sum ⟦1⟧61⟦/1⟧ % er 1 874 kr", style: base, styles: [bold] }]);
  assert.deepEqual(words.map((w) => w.pieces.map((p) => p.text).join("|") + (w.glue ? "+" : "")), ["Sum", "61", "%+", "er", "1", "874+", "kr+"]);
  const glued = (text) => wordsOf([{ text, style: base }]).map((w) => (w.glue ? "+" : "|") + w.pieces[0].text).join("");
  assert.equal(glued("Ring +47 55 12 34 56 nå"), "|Ring|+47+55+12+34+56|nå");
  assert.equal(glued("koster € 40 000, eller kr 412 000"), "|koster|€+40+000,|eller|kr+412+000");
  assert.equal(glued("i 2023 12 personer"), "|i|2023|12|personer");
});

test("PDF: stripText beholder valgte tekstoperatorer og fjerner valgte streker", () => {
  const src = Buffer.from("q 0 0 m 10 0 l S (A) Tj (B) Tj 5 5 10 10 re f Q", "latin1");
  const { bytes, shows, paints } = stripText(src, { keep: new Set([1]), cutPaths: new Set([0]) });
  assert.deepEqual([shows, paints], [2, 2]);
  assert.equal(bytes.toString("latin1").replace(/\s+/g, " ").trim(), "q (B) Tj 5 5 10 10 re f Q");
});

// Oversetter med en egen funksjon (uten Grok) og gir ut-PDF-en og advarslene.
async function applyWith(pdf, fn) {
  const collected = await core.collectStrings(pdf, ".pdf");
  const warnings = [];
  const out = await core.applyTranslations(pdf, ".pdf", collected.map((c) => c.map(fn)), { onWarning: (w) => warnings.push(w) });
  return { strings: collected.flat(), buffer: out.buffer, warnings };
}
// Innholdsstrømmene til side n, dekodet, i tegnerekkefølge.
async function pageStreams(buf, n = 0) {
  const lib = require("pdf-lib");
  const doc = await lib.PDFDocument.load(buf);
  const contents = doc.getPage(n).node.Contents();
  const refs = contents instanceof lib.PDFArray ? contents.asArray() : [contents];
  return refs.map((ref) => {
    const s = doc.context.lookup(ref) || ref;
    return Buffer.from(s instanceof lib.PDFRawStream ? lib.decodePDFRawStream(s).decode() : s.getContents()).toString("latin1");
  });
}
// PDF fra en liste objekter (streng = ordbok, { dict, data } = strøm); objekt 1 er katalogen.
function pdfFromObjects(objs) {
  const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
  let len = parts[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(len);
    const b = typeof o === "string" ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, "latin1")
      : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, "latin1"), o.data, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    parts.push(b);
    len += b.length;
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}
const streamObj = (text) => ({ dict: `<< /Length ${Buffer.byteLength(text, "latin1")} >>`, data: Buffer.from(text, "latin1") });
// Side med et bilde /Im0 (valgfritt med gjennomsiktighet, SMask) i tillegg til fontene.
function pdfWithImage(content, { alpha = null, w = 20, h = 20, rgb = 0 } = {}) {
  const zlib = require("zlib");
  const pixels = zlib.deflateSync(Buffer.alloc(w * h * 3, rgb));
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> >> >>",
    streamObj(content),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    { dict: `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8${alpha == null ? "" : " /SMask 7 0 R"} /Filter /FlateDecode /Length ${pixels.length} >>`, data: pixels },
  ];
  if (alpha != null) {
    const mask = zlib.deflateSync(Buffer.alloc(w * h, alpha));
    objs.push({ dict: `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${mask.length} >>`, data: mask });
  }
  return pdfFromObjects(objs);
}
const upper = (s) => "NB " + s.toUpperCase();

test("PDF: avsnitt over tre sider (eller spalter) oversettes helt, også siste del", async () => {
  const para = (y, a, b) => `BT /F1 11 Tf 72 ${y} Td (${a}) Tj 0 -14 Td (${b}) Tj ET`;
  const pdf = pdfOf([
    para(120, "Staff turnover remained stable at around nine per cent, which is", "mostly due to relocation rather than dissatisfaction with working"),
    para(760, "conditions and pay levels in the region, and the management team", "has therefore decided to review the onboarding process for all new"),
    para(760, "employees starting next year, with a structured mentoring scheme.", "The scheme will be evaluated after twelve months by the board."),
  ]);
  const { strings, buffer } = await applyWith(pdf, upper);
  assert.equal(strings.length, 1);
  assert.match(strings[0], /for all new employees starting next year.*by the board\.$/);
  const pages = await extractPages(buffer);
  const text = (n) => pages[n].items.map((i) => i.str).join(" ");
  assert.ok(!/[a-z]/.test(text(2)), `siste side er oversatt: ${text(2)}`);
  assert.match(text(2), /BOARD\./);
});

test("PDF: oversatt tekst legges ikke under en bakgrunn som lå under den i originalen", async () => {
  const para = "0 g BT /F1 11 Tf 72 700 Td (The committee reviewed the budget for the coming year in detail and) Tj 0 -14 Td (approved the plan with minor changes.) Tj ET";
  const icon = "0.8 0 0 rg 270 686 8 8 re f";
  // Bakgrunn tegnet før teksten og et lite ikon etter: teksten tegnes etter sidens innhold (synlig).
  let streams = await pageStreams((await applyWith(pdfOf([["0.93 0.95 1 rg 0 0 595 842 re f", para, icon].join("\n")]), upper)).buffer);
  const bgAt = streams.findIndex((s) => s.includes("595 842 re f"));
  const textAt = streams.findIndex((s) => /Tm <[0-9A-F]+> Tj/.test(s));
  assert.ok(bgAt >= 0 && textAt > bgAt, JSON.stringify(streams.map((s) => s.slice(0, 60))));
  // Uten bakgrunn: ikonet som ble tegnet over teksten, blir liggende over oversettelsen (teksten tegnes først).
  streams = await pageStreams((await applyWith(pdfOf([[para, icon].join("\n")]), upper)).buffer);
  assert.ok(streams.findIndex((s) => /Tm <[0-9A-F]+> Tj/.test(s)) < streams.findIndex((s) => s.includes("270 686 8 8 re f")));
});

test("PDF: gjennomsiktig vannmerke over teksten gjør den ikke usynlig, ugjennomsiktig bilde gjør", async () => {
  const content = [
    "BT /F1 11 Tf 72 700 Td (The committee reviewed the budget for the coming year in detail and) Tj 0 -14 Td (approved the plan with minor changes after a long discussion.) Tj ET",
    "q 595 0 0 842 0 0 cm /Im0 Do Q",
  ].join("\n");
  const [clear] = await extractPages(pdfWithImage(content, { alpha: 0 }));
  assert.ok(clear.items.filter((i) => i.str.trim()).every((i) => !i.invisible));
  const { buffer } = await applyWith(pdfWithImage(content, { alpha: 0 }), upper);
  const streams = await pageStreams(buffer);
  assert.ok(!streams.some((s) => /0 0 0 rg [\d.]+ [\d.]+ [\d.]+ [\d.]+ re f/.test(s)), "ingen svart dekkboks");
  const [opaque] = await extractPages(pdfWithImage(content, { rgb: 255 }));
  assert.ok(opaque.items.filter((i) => i.str.trim()).every((i) => i.invisible), "tekst under et ugjennomsiktig bilde er skjult");
});

test("PDF: uendret tekst etter fjernet tekst i samme tekstobjekt blir stående på samme sted", async () => {
  const pdf = pdfOf([[
    line("F1", 11, 72, 760, "A paragraph that will be translated here."),
    "BT /F1 11 Tf 72 700 Td (Net revenue) Tj [-12000 (412.0)] TJ ET",
    "BT /F1 11 Tf 72 680 Td (12) Tj ( ) Tj /F2 11 Tf (345) Tj ET",
  ].join("\n")]);
  const before = await textItems(pdf);
  const { buffer } = await applyWith(pdf, upper);
  const after = await textItems(buffer);
  for (const str of ["412.0", "345"]) {
    const a = before.find((i) => i.str.trim() === str);
    const b = after.find((i) => i.str.trim() === str);
    assert.ok(a && b && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01, `${str}: ${a && a.x} → ${b && b.x}`);
  }
});

test("PDF: bindestrek som tankestrek limer ikke sammen ord, og TeX-ord uten mellomromstegn beholder mellomrommet", async () => {
  const dash = pdfOf(["BT /F1 11 Tf 72 700 Td (The results from the first quarter were good -) Tj 0 -14 Td (but not as strong as the board had hoped for.) Tj ET"]);
  const [s] = await pdfStrings(dash);
  assert.ok(!/goodbut/.test(s) && /good -\s?but/.test(s), s);
  // Uten mellomromstegn (TeX: ordmellomrom er TJ-tall) er mellomrommet foran bindestreken bare et hull, men også da er
  // « -» en tankestrek.
  const texDash = pdfOf(["BT /F1 11 Tf 72 700 Td [(The)-333(results)-333(were)-333(good)-333(-)] TJ 0 -14 Td [(but)-333(not)-333(as)-333(strong)-333(as)-333(hoped.)] TJ ET"]);
  const [t] = await pdfStrings(texDash);
  assert.ok(!/goodbut/.test(t) && /good -\s?but/.test(t), t);
  // Orddelingsstrek tegnet for seg med et lite hull foran (LibreOffice i blokkjustert tekst): ordet limes sammen.
  const lib = require("pdf-lib");
  const helvetica = await (await lib.PDFDocument.create()).embedFont(lib.StandardFonts.Helvetica);
  const head = "We act on behalf of our client in connection with the exclus";
  const x = 72 + helvetica.widthOfTextAtSize(head, 11) + 2;
  const lo = pdfOf([`BT /F1 11 Tf 72 700 Td (${head}) Tj ET BT /F1 11 Tf ${x.toFixed(2)} 700 Td (-) Tj ET BT /F1 11 Tf 72 686 Td (ive agency agreement concluded between the parties.) Tj ET`]);
  assert.deepEqual(await pdfStrings(lo), ["We act on behalf of our client in connection with the exclusive agency agreement concluded between the parties."]);
  const tex = pdfOf(["BT /F2 11 Tf 72 660 Td [(I)-333(am)] TJ ET\nBT /F1 11 Tf 72 640 Td [(Table)-333(A)-333(1)] TJ ET\nBT /F1 11 Tf 72 620 Td [(I)-333(am)-333(a)] TJ ET"]);
  assert.deepEqual(await pdfStrings(tex), ["I am", "Table A 1", "I am a"]);
});

test("PDF: kort linje ved siden av en stor bokstav er ikke hevet skrift og blir stående, og en stor «Q»/«A» foran spørsmål og svar er ikke en initial", async () => {
  const pdf = pdfOf([[line("F2", 26, 72, 700, "Q"), line("F2", 11, 100, 705, "How do I change my delivery address?"),
    line("F2", 26, 72, 650, "A"), line("F1", 11, 100, 655, "Log in and open the settings page."),
    line("F1", 11, 72, 600, "Some other paragraph text that is translated.")].join("\n")]);
  const { strings, buffer } = await applyWith(pdf, (s) => s.replace("How", "Hvordan").replace("Log in", "Logg inn"));
  assert.ok(strings.includes("How do I change my delivery address?") && strings.includes("Log in and open the settings page."), JSON.stringify(strings));
  const items = await textItems(buffer);
  const q = items.find((i) => i.str.startsWith("Hvordan"));
  assert.ok(q && Math.abs(q.x - 100) < 0.5 && Math.abs(q.y - 705) < 0.5, JSON.stringify(q && [q.x, q.y]));
  const a = items.find((i) => i.str.startsWith("Logg inn"));
  assert.ok(a && Math.abs(a.x - 100) < 0.5 && Math.abs(a.y - 655) < 0.5, JSON.stringify(a && [a.x, a.y]));
  assert.deepEqual(items.filter((i) => i.size > 20).map((i) => [i.str, i.x, i.y]), [["Q", 72, 700], ["A", 72, 650]]);
});

test("PDF: like ordmellomrom i blokkjustert tekst er ikke en spalteskiller", async () => {
  // Blokkjustert avsnitt med hvert ord for seg; tre linjer begynner med «ventilation», så hullet etter står på linje.
  const lib = require("pdf-lib");
  const font = await (await lib.PDFDocument.create()).embedFont(lib.StandardFonts.Helvetica);
  const justified = (y, words, width = 260) => {
    const widths = words.map((w) => font.widthOfTextAtSize(w, 10.5));
    const gap = (width - widths.reduce((a, b) => a + b, 0)) / (words.length - 1);
    let x = 57;
    return words.map((w, i) => {
      const out = `BT /F1 10.5 Tf ${x.toFixed(2)} ${y} Td (${w}) Tj ET`;
      x += widths[i] + gap;
      return out;
    }).join("\n");
  };
  const pdf = pdfOf([[
    justified(700, ["Estimate", "cleaning", "budget", "housing", "interest", "roof"]),
    justified(686, ["ventilation", "energy", "pipe", "window", "laundry", "deficit"]),
    justified(672, ["ventilation", "laundry", "interest.", "Facade", "account"]),
    justified(658, ["ventilation", "inspection", "meeting", "facade", "pipe", "roof"]),
    line("F1", 10.5, 57, 644, "and the rest of the paragraph."),
  ].join("\n")]);
  const strings = await pdfStrings(pdf);
  assert.equal(strings.length, 1, JSON.stringify(strings));
  assert.match(strings[0], /^Estimate cleaning budget housing interest roof ventilation energy pipe window laundry deficit ventilation laundry/);
});

test("PDF: justering – venstremarg vinner over tilfeldig lik høyrekant, bildetekst i flukt med boksen, fast bredde blokkjusteres ikke", async () => {
  const pdf = pdfOf([[
    line("F1", 11, 60, 760, "The inspection of the ventilation system was carried out on 12 May by an external firm."),
    line("F1", 11, 60, 746, "All supply and exhaust units were tested and the filters were replaced where needed."),
    line("F2", 13, 60, 720, "Measured air flow per apartment"),
    line("F1", 10, 60, 700, "Apartment"), line("F1", 10, 210, 700, "Supply (l/s)"),
    line("F1", 10, 60, 684, "C-101"), line("F1", 10, 210, 684, "18"),
    "0.5 w 45 560 m 300 560 l 300 660 l 45 660 l h S",
    line("F1", 7.6, 45, 548, "An example of how the search engine can put it together."),
    "BT /F4 7.5 Tf 54 520 Td (KEYWORDS [ferry] \"ferry\" [boat] \"boat\" \"ferry ticket price\" \"buy ferry ticket\" \"harbour\") Tj 0 -11 Td (\"night ferry\" [timetable]) Tj ET",
  ].join("\n")]);
  const { buffer } = await applyWith(pdf, (s) => s.replace(/\p{L}+/gu, (w) => w.slice(0, Math.max(1, w.length - 2))));
  const items = await textItems(buffer);
  const head = items.find((i) => i.size > 12);
  assert.ok(head && Math.abs(head.x - 60) < 0.5, `overskriften står på venstremargen: ${head && head.x}`);
  const caption = items.find((i) => Math.abs(i.y - 548) < 1);
  assert.ok(caption && Math.abs(caption.x - 45) < 0.5, `bildeteksten står i flukt med boksen: ${caption && caption.x}`);
  const mono = items.filter((i) => Math.abs(i.y - 520) < 1 && /Courier/.test(i.style.font));
  assert.ok(mono.length && Math.max(...mono.map((i) => i.x + i.w)) < 440, "første linje i fast bredde strekkes ikke ut");
});

test("PDF: pent brutte linjer fra et program gir ikke harde skift, og avsnittet beholder bredden", async () => {
  // Linjene er brutt litt før boksens kant (neste ord ville fått plass): fortsatt ett avsnitt uten «\n».
  const pdf = pdfOf([[
    "0.5 w 50 500 m 545 500 l 545 560 l 50 560 l h S",
    "BT /F1 11 Tf 55 542 Td 14 TL (Note: the ferry route reopened on 12 June. Deliveries delayed by the storms) Tj T* (have all been completed, and affected customers received a 10% credit) Tj T* (on their next invoice.) Tj ET",
    "BT /F1 11 Tf 60 400 Td 14 TL (Residents on the top floor reported noise from the roof fans) Tj T* (during the night. The contractor recommends dampers, which) Tj T* (will be installed during the summer maintenance period.) Tj ET",
  ].join("\n")]);
  const strings = await pdfStrings(pdf);
  assert.ok(strings.every((s) => !s.includes("\n")), JSON.stringify(strings));
  const { buffer } = await applyWith(pdf, (s) => s.replace(/\p{L}+/gu, (w) => w + w.slice(0, Math.ceil(w.length / 5))));
  const body = (await textItems(buffer)).filter((i) => i.y < 420 && i.y > 300);
  assert.ok(body.length && Math.max(...body.map((i) => i.x + i.w)) < 60 + 300, `avsnittet vokser ikke ut over siden: ${Math.max(...body.map((i) => i.x + i.w))}`);
});

test("PDF: et ord som er bredere enn linjen, deles, og teksten går ikke utenfor siden", async () => {
  const pdf = pdfOf([[line("F1", 11, 400, 700, "Short cell text"), line("F1", 11, 72, 600, "A normal paragraph that is translated.")].join("\n")]);
  const { buffer } = await applyWith(pdf, (s) => (s.startsWith("Short") ? "Å".repeat(160) : s.toUpperCase()));
  const items = await textItems(buffer);
  assert.ok(items.every((i) => i.x + i.w <= 595.5), JSON.stringify(items.map((i) => [i.str.slice(0, 8), Math.round(i.x + i.w)])));
  assert.ok(items.filter((i) => /Å/.test(i.str)).length >= 2, "ordet er delt over flere linjer");
});

test("PDF: dekkfarge for skannede sider hentes bare når PDF-en skrives", async () => {
  const content = "q 595 0 0 842 0 0 cm /Im0 Do Q\nBT 3 Tr /F1 11 Tf 72 700 Td (Scanned words in an invisible text layer.) Tj ET";
  const pdf = pdfWithImage(content, { rgb: 240 });
  assert.equal((await extractPages(pdf, { collect: true }))[0].bg, null);
  assert.ok((await extractPages(pdf))[0].bg, "bakgrunnen er målt når siden skal skrives");
});

test("PDF: uten sikker kobling til tekstoperatorene fjernes all tekst og alt tegnes på nytt, også Words kulepunkt (U+F0B7)", async () => {
  // Den første tekstoperatoren står før en font er satt; pdf.js hopper over den, så antallet stemmer ikke med strømmen.
  const cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /PUA def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <B7> <F0B7> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end";
  const content = [
    "BT 72 780 Td (Orphan) Tj ET",
    "BT /F5 11 Tf 90 700 Td <B7> Tj ET BT /F1 11 Tf 108 700 Td (Replace the lighting in the two main warehouses.) Tj ET",
    "BT /F1 11 Tf 72 650 Td (A second paragraph that is translated as well.) Tj ET",
  ].join("\n");
  const pdf = pdfFromObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F5 6 0 R >> >> >>",
    streamObj(content),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Symbol /ToUnicode 7 0 R >>",
    streamObj(cmap),
  ]);
  const { strings, buffer, warnings } = await applyWith(pdf, upper);
  assert.deepEqual(strings, ["Replace the lighting in the two main warehouses.", "A second paragraph that is translated as well."]);
  const items = await textItems(buffer);
  assert.ok(!items.some((i) => /Replace|second/.test(i.str)), "den opprinnelige teksten er borte");
  const bullet = items.find((i) => i.str.trim() === "•");
  assert.ok(bullet && Math.abs(bullet.x - 90) < 0.5, JSON.stringify(items.map((i) => i.str)));
  assert.ok(items.some((i) => /NB REPLACE THE LIGHTING/.test(i.str)));
  assert.ok(!warnings.some((w) => w.code === "pdf_glyphs"), JSON.stringify(warnings));
});

test("korte strenger (tabellceller) pakkes i større batcher", () => {
  const cells = Array.from({ length: 160 }, (_, i) => `cell ${i}`);
  assert.deepEqual(planBatches(cells).map((b) => b.items.length), [80, 80]);
  const paragraphs = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}: We would like to apply for a place for our daughter.`);
  assert.deepEqual(planBatches(paragraphs).map((b) => b.items.length), [28, 28, 4]);
});

test("PDF: initial med tre innrykkede linjer, høyrejustert bunntekst og ledetekst foran skjemafelt", async () => {
  const lib = require("pdf-lib");
  const font = await (await lib.PDFDocument.create()).embedFont(lib.StandardFonts.Helvetica);
  // Blokkjustert tekst (hvert ord for seg) mellom x og 522.
  const justified = (x, y, words) => {
    const widths = words.map((w) => font.widthOfTextAtSize(w, 10));
    const gap = (522 - x - widths.reduce((a, b) => a + b, 0)) / (words.length - 1);
    return words.map((w, i) => `BT /F1 10 Tf ${(x + widths.slice(0, i).reduce((a, b) => a + b, 0) + gap * i).toFixed(2)} ${y} Td (${w}) Tj ET`).join("\n");
  };
  const pdf = pdfOf([[
    "BT /F1 34 Tf 72 592 Td (T) Tj ET",
    justified(98, 612, ["he", "ferry", "leaves", "the", "mainland", "at", "a", "quarter", "past", "seven,", "and", "for", "the", "first"]),
    justified(98, 600, ["twenty", "minutes", "nobody", "speaks.", "Fishermen", "drink", "coffee", "from", "thermos", "lids,"]),
    justified(98, 588, ["a", "teacher", "marks", "exercise", "books", "balanced", "on", "her", "knees,", "and", "two"]),
    justified(72, 576, ["teenagers", "share", "a", "pair", "of", "earphones", "while", "the", "grey", "water", "slides", "past", "the"]),
    line("F1", 10, 72, 564, "windows of the ferry."),
    line("F1", 9, (522 - font.widthOfTextAtSize("Page 1 of 2", 9)).toFixed(2), 40, "Page 1 of 2"),
    line("F2", 10, 72, 300, "Description of the problem:"),
    "0.5 w 205 300 m 522 300 l S",
  ].join("\n")]);
  const [page] = await extractPages(pdf);
  const drop = layoutPage(page).find((b) => b.drop);
  assert.ok(drop && drop.dropLines === 3 && drop.align === "justify", JSON.stringify(drop && [drop.dropLines, drop.align]));
  const { buffer } = await applyWith(pdf, (s) => s.replace(/\p{L}+/gu, (w) => w + w.slice(0, Math.ceil(w.length / 4))));
  const items = await textItems(buffer);
  const footer = items.filter((i) => Math.abs(i.y - 40) < 1);
  assert.ok(Math.abs(Math.max(...footer.map((i) => i.x + i.w)) - 522) < 1, `bunnteksten slutter på høyremargen: ${JSON.stringify(footer.map((i) => [i.x, i.w]))}`);
  const label = items.filter((i) => i.style.bold && i.y > 280 && i.y < 320);
  assert.ok(label.length && label.every((i) => Math.abs(i.y - 300) < 0.5 && i.x + i.w <= 205), JSON.stringify(label.map((i) => [i.str, i.x, i.y, i.w])));
});

test("PDF: et avsnitt i en trang boks krymper ikke avsnitt med samme stil utenfor boksen, og teksten i boksen blir i boksen med minst en halv linje luft over bunnkanten", async () => {
  const para = (x, y, lines) => `BT /F1 11 Tf ${x} ${y} Td 14 TL ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`;
  const pdf = pdfOf([[
    para(72, 760, ["The board approved a revised investment framework in March. Under the new", "framework, every project above the approval threshold must present a written", "business case and a clear plan for how the benefits will be measured."]),
    "0.9 0.95 0.9 rg 66 600 m 530 600 l 530 660 l 66 660 l h f 0 g",
    para(72, 644, ["Board decision. The roof report, budget and inspection were approved by the", "cooperative security committee after a long discussion in the spring meeting.", "Loan contractor window waste bicycle survey renovation budget."]),
  ].join("\n")]);
  const { buffer } = await applyWith(pdf, (s) => s.replace(/\p{L}+/gu, (w) => w + w.slice(0, Math.ceil(w.length / 3))));
  const items = await textItems(buffer);
  const body = items.filter((i) => i.y > 700);
  const boxed = items.filter((i) => i.y < 660 && i.y > 590);
  assert.ok(body.length && body.every((i) => Math.abs(i.size - 11) < 0.01), `avsnittet utenfor boksen beholder 11 pt: ${[...new Set(body.map((i) => i.size))]}`);
  // Teksten i boksen får bruke boksens bredde (like stor marg på begge sider) før den krympes, og luften over boksens
  // bunnkant (13,25 i originalen) blir ikke mindre enn en halv linjeavstand (7).
  assert.ok(boxed.length && boxed.every((i) => i.y - i.size * 0.25 - 600 >= 7 - 0.01 && i.x + i.w <= 530 - 6 + 0.5),
    `teksten i boksen blir i boksen: ${JSON.stringify(boxed.map((i) => [i.size, i.y, i.x + i.w]))}`);
  assert.ok(boxed.every((i) => i.size >= 9.9 - 0.01), `teksten i boksen krymper høyst to trinn: ${[...new Set(boxed.map((i) => i.size))]}`);
  assert.ok(Math.max(...boxed.map((i) => i.x + i.w)) > 480, "og bruker mer av boksens bredde enn originalen (som sluttet ved 445)");
});

// ---- Runde 3: tabellceller, parallelle blokker, tall som henger sammen, avsnitt i samme spalte, overmalt tekst ----

const paraOf = (x, y, lines, lead = 14, font = "F1") => `BT /${font} 11 Tf ${x} ${y} Td ${lead} TL ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`;
const longer = (s) => s.replace(/\p{L}+/gu, (w) => w + w.slice(0, Math.ceil(w.length / 3)));

test("PDF: tekst i en tabellcelle får bruke cellens bredde og radens høyde i stedet for å krympes; brødteksten beholder bredden", async () => {
  const cell = (x, y, lines) => paraOf(x, y, lines, 12.6);
  const pdf = pdfOf([[
    paraOf(72, 740, ["All information must be classified by its owner according to the table below.", "When in doubt, choose the higher level."]),
    "0 G 0.5 w 72 700 m 540 700 l S 72 655 m 540 655 l S 72 610 m 540 610 l S",
    "72 700 m 72 610 l S 200 700 m 200 610 l S 360 700 m 360 610 l S 540 700 m 540 610 l S",
    cell(78, 690, ["Internal"]), cell(206, 690, ["For employees and", "approved contractors only."]), cell(366, 690, ["Organisation charts,", "internal newsletters,", "meeting notes"]),
    cell(78, 645, ["Public"]), cell(206, 645, ["May be shared freely", "with anyone."]), cell(366, 645, ["Press releases,", "published price lists"]),
  ].join("\n")]);
  const bodyRight = Math.max(...(await textItems(pdf)).filter((i) => i.y > 720).map((i) => i.x + i.w));
  const { buffer } = await applyWith(pdf, longer);
  const items = await textItems(buffer);
  assert.ok(items.every((i) => i.size === 11), `ingen krymping: ${[...new Set(items.map((i) => i.size))]}`);
  assert.ok(items.filter((i) => i.y > 720).every((i) => i.x + i.w <= bodyRight + 1), "brødteksten beholder bredden");
  // Brødteksten får en linje til over tabellen og beholder minst en halv linjeavstand luft over den øverste streken.
  const bodyLow = Math.min(...items.filter((i) => i.y > 700).map((i) => i.y));
  assert.ok(bodyLow - 11 * 0.22 - 700 >= 7 - 0.3, `luft over tabellen: ${bodyLow}`);
  const inCell = (x0, x1, top, bottom) => items.filter((i) => i.x >= x0 && i.x < x1 && i.y < top && i.y > bottom);
  for (const [x0, x1] of [[72, 200], [200, 360], [360, 540]]) {
    for (const [top, bottom] of [[700, 655], [655, 610]]) {
      const got = inCell(x0, x1, top, bottom);
      assert.ok(got.length && got.every((i) => i.x + i.w <= x1 - 1 && i.y - i.size * 0.25 > bottom), `celle ${x0}-${x1}, ${top}: ${JSON.stringify(got.map((i) => [i.str, i.x + i.w, i.y]))}`);
    }
  }
  // Eksempelcellen (tre linjer) må bruke mer av cellens bredde for å få plass i raden.
  assert.ok(Math.max(...inCell(360, 540, 700, 655).map((i) => i.x + i.w)) > 480);
});

test("PDF: spalter med løpende tekst er ikke parallelle – et avsnitt som må krympes i én spalte, krymper ikke avsnittet i nabospalten", async () => {
  const pdf = pdfOf([[
    paraOf(72, 700, ["The ferry company has published a new", "timetable for the winter season, with", "more departures in the morning."]),
    paraOf(72, 600, ["Fewer departures late in the evening."]),
    paraOf(310, 700, ["Passengers with monthly passes do not", "need to do anything, since the new", "timetable is valid for all existing tickets."]),
    line("F2", 14, 310, 648, "Questions and answers"),
    line("F1", 11, 310, 628, "Ask at the ticket office."),
    "0.5 w 310 620 m 540 620 l S",
  ].join("\n")]);
  const { buffer } = await applyWith(pdf, longer);
  const items = await textItems(buffer);
  const left = items.filter((i) => i.x < 300 && i.y > 620);
  const right = items.filter((i) => i.x >= 300 && i.y > 660);
  assert.ok(right.length && right.every((i) => i.size < 11), "høyre spalte må krympes");
  assert.ok(left.length && left.every((i) => i.size === 11), `venstre spalte beholder størrelsen: ${[...new Set(left.map((i) => i.size))]}`);
});

test("PDF: tall som henger sammen (412 000, +47 55 12 34 56) deles ikke, men flyttes samlet til neste linje uten at avsnittet krymper", async () => {
  const pdf = pdfOf([[
    paraOf(72, 700, ["The financial result for the year was better than expected, and the", "board proposes a dividend to the members of the cooperative."]),
    paraOf(72, 640, ["Questions can be sent to the office by e-mail or by telephone."]),
  ].join("\n")]);
  let moved = 0;
  for (let k = 0; k < 12; k++) {
    const filler = "og så videre ".repeat(k);
    const { buffer } = await applyWith(pdf, (s) => (s.startsWith("The financial")
      ? `Resultatet for året ble bedre enn ventet, ${filler}og styret foreslår et utbytte på 412 000 kroner til medlemmene i laget.`
      : `Spørsmål kan sendes til kontoret ${filler}på telefon +47 55 12 34 56 hele dagen.`));
    const items = await textItems(buffer);
    const text = items.map((i) => i.str).join("\n");
    assert.match(text, /412 000/, `k=${k}: ${text}`);
    assert.match(text, /\+47 55 12 34 56/, `k=${k}: ${text}`);
    assert.ok(items.every((i) => i.size === 11), `k=${k}: ${[...new Set(items.map((i) => i.size))]}`);
    if (/^(412 000|\+47)/m.test(text)) moved++;
  }
  assert.ok(moved >= 1, "minst én gang står gruppen først på neste linje");
});

test("PDF: avsnitt under hverandre i samme spalte er én flyt – de neste skyves ned, avstanden mellom avsnittene beholdes, og må de krympes, får de samme størrelse", async () => {
  const two = (below) => pdfOf([[
    paraOf(72, 700, ["The regional transport authority announced the change after a year of", "consultation with residents, commuters and local businesses in the area."]),
    paraOf(72, 668, ["Passengers with monthly passes do not need to do anything; the new", "timetable is valid for all existing tickets and passes."]),
    line("F2", 14, 72, below, "Questions and answers"),
    line("F1", 11, 72, below - 20, "Ask at the ticket office."),
    `0.5 w 72 ${below - 28} m 540 ${below - 28} l S`,
  ].join("\n")]);
  // God plass under: første avsnitt får en linje til i full størrelse, og det andre flyttes ned.
  let items = await textItems((await applyWith(two(560), (s) => (s.startsWith("The regional") ? longer(s) : s.replace(/\.$/, "!")))).buffer);
  const body = items.filter((i) => i.size < 14 && i.y > 560);
  assert.ok(body.every((i) => i.size === 11), `${[...new Set(body.map((i) => i.size))]}`);
  const ys = body.map((i) => i.y).sort((a, b) => b - a);
  assert.equal(ys.length, 5);
  assert.deepEqual(ys.slice(0, 3), [700, 686, 672]);
  // Avsnittsavstanden var 18 (14 + 4 ekstra); minst halvparten av det ekstra beholdes.
  assert.ok(ys[2] - ys[3] >= 16 - 0.01 && ys[3] - ys[4] === 14, JSON.stringify(ys));
  // Trangt (overskrift like under): begge krymper, og til samme størrelse.
  items = await textItems((await applyWith(two(630), longer)).buffer);
  const sizes = new Set(items.filter((i) => i.y > 640).map((i) => i.size));
  assert.equal(sizes.size, 1, `${[...sizes]}`);
  assert.ok([...sizes][0] < 11);
  assert.ok(items.filter((i) => i.y > 640).every((i) => i.y - i.size * 0.25 > 630 + 14 * 0.8), "over overskriften");
});

test("PDF: tekst som er overmalt i originalen (whiteout med sidebakgrunn under), oversettes ikke og tegnes ikke; et lite ikon over teksten skjuler den ikke", async () => {
  const pdf = pdfOf([[
    "0.97 0.97 0.92 rg 0 0 595 842 re f",
    "0 g BT /F1 11 Tf 72 700 Td (Old price: 100 NOK per month, valid until March.) Tj ET",
    "0.97 0.97 0.92 rg 66 694 300 20 re f",
    "0 g BT /F1 11 Tf 72 670 Td (New price: 120 NOK per month from April.) Tj ET",
    "0.9 0.2 0.2 rg 200 668 12 12 re f",
  ].join("\n")]);
  const { strings, buffer } = await applyWith(pdf, upper);
  assert.deepEqual(strings, ["New price: 120 NOK per month from April."]);
  assert.deepEqual((await textItems(buffer)).map((i) => [i.str, i.y]), [["NB NEW PRICE: 120 NOK PER MONTH FROM APRIL.", 670]]);
  assert.ok(!(await pageStreams(buffer)).some((s) => /Old price|\(Old/.test(s)), "den overmalte teksten er borte");
});

test("PDF: et bilde med myk maske (ExtGState /SMask) over teksten er gjennomsiktig og gjør ikke teksten usynlig", async () => {
  const zlib = require("zlib");
  const gray = zlib.deflateSync(Buffer.alloc(100 * 100 * 3, 60));
  const pdf = pdfFromObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> /ExtGState << /GS1 7 0 R >> >> >>",
    streamObj("BT /F1 11 Tf 72 700 Td (The committee reviewed the budget for the coming year.) Tj ET\nq /GS1 gs 595 0 0 842 0 0 cm /Im0 Do Q"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    { dict: `<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${gray.length} >>`, data: gray },
    "<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 8 0 R >> >>",
    { dict: "<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Group << /S /Transparency /CS /DeviceGray >> /Length 16 >>", data: Buffer.from("0 g 0 0 1 1 re f") },
  ]);
  const [page] = await extractPages(pdf);
  assert.ok(page.items.length && page.items.every((i) => !i.invisible));
  // Ingen dekkboks i bildets farge (60/255) bak teksten.
  const streams = await pageStreams((await applyWith(pdf, upper)).buffer);
  assert.ok(!streams.some((s) => s.includes("0.235 0.235 0.235 rg")), "ingen mørk dekkboks");
});

test("PDF: en vanlig setning som slutter med kolon, brytes i full størrelse i stedet for å krympes", async () => {
  const pdf = pdfOf([[
    line("F1", 11, 72, 712, "After a long discussion the members agreed on the following main points:"),
    line("F1", 11, 72, 670, "\\225"), line("F1", 11, 86, 670, "The membership fee stays the same."),
  ].join("\n")]);
  const { buffer } = await applyWith(pdf, (s) => (s.endsWith(":")
    ? "Etter en lang og grundig diskusjon i salen ble medlemmene til slutt enige om de følgende hovedpunktene:" : s));
  const lines = (await textItems(buffer)).filter((i) => i.y > 690);
  assert.ok(lines.length === 2 && lines.every((i) => i.size === 11), JSON.stringify(lines.map((i) => [i.str, i.y, i.size])));
});

test("PDF: avsnitt som fortsetter i neste spalte under et avsnitt over hele bredden, oversettes samlet", async () => {
  const pdf = pdfOf([[
    paraOf(72, 760, ["The board met eleven times during the year and dealt with a wide range of matters, from the", "budget and the maintenance plan to the new rules for the use of the common areas."]),
    paraOf(72, 720, ["The largest project of the year was", "the renovation of the facades on the", "north side, which was planned with"]),
    paraOf(310, 720, ["the contractor during the spring and", "completed on time before the winter."]),
    paraOf(310, 684, ["The work on the south side will start", "next year, after a new round of offers."]),
  ].join("\n")]);
  const strings = await pdfStrings(pdf);
  assert.equal(strings.length, 3, JSON.stringify(strings));
  assert.match(strings[1], /planned with the contractor during the spring and completed on time before the winter\.$/);
});

// ---- Runde 4: dekket tekst bare når det er sikkert, celler med flere blokker, flyt med originale avstander ----

// Tekstlinjer som overlapper hverandre (samme område på siden).
const overlaps = (items) => {
  const out = [];
  items.forEach((a, m) => items.slice(m + 1).forEach((b) => {
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.size * 0.7, b.y + b.size * 0.7) - Math.max(a.y - a.size * 0.2, b.y - b.size * 0.2);
    if (ox > 1 && oy > 1) out.push([a.str.slice(0, 20), a.y, b.str.slice(0, 20), b.y]);
  }));
  return out;
};

test("PDF: tekst som bare ser dekket ut, blir stående – beskåret bilde, klippet flate, skjemaobjekt med /BBox, mønster og buet flate; og dekkes all tekst, tas ingenting ut", async () => {
  const para = "BT /F1 11 Tf 72 700 Td (The committee reviewed the budget for the coming year in detail and) Tj 0 -14 Td (approved the plan with minor changes after a long discussion.) Tj ET";
  const full = "The committee reviewed the budget for the coming year in detail and approved the plan with minor changes after a long discussion.";
  // Et bilde og en flate som er klippet til et område under teksten (nettleserens overflow:hidden, beskåret bilde).
  for (const paint of ["q 72 500 300 120 re W n 300 0 0 280 72 500 cm /Im0 Do Q", "q 72 500 300 120 re W n 0.8 0.85 0.9 rg 0 0 595 842 re f Q"]) {
    const pdf = pdfWithImage([para, paint, "BT /F1 11 Tf 72 480 Td (Caption under the picture.) Tj ET"].join("\n"), { rgb: 150 });
    const { strings, buffer } = await applyWith(pdf, upper);
    assert.deepEqual(strings, [full, "Caption under the picture."], paint);
    assert.ok((await textItems(buffer)).some((i) => /APPROVED THE PLAN/.test(i.str)), paint);
  }
  const objects = (content, extra) => pdfFromObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> ${extra[0]} >> >>`,
    streamObj(content),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ...extra.slice(1),
  ]);
  const sentence = "BT /F1 11 Tf 72 700 Td (The committee reviewed the budget and approved the plan.) Tj ET";
  // Skjemaobjekt (logo) med en flate som er større enn /BBox: bare det innenfor /BBox synes.
  const form = objects(`${sentence}\nq 1 0 0 1 400 500 cm /Fm0 Do Q`, ["/XObject << /Fm0 6 0 R >>",
    { dict: "<< /Type /XObject /Subtype /Form /BBox [0 0 120 60] /Length 37 >>", data: Buffer.from("0.2 0.4 0.8 rg -400 -100 600 400 re f") }]);
  // Skravur (mønster med gjennomsiktig bakgrunn) over en merkelapp.
  const hatch = objects(`${sentence}\n/Pattern cs /P0 scn 60 690 330 30 re f`, ["/Pattern << /P0 6 0 R >>",
    { dict: "<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 8 8] /XStep 8 /YStep 8 /Resources << >> /Length 30 >>", data: Buffer.from("0.6 0 0 RG 0.5 w 0 0 m 8 8 l S") }]);
  // Buet, ugjennomsiktig flate (sirkel, avrundet form): rammen er større enn det som faktisk dekker.
  const blob = pdfOf([`${sentence}\n1 1 1 rg 60 705 m 60 740 390 740 390 705 c 390 670 60 670 60 705 c f`]);
  for (const [name, pdf] of [["skjema", form], ["skravur", hatch], ["buet", blob]]) {
    assert.deepEqual(await pdfStrings(pdf), ["The committee reviewed the budget and approved the plan."], name);
  }
  // En ugjennomsiktig flate over sidens eneste tekst: det er heller dekket som er feiltolket (ingen «Fant ingen tekst»).
  const only = pdfOf([`${sentence}\n1 1 1 rg 60 690 340 30 re f`]);
  assert.deepEqual(await pdfStrings(only), ["The committee reviewed the budget and approved the plan."]);
  // Og når det eneste som ellers står på siden, er et tall: heller ikke da forsvinner all tekst som kan oversettes.
  const numbers = pdfOf([[line("F1", 11, 72, 760, "12 345"), sentence, "1 1 1 rg 60 690 340 30 re f"].join("\n")]);
  assert.deepEqual(await pdfStrings(numbers), ["The committee reviewed the budget and approved the plan."]);
});

test("PDF: tabellcelle med tittel over tekst eller innledning over punkter – øverste blokk vokser ikke ned over blokken under", async () => {
  const right = ["Documents in this class may be shared with", "all employees and hired consultants who", "have signed the confidentiality agreement.",
    "They must not be sent to customers or", "partners without written approval from", "the department manager, and printed copies", "must be shredded after use."];
  const table = (left) => pdfOf([["0.5 w 60 560 m 540 560 l S 60 730 m 540 730 l S 60 560 m 60 730 l S 250 560 m 250 730 l S 540 560 m 540 730 l S",
    ...left, ...right.map((t, i) => line("F1", 11, 256, 712 - 14 * i, t))].join("\n")]);
  const titled = table([line("F2", 11, 66, 712, "Internal"), line("F1", 11, 66, 686, "Only staff members may"), line("F1", 11, 66, 672, "read this document.")]);
  let items = await textItems((await applyWith(titled, (s) => (s === "Internal" ? "Intern bruk for avdelingen, styret og innleide konsulenter" : `NB ${s}`))).buffer);
  const leftCell = (list) => list.filter((i) => i.x < 250);
  assert.deepEqual(overlaps(leftCell(items)), []);
  assert.ok(leftCell(items).every((i) => i.x + i.w <= 250 && i.y > 560), JSON.stringify(leftCell(items).map((i) => [i.str, i.x + i.w, i.y])));
  const bullets = table([line("F1", 11, 66, 712, "Access is granted when"), line("F1", 11, 66, 698, "all of these are met:"),
    line("F1", 11, 66, 680, "\\225"), line("F1", 11, 80, 680, "signed agreement"), line("F1", 11, 66, 666, "\\225"), line("F1", 11, 80, 666, "valid staff card")]);
  items = await textItems((await applyWith(bullets, (s) => (s.startsWith("Access") ? "Tilgang gis først når alle disse kravene er oppfylt og godkjent av lederen:" : `NB ${s}`))).buffer);
  assert.deepEqual(overlaps(leftCell(items)), []);
  assert.ok(leftCell(items).every((i) => i.x + i.w <= 250 && i.y > 560), JSON.stringify(leftCell(items).map((i) => [i.str, i.x + i.w, i.y])));
});

test("PDF: avsnitt i samme flyt beholder avstanden mellom seg og minst halvparten av luften over overskriften under – linjene blir høyst 5 % tettere (likt i hele flyten) før luften brukes, og blir et avsnitt kortere, flyttes de neste opp", async () => {
  const P = [
    ["The regional transport authority announced the change after a year of", "consultation with residents, commuters and local businesses in the", "area, and the new timetable starts on the first Monday in October."],
    ["Passengers with monthly passes do not need to do anything, since the", "new timetable is valid for all existing tickets and passes, including", "the discounted passes for students and pensioners in the region."],
    ["Ferries will run every thirty minutes during the morning and afternoon", "rush hours, and every hour in the middle of the day and in the late", "evening, with the last departure from the city centre at midnight."],
  ];
  // Avsnittene står 24 pt fra hverandre (linjeavstand 14); overskriften under gir ikke plass til en linje til.
  const pdf = pdfOf([[paraOf(72, 700, P[0]), paraOf(72, 648, P[1]), paraOf(72, 596, P[2]), line("F2", 14, 72, 536, "Questions and answers"),
    line("F1", 11, 72, 516, "Ask at the ticket office."), "0.5 w 72 508 m 540 508 l S"].join("\n")]);
  const same = (s) => s.replace(/\bthe\b/g, "den");
  const ys = async (fn) => (await textItems((await applyWith(pdf, fn)).buffer)).filter((i) => i.size < 14 && i.y > 530).sort((a, b) => b.y - a.y);
  let body = await ys((s) => (s.startsWith("Passengers") ? longer(s) : same(s)));
  assert.equal(body.length, 10);
  assert.ok(body.every((i) => i.size === 11), JSON.stringify(body.map((i) => i.size)));
  const y = body.map((i) => i.y);
  assert.equal(y[0], 700, "første avsnitt begynner der det begynte");
  // Samme linjeavstand i alle avsnittene, ikke tettere enn 0,95 av originalen (luften brukes heller enn at linjene
  // blir tettere).
  const pitches = [y[0] - y[1], y[1] - y[2], y[3] - y[4], y[4] - y[5], y[5] - y[6], y[7] - y[8], y[8] - y[9]];
  assert.ok(pitches.every((p) => Math.abs(p - pitches[0]) < 0.02 && p <= 14 + 0.01 && p >= 13.3 - 0.01), `én linjeavstand: ${pitches}`);
  // Avsnittene står 24 fra hverandre (10 mer enn linjeavstanden); minst halvparten av det ekstra beholdes, likt.
  assert.ok(y[2] - y[3] >= 19 - 0.01 && y[6] - y[7] >= 19 - 0.01 && Math.abs(y[2] - y[3] - (y[6] - y[7])) < 0.02,
    `minst halvparten av luften mellom avsnittene beholdes, likt: ${y[2] - y[3]}, ${y[6] - y[7]}`);
  // Luften over overskriften var 18 (fra 568 − 0,25 × 11 ned til 536 + 0,8 × 14); minst halvparten beholdes.
  assert.ok(y[9] - 11 * 0.25 - (536 + 14 * 0.8) >= 9 - 0.01, `minst halvparten av luften over overskriften: ${y[9]}`);
  // Første avsnitt blir én linje: de neste flyttes opp, så avstanden mellom avsnittene er den samme som før.
  body = await ys((s) => (s.startsWith("The regional") ? "Endringen gjelder fra oktober." : same(s)));
  assert.deepEqual(body.map((i) => i.y), [700, 676, 662, 648, 624, 610, 596]);
});

test("PDF: et bredt avsnitt skyves ikke ned ved siden av noe som står ved et kort siste avsnitt, og et ord bredere enn spalten krymper bare sitt eget avsnitt", async () => {
  const pdf = pdfOf([[
    line("F1", 11, 72, 700, "The committee reviewed the budget for the coming year in detail and approved"),
    line("F1", 11, 72, 686, "the plan with minor changes after a long discussion about the priorities for"),
    line("F1", 11, 72, 672, "the new season and the need for more volunteers in the youth section."),
    line("F1", 11, 72, 644, "Thank you all for coming."),
    line("F1", 11, 380, 644, "Bergen, 12 March 2026"),
  ].join("\n")]);
  const long = "Styret gikk grundig gjennom budsjettet for det kommende året og godkjente planen med små endringer etter en lang diskusjon om prioriteringene for den nye sesongen, behovet for flere frivillige i ungdomsavdelingen og nye rutiner for regnskapet, medlemskontingenten, dugnadene og samarbeidet med skolene i bydelen gjennom hele året.";
  const items = await textItems((await applyWith(pdf, (s) => (s.startsWith("The committee") ? long : `NB ${s}`))).buffer);
  assert.deepEqual(overlaps(items), []);
  const closing = items.find((i) => i.str.includes("Thank you"));
  assert.ok(closing && closing.y === 644 && closing.size === 11, JSON.stringify(closing));

  // Smal spalte med fire avsnitt; oversettelsen av det tredje har et sammensatt ord som er bredere enn spalten.
  const paras = [
    ["The ferry leaves the mainland at a", "quarter past seven every morning", "and returns in the late afternoon."],
    ["Tickets can be bought on board or", "online through the new app which", "was launched in May this year."],
    ["The committee for the working", "environment has approved the new", "procedure for the monthly meetings."],
    ["Residents get a discount on all", "routes when they show a valid", "card at the ticket office."],
  ];
  const column = pdfOf([paras.map((p, k) => p.map((t, j) => line("F1", 9.5, 60, 760 - k * 44 - j * 12, t)).join("\n")).join("\n")]);
  const col = await textItems((await applyWith(column, (s) => (s.startsWith("The committee")
    ? "Arbeidsmiljøutvalgsmøteprotokollgodkjenningen for den nye ordningen med månedlige møter er vedtatt." : s.replace(/\bthe\b/g, "den")))).buffer);
  const third = col.filter((i) => i.y < 684 && i.y > 640);
  assert.ok(third.length && third.every((i) => i.size < 9.5), JSON.stringify(third.map((i) => [i.str, i.size])));
  assert.ok(col.filter((i) => !third.includes(i)).every((i) => i.size === 9.5), JSON.stringify(col.map((i) => [i.y, i.size])));
});

test("PDF: stor initial foran en innledning i versaler («O» + «NCE UPON A TIME») hører til avsnittet", async () => {
  const pdf = pdfOf([[
    line("F2", 34, 40, 692.5, "O"),
    line("F1", 9.5, 66, 712.8, "NCE UPON A TIME the harbour was"), line("F1", 9.5, 66, 700, "the heart of the town, and the boats"),
    line("F1", 9.5, 40, 687.3, "came in every morning with fish, and for the first"),
    line("F1", 9.5, 40, 674.6, "twenty minutes nobody said a word on the deck."),
  ].join("\n")]);
  const { strings, buffer } = await applyWith(pdf, (s) => s.replace("ONCE UPON A TIME", "DET VAR EN GANG"));
  assert.equal(strings.length, 1, JSON.stringify(strings));
  assert.match(strings[0], /^ONCE UPON A TIME the harbour was\s+the heart of the town/);
  const items = await textItems(buffer);
  assert.deepEqual(items.filter((i) => i.size > 20).map((i) => [i.str, i.x]), [["D", 40]]);
  // Linjen under den første står også ved siden av initialen, ikke under den.
  const second = items.find((i) => /heart of/.test(i.str));
  assert.ok(second && second.x >= 60, JSON.stringify(items.map((i) => [i.str, i.x, i.y])));
});

test("PDF: understreking som slutter rett foran et punktum, fjernes og tegnes under den oversatte teksten", async () => {
  // Understreket fet tekst (Word): streken går 0,55 pt inn under punktumet etter de understrekede ordene.
  const text = [
    "BT /F1 11 Tf 72 700 Td (The scheme is voluntary, but ) Tj /F2 11 Tf (all managers take part) Tj /F1 11 Tf (.) Tj ET",
    line("F1", 11, 72, 640, "Another paragraph so the page has a text measure."),
  ];
  const plain = await textItems(pdfOf([text.join("\n")]));
  const x0 = plain.find((i) => i.str.startsWith("all")).x;
  const x1 = plain.find((i) => i.str === ".").x + 0.55;
  const rule = `${x0.toFixed(2)} 697.8 ${(x1 - x0).toFixed(2)} 0.7 re f`;
  const pdf = pdfOf([[text[0], rule, text[1]].join("\n")]);
  const { buffer } = await applyWith(pdf, (s) => s.replace("voluntary", "frivillig for alle"));
  const streams = (await pageStreams(buffer)).join("\n");
  assert.ok(!streams.includes(rule), "den opprinnelige streken er fjernet");
  assert.ok(/re f/.test(streams), "ny understreking under de oversatte ordene");
});

test("PDF: tankestrek i en egen tekstoperator (flyttet med Td) limer ikke sammen ordene", async () => {
  // Hvert ord for seg, flyttet med Td; hullet foran bindestreken er et ordmellomrom (0,33 em), ikke et mellomromstegn.
  const pdf = pdfOf(["BT /F1 11 Tf 72 700 Td (The results from the first quarter were) Tj 186.5 0 Td (good) Tj 28.1 0 Td (-) Tj -214.6 -14 Td (but not as strong as the board had hoped for.) Tj ET"]);
  const strings = await pdfStrings(pdf);
  assert.equal(strings.length, 1, JSON.stringify(strings));
  assert.ok(!/goodbut/.test(strings[0]) && /good -\s?but/.test(strings[0]), strings[0]);
  // Orddeling tegnet på samme måte, men helt inntil ordet: ordet limes sammen.
  const hyphen = pdfOf(["BT /F1 11 Tf 72 700 Td (The results from the first quarter were very en) Tj 223.3 0 Td (-) Tj -223.3 -14 Td (couraging for the whole board and the staff.) Tj ET"]);
  assert.match((await pdfStrings(hyphen))[0], /very encouraging for/);
});

// ---- Runde 5: flyten flytter bare inn i ledig plass, lag (valgfritt innhold), initial eller etikett, store klipp ----

test("PDF: en avslutning («Yours faithfully,») skyves aldri ned i plassen til underskriften, verken når brevet blir lengre eller kortere", async () => {
  const P = [
    ["We write to inform you that the agreement between our client and your company", "will be terminated with effect from the end of April, in accordance with the", "notice period that is set out in clause 18.2 of the agreement."],
    ["Until that date, both parties remain bound by all of their obligations under", "the agreement, including the obligations of confidentiality."],
    ["Please acknowledge receipt of this letter by returning the enclosed form,", "duly completed and signed, to the address shown above."],
  ];
  const pdf = pdfOf([[paraOf(72, 700, P[0]), paraOf(72, 650, P[1]), paraOf(72, 614, P[2]),
    line("F1", 11, 72, 578, "Yours faithfully,"), line("F2", 11, 72, 534, "Fiona MacLeod")].join("\n")]);
  for (const fn of [longer, (s) => (s.startsWith("We write") ? "Avtalen avsluttes i april." : s.replace(/\bthe\b/g, "den"))]) {
    const items = await textItems((await applyWith(pdf, (s) => (s === "Yours faithfully," ? "Med vennlig hilsen," : s === "Fiona MacLeod" ? s : fn(s)))).buffer);
    assert.deepEqual(overlaps(items), []);
    const closing = items.find((i) => i.str.startsWith("Med vennlig"));
    const name = items.find((i) => i.str === "Fiona MacLeod");
    assert.ok(closing && closing.y === 578 && closing.size === 11, JSON.stringify(closing));
    assert.ok(name && name.y === 534, JSON.stringify(name));
    const body = items.filter((i) => i.y > 578);
    assert.ok(body.every((i) => i.y - i.size * 0.25 > 578 + 11 * 0.8), JSON.stringify(body.map((i) => [i.y, i.size])));
  }
});

test("PDF: blir et avsnitt kortere, trekkes avsnittet under ikke opp over en stor initial, et ikon eller tekst ved siden av", async () => {
  // Stor initial over tre linjer; avsnitt B følger under.
  const cap = pdfOf([[
    line("F1", 16, 40, 750, "Harbour stories"),
    line("F2", 34, 40, 687.3, "T"),
    line("F1", 9.5, 66, 712.8, "he ferry leaves the mainland at a quarter"),
    line("F1", 9.5, 66, 700, "past seven, and for the first twenty minutes"),
    line("F1", 9.5, 66, 687.3, "nobody says a word on the deck at all."),
    line("F1", 9.5, 40, 668.6, "Today the harbour is quieter, but the old market is"),
    line("F1", 9.5, 40, 655.9, "open every Saturday, and the fish sellers still shout"),
    line("F1", 9.5, 40, 643.2, "their prices across the square as they always did."),
  ].join("\n")]);
  let items = await textItems((await applyWith(cap, (s) => (s.startsWith("The ferry") ? "The ferry leaves at seven." : s))).buffer);
  assert.deepEqual(overlaps(items), []);
  assert.ok(items.some((i) => i.str === "T" && i.size === 34), "initialen står");
  // Et ikon til høyre for avsnitt A (A brytes rundt det), og tekst ved siden av A.
  const A = [
    "The committee reviewed the budget for the coming year in detail and then",
    "approved the plan with only minor changes after a long discussion about",
    "the priorities for the new season and the need for more volunteers in the",
    "youth section during the spring and the early summer months, when most of the",
  ];
  const B = [
    "Staff turnover remained stable at around nine per cent, which is mostly due to",
    "relocation rather than dissatisfaction with the working conditions, as it was",
    "shown by the survey that was carried out among all of the employees in March.",
  ];
  const beside = (extra) => pdfOf([[line("F1", 11, 72, 740, "Annual report of the harbour association"),
    ...A.map((t, i) => line("F1", 11, 72, 700 - i * 14, t)), extra, ...B.map((t, i) => line("F1", 11, 72, 632 - i * 14, t)),
    line("F1", 11, 72, 560, "Contact the office if you have more questions about the report.")].join("\n")]);
  const shorter = (s) => (s.startsWith("The committee") ? "Styret godkjente budsjettet." : s.replace("Staff turnover", "Staff-turnover"));
  items = await textItems((await applyWith(beside("q 0.85 0.3 0.2 rg 438 668 30 40 re f Q"), shorter)).buffer);
  const onIcon = items.filter((i) => i.x + i.w > 438 && i.x < 468 && i.y + i.size * 0.7 > 668 && i.y - i.size * 0.2 < 708);
  assert.deepEqual(onIcon.map((i) => [i.str.slice(0, 20), i.y]), []);
  items = await textItems((await applyWith(beside([line("F2", 9, 460, 700, "Budget 2026:"), line("F1", 9, 460, 689, "NOK 1.2 million"),
    line("F1", 9, 460, 678, "(was 1.1 million)")].join("\n")), shorter)).buffer);
  assert.deepEqual(overlaps(items), []);
});

test("PDF: står siste avsnitt i en flyt urørt (teksten er ikke endret), skyves avsnittet over ikke ned i det", async () => {
  const P = [
    ["The regional transport authority announced the change after a year of", "consultation with residents, commuters and local businesses in the", "area, and the new timetable starts on the first Monday in October."],
    ["Passengers with monthly passes do not need to do anything, since the", "new timetable is valid for all existing tickets and passes, including", "the discounted passes for students and pensioners in the region."],
    ["Ferries will run every thirty minutes during the morning and afternoon", "rush hours, and every hour in the middle of the day and in the late", "evening, with the last departure from the city centre at midnight."],
  ];
  const pdf = pdfOf([[paraOf(72, 700, P[0]), paraOf(72, 648, P[1]), paraOf(72, 596, P[2]), line("F1", 11, 72, 300, "Page footer text that is far below.")].join("\n")]);
  const items = await textItems((await applyWith(pdf, (s) => (s.startsWith("Ferries") || s.startsWith("Page") ? s : longer(s)))).buffer);
  assert.deepEqual(overlaps(items), []);
  assert.deepEqual(items.filter((i) => i.size === 11 && i.y > 400).map((i) => i.y), [596, 582, 568], "det urørte avsnittet står der det stod");
});

// Side med lag (valgfritt innhold): objekt 7 er laget, `state` er /D-oppsettet (null: dokumentet mangler /OCProperties).
function pdfWithLayer(content, state) {
  return pdfFromObjects([
    `<< /Type /Catalog /Pages 2 0 R ${state ? `/OCProperties << /OCGs [7 0 R] /D << ${state} /Order [7 0 R] >> >>` : ""} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /Properties << /oc1 7 0 R >> >> >>",
    streamObj(content),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    "<< /Type /OCG /Name (Layer) >>",
  ]);
}

test("PDF: lag som er av, tegnes ikke – en flate der dekker ikke teksten, og tekst der verken oversettes eller vises (den står urørt i laget)", async () => {
  const first = "BT /F1 11 Tf 72 780 Td (This first line is always visible on the page.) Tj ET";
  const target = "BT /F1 11 Tf 72 700 Td (Target sentence that sits in the middle of the page.) Tj ET";
  const fill = "/OC /oc1 BDC 1 1 1 rg 68 694 360 18 re f EMC";
  const off = "/ON [] /OFF [7 0 R]";
  // Hvit flate i et skjult lag over teksten: teksten synes og oversettes.
  let { strings } = await applyWith(pdfWithLayer([first, target, fill].join("\n"), off), upper);
  assert.deepEqual(strings, ["This first line is always visible on the page.", "Target sentence that sits in the middle of the page."]);
  // Ukjent tilstand (laget finnes ikke i /OCProperties): heller ikke da regnes flaten som et dekke.
  ({ strings } = await applyWith(pdfWithLayer([first, target, fill].join("\n"), null), upper));
  assert.equal(strings.length, 2, JSON.stringify(strings));
  // Laget er på: flaten dekker teksten som før.
  ({ strings } = await applyWith(pdfWithLayer([first, target, fill].join("\n"), "/ON [7 0 R] /OFF []"), upper));
  assert.deepEqual(strings, ["This first line is always visible on the page."]);
  // Tekst i et skjult lag: ikke med, ikke tegnet synlig, men står urørt i laget.
  const hidden = "/OC /oc1 BDC BT /F1 11 Tf 72 700 Td (Answer key: the correct answer is B.) Tj ET EMC";
  const res = await applyWith(pdfWithLayer([first, hidden].join("\n"), off), upper);
  assert.deepEqual(res.strings, ["This first line is always visible on the page."]);
  const streams = (await pageStreams(res.buffer)).join("\n");
  assert.ok(!streams.includes("414E53574552"), "ikke tegnet på nytt (ANSWER i heks)");
  assert.ok(/\/OC \/oc1 BDC[^]*\(Answer key: the correct answer is B\.\) Tj[^]*EMC/.test(streams), "står i laget");
});

test("PDF: en stor «Q»/«A» foran et svar som begynner med «I», «A» eller en forkortelse, er en etikett, ikke en initial", async () => {
  const faq = (a1, a2) => pdfOf([[
    line("F2", 26, 72, 700, "Q"), line("F2", 11, 100, 705, "How do I change the delivery address for"), line("F2", 11, 100, 691.8, "my weekly newspaper subscription?"),
    line("F2", 26, 72, 640, "A"), line("F1", 11, 100, 645, a1), line("F1", 11, 100, 631.8, a2),
    line("F1", 11, 72, 560, "Contact the office if you have more questions about your membership."),
  ].join("\n")]);
  for (const [a1, a2] of [["I recommend that you log in and open the settings", "page, then choose a new address and save it."],
    ["A credit card works fine, and you can also pay", "by invoice if you prefer that."], ["PDF copies of both documents are on the member", "pages under the heading Documents."]]) {
    const strings = await pdfStrings(faq(a1, a2));
    assert.ok(strings.includes("Q") && strings.includes("A"), JSON.stringify(strings));
    assert.ok(strings.some((s) => s.startsWith(a1.split(" ")[0] + " ")), JSON.stringify(strings));
  }
});

test("PDF: et klipp med svært mange delstier (over 100 000) gir ikke RangeError", async () => {
  const lib = require("pdf-lib");
  const doc = await lib.PDFDocument.create();
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("This is a normal paragraph of English text that should be translated.", { x: 72, y: 700, size: 12, font });
  let clip = "q\n72 600 450 150 re\n";
  for (let i = 0; i < 130000; i++) clip += `${((i % 400) * 1.4).toFixed(1)} ${(Math.floor(i / 400) * 1.4).toFixed(1)} 1 1 re\n`;
  const refs = [doc.context.register(doc.context.flateStream(`${clip}W n\n`))];
  const contents = page.node.Contents();
  if (contents instanceof lib.PDFArray) refs.push(...contents.asArray());
  else refs.push(page.node.get(lib.PDFName.of("Contents")));
  refs.push(doc.context.register(doc.context.flateStream("Q\n")));
  page.node.set(lib.PDFName.of("Contents"), doc.context.obj(refs));
  assert.deepEqual(await pdfStrings(Buffer.from(await doc.save())), ["This is a normal paragraph of English text that should be translated."]);
});

// ---- Runde 6: slutten av teksten er ledig plass, like avsnitt likt, følgere, skjulte lag i skjemaobjekter ----

const R6 = [
  ["The regional transport authority announced the change after a year of", "consultation with residents, commuters and local businesses in the", "area, and the new timetable starts on the first Monday in October."],
  ["Passengers with monthly passes do not need to do anything, since the", "new timetable is valid for all existing tickets and passes, including", "the discounted passes for students and pensioners in the region."],
  ["Ferries will run every thirty minutes during the morning and afternoon", "rush hours, and every hour in the middle of the day and in the late", "evening, with the last departure from the city centre at midnight."],
];
const byY = (items) => items.slice().sort((a, b) => b.y - a.y);

test("PDF: luften over en løpende bunntekst er ledig plass – flyten beholder størrelse og linjeavstand, og bunnteksten står fast med luft over seg", async () => {
  const pdf = pdfOf([[paraOf(72, 180, R6[0]), paraOf(72, 128, R6[1]), line("F1", 9, 280, 40, "Page 2 of 4")].join("\n")]);
  const items = byY(await textItems((await applyWith(pdf, (s) => (s.startsWith("Page") ? s : longer(s)))).buffer));
  const body = items.filter((i) => i.size !== 9);
  assert.ok(body.length === 8 && body.every((i) => i.size === 11), JSON.stringify(body.map((i) => [i.y, i.size])));
  const y = body.map((i) => i.y);
  assert.deepEqual([y[0] - y[1], y[1] - y[2], y[2] - y[3], y[4] - y[5], y[5] - y[6], y[6] - y[7]].map((d) => Math.round(d * 100) / 100), [14, 14, 14, 14, 14, 14]);
  assert.equal(y[3] - y[4], 24, "avstanden mellom avsnittene er som før");
  const footer = items.find((i) => i.size === 9);
  assert.ok(footer && footer.y === 40 && y[7] - 11 * 0.25 - (40 + 9 * 0.8) >= 0.6 * 14 - 0.01, `luft over bunnteksten: ${y[7]}`);
});

test("PDF: like avsnitt på samme side settes likt – en flyt og et enkelt avsnitt foran hver sin overskrift får samme størrelse og linjeavstand", async () => {
  const pdf = pdfOf([[line("F2", 14, 72, 760, "Purpose"), paraOf(72, 740, R6[0]), paraOf(72, 688, R6[1]), line("F2", 14, 72, 620, "Scope"), paraOf(72, 600, R6[2]),
    line("F2", 14, 72, 532, "Rules"), "0.5 w 72 520 m 540 520 l S", line("F1", 11, 72, 505, "Table row one"), "72 495 m 540 495 l S"].join("\n")]);
  const plus = (s) => s.replace(/\.$/, ", and the board will publish a short summary of the results soon.");
  const items = byY(await textItems((await applyWith(pdf, (s) => (/^(Passengers|Ferries)/.test(s) ? plus(s) : s))).buffer));
  const body = items.filter((i) => i.size < 14 && i.y > 540);
  assert.ok(body.every((i) => i.size === 11), JSON.stringify(body.map((i) => i.size)));
  const purpose = body.filter((i) => i.y > 630 && i.y < 700).map((i) => i.y);
  const scope = body.filter((i) => i.y < 610).map((i) => i.y);
  assert.equal(purpose.length, 4);
  assert.equal(scope.length, 4);
  const pitch = (ys) => (ys[0] - ys[ys.length - 1]) / (ys.length - 1);
  assert.ok(Math.abs(pitch(purpose) - pitch(scope)) < 0.05 && pitch(scope) >= 13.3 - 0.01, `samme linjeavstand: ${pitch(purpose)} ${pitch(scope)}`);
  // Luften over begge overskriftene (26 i originalen) blir den samme, og minst halvparten beholdes.
  const white = (ys, head) => ys[ys.length - 1] - 11 * 0.25 - (head + 14 * 0.8);
  assert.ok(Math.abs(white(purpose, 620) - white(scope, 532)) < 0.5 && white(scope, 532) >= 13 - 0.01, `${white(purpose, 620)} ${white(scope, 532)}`);
});

test("PDF: et kort siste avsnitt på én linje der teksten slutter, hører til flyten – ingen blir mindre", async () => {
  const pdf = pdfOf([[line("F2", 14, 72, 760, "Annual meeting"), paraOf(72, 736, R6[0]), paraOf(72, 684, R6[1]), paraOf(72, 632, ["Thank you for another good year."])].join("\n")]);
  const items = byY(await textItems((await applyWith(pdf, (s) => (s.startsWith("Annual") ? s : longer(s)))).buffer));
  const body = items.filter((i) => i.size < 14);
  assert.ok(body.length === 9 && body.every((i) => i.size === 11), JSON.stringify(body.map((i) => [i.y, i.size])));
  assert.deepEqual(overlaps(items), []);
  // Avstanden til siste linje er som før (24 = 14 + 10).
  assert.equal(body[7].y - body[8].y, 24);
});

test("PDF: en merknad under flyten med ledig plass under seg skyves ned heller enn at flyten krymper; avstanden til den er som før", async () => {
  const note = "BT /F1 8 Tf 72 604 Td (Budget for these initiatives was approved by the board in September.) Tj ET";
  const pdf = pdfOf([["0.9 0.93 1 rg 40 380 520 360 re f 0 g", paraOf(72, 700, R6[0]), paraOf(72, 648, R6[1]), note].join("\n")]);
  const items = byY(await textItems((await applyWith(pdf, (s) => (s.startsWith("Budget") ? upper(s) : longer(s)))).buffer));
  const body = items.filter((i) => i.size === 11);
  const noteItem = items.find((i) => i.size === 8);
  assert.equal(body.length, 8, JSON.stringify(items.map((i) => [i.y, i.size])));
  // Originalen: siste linje 620, merknaden 604 (16 under).
  assert.ok(Math.abs(body[7].y - noteItem.y - 16) < 0.01 && noteItem.y < 604 && noteItem.y > 380, `${body[7].y} ${noteItem.y}`);
  assert.deepEqual(overlaps(items), []);
});

test("PDF: et kort avsnitt som blir bredere når det settes, trekkes ikke opp ved siden av en merknad i margen", async () => {
  const pdf = pdfOf([[
    paraOf(72, 700, ["The board met eleven times during the year and dealt with a wide", "range of matters, from the budget and the maintenance plan to", "the new rules for the use of the common areas and the garden,", "and it approved the plan for the renovation of the facades."]),
    line("F2", 9, 400, 700, "Budget 2026:"), line("F1", 9, 400, 689, "NOK 1.2 million"), line("F1", 9, 400, 678, "(was 1.1 million)"),
    paraOf(72, 632, ["Contact the office with questions."]),
    paraOf(72, 604, ["Staff turnover remained stable at around nine per cent, which", "is mostly due to relocation rather than dissatisfaction with the", "working conditions, as shown by the survey carried out in March."]),
  ].join("\n")]);
  const items = await textItems((await applyWith(pdf, (s) => (s.startsWith("The board") ? "Styret godkjente budsjettet."
    : s.startsWith("Contact") ? "Kontakt kontoret dersom du har flere spørsmål om rapporten eller budsjettet." : s))).buffer);
  assert.deepEqual(overlaps(items), []);
  // Ingen linje fra avsnittene går inn i merknaden (x 398–470, y 675–708).
  const body = items.filter((i) => i.x < 100);
  assert.ok(body.every((i) => i.x + i.w <= 398 || i.y + i.size * 0.7 < 675 || i.y - i.size * 0.2 > 708), JSON.stringify(body.map((i) => [i.str, i.y, i.x + i.w])));
});

// Side med et skjemaobjekt /Fm0 (objekt 8) og et lag (objekt 7); `state` som i pdfWithLayer.
function pdfWithForm(content, form, state = "/ON [] /OFF [7 0 R]", formExtra = "") {
  return pdfFromObjects([
    `<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [7 0 R] /D << ${state} /Order [7 0 R] >> >> >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /Properties << /oc1 7 0 R >> /XObject << /Fm0 8 0 R >> >> >>",
    streamObj(content),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    "<< /Type /OCG /Name (Layer) >>",
    { dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 300 30] /Resources << /Font << /F1 5 0 R >> >> ${formExtra} /Length ${Buffer.byteLength(form, "latin1")} >>`, data: Buffer.from(form, "latin1") },
  ]);
}
async function formStream(buf) {
  const lib = require("pdf-lib");
  const doc = await lib.PDFDocument.load(buf);
  const xo = doc.getPage(0).node.Resources().lookup(lib.PDFName.of("XObject"));
  const fm = doc.context.lookup(xo.get(lib.PDFName.of("Fm0")));
  return Buffer.from(fm instanceof lib.PDFRawStream ? lib.decodePDFRawStream(fm).decode() : fm.getContents()).toString("latin1");
}

test("PDF: tekst i et skjemaobjekt i et skjult lag fjernes aldri; tegnes det både skjult og synlig, står det urørt og tegnes ikke dobbelt", async () => {
  const first = "BT /F1 11 Tf 72 780 Td (This first line is always visible on the page.) Tj ET";
  const form = "BT /F1 11 Tf 3 10 Td (Answer: Oslo is the capital.) Tj ET";
  // Skjemaobjektet har selv /OC til et lag som er av (også et vannmerke bare for utskrift regnes slik av pdf.js).
  let res = await applyWith(pdfWithForm([first, "q 1 0 0 1 72 600 cm /Fm0 Do Q"].join("\n"), form, undefined, "/OC 7 0 R"), upper);
  assert.deepEqual(res.strings, ["This first line is always visible on the page."]);
  assert.match(await formStream(res.buffer), /\(Answer: Oslo is the capital\.\) Tj/);
  // Tegnet inni et lag som er av på siden, og et vanlig skjemaobjekt: det skjulte står, det vanlige oversettes.
  res = await applyWith(pdfWithForm([first, "/OC /oc1 BDC q 1 0 0 1 72 600 cm /Fm0 Do Q EMC"].join("\n"), form), upper);
  assert.match(await formStream(res.buffer), /\(Answer: Oslo is the capital\.\) Tj/);
  res = await applyWith(pdfWithForm([first, "q 1 0 0 1 72 600 cm /Fm0 Do Q"].join("\n"), form), upper);
  assert.ok(!/Answer/.test(await formStream(res.buffer)), "et synlig skjemaobjekt får teksten fjernet og tegnet på nytt");
  assert.ok((await textItems(res.buffer)).some((i) => /NB ANSWER: OSLO/.test(i.str)));
  // Samme skjemaobjekt tegnet synlig (y 700) og i et skjult lag (y 600): urørt, og ikke tegnet dobbelt.
  res = await applyWith(pdfWithForm([first, "q 1 0 0 1 72 700 cm /Fm0 Do Q", "/OC /oc1 BDC q 1 0 0 1 72 600 cm /Fm0 Do Q EMC"].join("\n"), form), upper);
  assert.match(await formStream(res.buffer), /\(Answer: Oslo is the capital\.\) Tj/);
  const items = await textItems(res.buffer);
  assert.ok(!items.some((i) => /ANSWER/.test(i.str)), JSON.stringify(items.map((i) => i.str)));
  assert.ok(items.some((i) => /NB THIS FIRST LINE/.test(i.str)));
});

test("PDF: finnes det bare tekst i et skjult lag, gir det «Fant ingen tekst» (laget avsløres ikke)", async () => {
  const hidden = "/OC /oc1 BDC BT /F1 11 Tf 72 700 Td (Answer key: the correct answers are B, C and A.) Tj ET EMC";
  await assert.rejects(core.collectStrings(pdfWithLayer([hidden, "0 0 1 rg 72 600 100 40 re f"].join("\n"), "/ON [] /OFF [7 0 R]"), ".pdf"), /Fant ingen tekst/);
});

test("PDF: et BDC som ikke lukkes inne i et skjemaobjekt, skjuler ikke teksten på siden etter det", async () => {
  const pdf = pdfWithForm([
    "BT /F1 11 Tf 72 780 Td (This first line is always visible on the page.) Tj ET",
    "q 1 0 0 1 72 740 cm /Fm0 Do Q",
    "BT /F1 11 Tf 72 700 Td (Visible sentence right after the form that must be translated.) Tj ET",
  ].join("\n"), "/OC /oc1 BDC BT /F1 11 Tf 3 10 Td (Hidden note inside the form layer.) Tj ET");
  const pdfFixed = Buffer.from(pdf.toString("latin1").replace("/Properties << /oc1 7 0 R >> /XObject", "/Properties << /oc1 7 0 R >> /XObject"), "latin1");
  const lib = require("pdf-lib");
  // Skjemaobjektet må kjenne /oc1 selv: legg lagene i skjemaets ressurser.
  const doc = await lib.PDFDocument.load(pdfFixed);
  const fm = doc.context.lookup(doc.getPage(0).node.Resources().lookup(lib.PDFName.of("XObject")).get(lib.PDFName.of("Fm0")));
  fm.dict.lookup(lib.PDFName.of("Resources")).set(lib.PDFName.of("Properties"), doc.context.obj({ oc1: lib.PDFRef.of(7) }));
  const { strings, buffer } = await applyWith(Buffer.from(await doc.save()), upper);
  assert.deepEqual(strings, ["This first line is always visible on the page.", "Visible sentence right after the form that must be translated."]);
  assert.ok((await textItems(buffer)).some((i) => /NB VISIBLE SENTENCE/.test(i.str)));
});

// Simulerer pdf.js: et bilde som bare er brukt på én side så langt, dekodes for siden (og slippes etter den); fra andre
// side det brukes på, dekodes det én gang til fellesbufferen (g_-id), og etter det sender arbeideren det aldri igjen,
// heller ikke når hovedtråden har sluppet det. Gir største plass ved sidens slutt (før opprydding), plass etter
// oppryddingen og antall dekodinger.
function simulateSharedImages(pages, MB = 26e6, neededOf = () => []) {
  const { sharedImagePolicy } = require("../src/formats/pdf");
  const policy = sharedImagePolicy();
  const uses = new Map();
  const worker = new Set();
  const held = new Set();
  let decodes = 0;
  let peak = 0;
  let after = 0;
  pages.forEach((images, n) => {
    let local = 0;
    for (const m of images) {
      uses.set(m, (uses.get(m) || 0) + 1);
      if (uses.get(m) < 2) {
        local++;
        decodes++;
      } else if (!worker.has(m)) {
        worker.add(m);
        held.add(m);
        decodes++;
      }
    }
    peak = Math.max(peak, (held.size + local) * MB);
    const needed = new Set(neededOf(images).filter((m) => held.has(m)).map((m) => `g_${m}`));
    policy.use(images.filter((m) => held.has(m)).map((m) => `g_${m}`), n, needed);
    for (const id of policy.evict(n, (id) => (held.has(id.slice(2)) ? MB : 0))) held.delete(id.slice(2));
    // Aldri mer enn 48 MB igjen, bortsett fra bilder siden trengte pikslene til (de blir liggende).
    for (const id of needed) assert.ok(held.has(id.slice(2)), `side ${n}: ${id} ble sluppet`);
    assert.ok(held.size * MB <= Math.max(48e6, needed.size * MB), `side ${n}: ${held.size} bilder igjen`);
    after = Math.max(after, held.size * MB);
  });
  return { peak, after, decodes, distinct: uses.size };
}

test("PDF: bilder i fellesbufferen slippes eldste først til de tar høyst 48 MB (sidens egne regnes med), og et sluppet bilde dekodes ikke på nytt", () => {
  const MB = 26e6;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const cases = [
    // A/B annenhver side (venstre/høyre bakgrunn), seks bakgrunner i tilfeldig rekkefølge, et «navbilde» annenhver side,
    // grupper på tre sider, lysbildeoppsett, samme bakgrunn på hver side pluss ett av fem bilder, og sider med to av åtte.
    { pages: Array.from({ length: 30 }, (_, n) => [n % 2 ? "B" : "A"]), peak: 2 },
    { pages: Array.from({ length: 60 }, () => [String(Math.floor(rnd() * 6))]), peak: 2 },
    { pages: Array.from({ length: 80 }, (_, n) => [n % 2 ? "H" : String((n >> 1) % 7)]), peak: 2 },
    { pages: Array.from({ length: 60 }, (_, n) => [`G${Math.floor(n / 3)}`]), peak: 2 },
    { pages: Array.from({ length: 40 }, (_, n) => [n === 0 ? "T" : n % 4 === 0 ? "S" : "C"]), peak: 2 },
    { pages: Array.from({ length: 40 }, () => ["BG", `P${Math.floor(rnd() * 5)}`]), peak: 2 },
    { pages: Array.from({ length: 60 }, () => [...new Set([String(Math.floor(rnd() * 8)), String(Math.floor(rnd() * 8))])]), peak: 3 },
    // Skannede sider der pikslene trengs (tekst under bildene): de blir liggende, også over grensen.
    { pages: Array.from({ length: 30 }, (_, n) => [`S${n % 3}`, `T${n % 2}`]), peak: 3, needed: (images) => images },
  ];
  for (const { pages, peak, needed } of cases) {
    const r = simulateSharedImages(pages, MB, needed);
    assert.ok(r.peak <= peak * MB, `høyst ${peak} bilder: ${r.peak / MB}`);
    // Hvert bilde dekodes høyst to ganger (for siden, og til fellesbufferen), uansett hvor ofte det går igjen.
    assert.ok(r.decodes <= 2 * r.distinct, `dekodinger ${r.decodes} for ${r.distinct} bilder`);
  }
});

test("PDF: trengs pikslene til et bilde som er sluppet, leses siden på nytt – tekst under et gjennomsiktig bilde forblir synlig, uten ventetid", async () => {
  const zlib = require("zlib");
  // To bilder (A og B) over hele siden, gjennomsiktige (SMask 0), tegnet etter teksten, annenhver side: A B A B A. Med en
  // liten grense slippes A etter side 4, og side 5 trenger pikslene til A (dekker bildet teksten?).
  const img = (rgb) => ({ dict: `<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 9 0 R /Filter /FlateDecode /Length %L >>`, data: zlib.deflateSync(Buffer.alloc(100 * 100 * 3, rgb)) });
  const mask = zlib.deflateSync(Buffer.alloc(100 * 100, 0));
  const pageObj = (content) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /A 7 0 R /B 8 0 R >> >> >>`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [10 0 R 11 0 R 12 0 R 13 0 R 14 0 R] /Count 5 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    null, null, null,
    img(40), img(90),
    { dict: `<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${mask.length} >>`, data: mask },
  ];
  for (let k = 0; k < 5; k++) objs.push(pageObj(15 + k));
  for (let k = 0; k < 5; k++) objs.push(streamObj(`BT /F1 11 Tf 72 700 Td (Text on page ${k + 1} under the picture.) Tj ET q 595 0 0 842 0 0 cm /${k % 2 ? "B" : "A"} Do Q`));
  objs[3] = streamObj("");
  objs[4] = streamObj("");
  objs[5] = streamObj("");
  for (const o of objs) if (o && o.dict) o.dict = o.dict.replace("%L", String(o.data.length));
  const pdf = pdfFromObjects(objs);
  const t0 = Date.now();
  const tight = await extractPages(pdf, { sharedImages: 50e3 });
  const ms = Date.now() - t0;
  const normal = await extractPages(pdf);
  const view = (pages) => pages.map((p) => p.items.filter((i) => i.str.trim()).map((i) => [i.str, Boolean(i.invisible)]));
  assert.deepEqual(view(tight), view(normal));
  for (const p of view(tight)) assert.deepEqual(p.map((i) => i[1]), [false]);
  assert.ok(ms < 5000, `${ms} ms`);
});

// ---- Runde 7: følgere i flere ledd, overskrifter beholder luften mot innholdet sitt, alle lovlige oppsett i en
// størrelse før skriften blir mindre, original linjeavstand i mindre skrift, urørte skjemaobjekter avgjort for hele
// dokumentet (og ikke samlet inn), lagvilkår med /VE, øvre grense for bildebufferen ----

test("PDF: følgere i flere ledd – en flyt lenger ned som vokser, skyver sine egne følgere, og flyten over mister ikke det skyvet", async () => {
  const T = {
    a1: ["The harbour association held its annual meeting in March and the", "board presented the accounts for the previous year to members."],
    a2: ["Membership grew by twelve per cent, mostly among young families", "who moved to the area during the last two years."],
    b1: ["The new pier will be built in two phases, starting with the", "foundation work in the spring and the deck in the autumn."],
    b2: ["Funding comes from the municipality, a regional grant and the", "association's own reserves, which were set aside for this."],
    c1: ["Volunteers are needed for the summer festival, the autumn clean-up", "and the Christmas market on the square."],
  };
  // Grunnlinjer: A 760/746 og 724/710, «New pier» 682, B 660/646 og 624/610, «Volunteers» 582, C 560/546.
  const pdf = pdfOf([[line("F2", 16, 72, 790, "Annual report"), paraOf(72, 760, T.a1), paraOf(72, 724, T.a2), line("F2", 13, 72, 682, "New pier"),
    paraOf(72, 660, T.b1), paraOf(72, 624, T.b2), line("F2", 13, 72, 582, "Volunteers"), paraOf(72, 560, T.c1),
    line("F1", 8, 72, 40, "Harbour association - page 1")].join("\n")]);
  // A blir litt lengre (én linje mer), B 35 % lengre: B sin egen flyt skyver «Frivillige» og C ned, og A skyver alt.
  const grow = (s) => s.replace(/[A-Za-z]+/g, (w) => w + "x".repeat(Math.round(w.length * 0.35)));
  const tr = (s) => (/^(The new pier|Funding)/.test(s) ? grow(s) : s === "New pier" ? "Ny brygge" : s === "Volunteers" ? "Frivillige"
    : /^(Annual|Harbour)/.test(s) ? s : `NB ${s}`);
  const items = byY(await textItems((await applyWith(pdf, tr)).buffer));
  assert.deepEqual(overlaps(items), []);
  const head = items.find((i) => i.str === "Frivillige");
  const above = items.filter((i) => i.size === 11 && i.y > head.y);
  const below = items.filter((i) => i.size === 11 && i.y < head.y);
  assert.ok(above.length >= 9 && below.length === 2, JSON.stringify(items.map((i) => [i.str.slice(0, 12), i.y])));
  // Overskriften står like langt over sitt eget avsnitt som før (22), og luften over den er minst en halv linje.
  assert.equal(Math.round((head.y - below[0].y) * 100) / 100, 22);
  assert.ok(above[above.length - 1].y - 11 * 0.25 - (head.y + 13 * 0.75) >= 7 - 0.01, `${above[above.length - 1].y} ${head.y}`);
});

test("PDF: en overskrift rett over en tabell skyves ikke ned mot tabellen – flyten over tar plassen (luften over overskriften, tettere linjer)", async () => {
  const pdf = pdfOf([[paraOf(72, 740, R6[0]), paraOf(72, 688, R6[1]), line("F2", 12, 72, 626, "Measured air flow per apartment"),
    "0.5 w 72 610 m 540 610 l S 72 590 m 540 590 l S 72 570 m 540 570 l S", line("F1", 10, 76, 596, "Apartment"), line("F1", 10, 300, 596, "Litres per second"),
    line("F1", 10, 76, 576, "1A"), line("F1", 10, 300, 576, "12")].join("\n")]);
  // Samme bredde (å for a), men siste avsnitt får én linje til.
  const tr = (s) => (s.startsWith("Passengers") ? s.replace(/\.$/, ", and for all the members of their families.") : s).replace(/a/g, "å");
  const items = byY(await textItems((await applyWith(pdf, tr)).buffer));
  assert.deepEqual(overlaps(items), []);
  const head = items.find((i) => i.size === 12);
  assert.ok(Math.abs(head.y - 626) < 0.01, `overskriften står der den stod: luften mot tabellen er som før (${head.y})`);
  const body = items.filter((i) => i.size === 11 || (i.y > 640 && i.size < 12));
  assert.ok(body.length === 7 && body.every((i) => i.size === 11), JSON.stringify(body.map((i) => [i.y, i.size])));
  // Linjene høyst 7 % tettere, og minst halvparten av luften over overskriften (22,25) står igjen.
  assert.ok(body[0].y - body[1].y >= 0.93 * 14 - 0.01, `${body[0].y - body[1].y}`);
  assert.ok(body[6].y - 11 * 0.25 - (626 + 12 * 0.75) >= 22.25 / 2 - 0.3, `${body[6].y}`);
});

test("PDF: tekst i en boks beholder størrelsen når den med inntil 7 % tettere linjer får en halv linje luft over bunnkanten (målt fra underlengdene)", async () => {
  const text = ["Accommodation ranges from", "simple fishing cabins to a small", "family-run hotel with twelve rooms."];
  // Boksen slutter 14,4 under avsnittets nederste kant (siste grunnlinje 349,5 minus 0,25 × 8,5).
  const pdf = pdfOf([["0.9 0.93 1 rg 423 332.95 150 290 re f 0 g", line("F2", 11, 432, 600, "Plan your visit"),
    `BT /F1 8.5 Tf 432 372 Td 11.25 TL ${text.map((l) => `(${l}) Tj T*`).join(" ")} ET`].join("\n")]);
  const tr = (s) => (s.startsWith("Plan") ? s : s.replace(/\p{L}+/gu, (w) => w + (w.length > 5 ? w.slice(0, 1) : "")));
  const items = byY((await textItems((await applyWith(pdf, tr)).buffer)).filter((i) => i.y < 400));
  assert.ok(items.length === 4 && items.every((i) => i.size === 8.5), `samme størrelse, én linje mer: ${JSON.stringify(items.map((i) => [i.y, i.size]))}`);
  assert.ok(items[0].y - items[1].y >= 0.93 * 11.25 - 0.01, `høyst 7 % tettere: ${items[0].y - items[1].y}`);
  assert.ok(items[3].y - 0.22 * 8.5 - 332.95 >= 0.5 * 11.25 - 0.3, `luft over bunnkanten: ${items[3].y}`);
});

test("PDF: blir skriften mindre og avsnittet har like mange linjer som før, beholder det originalens linjeavstand", async () => {
  const pdf = pdfOf([[paraOf(72, 700, R6[0]), "0.5 w 72 664 m 540 664 l S", line("F1", 11, 72, 650, "Text under the rule stays put.")].join("\n")]);
  const tr = (s) => (s.startsWith("Text under") ? s : s.replace(/\p{L}+/gu, (w) => w + w.slice(0, Math.round(w.length * 0.1))));
  const items = byY(await textItems((await applyWith(pdf, tr)).buffer));
  const body = items.filter((i) => i.y > 664);
  assert.ok(body.length === 3 && body.every((i) => i.size < 11), JSON.stringify(body.map((i) => [i.y, i.size])));
  assert.deepEqual(body.map((i) => i.y), [700, 686, 672]);
});

// Én eller flere sider med egne ressurser; objekt 1 katalog, 2 sidetre. `st(data, dict)` gir en strøm med riktig lengde.
const st = (data, dict = "") => ({ dict: `<< ${dict} /Length ${Buffer.byteLength(data, "latin1")} >>`, data: Buffer.from(data, "latin1") });
const HELV = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

test("PDF: urørte skjemaobjekter avgjøres for hele dokumentet – ingen dobbel eller manglende tekst, og teksten der samles ikke inn", async () => {
  const FIRST = "BT /F1 11 Tf 72 780 Td (This first line is always visible on the page.) Tj ET";
  const LAST = "BT /F1 11 Tf 72 640 Td (Another visible sentence further down on the page.) Tj ET";
  const OFF = "/OCProperties << /OCGs [7 0 R] /D << /ON [] /OFF [7 0 R] /Order [7 0 R] >> >>";
  const strs = async (buf, n = 0) => (await textItems(buf, n)).map((i) => i.str);
  // (a) Skjemaobjekt med synlig og skjult tekst, og en linje med høyre-til-venstre-skrift på siden (tekstoperatorene kan
  // ikke kobles sikkert): skjemaobjektets tekst står én gang, uoversatt, og resten oversettes.
  let pdf = pdfFromObjects([
    `<< /Type /Catalog /Pages 2 0 R ${OFF} >>`, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /FH 6 0 R >> /XObject << /Fm0 8 0 R >> >> >>",
    st([FIRST, "q 1 0 0 1 72 700 cm /Fm0 Do Q", LAST, "BT /FH 11 Tf 72 600 Td (ABCDE) Tj ET"].join("\n")), HELV,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [65 /afii57664 /afii57665 /afii57666 /afii57667 /afii57668] >> >>",
    "<< /Type /OCG /Name (Notes) >>",
    st("BT /F1 11 Tf 0 10 Td (Header sentence drawn inside the form object.) Tj ET /OC /off BDC BT /F1 9 Tf 0 0 Td (Hidden note in the form.) Tj ET EMC",
      "/Type /XObject /Subtype /Form /BBox [0 0 450 40] /Resources << /Font << /F1 5 0 R >> /Properties << /off 7 0 R >> >>"),
  ]);
  let res = await applyWith(pdf, upper);
  assert.ok(!res.strings.some((s) => /Header|Hidden/.test(s)), JSON.stringify(res.strings));
  let out = await strs(res.buffer);
  assert.equal(out.filter((s) => /Header sentence/i.test(s)).length, 1, JSON.stringify(out));
  assert.ok(out.includes("Header sentence drawn inside the form object.") && out.some((s) => /NB ANOTHER VISIBLE/.test(s)), JSON.stringify(out));
  assert.ok(res.warnings.some((w) => w.code === "pdf_hidden_layer"));

  // (b) Skjemaobjektet tegnes i et skjult lag på side 1 og synlig på side 2, der en myk maske gjør at tegningene ikke kan
  // kobles: på side 2 står det urørt (én gang).
  const res2 = "<< /Font << /F1 5 0 R >> /XObject << /F 6 0 R >> /Properties << /off 7 0 R >> /ExtGState << /GS1 10 0 R >> >>";
  pdf = pdfFromObjects([
    `<< /Type /Catalog /Pages 2 0 R ${OFF} >>`, "<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources ${res2} >>`,
    st(["BT /F1 11 Tf 72 780 Td (Page one has ordinary body text at the top.) Tj ET", "/OC /off BDC q 1 0 0 1 72 700 cm /F Do Q EMC"].join("\n")), HELV,
    st("BT /F1 11 Tf 0 10 Td (Company header sentence shown inside the form.) Tj ET", "/Type /XObject /Subtype /Form /BBox [0 0 450 40] /Resources << /Font << /F1 5 0 R >> >>"),
    "<< /Type /OCG /Name (Layer) >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 9 0 R /Resources ${res2} >>`,
    st(["BT /F1 11 Tf 72 780 Td (Page two has ordinary body text at the top.) Tj ET", "q 1 0 0 1 72 700 cm /F Do Q", "q /GS1 gs 0 0 1 rg 300 300 80 80 re f Q"].join("\n")),
    "<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 11 0 R >> >>",
    st("1 g 0 0 595 842 re f", "/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Group << /S /Transparency /CS /DeviceGray >>"),
  ]);
  res = await applyWith(pdf, upper);
  assert.ok(!res.strings.some((s) => /Company/.test(s)), JSON.stringify(res.strings));
  out = await strs(res.buffer, 1);
  assert.equal(out.filter((s) => /Company header/i.test(s)).length, 1, JSON.stringify(out));
  assert.ok(out.includes("Company header sentence shown inside the form.") && out.some((s) => /NB PAGE TWO/.test(s)), JSON.stringify(out));

  // (c) Én linje med tekst fra to skjemaobjekter, et urørt (skjult tekst) og et vanlig: hele linjen står urørt.
  const form = (text) => st(text, "/Type /XObject /Subtype /Form /BBox [0 0 300 40] /Resources << /Font << /F1 5 0 R >> /Properties << /off 7 0 R >> >>");
  pdf = pdfFromObjects([
    `<< /Type /Catalog /Pages 2 0 R ${OFF} >>`, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /U 8 0 R /F2 9 0 R >> >> >>",
    st([FIRST, "q 1 0 0 1 72 690 cm /U Do Q", "q 1 0 0 1 72 690 cm /F2 Do Q", LAST].join("\n")), HELV, "<< >>",
    "<< /Type /OCG /Name (Notes) >>",
    form("BT /F1 11 Tf 0 10 Td (The committee met on Monday) Tj ET /OC /off BDC BT /F1 8 Tf 0 0 Td (hidden remark) Tj ET EMC"),
    form("BT /F1 11 Tf 150.5 10 Td (and approved the budget for next year.) Tj ET"),
  ]);
  res = await applyWith(pdf, upper);
  assert.deepEqual(res.strings, ["This first line is always visible on the page.", "Another visible sentence further down on the page."]);
  out = await strs(res.buffer);
  assert.ok(out.includes("The committee met on Monday") && out.includes("and approved the budget for next year."), JSON.stringify(out));

  // (d) Skjemaobjektene bruker sidens egen ressursordbok (som inneholder dem selv), og ett av dem tegnes ikke, et annet
  // bare i et skjult lag: ingen uendelig løkke, teksten fjernes og tegnes på nytt som vanlig (ikke dekket med hvitt).
  pdf = pdfFromObjects([
    "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [10 0 R] /D << /ON [] /OFF [10 0 R] /Order [10 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources 4 0 R >>",
    "<< /Font << /F1 6 0 R >> /XObject << /Fm0 7 0 R /Fm1 8 0 R /Wm 9 0 R >> >>",
    st([FIRST, "q 1 0 0 1 72 640 cm /Fm0 Do Q", "q 1 0 0 1 150 400 cm /Wm Do Q"].join("\n")), HELV,
    st("BT /F1 11 Tf 0 0 Td (Form zero text is drawn on the page.) Tj ET", "/Type /XObject /Subtype /Form /BBox [0 0 400 60] /Resources 4 0 R"),
    st("BT /F1 11 Tf 0 0 Td (Form one is never drawn on this page.) Tj ET", "/Type /XObject /Subtype /Form /BBox [0 0 400 60] /Resources 4 0 R"),
    st("0.5 g BT /F1 40 Tf 10 15 Td (DRAFT COPY) Tj ET", "/Type /XObject /Subtype /Form /BBox [0 0 400 60] /Resources 4 0 R /OC 10 0 R"),
    "<< /Type /OCG /Name (Watermark) >>",
  ]);
  res = await applyWith(pdf, upper);
  assert.deepEqual(res.warnings.map((w) => w.code), []);
  out = await strs(res.buffer);
  assert.deepEqual(out.filter((s) => /first line|Form zero/i.test(s)).sort(), ["NB FORM ZERO TEXT IS DRAWN ON THE PAGE.", "NB THIS FIRST LINE IS ALWAYS VISIBLE ON THE PAGE."]);
});

test("PDF: lagvilkår med uttrykk (/VE) regnes ut – tekst i et skjult lag oversettes ikke og tegnes ikke, og skjemaobjektet beholder teksten", async () => {
  const KEEP = "BT /F1 11 Tf 72 780 Td (This first line is always visible on the page.) Tj ET";
  const make = (ve, where) => pdfFromObjects([
    "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [7 0 R 8 0 R] /D << /ON [8 0 R] /OFF [7 0 R] /Order [7 0 R 8 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Fm 6 0 R >> /Properties << /md 9 0 R >> >> >>",
    st(where === "form" ? [KEEP, "q 1 0 0 1 72 700 cm /Fm Do Q"].join("\n")
      : [KEEP, "/OC /md BDC BT /F1 11 Tf 72 710 Td (Conditional sentence in the marked content.) Tj ET EMC"].join("\n")),
    HELV,
    st("BT /F1 11 Tf 0 10 Td (Conditional sentence in the form object.) Tj ET", "/Type /XObject /Subtype /Form /BBox [0 0 400 30] /Resources << /Font << /F1 5 0 R >> >> /OC 9 0 R"),
    "<< /Type /OCG /Name (Off) >>", "<< /Type /OCG /Name (On) >>",
    `<< /Type /OCMD /VE ${ve} >>`,
  ]);
  for (const where of ["form", "bdc"]) {
    // Av og på: skjult.
    let res = await applyWith(make("[/And 7 0 R 8 0 R]", where), upper);
    assert.deepEqual(res.strings, ["This first line is always visible on the page."], where);
    assert.ok(!(await textItems(res.buffer)).some((i) => /CONDITIONAL/.test(i.str)), where);
    if (where === "form") assert.match(await formStreamOf(res.buffer, "Fm"), /\(Conditional sentence in the form object\.\) Tj/);
    // Ikke av: synlig, oversettes.
    res = await applyWith(make("[/Not 7 0 R]", where), upper);
    assert.ok(res.strings.some((s) => /^Conditional/.test(s)), where);
  }
});
async function formStreamOf(buf, name) {
  const lib = require("pdf-lib");
  const doc = await lib.PDFDocument.load(buf);
  const fm = doc.context.lookup(doc.getPage(0).node.Resources().lookup(lib.PDFName.of("XObject")).get(lib.PDFName.of(name)));
  return Buffer.from(fm instanceof lib.PDFRawStream ? lib.decodePDFRawStream(fm).decode() : fm.getContents()).toString("latin1");
}

// ---- Runde 8: enkeltlinjer vokser ikke over et spaltemellomrom, urørte skjemaobjekter uten å fryse hele sider,
// overskrifter over to linjer, lagvilkår med ukjente grupper ----

test("PDF: en tekstbit uten sikker kobling fryser ikke hele siden – topptekst og brødtekst oversettes, vannmerket i et skjult lag står urørt og samles ikke inn", async () => {
  const FH = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [65 /afii57664 /afii57665 /afii57666 /afii57667 /afii57668] >> >>";
  const OFF = "/OCProperties << /OCGs [7 0 R] /D << /ON [] /OFF [7 0 R] /Order [7 0 R] >> >>";
  const T = (f, s, x, y, t) => `BT /${f} ${s} Tf ${x} ${y} Td (${t}) Tj ET`;
  // Topptekst i skjemaobjektet H, vannmerke i W (lag som er av).
  const page = (content) => pdfFromObjects([
    `<< /Type /Catalog /Pages 2 0 R ${OFF} >>`, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /FH 6 0 R >> /XObject << /H 8 0 R /W 9 0 R >> >> >>",
    st(content.join("\n")), HELV, FH, "<< /Type /OCG /Name (Watermark) >>",
    st(T("F1", 9, 0, 10, "Harbour association annual report 2025"), "/Type /XObject /Subtype /Form /BBox [0 0 400 30] /Resources << /Font << /F1 5 0 R >> >>"),
    st(`0.5 g ${T("F1", 40, 10, 15, "DRAFT COPY")}`, "/Type /XObject /Subtype /Form /BBox [0 0 400 60] /Resources << /Font << /F1 5 0 R >> >> /OC 7 0 R"),
  ]);
  const BODY = [T("F1", 11, 72, 760, "The harbour association held its annual meeting in March."), T("F1", 11, 72, 746, "The board presented the accounts for the previous year.")];
  const HEAD = "q 1 0 0 1 72 790 cm /H Do Q";
  const LAST = T("F1", 11, 72, 640, "Membership grew by twelve per cent during the year.");
  const WM = "q 1 0 0 1 150 400 cm /W Do Q";
  const cases = {
    // Tekst utenfor siden (tas ikke med av pdf.js) rett før toppteksten.
    slug: [...BODY, T("F1", 7, 72, -30, "Job 4711 harbour-report.indd"), HEAD, LAST, WM],
    // Høyre-til-venstre-linje først (pdf.js snur den).
    rtl: [T("FH", 11, 72, 820, "ABCDE"), ...BODY, HEAD, LAST, WM],
    // Høyre-til-venstre-linje rett før vannmerket: vannmerket kobles ikke, men bare skjulte tegn kan stave det.
    rtlBeforeWatermark: [...BODY, HEAD, T("FH", 11, 72, 700, "ABCDE"), WM, LAST],
  };
  for (const [name, content] of Object.entries(cases)) {
    const pdf = page(content);
    const res = await applyWith(pdf, upper);
    assert.ok(res.strings.includes("Harbour association annual report 2025"), `${name} ${JSON.stringify(res.strings)}`);
    assert.ok(!res.strings.some((s) => /DRAFT/.test(s)), `${name} ${JSON.stringify(res.strings)}`);
    assert.ok(!res.warnings.some((w) => w.code === "pdf_hidden_layer"), name);
    const out = (await textItems(res.buffer)).map((i) => i.str);
    assert.equal(out.filter((s) => /Harbour association annual/i.test(s)).length, 1, `${name} ${JSON.stringify(out)}`);
    assert.ok(out.includes("NB HARBOUR ASSOCIATION ANNUAL REPORT 2025") && out.includes("NB MEMBERSHIP GREW BY TWELVE PER CENT DURING THE YEAR."), `${name} ${JSON.stringify(out)}`);
    assert.ok(!out.some((s) => /DRAFT/.test(s)), `${name} ${JSON.stringify(out)}`);
    assert.match(await formStreamOf(res.buffer, "W"), /\(DRAFT COPY\) Tj/, name);
  }
});

test("PDF: kan tekst fra et urørt skjemaobjekt ikke kobles, står bare den usikre delen av siden urørt – andre sider og skjemaobjekter oversettes", async () => {
  const OFF = "/OCProperties << /OCGs [7 0 R] /D << /ON [] /OFF [7 0 R] /Order [7 0 R] >> >>";
  const T = (f, s, x, y, t) => `BT /${f} ${s} Tf ${x} ${y} Td (${t}) Tj ET`;
  const res = "<< /Font << /F1 5 0 R /FH 6 0 R >> /XObject << /F 8 0 R /U 9 0 R >> /Properties << /off 7 0 R >> >>";
  // Side 2: høyre-til-venstre-linje først (ingen tekst på siden kobles), og en linje med tekst fra U (synlig tekst og
  // tekst i et skjult lag). F (topptekst) tegnes bare på side 1.
  const pdf = pdfFromObjects([
    `<< /Type /Catalog /Pages 2 0 R ${OFF} >>`, "<< /Type /Pages /Kids [3 0 R 10 0 R] /Count 2 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources ${res} >>`,
    st([T("F1", 11, 72, 780, "Page one has ordinary body text at the top."), "q 1 0 0 1 72 700 cm /F Do Q", T("F1", 11, 72, 640, "Page one closing sentence is translated.")].join("\n")),
    HELV,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [65 /afii57664 /afii57665 /afii57666 /afii57667 /afii57668] >> >>",
    "<< /Type /OCG /Name (Layer) >>",
    st(T("F1", 11, 0, 10, "Company header sentence shown inside the form."), "/Type /XObject /Subtype /Form /BBox [0 0 450 40] /Resources << /Font << /F1 5 0 R >> >>"),
    st(`${T("F1", 11, 0, 0, "the annual budget")} /OC /off BDC ${T("F1", 8, 0, -12, "hidden remark")} EMC`,
      "/Type /XObject /Subtype /Form /BBox [0 -20 400 40] /Resources << /Font << /F1 5 0 R >> /Properties << /off 7 0 R >> >>"),
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 11 0 R /Resources ${res} >>`,
    st([T("FH", 11, 72, 790, "ABCDE"), T("F1", 11, 72, 760, "Page two has ordinary body text at the top."), T("F1", 11, 72, 700, "Reference:"),
      "q 1 0 0 1 130 700 cm /U Do Q", T("F1", 11, 72, 640, "Page two closing sentence.")].join("\n")),
  ]);
  const r = await applyWith(pdf, upper);
  assert.ok(r.strings.includes("Company header sentence shown inside the form."), JSON.stringify(r.strings));
  assert.ok(!r.strings.some((s) => /annual budget|hidden/.test(s)), JSON.stringify(r.strings));
  const p1 = (await textItems(r.buffer, 0)).map((i) => i.str);
  assert.ok(p1.includes("NB COMPANY HEADER SENTENCE SHOWN INSIDE THE FORM."), JSON.stringify(p1));
  // Side 2: ingenting dobbelt eller borte.
  const words = (list) => list.join(" ").split(/\s+/).filter((w) => w && w !== "NB").map((w) => w.toLowerCase()).sort();
  const before = (await textItems(pdf, 1)).map((i) => i.str);
  const after = (await textItems(r.buffer, 1)).map((i) => i.str);
  assert.deepEqual(words(after), words(before));
  assert.ok(r.warnings.some((w) => w.code === "pdf_hidden_layer"));
});

test("PDF: en overskrift over to linjer beholder luften mot innholdet sitt når flyten over skyver den", async () => {
  const pdf = pdfOf([[
    line("F1", 11, 72, 760, "The harbour association held its annual meeting in March and the"),
    line("F1", 11, 72, 746, "board presented the accounts for the previous year to members."),
    line("F1", 11, 72, 724, "Membership grew by twelve per cent, mostly among young families"),
    line("F1", 11, 72, 710, "who moved to the area during the last two years."),
    line("F2", 13, 72, 680, "Plans for the new pier and the ferry terminal"),
    line("F2", 13, 72, 664, "in the coming season"),
    line("F1", 11, 72, 640, "The new pier will be built in two phases next year"),
    line("F1", 11, 72, 626, "and the deck will be finished in the autumn."),
    "0.5 w 72 572 m 520 572 l S",
    line("F1", 11, 72, 550, "Text under the rule stays where it is."),
  ].join("\n")]);
  const res = await applyWith(pdf, (s) => (/^(The harbour|Membership)/.test(s) ? `${s} ${s.slice(0, 40)}` : s.replace(/e/g, "é")));
  const items = await textItems(res.buffer);
  const at = (re) => items.find((i) => re.test(i.str));
  assert.deepEqual(overlaps(items), []);
  assert.ok(at(/^Plans/).y < 680, "overskriften er skjøvet ned");
  assert.ok(Math.abs(at(/^in thé coming/).y - at(/^Thé néw piér/).y - 24) < 0.05, `${at(/^in thé coming/).y} ${at(/^Thé néw piér/).y}`);
});

test("PDF: lagvilkår (/VE) med en gruppe som ikke finnes i /OCGs – er en kjent gruppe i uttrykket av, regnes laget som av", async () => {
  const KEEP = "BT /F1 11 Tf 72 780 Td (This first line is always visible on the page.) Tj ET";
  // Gruppe 7 er av, 8 er på, 10 finnes ikke i /OCGs.
  const make = (ve) => pdfFromObjects([
    "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [7 0 R 8 0 R] /D << /ON [8 0 R] /OFF [7 0 R] /Order [7 0 R 8 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Fm 6 0 R >> >> >>",
    st([KEEP, "q 1 0 0 1 72 700 cm /Fm Do Q"].join("\n")), HELV,
    st("BT /F1 11 Tf 0 10 Td (Conditional sentence in the form object.) Tj ET", "/Type /XObject /Subtype /Form /BBox [0 0 400 30] /Resources << /Font << /F1 5 0 R >> >> /OC 9 0 R"),
    "<< /Type /OCG /Name (Off) >>", "<< /Type /OCG /Name (On) >>",
    `<< /Type /OCMD /VE ${ve} >>`, "<< /Type /OCG /Name (Stray) >>",
  ]);
  for (const ve of ["[/And 10 0 R 7 0 R]", "[/Or 10 0 R 7 0 R]", "[/And 10 0 R [/Not 8 0 R]]"]) {
    const res = await applyWith(make(ve), upper);
    assert.deepEqual(res.strings, ["This first line is always visible on the page."], ve);
    assert.match(await formStreamOf(res.buffer, "Fm"), /\(Conditional sentence in the form object\.\) Tj/, ve);
  }
  // Or med en gruppe som er på, er på; bare ukjente grupper: ukjent (synlig, oversettes).
  for (const ve of ["[/Or 10 0 R 8 0 R]", "[/Not 10 0 R]"]) {
    const res = await applyWith(make(ve), upper);
    assert.ok(res.strings.some((s) => /^Conditional/.test(s)), ve);
  }
});
