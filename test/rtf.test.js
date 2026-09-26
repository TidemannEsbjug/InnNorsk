// RTF inn → RTF ut: teksten byttes på stedet, alt annet står urørt. Falsk Grok (aldri ekte xAI).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const mock = require("./helpers/mock-grok");
const core = require("../src/core");
const { validateOutput } = require("../src/validate");
const { CODEPAGES, TOO_BIG, TOO_MUCH_TEXT, translateRtf } = require("../src/formats/rtf");

// RTF-kilde som String.raw, men § betyr \u (\u-kontrollordene står da aldri som \u + sifre i kildekoden).
const R = (strings, ...vals) => String.raw(strings, ...vals).replace(/§/g, "\\u");
const ctx = (extra = {}) => ({ apiKey: "test", model: "grok-4.6", retryDelayMs: 1, ...extra });
const rtf = (s) => Buffer.from(s, "latin1");
const translate = async (s) => (await core.translateBuffer(rtf(s), ".rtf", ctx())).buffer.toString("latin1");
const collect = async (s) => (await core.collectStrings(rtf(s), ".rtf")).flat();
// Som skyjobbens siste steg: ferdige oversettelser (ett kall) legges inn i originalen.
const applyWith = async (s, translations) =>
  (await core.applyTranslations(rtf(s), ".rtf", [translations])).buffer.toString("latin1");
const untag = (s) => s.replace(/⟦\/?\d+⟧/g, "");
const valid = async (s) => (await validateOutput(rtf(s), ".rtf")).ok;
// Tekst tilbake fra utfilen, uten merker, sammenlignet med falsk oversettelse av originalen.
const readsBackAs = async (out, strings) =>
  assert.deepEqual((await collect(out)).map(untag), strings.map((s) => untag(mock.transform(s))));

test.before(() => mock.install());
test.after(() => mock.uninstall());
test.beforeEach(() => {
  mock.setMode("upper");
  mock.reset();
});

// Slik Word skriver RTF (forenklet), med CRLF-linjeskift.
const WORD = [
  R`{\rtf1\adeflang1025\ansi\ansicpg1252\uc1\adeff0\deff0\deflang1044{\fonttbl{\f0\froman\fcharset0\fprq2{\*\panose 02020603050405020304}Times New Roman;}{\f1\fswiss\fcharset0\fprq2 Calibri;}{\f2\fswiss\fcharset204\fprq2 Arial Cyr;}{\f3\fnil\fcharset2 Symbol;}}`,
  R`{\colortbl;\red0\green0\blue0;\red255\green0\blue0;\red5\green99\blue193;}`,
  R`{\stylesheet{\ql \li0\ri0\widctlpar\f1\fs24\lang1044 \snext0 \sqformat Normal;}{\*\cs10 \additive \ssemihidden Default Paragraph Font;}{\s1\ql\b\f1\fs32 \sbasedon0 \snext0 heading 1;}}`,
  R`{\*\generator Microsoft Word 16;}{\info{\title Quarterly report}{\author Jane Doe}}`,
  R`\paperw11906\paperh16838\margl1417\margr1417\margt1417\margb1417 \sectd`,
  R`{\header \pard\plain \ql \f1\fs18 Company header text\par}`,
  R`{\footer \pard\plain \qc \f1\fs18 Page {\field{\*\fldinst {\f1 PAGE }}{\fldrslt {\f1 1}}} of the report\par}`,
  R`\pard\plain \s1\ql\b\f1\fs32 Quarterly results\par`,
  R`\pard\plain \ql\f1\fs24 {\b Bold start} and a much longer normal part of the sentence.\par`,
  R`\pard {\i Italic} words written {\cf2 in red} here.\par`,
  R`\pard Norwegian letters: \'e6\'f8\'e5 and \'c6\'d8\'c5.\par`,
  R`\pard {\f2 \'cf\'f0\'e8\'e2\'e5\'f2 \'ec\'e8\'f0}\par`,
  R`\pard Unicode §8364\'80 euro and §248\'f8 slash.\par`,
  R`{\uc0 \pard Zero fallback bl§229 b§230 r\par}`,
  R`\trowd\trgaph108\trleft-108\cellx4000\cellx8000 \pard\intbl First cell\cell Second cell\cell\row`,
  R`\pard See {\field{\*\fldinst {HYPERLINK "https://example.com/"}}{\fldrslt {\ul\cf3 our website}}} for details.\par`,
  R`\pard Text with a footnote{\super\chftn}{\footnote \pard\plain \f1\fs20 {\super\chftn} Footnote text here.}.\par`,
  R`\pard Line one\line Line two\tab tabbed\par`,
  R`\pard {\*\shppict{\pict\pngblip\picw10\pich10\picwgoal150\pichgoal150 89504e470d0a1a0a7b7d5c`,
  R`0000000d49484452}}{\nonshppict{\pict\wmetafile8\picw10\pich10 0100090000037b7d}}Picture caption\par`,
  R`\pard {\listtext\f3 \'b7\tab}Bullet item\par`,
  R`\pard 2024\par`,
  R`}`,
].join("\r\n");

const WORD_STRINGS = [
  "Company header text",
  "Page ⟦1⟧ of the report⟦/1⟧", // sidetallet er et anker: teksten etter merkes
  "Quarterly results",
  "⟦1⟧Bold start⟦/1⟧ and a much longer normal part of the sentence.",
  "⟦1⟧Italic⟦/1⟧ words written ⟦2⟧in red⟦/2⟧ here.",
  "Norwegian letters: æøå and ÆØÅ.",
  "Привет мир",
  "Unicode € euro and ø slash.",
  "Zero fallback blåbær",
  "First cell",
  "Second cell",
  "See",
  "our website",
  "for details.",
  "Text with a footnote⟦1⟧.⟦/1⟧",
  "Footnote text here.",
  "Line one\nLine two\ttabbed",
  "Picture caption",
  "Bullet item",
];

// Slik LibreOffice skriver fotnoter, sluttnoter og symbolskrift: {\*\footnote …}, Symbol med \fcharset0 og \u-3913.
const LIBRE = [
  R`{\rtf1\ansi\deff4\adeflang1025`,
  R`{\fonttbl{\f0\froman\fprq2\fcharset0 Times New Roman;}{\f4\froman\fprq2\fcharset0 Liberation Serif{\*\falt Times New Roman};}{\f7\fnil\fprq2\fcharset0 Symbol;}}`,
  R`{\stylesheet{\s0\snext0 Normal;}{\*\cs17\snext17\super footnote reference;}}`,
  R`\pard\plain \s0\ql\loch\f4\fs24\lang1044{`,
  R`The project started in 2019 and was led by a small team}{{\super\rtlch\alang1025\ltrch\loch\lang1044 \chftn{\*\footnote \chftn\pard\plain \s28\loch\f4\fs20\lang1044{`,
  R` }{`,
  R`The footnote explains the team size.}`,
  R`\par \pard\plain \s28\loch\f4\fs20`,
  R``,
  R`}}`,
  R`}{`,
  R`. Norwegian letters: bl§229\'e5b§230\'e6r.}`,
  R`\par \pard\plain \s0\ql\loch\f4\fs24{`,
  R`Endnote here}{{\super \chftn{\*\footnote\ftnalt \chftn\pard\plain \loch\f4\fs20 {`,
  R` The endnote text.}}}}{`,
  R` follows.}`,
  R`\par \pard\plain \s0\ql\loch\f4\fs24{`,
  R`Symbols stay: }{\rtlch\af14\ltrch\f7`,
  R`§-3913\'3f§-3872\'3f}{`,
  R` after symbol font.}`,
  R`\par }`,
].join("\n");

const LIBRE_STRINGS = [
  "The project started in 2019 and was led by a small team⟦1⟧. Norwegian letters: blåbær.⟦/1⟧",
  "The footnote explains the team size.",
  "Endnote here⟦1⟧ follows.⟦/1⟧",
  "The endnote text.",
  "Symbols stay: ⟦1⟧ after symbol font.⟦/1⟧",
];

// Sporede endringer (Word): slettet tekst står urørt, innsatt tekst oversettes.
const TRACKED = [
  R`{\rtf1\ansi\deff0{\fonttbl{\f0 Times New Roman;}}{\*\revtbl {Unknown;}{Ola Nordmann;}}`,
  R`{\rtlch\fcs1 \af0 \ltrch\fcs0 \insrsid1 Tracked: }{\rtlch\fcs1 \af0 \ltrch\fcs0 \deleted\revauthdel1\revdttmdel123\insrsid1 old deleted wording here that is long}{\rtlch\fcs1 \af0 \ltrch\fcs0 \revised\revauth1\revdttm123\insrsid1 new}{\rtlch\fcs1 \af0 \ltrch\fcs0 \insrsid1  end.\par }`,
  R`\pard {\deleted\revauthdel1 This whole paragraph was deleted.}\par`,
  R`\pard The meeting is on {\deleted Monday}{\revised Tuesday} at noon.\par`,
  R`\pard A {\deleted gone\deleted0  back} and {\deleted x\plain  y} here.\par`,
  R`}`,
].join("\r\n");

const TRACKED_STRINGS = [
  "Tracked: ⟦1⟧new⟦/1⟧ end.",
  "The meeting is on ⟦1⟧Tuesday⟦/1⟧ at noon.",
  "A ⟦1⟧ back and ⟦/1⟧ y here.",
];

// Symbolskrift: \fcharset2, skrift som heter Wingdings/Symbol med \fcharset0, og \uN i U+F000–U+F0FF.
const SYMBOLS = [
  R`{\rtf1\ansi\deff0{\fonttbl{\f0 Arial;}{\f5\fnil\fcharset2 Wingdings;}{\f6\fnil\fcharset0 Wingdings;}{\f7\fnil\fcharset0 Symbol;}}`,
  R`\pard {\f5 o} Yes, I agree to the terms {\f5 o} No\par`,
  R`\pard Check {\f6 x} done and {\f7 a} open.\par`,
  R`\pard Status §-3842\'3f approved today.\par`,
  R`}`,
].join("\n");

const SYMBOL_STRINGS = [
  "Yes, I agree to the terms ⟦1⟧ No⟦/1⟧",
  "Check ⟦1⟧ done and ⟦/1⟧ open.",
  "Status ⟦1⟧ approved today.⟦/1⟧",
];

// Grunnformatet er formatet med flest bokstaver, ikke den lengste run-en. Usynlige kontrollord (\strokec, \insrsid,
// \cf0, svart = automatisk farge, \lang) og «Arial CYR» = «Arial» deler ikke formatet.
const STYLES = [
  R`{\rtf1\ansi\ansicpg1252\cocoartf2907`,
  R`{\fonttbl\f0\fnil\fcharset0 Georgia-Bold;\f1\fnil\fcharset0 Georgia;\f2\fnil\fcharset0 Georgia-Italic;\f3\fswiss\fcharset0 Arial;\f4\fswiss\fcharset204 Arial CYR;}`,
  R`{\colortbl;\red255\green255\blue255;\red0\green0\blue0;\red176\green0\blue4;\red0\green0\blue233;}`,
  R`\pard\f1\b0\fs32 \cf0 \strokec2 This is a `,
  R`\f0\b bold statement`,
  R`\f1\b0  and an `,
  R`\f2\i italic remark`,
  R`\f1\i0  about the \cf3 \strokec3 red numbers\cf0 \strokec2  in the \cf2 budget\cf0 .` + "\\", // \ + linjeskift = \par
  R`\pard {\insrsid1 Only }{\insrsid2 a }{\insrsid3 few }{\b\insrsid4 remarkably long bold words}{\insrsid5  and }{\insrsid6 more }{\insrsid7 plain words here, many more of them.}\par`,
  R`\pard\f3 Hello {\f4 §1055?§1088?§1080?§1074?§1077?§1090?} world {\lang1033\langfe1033 again}.\par`,
  R`\pard Read more at \cf4 \ul the minutes archive\cf0 \ulnone  before next week.\par`,
  R`}`,
].join("\n");

