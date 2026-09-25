const test = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const mock = require("./helpers/mock-grok");
const { minimalDocx, minimalPdf } = require("./helpers/fixtures");
const { translateStrings, planBatches, GrokError } = require("../src/grok");
const core = require("../src/core");
const { extractPages, stripText } = require("../src/formats/pdf");

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
  assert.equal(out, "q 1 0 0 rg 0 0 10 10 re f BT /F1 12 Tf 10 10 Td   T* T* ET BI /W 1 /H 1 /CS /G /BPC 8 ID \u0000Tj( EI q 0.5 g");
  assert.equal(open, 2, "to q uten Q: tegningen vår lukker dem");
});

test("utfilnavn kolliderer ikke, låsefiler ignoreres", () => {
  const names = core.assignOutputNames(["a/x.pdf", "a/x.docx", "a/X.rtf", "b.htm", "b.html"]);
  assert.equal(names.get("a/x.docx"), "a/x.docx");
  assert.equal(names.get("a/x.pdf"), "a/x.pdf", "PDF blir PDF");
  assert.equal(names.get("a/X.rtf"), "a/X (rtf).docx");
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