const STYLE_STRINGS = [
  "This is a ⟦1⟧bold statement⟦/1⟧ and an ⟦2⟧italic remark⟦/2⟧ about the ⟦3⟧red numbers⟦/3⟧ in the budget.",
  "Only a few ⟦1⟧remarkably long bold words⟦/1⟧ and more plain words here, many more of them.",
  "Hello Привет world again.",
  "Read more at ⟦1⟧the minutes archive⟦/1⟧ before next week.",
];

// Ankre midt i avsnittet: sidetall, bilde, dato/tid/seksjon, hevet/senket tall, kommentar, SYMBOL-felt, skjult tekst.
const INLINE = [
  R`{\rtf1\ansi\deff0{\fonttbl{\f0 Times New Roman;}}`,
  R`{\footer \pard\qc Page \chpgn  of the annual report\par}`,
  R`\pard Click the {\pict\pngblip\picw10\pich10 89504e470d0a1a0a} icon to continue.\par`,
  R`\pard Printed \chdate  at \chtime  in section \sectnum .\par`,
  R`\pard Water is H{\sub 2}O and E = mc{\super 2} here{\super 1}.\par`,
  R`\pard Comment here{\*\atrfstart 1} annotated words{\*\atrfend 1}{\*\atnid KN}{\*\atnauthor Kari}\chatn {\*\annotation{\*\atnref 1}\pard Reviewer note.} finished.\par`,
  R`\pard Tick {\field{\*\fldinst SYMBOL 252 \\f "Wingdings" \\s 11}{\fldrslt\f2 \'fc}} done now.\par`,
  R`\pard Visible {\v hidden words} text.\par`,
  R`}`,
].join("\n");

const INLINE_STRINGS = [
  "Page ⟦1⟧ of the annual report⟦/1⟧",
  "Click the ⟦1⟧ icon to continue.⟦/1⟧",
  "Printed ⟦1⟧ at ⟦/1⟧ in section ⟦2⟧.⟦/2⟧",
  "Water is H⟦1⟧O and E = mc⟦/1⟧ here⟦2⟧.⟦/2⟧",
  "Comment here⟦1⟧ annotated words⟦/1⟧ finished.",
  "Tick ⟦1⟧ done now.⟦/1⟧",
  "Visible ⟦1⟧ text.⟦/1⟧",
];

// macOS/Cocoa (TextEdit, textutil, Pages) skriver symbolskrift med PostScript-navn og \fcharset0, og koder om
// Wingdings-tegnene til vanlige tegn: 'o' → ο (§959), 'q' → θ (§952). Alt i slik skrift er tegn.
const COCOA_SYMBOLS = [
  R`{\rtf1\ansi\ansicpg1252\cocoartf2907`,
  R`{\fonttbl\f0\fswiss\fcharset0 Helvetica;\f1\ftech\fcharset0 Wingdings-Regular;\f2\fnil\fcharset0 SymbolMT;\f3\fnil\fcharset0 ZapfDingbatsITC;\f4\fnil\fcharset0 Webdings;\f5\fnil\fcharset0 Wingdings 2;}`,
  R`\pard\f1 \uc0 §959 \f0  Yes, I agree to the terms \f1 §952 \f0  No, I do not agree` + "\\",
  R`\f2 §945 \f0  Alpha, \f3 4\f0  tick, \f4 a\f0  and \f5 P\f0  done.` + "\\",
  R`}`,
].join("\n");

const COCOA_SYMBOL_STRINGS = [
  "Yes, I agree to the terms ⟦1⟧ No, I do not agree⟦/1⟧",
  "Alpha, ⟦1⟧ tick, ⟦/1⟧ and ⟦2⟧ done.⟦/2⟧",
];

// Skjema: understreket/uthevet blankt felt av tab eller mellomrom (Word-brev, signaturlinjer).
const FORM = [
  R`{\rtf1\ansi\deff0{\fonttbl{\f0 Times;}}`,
  R`\pard Name: {\ul\tab\tab\tab} Date: {\ul\tab\tab}\par`,
  R`\pard Signature {\ul                    }\par`,
  R`\pard I, {\ul\tab\tab}, confirm the terms.\par`,
  R`\pard Fill in {\highlight7      } here, or {\strike\tab} there.\par`,
  R`}`,
].join("\n");

const FORM_STRINGS = [
  "Name: ⟦1⟧ Date: ⟦/1⟧",
  "Signature",
  "I, ⟦1⟧, confirm the terms.⟦/1⟧",
  "Fill in ⟦1⟧ here, or ⟦/1⟧ there.",
];

// TextEdit: linjeskift inni et avsnitt er U+2028 (§8232), lagret som \uc0舲.
const LINES = R`{\rtf1\ansi\ansicpg1252\cocoartf2907{\fonttbl\f0\fswiss\fcharset0 Helvetica;\f1\fswiss\fcharset0 Helvetica-Bold;}\f0\fs24 \cf0 Dear Kari,\uc0§8232 thanks for the \f1\b letter\f0\b0 .\uc0§8232 Best wishes` + "\\\n}";

test("RTF: henter avsnitt fra brødtekst, topp/bunn, tabell, lenke og fotnote; aldri tabeller, metadata eller bilder", async () => {
  assert.deepEqual(await core.collectStrings(rtf(WORD), ".rtf"), [WORD_STRINGS], "ett kall, i dokumentrekkefølge");
  const a = await core.analyzeBuffer(rtf(WORD), ".rtf");
  assert.equal(a.segments, WORD_STRINGS.length);
});

test("RTF blir RTF: teksten byttes på stedet, formatering og alt annet står urørt", async () => {
  const input = WORD;
  const out = await translate(input);
  assert.equal(mock.state.calls, 1);
  assert.ok(out.startsWith("{\\rtf1\\adeflang1025"));
  assert.ok(await valid(out));

  // Skrifttabell, farger, stiler, metadata og sideoppsett byte for byte.
  const lines = input.split("\r\n");
  for (const line of lines.slice(0, 5)) assert.ok(out.includes(line), line.slice(0, 40));
  assert.ok(out.includes(R`{\info{\title Quarterly report}{\author Jane Doe}}`));

  const expected = [
    R`{\header \pard\plain \ql \f1\fs18 NB:COMPANY HEADER TEXT\par}`,
    // Sidetallsfeltet står mellom «Page» og «of the report».
    R`\qc \f1\fs18 NB:PAGE {\field{\*\fldinst {\f1 PAGE }}{\fldrslt {\f1 1}}} OF THE REPORT\par}`,
    R`\s1\ql\b\f1\fs32 NB:QUARTERLY RESULTS\par`,
    // Uthevede ord beholder sin egen run og sitt format; resten får grunnformatet.
    R`\pard\plain \ql\f1\fs24 {\b NB:BOLD START} AND A MUCH LONGER NORMAL PART OF THE SENTENCE.\par`,
    R`\pard {\i NB:ITALIC} WORDS WRITTEN {\cf2 IN RED} HERE.\par`,
    R`\pard NB:NORWEGIAN LETTERS: §198?§216?§197? AND §198?§216?§197?.\par`,
    R`{\f2 NB:§1055?§1056?§1048?§1042?§1045?§1058? §1052?§1048?§1056?}\par`,
    R`\pard NB:UNICODE §8364? EURO AND §216? SLASH.\par`,
    R`{\uc0 \pard NB:ZERO FALLBACK BL§197 B§198 R\par}`,
    R`\trowd\trgaph108\trleft-108\cellx4000\cellx8000 \pard\intbl NB:FIRST CELL\cell NB:SECOND CELL\cell\row`,
    R`\pard NB:SEE {\field{\*\fldinst {HYPERLINK "https://example.com/"}}{\fldrslt {\ul\cf3 NB:OUR WEBSITE}}} NB:FOR DETAILS.\par`,
    // Fotnotemerket står fortsatt mellom «footnote» og punktumet.
    R`\pard NB:TEXT WITH A FOOTNOTE{\super\chftn}{\footnote \pard\plain \f1\fs20 {\super\chftn} NB:FOOTNOTE TEXT HERE.}.\par`,
    R`\pard NB:LINE ONE\line LINE TWO\tab TABBED\par`,
    R`{\listtext\f3 \'b7\tab}NB:BULLET ITEM\par`,
    R`\pard 2024\par`,
  ];
  for (const s of expected) assert.ok(out.includes(s), `mangler: ${s}`);

  // Bildet (hex med 7b7d5c = «{}\») er identisk.
  const pict = (s) => s.slice(s.indexOf("{\\*\\shppict"), s.indexOf("}}", s.indexOf("{\\nonshppict")) + 2);
  assert.ok(pict(input).length > 100);
  assert.equal(pict(out), pict(input));
  assert.ok(out.includes(R`7b7d}}NB:PICTURE CAPTION\par`));

  // Resultatet leses tilbake til oversettelsene.
  await readsBackAs(out, WORD_STRINGS);
});

test("RTF: collect + apply gir samme fil som direkte oversettelse, og samme fil gir samme strenger", async () => {
  for (const doc of [WORD, LIBRE, TRACKED, SYMBOLS, STYLES, INLINE, COCOA_SYMBOLS, FORM, LINES]) {
    const buf = rtf(doc);
    const direct = await core.translateBuffer(buf, ".rtf", ctx());
    const collected = await core.collectStrings(buf, ".rtf");
    const translatedCalls = collected.map((strings) => strings.map(mock.transform));
    const applied = await core.applyTranslations(buf, ".rtf", translatedCalls);
    assert.equal(applied.outExt, ".rtf");
    assert.ok(applied.buffer.equals(direct.buffer), doc.slice(0, 60));
    assert.deepEqual(await core.collectStrings(buf, ".rtf"), collected, "deterministisk");
  }
  await assert.rejects(core.applyTranslations(rtf(WORD), ".rtf", []), /endret seg/);
});

test("RTF: innsamling bygger ingen utfil (returnerer originalen)", async () => {
  const buf = rtf(WORD);
  const calls = [];
  assert.equal(await translateRtf(buf, { collect: calls, apiKey: "" }), buf);
  assert.deepEqual(calls.map((c) => c.strings), [WORD_STRINGS]);
});

test("RTF fra LibreOffice: {\\*\\footnote} (fotnoter og sluttnoter) oversettes, merket står etter riktig ord", async () => {
  assert.deepEqual(await collect(LIBRE), LIBRE_STRINGS);
  const out = await translate(LIBRE);
  assert.ok(await valid(out));
  assert.ok(out.includes(R`{\*\footnote \chftn\pard\plain \s28\loch\f4\fs20\lang1044{`), "fotnotegruppen står");
  assert.ok(out.includes("NB:THE FOOTNOTE EXPLAINS THE TEAM SIZE.}"));
  assert.ok(out.includes("NB:THE ENDNOTE TEXT.}"));
  // Fotnotemerket står mellom «team» og punktumet, sluttnotemerket mellom «here» og «follows».
  const at = (s) => out.indexOf(s);
  assert.ok(at("SMALL TEAM}{{\\super") > 0 && at("SMALL TEAM}{{\\super") < at(R`}{` + "\n" + R`. NORWEGIAN LETTERS: BL§197?B§198?R.}`));
  assert.ok(out.includes(R`NB:ENDNOTE HERE}{{\super \chftn{\*\footnote\ftnalt`));
  assert.ok(out.includes(R`}}}}{` + "\n" + R` FOLLOWS.}`));
  // Symbolene (LibreOffice: Symbol med \fcharset0, \u-3913) står urørt, der de var.
  assert.ok(out.includes(R`NB:SYMBOLS STAY: }{\rtlch\af14\ltrch\f7` + "\n" + R`§-3913\'3f§-3872\'3f}{` + "\n" + R` AFTER SYMBOL FONT.}`));
  await readsBackAs(out, LIBRE_STRINGS);
});

test("RTF: sporet sletting sendes aldri og står byte for byte; innsatt tekst oversettes for seg", async () => {
  assert.deepEqual(await collect(TRACKED), TRACKED_STRINGS);
  const out = await translate(TRACKED);
  assert.ok(await valid(out));
  // Den slettede run-en er lengst, men får aldri oversettelsen.
  assert.ok(out.includes(R`{\rtlch\fcs1 \af0 \ltrch\fcs0 \deleted\revauthdel1\revdttmdel123\insrsid1 old deleted wording here that is long}`));
  assert.ok(out.includes(R`\insrsid1 NB:TRACKED: }`));
  assert.ok(out.includes(R`\revised\revauth1\revdttm123\insrsid1 NEW}{\rtlch\fcs1 \af0 \ltrch\fcs0 \insrsid1  END.\par }`));
  assert.ok(out.includes(R`\pard {\deleted\revauthdel1 This whole paragraph was deleted.}\par`));
  assert.ok(out.includes(R`\pard NB:THE MEETING IS ON {\deleted Monday}{\revised TUESDAY} AT NOON.\par`));
  // \deleted0 og \plain avslutter slettingen.
  assert.ok(out.includes(R`\pard NB:A {\deleted gone\deleted0  BACK AND }{\deleted x\plain  Y HERE.}\par`));
  await readsBackAs(out, TRACKED_STRINGS);
});

test("RTF: tegn i symbolskrift og U+F000–U+F0FF er tegn, ikke tekst: de sendes ikke og blir stående", async () => {
  assert.deepEqual(await collect(SYMBOLS), SYMBOL_STRINGS);
  const out = await translate(SYMBOLS);
  assert.ok(await valid(out));
  assert.ok(out.includes(R`\pard {\f5 o} NB:YES, I AGREE TO THE TERMS {\f5 o} NO\par`));
  assert.ok(out.includes(R`\pard NB:CHECK {\f6 x} DONE AND {\f7 a} OPEN.\par`));
  assert.ok(out.includes(R`\pard NB:STATUS §-3842\'3f APPROVED TODAY.\par`));
  // Cocoa (TextEdit) skriver skrifttabellen uten grupper.
  const cocoa = R`{\rtf1\ansi\ansicpg1252\cocoartf2907{\fonttbl\f0\fswiss\fcharset0 Helvetica;\f1\fnil\fcharset0 ZapfDingbats;}\f0 Tick {\f1 4} done here.\par}`;
  assert.deepEqual(await collect(cocoa), ["Tick ⟦1⟧ done here.⟦/1⟧"]);
  assert.ok((await translate(cocoa)).includes(R`\f0 NB:TICK {\f1 4} DONE HERE.\par}`));
});

test("RTF: grunnformatet er formatet med flest bokstaver; uthevede ord beholder formatet sitt", async () => {
  assert.deepEqual(await collect(STYLES), STYLE_STRINGS);
  const out = await translate(STYLES);
  assert.ok(await valid(out));
  assert.ok(out.includes(R`\strokec2 NB:THIS IS A ` + "\n" + R`\f0\b BOLD STATEMENT` + "\n" + R`\f1\b0  AND AN ` + "\n" + R`\f2\i ITALIC REMARK`));
  assert.ok(out.includes(R`\f1\i0  ABOUT THE \cf3 \strokec3 RED NUMBERS\cf0 \strokec2  IN THE BUDGET.\cf2 \cf0 ` + "\\\n"));
  // Mange små run-er i grunnformatet og én lang fet: bare de fete ordene blir fete.
  assert.ok(out.includes(R`{\insrsid1 NB:ONLY A FEW }{\insrsid2 }{\insrsid3 }{\b\insrsid4 REMARKABLY LONG BOLD WORDS}{\insrsid5  AND MORE PLAIN WORDS HERE, MANY MORE OF THEM.}{\insrsid6 }{\insrsid7 }\par`));
  // Lenkeformat (farge + understreking) bare på lenketeksten.
  assert.ok(out.includes(R`\pard NB:READ MORE AT \cf4 \ul THE MINUTES ARCHIVE\cf0 \ulnone  BEFORE NEXT WEEK.\par`));
  await readsBackAs(out, STYLE_STRINGS);
});

test("RTF: ankre midt i avsnittet (sidetall, bilde, dato, hevet tall, kommentar, symbolfelt, skjult tekst) står på plass", async () => {
  assert.deepEqual(await collect(INLINE), INLINE_STRINGS);
  const out = await translate(INLINE);
  assert.ok(await valid(out));
  const expected = [
    R`{\footer \pard\qc NB:PAGE \chpgn  OF THE ANNUAL REPORT\par}`,
    R`\pard NB:CLICK THE {\pict\pngblip\picw10\pich10 89504e470d0a1a0a} ICON TO CONTINUE.\par`,
    R`\pard NB:PRINTED \chdate  AT \chtime  IN SECTION \sectnum .\par`,
    // Hevet/senket uten bokstaver (H₂O, mc², fotnotetall) står urørt.
    R`\pard NB:WATER IS H{\sub 2}O AND E = MC{\super 2} HERE{\super 1}.\par`,
    R`\pard NB:COMMENT HERE{\*\atrfstart 1} ANNOTATED WORDS{\*\atrfend 1}{\*\atnid KN}{\*\atnauthor Kari}\chatn {\*\annotation{\*\atnref 1}\pard Reviewer note.} FINISHED.\par`,
    R`\pard NB:TICK {\field{\*\fldinst SYMBOL 252 \\f "Wingdings" \\s 11}{\fldrslt\f2 \'fc}} DONE NOW.\par`,
    R`\pard NB:VISIBLE {\v hidden words} TEXT.\par`,
  ];
  for (const s of expected) assert.ok(out.includes(s), `mangler: ${s}`);
  await readsBackAs(out, INLINE_STRINGS);
});

test("RTF: oversatte biter legges i run-ene med samme merke; feil merker gir grunnformatet", async () => {
  const doc = (body) => R`{\rtf1\ansi\deff0{\fonttbl{\f0 Times;}}\pard ` + body + R`\par}`;
  const red = doc(R`The {\b red} car.`);
  // Omvendt rekkefølge: biten legges i run-en med samme merke, teksten rundt beholder rekkefølgen.
  assert.equal(await applyWith(doc(R`The {\b red} car is fast.`), ["⟦1⟧Den røde⟦/1⟧ bilen er rask."]), doc(R`{\b Den r§248?de} bilen er rask.`));
  assert.equal(await applyWith(doc(R`Normal text {\b bold} end.`), ["⟦1⟧fet⟦/1⟧ vanlig tekst slutt."]), doc(R`{\b fet} vanlig tekst slutt.`));
  // Ubalansert merke, ukjent nummer eller ingen merker: alt i grunnformatet, den fete run-en tømmes.
  for (const t of ["Den ⟦1⟧røde bilen.", "Den ⟦2⟧røde⟦/2⟧ bilen.", "Den røde bilen."]) {
    assert.equal(await applyWith(red, [t]), doc(R`Den r§248?de bilen.{\b }`), t);
  }
  // Tom oversettelse: avsnittet står urørt.
  assert.equal(await applyWith(red, ["  "]), red);
  // Merker Grok har funnet på i et avsnitt uten merker, fjernes.
  assert.equal(await applyWith(doc("Plain text here."), ["⟦1⟧Vanlig⟦/1⟧ tekst her."]), doc("Vanlig tekst her."));
  // Mellomrommet står på samme side av fotnotemerket som i originalen.
  const fn = doc(R`The study{\super\chftn}{\footnote\pard Note.} found it.`);
  assert.equal(await applyWith(fn, ["Studien ⟦1⟧fant det.⟦/1⟧", "Merknad."]), doc(R`Studien{\super\chftn}{\footnote\pard Merknad.} fant det.`));
  // Flere enn 6 formater: de første 6 får merker, resten sendes som vanlig tekst.
  const seven = doc(R`A {\b b} c {\i d} e {\ul f} g {\strike h} i {\caps j} k {\scaps l} m {\outl n} o.`);
  assert.deepEqual(await collect(seven), ["A ⟦1⟧b⟦/1⟧ c ⟦2⟧d⟦/2⟧ e ⟦3⟧f⟦/3⟧ g ⟦4⟧h⟦/4⟧ i ⟦5⟧j⟦/5⟧ k ⟦6⟧l⟦/6⟧ m n o."]);
  assert.equal(await translate(seven), doc(R`NB:A {\b B} C {\i D} E {\ul F} G {\strike H} I {\caps J} K {\scaps L} M N O.{\outl }`));
  // Tekst med ⟦ ⟧ i originalen får ingen merker, og tegnene står.
  const literal = doc(R`Keep §10214?1§10215? here {\b bold}.`);
  assert.deepEqual(await collect(literal), ["Keep ⟦1⟧ here bold."]);
  assert.equal(await applyWith(literal, ["Behold ⟦1⟧ her fet."]), doc(R`Behold §10214?1§10215? her fet.{\b }`));
  // Det samme med 〚 〛 (som modellen ellers kan skrive i stedet for ⟦ ⟧).
  const white = doc(R`Values §12314?a, b§12315? and §12314?1§12315? here {\b bold}.`);
  assert.deepEqual(await collect(white), ["Values 〚a, b〛 and 〚1〛 here bold."]);
  assert.equal(await applyWith(white, await collect(white)), doc(R`Values §12314?a, b§12315? and §12314?1§12315? here bold.{\b }`));
});

test("RTF: tegntabeller fra \\ansicpg og \\fcharset, råbytes, \\plain, flerbyte og symbolskrift", async () => {
  const doc = [
    R`{\rtf1\ansi\ansicpg1251\deff0{\fonttbl{\f0 Arial;}{\f1\fcharset238 Arial CE;}{\f2\fcharset0 Arial;}{\f3\fcharset128 MS Mincho;}{\f4\fcharset2 Symbol;}}`,
    R`\pard \'cf\'f0\'e8\'e2\'e5\'f2\par`,
    R`\pard\f1 \'8a\'9a\'e8 ok\par`,
    R`\pard\f2 \'e6\'f8\'e5 Tokyo \plain \'e0\par`,
    // Shift-JIS «日本» (andre byte 0x7b = «{») uten \u: vi kan ikke lese det, avsnittet står urørt.
    R`\pard {\f3 \'93\'fa\'96\'7b}iPhone\par`,
    R`\pard {\f4 \'b7}\tab Symbol bullet\par`,
    R`}`,
  ].join("\n");
  assert.deepEqual(await collect(doc), ["Привет", "Ššč ok", "æøå Tokyo а", "Symbol bullet"]);
  const res = await core.translateBuffer(rtf(doc), ".rtf", ctx());
  const out = res.buffer.toString("latin1");
  assert.ok(out.includes(R`\pard {\f3 \'93\'fa\'96\'7b}iPhone\par`));
  assert.ok(out.includes(R`\pard {\f4 \'b7}\tab NB:SYMBOL BULLET\par`));
  assert.deepEqual(await collect(out), ["NB:ПРИВЕТ", "NB:ŠŠČ OK", "NB:ÆØÅ TOKYO А", "NB:SYMBOL BULLET"]);
  // Avsnitt vi ikke kan lese: én advarsel for hele filen.
  assert.deepEqual(res.warnings.map((w) => w.code), ["rtf_charset"]);
  assert.match(res.warnings[0].message, /^Ett avsnitt står uoversatt/);
  const two = doc.replace("iPhone", R`iPhone\par\pard {\f3 \'82\'a0}`);
  const warned = [];
  await core.applyTranslations(rtf(two), ".rtf", await core.collectStrings(rtf(two), ".rtf"), { onWarning: (w) => warned.push(w) });
  assert.equal(warned.length, 1);
  assert.match(warned[0].message, /^2 avsnitt står uoversatt/);

  const raw = Buffer.concat([rtf("{\\rtf1\\ansi\\ansicpg1252 Bl"), Buffer.from([0xe5]), rtf(" hav\\par}")]);
  assert.deepEqual((await core.collectStrings(raw, ".rtf")).flat(), ["Blå hav"]);
  assert.deepEqual(await collect(R`{\rtf1\mac\deff0 \pard bl\'8cb\'ber\par}`), ["blåbær"]);
});

test("RTF: tegntabellene stemmer med Node sin TextDecoder", () => {
  for (const [cp, table] of Object.entries(CODEPAGES)) {
    const label = cp === "10000" ? "macintosh" : `windows-${cp}`;
    const dec = new TextDecoder(label);
    const want = Array.from({ length: 128 }, (_, i) => dec.decode(Uint8Array.of(0x80 + i))).join("");
    assert.equal(table, want, label);
  }
});

test("RTF: \\uN med \\uc2, surrogatpar og reservetegn", async () => {
  const doc = R`{\rtf1\ansi {\uc2 \pard §12354\'82\'a0 text\par}\pard Smile §-10179?§-8703?\par}`;
  assert.deepEqual(await collect(doc), ["あ text", "Smile \u{1F601}"]);
  const out = await translate(doc);
  assert.ok(out.includes(R`{\uc2 \pard NB:§12354?? TEXT\par}`));
  assert.ok(out.includes(R`\pard NB:SMILE §-10179?§-8703?\par}`));
});

test("RTF: kontrollord uten mellomrom får skilletegn foran ny tekst", async () => {
  const out = await translate(R`{\rtf1\ansi\pard\b\'c6rlig talt\b0\par}`);
  assert.equal(out, R`{\rtf1\ansi\pard\b NB:§198?RLIG TALT\b0\par}`);
});

test("RTF: reservetegn kan være tegnord, men \\par etter \\uN uten reserve står", async () => {
  const dash = 8212;
  const doc = R`{\rtf1\ansi\uc1 \pard A§${dash}\emdash B\par\pard Dash §${dash}\par Next line {\*\bkmkstart b1}{\*\ukjent Secret}end\par}`;
  // Bokmerket er et anker: det står fortsatt foran «end».
  assert.deepEqual(await collect(doc), ["A—B", "Dash —", "Next line ⟦1⟧end⟦/1⟧"]);
  const out = await translate(doc);
  assert.equal(
    out,
    R`{\rtf1\ansi\uc1 \pard NB:A§${dash}?B\par\pard NB:DASH §${dash}?\par NB:NEXT LINE {\*\bkmkstart b1}{\*\ukjent Secret}END\par}`
  );
});

test("RTF: skjult tekst, \\bin-data og tekstbokser", async () => {
  const bin = "}{\\'{}";
  const doc = [
    R`{\rtf1\ansi`,
    R`\pard Visible {\v hidden words} text\par`,
    R`{\pict\wmetafile8\bin6 ${bin}}Caption text\par`,
    R`{\shp{\*\shpinst\shpleft0\shptop0{\sp{\sn shapeType}{\sv 202}}{\shptxt \pard Box text\par}}{\shprslt {\*\do\dobxcolumn{\*\dptxbxtext\pard Box text\par}}}}`,
    R`}`,
  ].join("\n");
  assert.deepEqual(await collect(doc), ["Visible ⟦1⟧ text⟦/1⟧", "Caption text", "Box text"]);
  const out = await translate(doc);
  // Skjult tekst sendes ikke og står der den stod.
  assert.ok(out.includes(R`\pard NB:VISIBLE {\v hidden words} TEXT\par`));
  assert.ok(out.includes(R`{\pict\wmetafile8\bin6 ${bin}}NB:CAPTION TEXT\par`));
  assert.ok(out.includes(R`{\sp{\sn shapeType}{\sv 202}}{\shptxt \pard NB:BOX TEXT\par}`));
  assert.ok(out.includes(R`{\*\dptxbxtext\pard Box text\par}`));
  assert.ok(await valid(out));
});

test("RTF: kildelinjeskift er ikke tekst, manglende } repareres, uten tekst → ingen Grok-kall", async () => {
  assert.deepEqual(await collect("{\\rtf1\\ansi\\pard Hello \r\nworld\\par\r\n}"), ["Hello world"]);

  const open = await translate("{\\rtf1\\ansi\\pard Hello world\\par");
  assert.equal(open, "{\\rtf1\\ansi\\pard NB:HELLO WORLD\\par}");

  mock.reset();
  const empty = rtf("{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\pard 12345\\par}");
  const res = await core.translateBuffer(empty, ".rtf", ctx());
  assert.ok(res.buffer.equals(empty));
  assert.equal(mock.state.calls, 0);
  assert.equal((await core.analyzeBuffer(empty, ".rtf")).segments, 0);

  await assert.rejects(core.translateBuffer(rtf("Dette er ikke RTF"), ".rtf", ctx()), /ikke en gyldig RTF/);
});

test("RTF: skadet struktur repareres før noe betales, eller avvises allerede ved opplasting", async () => {
  const cases = [
    // [inn, ut etter falsk oversettelse]
    [R`{\rtf1\ansi\pard Hello world\par}}}`, R`{\rtf1\ansi\pard NB:HELLO WORLD\par}`], // } for mye etter rotgruppen
    [R`{\rtf1\ansi\pard Hello world\par}garbage {\b x}`, R`{\rtf1\ansi\pard NB:HELLO WORLD\par}`], // rot etter slutten
    ["{\\rtf1\\ansi\\pard Hello world\\par}\r\n\0", "{\\rtf1\\ansi\\pard NB:HELLO WORLD\\par}\r\n\0"], // mellomrom/NUL står
    [R`{\rtf1\ansi\pard Hello world\par`, R`{\rtf1\ansi\pard NB:HELLO WORLD\par}`], // mangler }
    [R`{\rtf1\ansi\pard Hello world` + "\\", R`{\rtf1\ansi\pard NB:HELLO WORLD}`], // avsluttende \
    [R`{\rtf1\ansi\pard Hello world\'e`, R`{\rtf1\ansi\pard NB:HELLO WORLD}`], // avkuttet \'h
    [R`{\rtf1\ansi\pard Hello {\pict\bin999999999 abc`, R`{\rtf1\ansi\pard NB:HELLO {\pict\bin3 abc}}`], // avkuttet \bin
  ];
  for (const [input, want] of cases) {
    assert.equal((await core.analyzeBuffer(rtf(input), ".rtf")).segments, 1, input);
    const out = await translate(input);
    assert.equal(out, want, input);
    assert.ok(await valid(out), input);
  }
  // Uten tekst å oversette: ingen kall, men filen rettes likevel.
  mock.reset();
  assert.equal(await translate(R`{\rtf1\ansi\pard 12345\par}}`), R`{\rtf1\ansi\pard 12345\par}`);
  assert.equal(mock.state.calls, 0);
  // Umulig dyp nesting: norsk feilmelding allerede i analysen ved opplasting (ingen Grok-kall).
  const deep = rtf(`{\\rtf1 Hi ${"{".repeat(10001)}text`);
  await assert.rejects(core.analyzeBuffer(deep, ".rtf"), /RTF-filen er skadet og kan ikke leses/);
  assert.equal(mock.state.calls, 0);
});

test("RTF: validering og filnavn", async () => {
  assert.ok(await valid("{\\rtf1 {\\b x}\\{ \\}}"));
  assert.ok(await valid("{\\rtf1 {\\pict\\bin2 }{}}"));
  assert.ok(await valid("{\\rtf1 x}\r\n\0"));
  assert.ok(!(await valid("{\\rtf1 {\\b x}")));
  assert.ok(!(await valid("{\\rtf1 x}}")));
  assert.ok(!(await valid("{\\rtf1 x} tail")));
  assert.ok(!(await valid("{\\rtf1 {\\pict\\bin9 }}")), "binærdata sluker }");
  assert.ok(!(await valid("hei")));
  assert.equal(core.HANDLERS[".rtf"].outExt, ".rtf");
  assert.equal(core.outputNameFor("mappe/Brev.rtf"), "mappe/Brev.rtf");
});

// Ferdige oversettelser (ett kall) legges inn; gir utfilen og advarslene.
const applyFull = async (s, translations) => {
  const res = await core.applyTranslations(rtf(s), ".rtf", [translations]);
  return { out: res.buffer.toString("latin1"), warnings: res.warnings };
};
const para = (body) => R`{\rtf1\ansi\deff0{\fonttbl{\f0 Times;}}\pard ` + body + R`\par}`;

test("RTF: symbolskrift fra macOS/Cocoa (PostScript-navn, \\fcharset0, omkodede tegn) er tegn, ikke tekst", async () => {
  assert.deepEqual(await collect(COCOA_SYMBOLS), COCOA_SYMBOL_STRINGS);
  const out = await translate(COCOA_SYMBOLS);
  assert.ok(await valid(out));
  // Avkrysningsboksene står urørt, der de stod.
  assert.ok(out.includes(R`\pard\f1 \uc0 §959 \f0  NB:YES, I AGREE TO THE TERMS \f1 §952 \f0  NO, I DO NOT AGREE` + "\\"));
  assert.ok(out.includes(R`\f2 §945 \f0  NB:ALPHA, \f3 4\f0  TICK, \f4 a\f0  AND \f5 P\f0  DONE.` + "\\"));
  // Familien gjenkjennes uansett store/små bokstaver, mellomrom, bindestrek og -Regular/-Bold/MT/ITC.
  const fonts = ["Wingdings", "wingdings-Bold", "Wingdings 3", "Symbol", "SymbolMT", "Symbol-Regular", "Webdings",
    "ZapfDingbats", "ITC Zapf Dingbats", "ZapfDingbatsITC", "MT Extra", "Marlett"];
  for (const name of fonts) {
    const doc = R`{\rtf1\ansi{\fonttbl{\f0 Arial;}{\f1\fnil\fcharset0 ${name};}}\pard Text {\f1 xq} more text\par}`;
    assert.deepEqual(await collect(doc), ["Text ⟦1⟧ more text⟦/1⟧"], name);
  }
  for (const name of ["Helvetica", "Georgia-Bold", "Segoe UI"]) {
    const doc = R`{\rtf1\ansi{\fonttbl{\f0 Arial;}{\f1\fnil\fcharset0 ${name};}}\pard Text {\f1 xq} more text\par}`;
    assert.deepEqual(await collect(doc), ["Text ⟦1⟧xq⟦/1⟧ more text"], name);
  }
});

test("RTF: understreket/uthevet blankt felt av tab eller mellomrom står med formatet sitt der det står", async () => {
  assert.deepEqual(await collect(FORM), FORM_STRINGS);
  const out = await translate(FORM);
  assert.ok(await valid(out));
  const expected = [
    R`\pard NB:NAME: {\ul\tab\tab\tab} DATE: {\ul\tab\tab}\par`,
    R`\pard NB:SIGNATURE {\ul                    }\par`,
    R`\pard NB:I, {\ul\tab\tab}, CONFIRM THE TERMS.\par`,
    R`\pard NB:FILL IN {\highlight7      } HERE, OR {\strike\tab} THERE.\par`,
  ];
  for (const s of expected) assert.ok(out.includes(s), `mangler: ${s}`);
  // En perfekt oversettelse (samme tekst) gir samme fil.
  assert.equal(await applyWith(FORM, await collect(FORM)), FORM);
  // Modellen tar bort mellomrommene rundt feltet: de settes tilbake.
  const form = para(R`Name: {\ul\tab\tab\tab} Date: {\ul\tab\tab}`);
  assert.equal(await applyWith(form, ["Navn:⟦1⟧Dato:⟦/1⟧"]), para(R`Navn: {\ul\tab\tab\tab} Dato: {\ul\tab\tab}`));
  // Ett understreket mellomrom mellom to ord er ikke et felt (ordene skal ikke klistres sammen for Grok).
  assert.deepEqual(await collect(para(R`Word{\ul  }word here`)), ["Word word here"]);
  // \ulw understreker bare ord: mellomrom i det formatet er ikke et felt.
  assert.deepEqual(await collect(para(R`Name: {\ulw\tab\tab} here`)), ["Name: \t\t here"]);
  // Feltet er et felt også når understrekingen har ord ellers i avsnittet («{\ul Navn:}» + understreket tomrom).
  const label = para(R`Please write your {\ul Name:}{\ul\tab\tab\tab} and the date here.`);
  assert.deepEqual(await collect(label), ["Please write your ⟦1⟧Name:⟦/1⟧ and the date here."]);
  assert.equal(await applyWith(label, await collect(label)), label);
});

test("RTF: merkevarianter fra modellen rettes; rester fjernes med én advarsel per fil; bare merker → urørt", async () => {
  const red = para(R`The {\b red} car.`);
  const want = para(R`Den {\b r§248?de} bilen.`);
  for (const t of ["Den ⟦ 1 ⟧røde⟦ /1 ⟧ bilen.", "Den ⟦１⟧røde⟦/１⟧ bilen.", "Den 〚1〛røde〚/1〛 bilen.", "Den [1]røde[/1] bilen.",
    "Den [ 1 ]røde[ /1 ] bilen."]) {
    const { out, warnings } = await applyFull(red, [t]);
    assert.equal(out, want, t);
    assert.deepEqual(warnings, [], t);
  }
  // [1] er tekst når originalen har [ (kildehenvisning): bare [n]…[/n] i par blir merker, «[1]» alene står.
  const cite = para(R`See [1] and {\b bold} text.`);
  assert.deepEqual(await collect(cite), ["See [1] and ⟦1⟧bold⟦/1⟧ text."]);
  assert.equal((await applyFull(cite, ["Se [1] og ⟦1⟧fet⟦/1⟧ tekst."])).out, para(R`Se [1] og {\b fet} tekst.`));
  for (const t of ["Se [1] og [1]fet[/1] tekst.", "Se [1] og [ 1 ]fet[ /1 ] tekst."]) {
    const { out, warnings } = await applyFull(cite, [t]);
    assert.equal(out, para(R`Se [1] og {\b fet} tekst.`), t);
    assert.deepEqual(warnings, [], t);
  }
  // Uten par er [1] tekst (og merket er borte: grunnformatet, én advarsel).
  assert.equal((await applyFull(cite, ["Se [1] og fet tekst [1]."])).out, para(R`Se [1] og fet tekst [1].{\b }`));
  // Har originalen [/ som tekst, er [n] aldri et merke.
  const tags = para(R`Write [b]x[/b] for {\b bold} text.`);
  assert.equal((await applyFull(tags, ["Skriv [b]x[/b] for [1]fet[/1] tekst."])).out, para(R`Skriv [b]x[/b] for [1]fet[/1] tekst.{\b }`));

  // Ødelagte merker: alt i grunnformatet, rester av merker fjernes (også ⟦x⟧ og løse ⟦), ett mellomrom blir igjen.
  for (const [t, body] of [
    ["Den ⟦1⟧røde bilen ⟦x⟧.", R`Den r§248?de bilen x.{\b }`],
    ["Den røde ⟦ bilen⟧.", R`Den r§248?de bilen.{\b }`],
    ["Den ⟦1⟧ røde ⟦/2⟧ bilen.", R`Den r§248?de bilen.{\b }`],
  ]) {
    const { out, warnings } = await applyFull(red, [t]);
    assert.equal(out, para(body), t);
    assert.deepEqual(warnings.map((w) => w.code), ["markers_lost"], t);
    assert.match(warnings[0].message, /^Ett avsnitt fikk enklere formatering/);
  }
  // Én advarsel for hele filen, med antall avsnitt. Et avsnitt der alle merkene er borte, teller også.
  const three = R`{\rtf1\ansi\deff0{\fonttbl{\f0 Times;}}\pard The {\b red} car.\par\pard A {\i blue} boat.\par\pard Plain.\par}`;
  const lost = await applyFull(three, ["Den ⟦1⟧røde bilen.", "En blå båt.", "Vanlig ⟦1⟧x⟦/1⟧."]);
  assert.equal(lost.out, R`{\rtf1\ansi\deff0{\fonttbl{\f0 Times;}}\pard Den r§248?de bilen.{\b }\par\pard En bl§229? b§229?t.{\i }\par\pard Vanlig x.\par}`);
  assert.deepEqual(lost.warnings.map((w) => w.message.slice(0, 40)), ["2 avsnitt fikk enklere formatering: over"]);

  // Bare merker og mellomrom: som en tom oversettelse står avsnittet urørt.
  for (const t of ["⟦1⟧⟦/1⟧", "⟦1⟧ ⟦/1⟧", " ⟦2⟧", "⟦ 1 ⟧", "[1][/1]"]) assert.equal(await applyWith(red, [t]), red, t);

  // Hele veien gjennom grok.js: modellen skriver ⟦ 1 ⟧ … ⟦ /1 ⟧, resultatet blir som med riktige merker.
  const upper = await translate(WORD);
  mock.setMode("spacedmarks");
  const res = await core.translateBuffer(rtf(WORD), ".rtf", ctx());
  assert.equal(res.buffer.toString("latin1"), upper);
  assert.deepEqual(res.warnings, []);
});

test("RTF: mellomrom ved ankre står på samme side som i originalen, også når modellen tar dem bort", async () => {
  // Anker til slutt i avsnittet med mellomrom på begge sider: mellomrommet og tab-en etter bildet står urørt.
  assert.equal(await translate(para(R`Our logo {\pict\pngblip 89} \tab`)), para(R`NB:OUR LOGO {\pict\pngblip 89} \tab`));
  // Modellen tar bort mellomrommene inni merket ved bildet og fotnoten: de settes inn igjen.
  const click = para(R`Click the {\pict\pngblip 89} icon now.`);
  assert.deepEqual(await collect(click), ["Click the ⟦1⟧ icon now.⟦/1⟧"]);
  assert.equal(await applyWith(click, ["KLIKK PÅ⟦1⟧IKONET NÅ.⟦/1⟧"]), para(R`KLIKK P§197? {\pict\pngblip 89} IKONET N§197?.`));
  const fn = para(R`The study{\super\chftn}{\footnote\pard Note.} found it.`);
  const note = R`{\super\chftn}{\footnote\pard Merknad.}`;
  assert.equal(await applyWith(fn, ["Studien⟦1⟧fant det.⟦/1⟧", "Merknad."]), para(`Studien${note} fant det.`));
  assert.equal(await applyWith(fn, ["Studien ⟦1⟧fant det.⟦/1⟧", "Merknad."]), para(`Studien${note} fant det.`));
  // Men aldri et mellomrom foran tegnsetting.
  assert.equal(await applyWith(fn, ["Studien⟦1⟧, fant det.⟦/1⟧", "Merknad."]), para(`Studien${note}, fant det.`));
  // Mellomrom foran et bilde først i avsnittet står urørt foran bildet; teksten etter trenger da ikke merke.
  const caption = para(R`  {\pict\pngblip 89} Caption text here`);
  assert.deepEqual(await collect(caption), ["Caption text here"]);
  assert.equal(await applyWith(caption, ["Bildetekst her"]), para(R`  {\pict\pngblip 89} Bildetekst her`));
  // Mellomrom på begge sider av ankeret, det ene i kanten av en uthevet run: ingen ekstra mellomrom.
  for (const body of [R`Plain words before the picture here {\pict\pngblip 89}{\i  italic caption}`,
    R`{\b Bold heading }{\pict\pngblip 89} plain words after the picture here.`,
    R`Different depth: {\b {\*\bkmkstart X} bold words}{\*\bkmkend X} and plain.`]) {
    const doc = para(body);
    assert.equal(await applyWith(doc, await collect(doc)), doc, body);
  }
  // Samme i et avsnitt med uthevet tekst: tab-en står foran ankeret, teksten havner etter det.
  const tab = para(R`{\b \tab{\super 1}{\super\chftn}{\footnote\pard Note.}Text after} and {\i more}.`);
  const upper = await applyWith(tab, (await collect(tab)).map((x) => x.toUpperCase()));
  assert.ok(upper.includes(R`\pard {\b \tab{\super 1}{\super\chftn}{\footnote\pard NOTE.}TEXT AFTER`), upper);
});

// Tab, linjeskift og mellomrom alene inntil et anker (bilde, symbol, fotnotemerke) står på samme side av ankeret og
// med formatet sitt: en perfekt oversettelse gir samme fil.
const NEAR_ANCHORS = [
  R`Figure one shows the full result {\pict\pngblip 89}\line {\i Source: our own survey}`,
  R`Plain words here and {\ul Name}\tab {\pict\pngblip 89} caption words.`,
  R`Many plain words here {\strike old price}\tab {\super\chftn}{\footnote\pard Note.} new price follows.`,
  R`Many plain words here {\ul underlined words} {\super\chftn}{\footnote\pard Note.} more text follows.`,
  R`The main claim of the paper{\super\chftn}{\footnote\pard Note.}\line {\i Second line in italics here}`,
  R`Checked items are marked {\f5\'fe}\uc0§8232 {\b Next line in bold}`,
  R`Checked items are marked {\f5\'fe}§8232?{\b Next line in bold}`,
  R`Some text here {\pict\pngblip 89}\line {\b Next line in bold} and more.`,
  R`A picture {\pict\pngblip 89} {\i caption in italics} and plain words after it.`,
  // Mellomrom og linjeskift i hver sin run (\uc0 deler dem) regnes sammen.
  R`Words before the mark {\f5\'fe}  \uc0§8232 {\i next line in italics}`,
  R`Words before the mark {\f5\'fe} {\*\bkmkstart b4}  \uc0§8232 {\i next line in italics}`,
];

test("RTF: tab, linjeskift og mellomrom inntil et anker blir på sin side av ankeret, med sitt format", async () => {
  const sym = (body) => R`{\rtf1\ansi\deff0{\fonttbl{\f0 Times;}{\f5\fnil\fcharset2 Wingdings;}}\pard ` + body + R`\par}`;
  for (const body of NEAR_ANCHORS) {
    const doc = sym(body);
    const strings = await collect(doc);
    assert.equal(await applyWith(doc, strings), doc, body);
    assert.ok(strings.every((s) => !/^\s|\s$/.test(s)), body);
  }
  // Med falsk oversettelse: linjeskiftet står fortsatt etter bildet, tab-en utenfor understrekingen.
  const out = await translate(sym(NEAR_ANCHORS[0]));
  assert.ok(out.includes(R`NB:FIGURE ONE SHOWS THE FULL RESULT {\pict\pngblip 89}\line {\i SOURCE: OUR OWN SURVEY}`), out);
  const ul = await translate(sym(NEAR_ANCHORS[1]));
  assert.ok(ul.includes(R`{\ul NAME}\tab {\pict\pngblip 89} CAPTION WORDS.`), ul);
  // Ugyldige merker: når merkene fjernes, blir siden med tab eller linjeskift stående.
  const form = sym(R`Signature {\ul\tab\tab\tab}\tab Date {\ul\tab\tab}`);
  assert.deepEqual(await collect(form), ["Signature ⟦1⟧\tDate ⟦/1⟧"]);
  assert.equal(await applyWith(form, ["Signatur ⟦1⟧\tDato"]), sym(R`Signatur\tab Dato{\ul\tab\tab\tab}{\ul\tab\tab}`));
  const line = sym(R`Caption text {\pict\pngblip 89}\line Second line here`);
  assert.deepEqual(await collect(line), ["Caption text ⟦1⟧\nSecond line here⟦/1⟧"]);
  assert.equal(await applyWith(line, ["Bildetekst ⟦1⟧\nAndre linje her"]), sym(R`{\pict\pngblip 89}Bildetekst\line Andre linje her`));
  assert.equal(await applyWith(line, ["Bildetekst \n⟦1⟧ Andre linje her"]), sym(R`{\pict\pngblip 89}Bildetekst \line Andre linje her`));
  // Tab-er sist i avsnittet stod inni merket: de blir stående også når modellen mister merket.
  const tabs = sym(R`Plain words here {\pict\pngblip 89}\tab after the picture\tab\tab`);
  assert.deepEqual(await collect(tabs), ["Plain words here ⟦1⟧\tafter the picture\t\t⟦/1⟧"]);
  for (const t of ["Vanlige ord her ⟦1⟧\tetter bildet\t\t", "Vanlige ord her \tetter bildet\t\t "]) {
    assert.equal((await applyWith(tabs, [t])).match(/\\tab/g).length, 3, t);
  }
});

test("RTF: teksten etter et anker blir etter ankeret, også når en run med bare mellomrom i samme format står foran", async () => {
  // «{\b fet} {\b fet}{fotnote} vanlig»: mellomrommet mellom de fete ordene har samme format som teksten etter
  // fotnoten, men teksten skal ikke dit (verken med perfekt eller falsk oversettelse).
  const note = R`{\super\chftn}{\footnote\pard Note.}`;
  const fakeNote = R`{\super\chftn}{\footnote\pard NB:NOTE.}`;
  for (const [body, tail, fakeTail] of [
    [R`{\b The bold statement is long} {\b and continues}${note}see page two`, `${note}see page two`, `${fakeNote}SEE PAGE TWO`],
    [R`{\b Section five of the agreement}\tab {\b Scope}${note} (draft)`, `${note} (draft)`, `${fakeNote} (DRAFT)`],
    [R`{\i Figure 3: results} {\i of the survey}{\pict\pngblip 89} (source: NSD)`, R`{\pict\pngblip 89} (source: NSD)`, R`{\pict\pngblip 89} (SOURCE: NSD)`],
  ]) {
    const doc = para(body);
    const strings = await collect(doc);
    const out = await applyWith(doc, strings);
    assert.ok(out.endsWith(tail + R`\par}`), out);
    assert.deepEqual(await collect(out), strings, body);
    const fake = await translate(doc);
    assert.ok(fake.endsWith(fakeTail + R`\par}`), fake);
  }
});

test("RTF: U+2028 (Cocoa) er linjeskift; lange avsnitt deles ved linjeskift etter setningsslutt, så én merkefeil bare rammer sin del", async () => {
  assert.deepEqual(await collect(LINES), ["Dear Kari,\nthanks for the ⟦1⟧letter⟦/1⟧.\nBest wishes"]);
  const out = await translate(LINES);
  // \uc0 (usynlig) står nå etter teksten i run-en foran; teksten der er skrevet med run-ens egen \ucN.
  assert.ok(out.includes(R`\cf0 NB:DEAR KARI,\line THANKS FOR THE \uc0\f1\b LETTER\f0\b0 .\line BEST WISHES\uc0` + "\\"), out);
  assert.ok(await valid(out));

  // Et helt dokument skrevet med U+2028 (som Apples egne): deles i biter på rundt 1000 tegn ved et linjeskift.
  const line = (i) => R`Line ${i} has some words and a {\b bold ${i}} part that should stay bold.\uc0§8232 `;
  const long = R`{\rtf1\ansi{\fonttbl{\f0 Helvetica;}}\pard ` + Array.from({ length: 60 }, (_, i) => line(i)).join("") + R`\par}`;
  const strings = await collect(long);
  assert.ok(strings.length >= 3, `${strings.length} biter`);
  assert.ok(strings.every((s) => s.length < 1200));
  assert.equal(strings.join("\n").split("\n").length, 60);
  // Modellen ødelegger merkene i første bit: bare den biten mister fet skrift.
  const translations = strings.map((s, k) => (k === 0 ? s.replace(/⟦\/1⟧/, "") : s));
  const { out: broken, warnings } = await applyFull(long, translations);
  assert.ok(await valid(broken));
  const bold = (s) => (s.match(/\{\\b bold \d+\}/g) || []).length;
  const firstLines = strings[0].split("\n").length;
  assert.equal(bold(broken), 60 - firstLines);
  assert.deepEqual(warnings.map((w) => w.message.slice(0, 11)), ["Ett avsnitt"]);
});

test("RTF: et langt avsnitt deles bare ved linjeskift etter setningsslutt eller ved to linjeskift (ellers etter 5000 tegn)", async () => {
  // Hardt ombrutt tekst (PDF → Word, e-post i TextEdit): linjeskift midt i setninger.
  const words = "the committee reviewed the proposal and decided that the budget for the next year should be increased by ten percent because costs have risen".split(" ");
  const wrapped = (chars, end = "") => {
    const lines = [];
    let line = "";
    for (let i = 0, n = 0; n < chars; i++) {
      line += (line ? " " : "") + words[i % words.length];
      if (line.length > 70) {
        lines.push(line);
        n += line.length + 1;
        line = "";
      }
    }
    return lines.join(R`\line `) + end;
  };
  const one = await collect(para(wrapped(1500, ".")));
  assert.equal(one.length, 1, "ingen setningsslutt ved et linjeskift: ett avsnitt");
  // En setning slutter ved et linjeskift etter 1000 tegn (også med anførselstegn etter punktumet): delt der.
  for (const [stop, text] of [[".", "."], [R`.\rdblquote `, ".”"], ["?)", "?)"], [R`!§8217?`, "!’"]]) {
    const two = await collect(para(wrapped(1100) + stop + R`\line ` + wrapped(400, ".")));
    assert.equal(two.length, 2, stop);
    assert.ok(two[0].endsWith(`s${text}`) && two[1].startsWith("the committee"), two[0].slice(-20));
  }
  // Men ikke etter en forkortelse.
  for (const abbr of ["e.g.", "Mr.", "f.eks.", "bl.a."]) {
    assert.equal((await collect(para(wrapped(1100) + ` ${abbr}` + R`\line ` + wrapped(400, ".")))).length, 1, abbr);
  }
  // To linjeskift (tomt linje) etter 1000 tegn: delt der.
  const blank = await collect(para(wrapped(1100) + R`\line\line ` + wrapped(400, ".")));
  assert.equal(blank.length, 2);
  // Uten setningsslutt: delt ved første linjeskift etter 5000 tegn; ingen bokstaver går tapt.
  const huge = await collect(para(wrapped(7000, ".")));
  assert.equal(huge.length, 2);
  assert.ok(huge[0].length >= 5000 && huge[0].length < 5100, `${huge[0].length}`);
  assert.equal(huge.join(" ").replace(/\s+/g, " "), wrapped(7000, ".").replace(/\\line /g, " ").replace(/\s+/g, " "));
});

test("RTF: \\softline, \\softpage og \\softcol er ikke linjeskift: ordet står urørt, Grok får et mellomrom", async () => {
  const soft = para(R`First line\softline second line and \softpage third\softcol end`);
  assert.deepEqual(await collect(soft), ["First line second line and third end"]);
  const out = await translate(soft);
  assert.equal(out, para(R`\softline NB:FIRST LINE SECOND LINE AND THIRD END\softpage \softcol `));
  assert.ok(!out.includes(R`\line`));
  // En perfekt oversettelse gir samme tekst og de samme kontrollordene (ingen \line).
  const same = await applyWith(soft, await collect(soft));
  assert.equal(same.match(/\\soft\w+/g).join(), R`\softline,\softpage,\softcol`.replace(/\\/g, "\\"));
  assert.ok(!same.includes(R`\line`));
  assert.deepEqual(await collect(same), await collect(soft));
});

test("RTF: bokmerker er ankre og står rundt de samme ordene", async () => {
  const doc = para(R`See {\*\bkmkstart ref1}chapter two{\*\bkmkend ref1} for more details.`);
  assert.deepEqual(await collect(doc), ["See ⟦1⟧chapter two⟦/1⟧ for more details."]);
  assert.equal(await translate(doc), para(R`NB:SEE {\*\bkmkstart ref1}CHAPTER TWO{\*\bkmkend ref1} FOR MORE DETAILS.`));
  // Bokmerke rundt hele avsnittet (overskrift i innholdsfortegnelsen): ingen merker trengs.
  const heading = para(R`{\*\bkmkstart _Toc1}Heading text{\*\bkmkend _Toc1}`);
  assert.deepEqual(await collect(heading), ["Heading text"]);
  assert.equal(await translate(heading), para(R`{\*\bkmkstart _Toc1}NB:HEADING TEXT{\*\bkmkend _Toc1}`));
  // Et tomt bokmerke (Words _GoBack: start rett fulgt av slutten) markerer bare et punkt: ingen merker, ingen advarsel
  // når modellen skriver setningen om, og bokmerket blir i avsnittet.
  const goBack = para(R`The quick brown{\*\bkmkstart _GoBack}{\*\bkmkend _GoBack} fox jumps over the dog.`);
  assert.deepEqual(await collect(goBack), ["The quick brown fox jumps over the dog."]);
  const { out, warnings } = await applyFull(goBack, ["Den raske brune reven hopper over hunden."]);
  assert.deepEqual(warnings, []);
  assert.equal(out, para(R`{\*\bkmkstart _GoBack}{\*\bkmkend _GoBack}Den raske brune reven hopper over hunden.`));
  // Start og slutt med ulike navn, eller tekst mellom, er fortsatt ankre.
  assert.deepEqual(await collect(para(R`The quick brown{\*\bkmkstart A}{\*\bkmkend B} fox jumps.`)), ["The quick brown⟦1⟧ fox jumps.⟦/1⟧"]);
  assert.deepEqual(await collect(para(R`Brown{\*\bkmkstart A}{\pict\pngblip 89}{\*\bkmkend A} fox jumps.`)), ["Brown⟦1⟧ fox jumps.⟦/1⟧"]);
});

test("RTF: over 6 formater og fotnoter: fotnotemerkene får merke først og flytter seg ikke", async () => {
  const doc = para(R`A {\b b1} c {\i i1} d {\ul u1} e {\cf2 red} f {\scaps blue} g {\strike st} h{\super\chftn}{\footnote\pard N1.} after first note and more{\super\chftn}{\footnote\pard N2.} after second note end.`);
  assert.deepEqual(await collect(doc), [
    "A ⟦1⟧b1⟦/1⟧ c ⟦2⟧i1⟦/2⟧ d ⟦3⟧u1⟦/3⟧ e ⟦4⟧red⟦/4⟧ f ⟦5⟧blue⟦/5⟧ g st h⟦6⟧ after first note and more⟦/6⟧ after second note end.",
    "N1.",
    "N2.",
  ]);
  const out = await translate(doc);
  assert.ok(out.includes(R`G ST H{\strike }{\super\chftn}{\footnote\pard NB:N1.} AFTER FIRST NOTE AND MORE{\super\chftn}{\footnote\pard NB:N2.} AFTER SECOND NOTE END.`), out);
});

test("RTF: flere enn 6 merker: formatene fra nr. 6 blir vanlig tekst, men fotnotemerker flytter seg aldri", async () => {
  // Fotnote etter et ord i format nr. 7: teksten før og etter får da samme format, og strekket etter får merke.
  const fn7 = para(R`a {\b bb} c {\i dd} e {\ul ff} g {\strike hh} i {\cf1 jj} k {\scaps ll} m {\outl nn}{\super\chftn}{\footnote\pard Note.} after the note end.`);
  assert.deepEqual(await collect(fn7), ["a ⟦1⟧bb⟦/1⟧ c ⟦2⟧dd⟦/2⟧ e ⟦3⟧ff⟦/3⟧ g ⟦4⟧hh⟦/4⟧ i ⟦5⟧jj⟦/5⟧ k ll m nn⟦6⟧ after the note end.⟦/6⟧", "Note."]);
  assert.ok((await translate(fn7)).includes(R`M NN{\scaps }{\outl }{\super\chftn}{\footnote\pard NB:NOTE.} AFTER THE NOTE END.`));
  // 16 fotnoter og to formater: strekkene deler de fire plassene som er igjen (samme nummer brukes igjen lenger ut).
  const notes = Array.from({ length: 16 }, (_, i) => R`word${i}{\super\chftn}{\footnote\pard N${i}.} `).join("");
  const many = para(R`{\b Bold} {\i italic} ` + notes + "end.");
  const [body] = await collect(many);
  assert.equal(new Set(body.match(/⟦\d⟧/g)).size, 6);
  assert.equal(await applyWith(many, await collect(many)), many, "perfekt oversettelse: samme fil");
  const upper = await applyWith(many, (await collect(many)).map((x) => x.toUpperCase()));
  for (let i = 0; i < 16; i++) assert.ok(upper.includes(R`WORD${i}{\super\chftn}{\footnote\pard N${i}.} `), `note ${i}`);
});

test("RTF: tegnsetting med mellomrom i et format uten ord («•\t», « - », « <») står urørt, med formatet sitt", async () => {
  // TextEdit: punkt skrevet som tekst (•, tab) foran fet tekst.
  const bullet = R`{\rtf1\ansi\ansicpg1252\cocoartf2907{\fonttbl\f0\fswiss\fcharset0 Helvetica-Bold;\f1\fswiss\fcharset0 Helvetica;}\pard\f1\b0 \'95\tab \f0\b Bold item text here\f1\b0 \par}`;
  assert.deepEqual(await collect(bullet), ["Bold item text here"]);
  assert.ok((await translate(bullet)).includes(R`\pard\f1\b0 \'95\tab \f0\b NB:BOLD ITEM TEXT HERE\f1\b0 \par}`));
  for (const body of [R`Python (dateutil{\b  - }Extensions) and more words here.`, R`Lead Developers{\b  <}dev@example.com{\b >} and more words.`]) {
    const doc = para(body);
    assert.equal(await applyWith(doc, await collect(doc)), doc, body);
  }
  assert.ok((await translate(para(R`Python (dateutil{\b  - }Extensions) and more.`))).includes(R`DATEUTIL{\b  - }EXTENSIONS) AND MORE.`));
  // Bare mellomrom mellom to uthevede ord får ikke formatet til noen av dem.
  const two = para(R`Plain words and {\b bold} {\i italic} words.`);
  assert.equal(await applyWith(two, await collect(two)), two);
});

test("RTF: Cocoa-farger som bare skiller seg i gjennomsiktighet (\\expandedcolortbl), er ulike formater", async () => {
  const doc = [
    R`{\rtf1\ansi\ansicpg1252\cocoartf2638`,
    R`{\fonttbl\f0\fswiss\fcharset0 Helvetica;}`,
    R`{\colortbl;\red255\green255\blue255;\red0\green0\blue0;\red0\green0\blue0;\red0\green0\blue0;\red127\green127\blue127;}`,
    R`{\*\expandedcolortbl;;\cssrgb\c0\c0\c0\cname textColor;\cssrgb\c0\c0\c0\c24706\cname tertiaryLabelColor;\cssrgb\c0\c0\c0\c49804\cname secondaryLabelColor;\csgenericrgb\c49804\c49804\c49804;}`,
    R`\pard\f0\fs24 \cf2 Charles Kerr, main developer and maintainer\cf3  \cf4 (GNOME adaptation of main icon)\cf5  grey\par}`,
  ].join("\n");
  assert.deepEqual(await collect(doc), ["Charles Kerr, main developer and maintainer ⟦1⟧(GNOME adaptation of main icon)⟦/1⟧ ⟦2⟧grey⟦/2⟧"]);
  const out = await translate(doc);
  // Teksten i den halvt gjennomsiktige fargen blir i sin run (ikke i mellomrommet i den lysere fargen foran).
  assert.match(out, /\\cf3 \\cf4 \(GNOME ADAPTATION OF MAIN ICON\) ?\\cf5  ?GREY\\par\}/);
  // Uten gjennomsiktighet er svart fortsatt automatisk farge (samme format som \cf0).
  const plain = doc.replace(R`\c24706`, "").replace(R`\c49804\cname`, R`\cname`);
  assert.deepEqual(await collect(plain), ["Charles Kerr, main developer and maintainer (GNOME adaptation of main icon) ⟦1⟧grey⟦/1⟧"]);
});

test("RTF: vedlegg i Cocoas RTFD (\\NeXTGraphic) er et anker: filnavnet sendes ikke, og ingen tekst havner i vedlegget", async () => {
  const doc = [
    R`{\rtf1\ansi\ansicpg1252\cocoartf2761`,
    R`{\fonttbl\f0\fswiss\fcharset0 Helvetica;\f1\fswiss\fcharset0 Helvetica-Bold;}`,
    R`\pard\f0\fs24 \cf0 {{\NeXTGraphic Pasted Graphic.png \width1280 \height1280 \appleattachmentpadding0 \appleembedtype0 \appleaqc`,
    R`}\uc0§8203 `,
    R`}Figure one shows the \f1\b results\f0\b0  of the test.` + "\\",
    R`Here is the picture: {{\NeXTGraphic Attachment.png \width320 \height320 \appleattachmentpadding0 \appleembedtype0 \appleaqc`,
    R`}\'ac} and the text after it.` + "\\",
    R`}`,
  ].join("\n");
  const strings = await collect(doc);
  assert.deepEqual(strings, ["Figure one shows the ⟦1⟧results⟦/1⟧ of the test.", "Here is the picture: ⟦1⟧ and the text after it.⟦/1⟧"]);
  const out = await translate(doc);
  assert.ok(out.includes(R`\appleaqc` + "\n" + R`}\uc0§8203 ` + "\n" + R`}NB:FIGURE ONE SHOWS THE \f1\b RESULTS\f0\b0  OF THE TEST.`), out);
  assert.ok(out.includes(R`NB:HERE IS THE PICTURE: {{\NeXTGraphic Attachment.png \width320`), out);
  assert.ok(out.includes(R`}\'ac} AND THE TEXT AFTER IT.`), out);
  assert.equal(await applyWith(doc, strings), doc, "perfekt oversettelse: samme fil");
});

test("RTF: tekst mellom \\* og kontrollordet (skadet fil) er et anker: den sendes ikke, og ingen oversettelse havner der", async () => {
  // Word og vi hopper over gruppen; teksten i den skal ikke få oversettelsen av avsnittet (den ville blitt borte).
  const star = R`{\rtf1\ansi{\fonttbl{\f0 Times;}}{\*\\u-3913?expandedcolortbl;;\cssrgb\c0\c0\c0;}\pard Line one\line Line {\b two}\line Line three\par}`;
  assert.deepEqual(await collect(star), ["Line one\nLine ⟦1⟧two⟦/1⟧\nLine three"]);
  const out = await translate(star);
  assert.ok(out.includes(R`{\*\\u-3913?expandedcolortbl;;\cssrgb\c0\c0\c0;}\pard NB:LINE ONE\line LINE {\b TWO}\line LINE THREE\par}`), out);
  // \* midt i et avsnitt fulgt av tekst: teksten står urørt.
  const mid = R`{\rtf1\ansi{\fonttbl{\f0 Times;}}\pard Some words here \*l\partightenfactor0 more words\par}`;
  const strings = await collect(mid);
  assert.ok(strings.every((x) => !/\bl\b/.test(x)), JSON.stringify(strings));
  assert.ok((await translate(mid)).includes(R`\*l\partightenfactor0`));
});

test("RTF: minnevakten gir samme svar for samme fil, uansett hva som er lest før (innsamling og innlegging må være enige)", () => {
  const { parseRtf } = require("../src/formats/rtf");
  const doc = rtf(para(Array.from({ length: 200 }, (_, i) => R`{\b w${i}} plain words `).join("")));
  const fresh = parseRtf(doc).memory;
  // Et avsnitt med mange run-er først (kladden vokser), deretter samme fil igjen, også uten kildetekst (innlegging).
  parseRtf(rtf(para(R`{\b a}`.repeat(3000))));
  assert.deepEqual(parseRtf(doc).memory, fresh);
  assert.deepEqual(parseRtf(doc, { keepCore: false }).memory, fresh);
  assert.ok(fresh.collect > doc.length && fresh.apply > 2 * doc.length);
});

test("RTF: tette avsnitt med mange uthevede ord plasseres riktig og raskt", async () => {
  for (const [words, paras] of [[1000, 10], [3000, 2]]) {
    let body = "";
    for (let i = 0; i < words; i++) body += R`{\b w${i}} plain words `;
    const doc = R`{\rtf1\ansi ` + R`\pard ${body}\par`.repeat(paras) + "}";
    const strings = await collect(doc);
    const t0 = Date.now();
    const out = await applyWith(doc, strings.map((s) => s.toUpperCase()));
    const ms = Date.now() - t0;
    assert.ok(ms < 5000, `${ms} ms`);
    for (let i = 0; i < words; i += 97) assert.ok(out.includes(R`{\b W${i}} PLAIN WORDS `), `w${i}`);
    assert.equal((out.match(/\{\\b W\d+\}/g) || []).length, words * paras);
  }
});

// Minnet: Workeren har 128 MB i alt, JS-heap og buffere (innfil, utfil, typede tabeller) sammen. For enhver fil
// vakten slipper gjennom (25 MB er maks opplasting) skal levende minne (heapUsed + arrayBuffers etter GC, med ca. 20 MB
// til selve kjøringen) holde seg under 100 MB ved analysen/innsamlingen og under 110 MB ved innleggingen. Målt der
// minnet er størst: når strengene går inn i og kommer ut av translateStrings, i planBatches (analysen ved
// opplasting) og når utfilen lages. Oversettelsene er 30 % lengre enn originalen og flate strenger fra JSON med ’
// (2 byte per tegn), som i Workerens siste steg. Mellom stegene får minnet tid til å bli gitt tilbake (i Workeren er de egne kall). Filer som
// ville sprengt minnet, avvises allerede ved analysen, med norsk melding. Kjøres i en egen prosess.
test("RTF: minnet holder seg under 100 MB ved innsamling og 110 MB ved innlegging for alt vakten slipper gjennom", { timeout: 300000 }, () => {
  const script = `
    const MB = 1048576;
    const grok = require(${JSON.stringify(path.join(__dirname, "../src/grok"))});
    const peak = { analyze: 0, collect: 0, apply: 0 };
    let phase = "";
    const probe = () => {
      if (!phase) return;
      global.gc();
      const m = process.memoryUsage();
      peak[phase] = Math.max(peak[phase], (m.heapUsed + m.arrayBuffers) / MB);
    };
    // Venter til minne som er gitt fri, faktisk er gitt tilbake (typede tabeller frigjøres litt etter GC).
    async function settle() {
      let last = Infinity;
      for (let t = 0; t < 30; t++) {
        global.gc();
        const ab = process.memoryUsage().arrayBuffers;
        if (ab >= last) break;
        last = ab;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // Målepunktene settes før rtf.js brukes (core henter translateStrings og planBatches ved lasting).
    const translateStrings = grok.translateStrings;
    grok.translateStrings = async (c) => {
      probe();
      const res = await translateStrings(c);
      probe();
      return res;
    };
    const planBatches = grok.planBatches;
    grok.planBatches = (strings) => {
      const res = planBatches(strings);
      probe();
      return res;
    };
    const allocUnsafe = Buffer.allocUnsafe;
    Buffer.allocUnsafe = (n) => {
      const b = allocUnsafe.call(Buffer, n);
      if (n > MB) probe();
      return b;
    };
    const core = require(${JSON.stringify(path.join(__dirname, "../src/core"))});
    const rtf = require(${JSON.stringify(path.join(__dirname, "../src/formats/rtf"))});
    const B = String.fromCharCode(92);
    const w = (s) => s.split("@").join(B);
    // Fyller opp til 25 MB med et bilde (innfilen teller med), eller lager bare enheter.
    function build(head, unit, count, pad = true) {
      const parts = [head];
      let size = head.length;
      for (let i = 0; i < count && size < 25 * MB; i++) {
        const p = unit(i);
        parts.push(p);
        size += p.length;
      }
      if (pad) {
        const line = "0123456789abcdef".repeat(8) + String.fromCharCode(13, 10);
        parts.push(w("{@*@shppict{@pict@pngblip "), line.repeat(Math.max(0, Math.floor((25 * MB - size - 40) / line.length))), "}}");
      }
      parts.push(w("@par}"));
      return Buffer.from(parts.join(""), "latin1");
    }
    const HEAD = w("{@rtf1@ansi@ansicpg1252@uc1@deff0{@fonttbl{@f0@froman@fcharset0 Times New Roman;}{@f1@fswiss@fcharset0 Arial;}}{@colortbl;@red0@green0@blue0;@red192@green0@blue0;}@sectd ");
    const WORD = [
      (i) => "@pard@plain @ql @f0@fs24 {@rtlch@fcs1 @af0 @ltrch@fcs0 @insrsid1 This is paragraph " + i + " with @'e6@'f8@'e5 letters and a longer sentence.}{@rtlch@fcs1 @af0 @ltrch@fcs0 @b@insrsid2  Bold tail}{@rtlch@fcs1 @af0 @ltrch@fcs0 @insrsid1  and normal again.@par }",
      (i) => "@pard@plain @f0@fs24 {@insrsid1 The study " + i + " found}{@super@insrsid1 @chftn {@footnote @pard@plain @f0@fs20 {@super @chftn }{@insrsid1  Footnote text " + i + ".}}}{@insrsid1  that the {@i results} were {@cf2 clear} in all groups.@par }",
      (i) => "@trowd@trgaph108@cellx4000@cellx8000 @pard@intbl {@insrsid1 Cell text " + i + "@cell Other cell with words@cell }@pard@intbl {@row }",
      (i) => "@pard {@insrsid1 See }{@field{@*@fldinst {HYPERLINK " + '"https://example.com/"' + "}}{@fldrslt {@ul@cf2 our website}}}{@insrsid1  for details on page }{@field{@*@fldinst PAGE}{@fldrslt 3}}{@insrsid1 .@par }",
    ];
    const CELLS = ["Ja", "Nei", "Oslo", "Bergen", "Open", "Paid", "Due", "Red"];
    const SHAPES = {
      // Tekstrik Word-RTF: fire slags avsnitt (fet hale, fotnote, tabell, lenke og sidetall), så mye vakten slipper
      // gjennom (resten av filen er et bilde), og 25 MB av den (for mye når oversettelsen kan bli 30 % lengre).
      word: () => build(HEAD, (i) => w(WORD[i % 4](i)) + String.fromCharCode(13, 10), 102000),
      word25: () => build(HEAD, (i) => w(WORD[i % 4](i)) + String.fromCharCode(13, 10), Infinity, false),
      // Mange korte avsnitt og tabellceller, så mange vakten slipper gjennom (resten av filen er et bilde) …
      paras: () => build(HEAD, (i) => w("@pard Ja " + (i % 10) + "@par") + String.fromCharCode(10), 465000),
      cells: () => build(HEAD, (i) => (i % 8 ? "" : w("@trowd@cellx1000@cellx2000@cellx3000@cellx4000@cellx5000@cellx6000@cellx7000@cellx8000")) + w("@intbl " + CELLS[i % 8] + "@cell ") + (i % 8 === 7 ? w("@row") + String.fromCharCode(10) : ""), 465000),
      // … og 25 MB av dem (for mange).
      paras25: () => build(HEAD, (i) => w("@pard Ja " + (i % 10) + "@par") + String.fromCharCode(10), Infinity, false),
      cells25: () => build(HEAD, (i) => (i % 8 ? "" : w("@trowd@cellx1000@cellx2000")) + w("@intbl " + CELLS[i % 8] + "@cell ") + (i % 8 === 7 ? w("@row") : ""), Infinity, false),
      // Én bokstav per run, og felt i felt med lange avsnitt (kladd per nivå).
      runs: () => build(HEAD + w("@pard "), () => w("{@b a}"), Infinity, false),
      nested: () => build(HEAD + w("@pard "), (i) => w("{@field{@*@fldinst HYPERLINK x}{@fldrslt ") + "a{}".repeat(100000), 32) ,
      // Svært mange ulike formater (ny farge i hver run) og en enorm skrifttabell: tabellene regnes med.
      formats: () => build(HEAD + w("@pard "), (i) => w("{@cf" + (i + 3) + " a}") + (i % 100 === 99 ? w("@par ") : ""), 185000),
      formats25: () => build(HEAD + w("@pard "), (i) => w("{@cf" + (i + 3) + " a}") + (i % 100 === 99 ? w("@par ") : ""), Infinity, false),
      fonts: () => build(w("{@rtf1@ansi@deff0{@fonttbl"), (i) => w("{@f" + i + "@fcharset0 Font " + i + ";}"), Infinity, false),
      // 13 MB ren tekst.
      text: () => build(HEAD + w("@pard "), () => "Some words here. ", 800000, false),
    };
    async function collectAndTranslate(buf) {
      const calls = await core.collectStrings(buf, ".rtf");
      const longer = (s) => s.toUpperCase() + " ord".repeat(Math.floor((0.3 * s.length) / 4)) + String.fromCharCode(0x2019);
      return JSON.parse(JSON.stringify(calls.map((c) => c.map(longer))));
    }
    async function run(name) {
      let buf = SHAPES[name]();
      const info = { name, inMB: buf.length / MB };
      await settle();
      phase = "analyze";
      const t0 = Date.now();
      try {
        const a = await core.analyzeBuffer(buf, ".rtf");
        info.segments = a.segments;
      } catch (e) {
        phase = "";
        return { ...info, rejected: e.message, ms: Date.now() - t0 };
      }
      phase = "";
      await settle();
      phase = "collect";
      const translated = await collectAndTranslate(buf);
      phase = "";
      await settle();
      phase = "apply";
      const out = await core.applyTranslations(buf, ".rtf", translated);
      phase = "";
      info.outMB = out.buffer.length / MB;
      info.estimate = rtf.parseRtf(buf).memory;
      return { ...info, ...peak };
    }
    (async () => {
      const results = [];
      for (const name of process.argv.slice(1)) {
        for (const k of Object.keys(peak)) peak[k] = 0;
        results.push(await run(name));
      }
      process.stdout.write(JSON.stringify(results));
    })().catch((e) => { console.error(e.stack || e); process.exit(1); });
  `;
  const shapes = ["word", "paras", "cells", "formats", "word25", "paras25", "cells25", "runs", "nested", "formats25", "fonts", "text"];
  const res = spawnSync(process.execPath, ["--expose-gc", "-e", script, ...shapes], { encoding: "utf8" });
  assert.equal(res.status, 0, String(res.stderr).slice(-2000));
  const results = Object.fromEntries(JSON.parse(res.stdout).map((r) => [r.name, r]));
  const show = (r) => JSON.stringify(r);
  // Godtatt: under grensene i alle steg. Avvist: allerede ved analysen, fort, med norsk melding.
  for (const r of Object.values(results)) {
    assert.ok(r.inMB <= 25.01, show(r));
    assert.ok(r.rejected || (r.analyze > 40 && r.collect > 40 && r.apply > 40), `målepunktene virker: ${show(r)}`);
    if (r.rejected) {
      assert.ok([TOO_BIG, TOO_MUCH_TEXT].includes(r.rejected), show(r));
      assert.ok(r.ms < 10000, show(r));
    } else {
      assert.ok(r.analyze < 100 && r.collect < 100, `innsamling: ${show(r)}`);
      assert.ok(r.apply < 110, `innlegging: ${show(r)}`);
      assert.ok(r.outMB >= r.inMB - 0.1, show(r));
    }
  }
  // Tekstrik Word-RTF og filer med så mange korte avsnitt/celler/formater som får plass (fylt opp til 25 MB), oversettes.
  for (const name of ["word", "paras", "cells", "formats"]) {
    assert.ok(!results[name].rejected, show(results[name]));
    assert.ok(results[name].inMB >= 24.9, show(results[name]));
  }
  assert.ok(results.word.segments > 200000 && results.paras.segments > 450000 && results.cells.segments > 450000);
  // 25 MB tekstrik Word-RTF, bare korte avsnitt, tabellceller, run-er eller formater, felt i felt og en enorm
  // skrifttabell: for mye for minnet. 13 MB tekst: for mye tekst.
  for (const name of ["word25", "paras25", "cells25", "runs", "nested", "formats25", "fonts"]) assert.equal(results[name].rejected, TOO_BIG, name);
  assert.equal(results.text.rejected, TOO_MUCH_TEXT);
  assert.match(TOO_BIG, /^RTF-filen er for stor til å oversettes/);
  assert.match(TOO_MUCH_TEXT, /^RTF-filen har for mye tekst til å oversettes på én gang \(maks 12 MB tekst\)/);
});
