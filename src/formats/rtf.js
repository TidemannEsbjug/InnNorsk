// RTF inn → RTF ut med samme oppsett. Bare teksten byttes; skrift, størrelse, fet/kursiv, farger, tabeller, lister,
// bilder, felt, fotnoter og topp-/bunntekst står urørt, byte for byte.
//
// Enhet = ett avsnitt: tekst fram til \par, \cell, \row, \sect, \page … eller slutten av en topptekst, bunntekst,
// fotnote eller tekstboks. \line og Cocoas linjeskift U+2028 blir "\n", \tab blir "\t". \softline/\softpage/\softcol
// (skift som ikke er påkrevd; vises ikke) står urørt og blir et mellomrom for Grok. Et langt avsnitt deles ved et
// linjeskift etter setningsslutt (ikke etter «Mr.», «f.eks.» o.l.) eller ved to linjeskift (så én merkefeil aldri tar
// formateringen fra et helt dokument skrevet med U+2028), et svært langt ved et hvilket som helst linjeskift, og et
// enormt ved et mellomrom (minne). Et felt med bokstaver i resultatet (lenketekst) deler avsnittet; et felt uten
// bokstaver (sidetall) er et anker.
//
// Formatering: en run er tekst mellom to kontrollord. Run-ene grupperes etter synlig tegnformat (skrift, størrelse,
// fet, kursiv, understreking, gjennomstreking, farge med gjennomsiktighet, utheving, kapitéler, hevet/senket, innsatt
// tekst); kontrollord som ikke endrer utseendet (\insrsid, \strokec, \cf0, svart = automatisk …) teller ikke. Formatet
// med flest bokstaver er avsnittets grunnformat. Ord i et annet format sendes som ⟦1⟧…⟦/1⟧ (grok.js ber Grok beholde
// merkene; høyst 6, resten som vanlig tekst). Ankre midt i avsnittet (fotnotemerke, bilde, symbol, sidetall,
// kommentar, bokmerke rundt tekst, slettet/skjult tekst, hevet tall uten bokstaver, tegnsetting i et format uten ord,
// understreket/uthevet blankt felt, tab/linjeskift/mellomrom alene inntil et anker) står urørt; teksten etter et
// anker merkes så den havner etter ankeret: «The study⟦1⟧ found X⟦/1⟧». Slike merker får plass før formater nr. 6 og
// videre, så fotnotemerker ikke flytter seg. Oversatte biter skrives i run-ene med samme merke, i samme rekkefølge;
// ubrukte run-er tømmes (en run med bare mellomrom får tekst bare når ingen annen passer); mellomrom ved et anker
// settes tilbake på samme side som i originalen. Merkevarianter fra modellen (⟦ 1 ⟧, ⟦１⟧, 〚1〛, [1]…[/1]) rettes; har
// originalen ⟦ ⟧ eller 〚 〛 som tekst, får avsnittet ingen merker. Ugyldige merker → hele teksten i grunnformatet,
// rester av merker fjernes (tab og linjeskift i kantene blir stående), og én advarsel (markers_lost). Tom oversettelse,
// eller bare merker → avsnittet står urørt.
//
// Robusthet og minne: filen leses byte for byte (ingen kopi som streng), run-er ligger i typede tabeller i blokker
// (ingen dobbel kapasitet), innsamling bygger ingen utfil, og utfilen skrives i én buffer med nøyaktig størrelse.
// Innhold etter rotgruppen fjernes, manglende } legges til (etter en avkuttet \, \'h eller \binN); en fil som ikke
// kan repareres, eller som ville sprengt minnet, avvises allerede ved opplasting.
const { translateStrings } = require("../grok");

// Enkeltbyte-tegntabeller for \'hh 0x80–0xFF. Egne tabeller fordi Cloudflare Workers ikke har
// TextDecoder for windows-125x. Flerbyte (932/936/949/950) har ingen tabell: et avsnitt med slike
// \'hh-byter blir stående uoversatt (Word skriver dem også som \uN, og det leses fint).
// Symbolskrift (\fcharset2, Symbol, Wingdings …) er aldri tekst.
const CODEPAGES = {
  874: "€\u0081\u0082\u0083\u0084…\u0086\u0087\u0088\u0089\u008A\u008B\u008C\u008D\u008E\u008F\u0090‘’“”•–—\u0098\u0099\u009A\u009B\u009C\u009D\u009E\u009F\u00A0กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรฤลฦวศษสหฬอฮฯะ\u0E31าำ\u0E34\u0E35\u0E36\u0E37\u0E38\u0E39\u0E3A\uF8C1\uF8C2\uF8C3\uF8C4฿เแโใไๅๆ\u0E47\u0E48\u0E49\u0E4A\u0E4B\u0E4C\u0E4D\u0E4E๏๐๑๒๓๔๕๖๗๘๙๚๛\uF8C5\uF8C6\uF8C7\uF8C8",
  1250: "€\u0081‚\u0083„…†‡\u0088‰Š‹ŚŤŽŹ\u0090‘’“”•–—\u0098™š›śťžź\u00A0ˇ˘Ł¤Ą¦§¨©Ş«¬\u00AD®Ż°±˛ł´µ¶·¸ąş»Ľ˝ľżŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢßŕáâăäĺćçčéęëěíîďđńňóôőö÷řůúűüýţ˙",
  1251: "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ\u00A0ЎўЈ¤Ґ¦§Ё©Є«¬\u00AD®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя",
  1252: "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ\u00A0¡¢£¤¥¦§¨©ª«¬\u00AD®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ",
  1253: "€\u0081‚ƒ„…†‡\u0088‰\u008A‹\u008C\u008D\u008E\u008F\u0090‘’“”•–—\u0098™\u009A›\u009C\u009D\u009E\u009F\u00A0΅Ά£¤¥¦§¨©ª«¬\u00AD®―°±²³΄µ¶·ΈΉΊ»Ό½ΎΏΐΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡ\uFFFDΣΤΥΦΧΨΩΪΫάέήίΰαβγδεζηθικλμνξοπρςστυφχψωϊϋόύώ\uFFFD",
  1254: "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008D\u008E\u008F\u0090‘’“”•–—˜™š›œ\u009D\u009EŸ\u00A0¡¢£¤¥¦§¨©ª«¬\u00AD®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏĞÑÒÓÔÕÖ×ØÙÚÛÜİŞßàáâãäåæçèéêëìíîïğñòóôõö÷øùúûüışÿ",
  1255: "€\u0081‚ƒ„…†‡ˆ‰\u008A‹\u008C\u008D\u008E\u008F\u0090‘’“”•–—˜™\u009A›\u009C\u009D\u009E\u009F\u00A0¡¢£₪¥¦§¨©×«¬\u00AD®¯°±²³´µ¶·¸¹÷»¼½¾¿\u05B0\u05B1\u05B2\u05B3\u05B4\u05B5\u05B6\u05B7\u05B8\u05B9\uFFFD\u05BB\u05BC\u05BD־\u05BF׀\u05C1\u05C2׃װױײ׳״\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFDאבגדהוזחטיךכלםמןנסעףפץצקרשת\uFFFD\uFFFD\u200E\u200F\uFFFD",
  1256: "€پ‚ƒ„…†‡ˆ‰ٹ‹Œچژڈگ‘’“”•–—ک™ڑ›œ\u200C\u200Dں\u00A0،¢£¤¥¦§¨©ھ«¬\u00AD®¯°±²³´µ¶·¸¹؛»¼½¾؟ہءآأؤإئابةتثجحخدذرزسشصض×طظعغـفقكàلâمنهوçèéêëىيîï\u064B\u064C\u064D\u064Eô\u064F\u0650÷\u0651ù\u0652ûü\u200E\u200Fے",
  1257: "€\u0081‚\u0083„…†‡\u0088‰\u008A‹\u008C¨ˇ¸\u0090‘’“”•–—\u0098™\u009A›\u009C¯˛\u009F\u00A0\uFFFD¢£¤\uFFFD¦§Ø©Ŗ«¬\u00AD®Æ°±²³´µ¶·ø¹ŗ»¼½¾æĄĮĀĆÄÅĘĒČÉŹĖĢĶĪĻŠŃŅÓŌÕÖ×ŲŁŚŪÜŻŽßąįāćäåęēčéźėģķīļšńņóōõö÷ųłśūüżž˙",
  1258: "€\u0081‚ƒ„…†‡ˆ‰\u008A‹Œ\u008D\u008E\u008F\u0090‘’“”•–—˜™\u009A›œ\u009D\u009EŸ\u00A0¡¢£¤¥¦§¨©ª«¬\u00AD®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂĂÄÅÆÇÈÉÊË\u0300ÍÎÏĐÑ\u0309ÓÔƠÖ×ØÙÚÛÜƯ\u0303ßàáâăäåæçèéêë\u0301íîïđñ\u0323óôơö÷øùúûüư₫ÿ",
  10000: "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»…\u00A0ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\uF8FFÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ", // Mac Roman (\mac, \fcharset77)
};

// \fcharsetN → tegntabell. null = dokumentets \ansicpg, -1 = symbolskrift (aldri tekst).
const CHARSET_CP = {
  0: 1252, 1: null, 2: -1, 77: 10000, 128: 932, 129: 949, 130: 1361, 134: 936, 136: 950,
  161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250, 255: 437,
};

const NOT_RTF = "Filen er ikke en gyldig RTF-fil (mangler {\\rtf).";
const MB = 1048576;
const MAX_TEXT_MB = 12;
const TOO_MUCH_TEXT = `RTF-filen har for mye tekst til å oversettes på én gang (maks ${MAX_TEXT_MB} MB tekst). Del den i mindre filer.`;
const TOO_BIG = "RTF-filen er for stor til å oversettes på én gang (for mange avsnitt, tabellceller eller formatskift). Del den i mindre filer.";
// Minnet: Workeren har 128 MB i alt (JS-heap + buffere). Målt i Node (heapUsed + arrayBuffers etter GC) går 20–21 MB
// til selve kjøringen; resten skal holde seg under 79 MB ved innsamling/analyse og 89 MB ved innlegging (til sammen
// under 100 og 110 MB), for enhver fil vakten slipper gjennom (test i test/rtf.test.js). Vakten regnes ut mens filen
// leses og avviser allerede ved opplasting, før noe betales. Byte som lever samtidig (J avsnitt, T tegn å oversette):
//  - alltid: innfilen, run-tabellen (11 B per run) og avsnittstabellen (9 B per avsnitt), i blokker på 64K, og
//    tabellene over formater, skrifter og farger (om lag 150 B per format; en fil kan ha svært mange). Tabellene regnes
//    med helt til analysen er ferdig (typede tabeller gis tilbake først etter en stund, og V8 slipper heller ikke
//    alltid de andre med en gang).
//  - innsamling: kildestrengene (16 B hode + 1 eller 2 B per tegn), mens filen leses også kladden for avsnittet som
//    leses (per tekstnivå: fotnote i avsnitt, felt i felt …) og listen over strengene; i translateStrings tre lister
//    med J pekere (8 B) + rekkefølgen (4 B); i analyzeBuffer lager planBatches i tillegg ett objekt per streng (56 B).
//  - innlegging: oversettelsene (inntil 1,3 ganger så lange som originalen, 2 B per tegn, som med ’ eller merker) og
//    kallerens liste over dem, pluss enten fire lister i translateStrings (28 B per avsnitt med rekkefølgen), utfilen
//    (innfilen + den lengre teksten, æøå og typografiske tegn som \uN), svaret fra translateStrings og justeringen (DP)
//    for det største avsnittet med merker, eller (mens filen leses) kladden.
const COLLECT_BUDGET = 79 * MB;
const APPLY_BUDGET = 89 * MB;
const DAMAGED = "RTF-filen er skadet og kan ikke leses.";
const RTF_START = /^(?:\xEF\xBB\xBF)?\s*\{\\rtf/;
const MAX_DEPTH = 10000; // så mange nivåer { } har ingen ekte fil; stopper minnesprengning
const MAX_TAGS = 6;
const TAG = /⟦(\/?)(\d+)⟧/g;
// Merkevarianter fra modellen: mellomrom inni, sifre i full bredde o.l., 〚 〛 i stedet for ⟦ ⟧.
const TAG_VARIANT = /[⟦〚]\s*(\/?)\s*(\p{Nd}{1,3})\s*[⟧〛]/gu;
const TAG_STRAY = /⟦(?!\/?\d+⟧)|(?<!⟦\/?\d+)⟧|[〚〛]/g;
const BRACKET_TAG = /[[［]\s*(\/?)\s*(\p{Nd})\s*[\]］]/gu;
const BRACKET_CLOSE = /[[［]\s*\/\s*\p{Nd}\s*[\]］]/u;
const EDGE_SEP = String.fromCharCode(0);
// Avsnitt over UNIT_SOFT tegn deles ved et linjeskift etter setningsslutt eller ved to linjeskift, over UNIT_BREAK ved
// et hvilket som helst linjeskift, over UNIT_HARD ved et mellomrom og uansett over UNIT_MAX.
const UNIT_SOFT = 1000;
const UNIT_BREAK = 5000;
const UNIT_HARD = 50000;
const UNIT_MAX = 100000;
const SENTENCE_END = new Set([...".!?…。！？"].map((ch) => ch.charCodeAt(0)));
const CLOSERS = new Set([..."\"')]}’”»›"].map((ch) => ch.charCodeAt(0)));
// Forkortelser som sjelden avslutter en setning: avsnittet deles ikke ved «Mr.» eller «f.eks.» + linjeskift.
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "e.g", "i.e", "bl.a", "f.eks", "osv", "nr", "ca", "vs",
]);
// Justeringen (bit → run) er en DP over biter × run-er; større avsnitt får en rask grådig kobling.
const DP_MAX = 1e6;
const DP_CACHE = 20000; // resultater fra så store DP-er gjenbrukes mellom størrelses- og skriverunden …
const CACHE_MAX = 1 << 19; // … så lenge de til sammen er små (antall biter; 2 MB)

// Grupper som aldri oversettes. Ukjente \*-grupper hoppes også over.
const SKIP_DEST = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "themedata", "colorschememapping",
  "datastore", "latentstyles", "listtable", "listoverridetable", "rsidtbl", "generator", "xmlnstbl",
  "mmathPr", "fldinst", "listtext", "pntext", "pntxta", "pntxtb", "pn", "bkmkstart", "bkmkend", "falt",
  "panose", "filetbl", "revtbl", "pgptbl", "upr", "ud", "sp", "sn", "sv", "nonshppict", "nonesttables",
  "xe", "tc", "template", "keycode", "do", "annotation", "atnid", "atnauthor", "atndate", "atnref",
  "atnparent", "objdata", "objclass", "result", "userprops", "docvar", "ftnsep", "ftnsepc", "ftncn",
  "aftnsep", "aftnsepc", "aftncn", "picprop", "NeXTGraphic",
]);
// Grupper med egen tekst: eget sett av avsnitt, avsnittet utenfor fortsetter etterpå.
const TEXT_DEST = new Set([
  "footnote", "header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr", "footerf",
  "fldrslt", "shptxt", "shprslt",
]);
// Figurer: selve gruppen har ingen tekst, men \shptxt inni har.
const CONTAINER_DEST = new Set(["shp", "shpgrp", "shpinst"]);
// Grupper og kontrollord som står på et bestemt sted i teksten (ankre). \NeXTGraphic: vedlegg i Cocoas RTFD
// ({{\NeXTGraphic fil.png …}¬}); hele den ytre gruppen er vedlegget.
const ANCHOR_DEST = new Set([
  "pict", "shppict", "nonshppict", "object", "shp", "shpgrp", "do", "footnote", "atrfstart", "atrfend", "annotation",
  "bkmkstart", "bkmkend", "NeXTGraphic",
]);
const ANCHOR_WORDS = new Set(["chftn", "chatn", "chpgn", "chdate", "chdpl", "chdpa", "chtime", "sectnum", "objattph"]);
const FONT_SUBDEST = new Set(["panose", "falt", "fname", "fontemb", "fontfile"]);
const BREAKS = new Set(["par", "cell", "nestcell", "row", "nestrow", "sect", "page", "column"]);
const SOFT_BREAKS = new Set(["softline", "softpage", "softcol"]);
// Komponenter per fargerom i Cocoas \expandedcolortbl; én til er gjennomsiktigheten (alfa).
const COLOR_SPACES = { cssrgb: 3, csgenericrgb: 3, csdevicergb: 3, csgray: 1, csgenericgray: 1, csdevicegray: 1,
  cscmyk: 4, csgenericcmyk: 4, csdevicecmyk: 4 };
const CHAR_WORDS = new Map(Object.entries({
  tab: 0x09, line: 0x0a, emdash: 0x2014, endash: 0x2013, emspace: 0x2003, enspace: 0x2002, qmspace: 0x2005,
  bullet: 0x2022, lquote: 0x2018, rquote: 0x2019, ldblquote: 0x201c, rdblquote: 0x201d, zwj: 0x200d,
  zwnj: 0x200c, zwbo: 0x200b, zwnbo: 0xfeff, ltrmark: 0x200e, rtlmark: 0x200f,
}));
// \~ \_ \- \\ \{ \}. \- (myk bindestrek, -1) bidrar ikke med tekst, men hører til run-en.
const CHAR_SYMBOLS = new Map([[0x7e, 0xa0], [0x5f, 0x2011], [0x2d, -1], [0x5c, 0x5c], [0x7b, 0x7b], [0x7d, 0x7d]]);
const UNDERLINES = new Set([
  "ul", "uld", "uldash", "uldashd", "uldashdd", "uldb", "ulhwave", "ulldash", "ulth", "ulthd", "ulthdash",
  "ulthdashd", "ulthdashdd", "ulthldash", "ululdbwave", "ulw", "ulwave",
]);
const EFFECTS = { caps: 1, scaps: 2, outl: 4, shad: 8, embo: 16, impr: 32 };
// Symbolskrift etter navn, også slik macOS/Cocoa skriver dem (PostScript-navn med \fcharset0: «Wingdings-Regular»,
// «SymbolMT», «ZapfDingbatsITC»): familien først, uten store/små bokstaver, mellomrom og bindestreker.
const SYMBOL_FONT = /^(?:symbol|wingdings|webdings|(?:itc)?zapfdingbats|marlett|mtextra|monotypesorts|bookshelfsymbol|msreferencespecialty|opensymbol)/;
const isSymbolFont = (name) => SYMBOL_FONT.test(name.toLowerCase().replace(/[\s_-]+/g, ""));
// «Arial CYR», «Times New Roman CE» … er samme skrift som «Arial»/«Times New Roman» for et annet alfabet.
const FONT_SCRIPT = / (?:cyr|ce|greek|tur|baltic|\(hebrew\)|\(arabic\)|\(vietnamese\))$/i;

const TEXT = 1;
const CONTAINER = 2;
const SKIP = 3;
const FONTS = 1;
const COLORS = 2;
const XCOLORS = 3; // Cocoas \expandedcolortbl
// Run-flagg
const PREFIX = 1; // starter rett etter et kontrollord uten mellomrom: ny tekst må skilles med " "
const AFTER = 2; // et anker står mellom forrige run og denne
const TARGET = 4; // kan få oversatt tekst
const PENDING = 8; // starter med \uN som avsluttet reservetegnene til en \uN foran: ny tekst må også starte med \uN
const GAP = 16; // et anker (eller en urørt run) står rett foran denne run-en i avsnittets tekst
const WSB = 32; // … og i originalen stod det mellomrom rett foran ankeret
const WSA = 64; // … og i originalen stod det mellomrom rett etter ankeret
const BASE = 128; // grunnformatets run med flest bokstaver: får hele teksten når merkene er ugyldige
// Avsnittsflagg (lagres sammen med antall merker: merker | flagg << 3)
const LITERAL = 1; // originalen har ⟦ ⟧ eller 〚 〛 som tekst: ingen merker
const BRACKETS = 2; // originalen har [ som tekst: bare [n]…[/n] i par kan være merker …
const BRSLASH = 4; // … og har den [/ også, er [n] aldri et merke
const TAILGAP = 8; // et anker står etter avsnittets siste run
const TAILWS = 16; // … og i originalen stod det mellomrom rett foran det

const isLetter = (c) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
const isDigit = (c) => c >= 0x30 && c <= 0x39;
const isHex = (c) => isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
const hexVal = (c) => (c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x57);

// Tegnklasser: 1 bokstav, 2 tall, 4 mellomrom (samme som /\s/ og trim()), 0x80 = beregnet.
const CLASS = new Uint8Array(65536);
function charClass(code) {
  let v = CLASS[code];
  if (!v) {
    const s = String.fromCharCode(code);
    v = 0x80 | (/\p{L}/u.test(s) ? 1 : 0) | (/\p{N}/u.test(s) ? 2 : 0) | (/\s/.test(s) ? 4 : 0);
    CLASS[code] = v;
  }
  return v;
}
for (let c = 0; c < 256; c++) charClass(c);

function decode(tb, a, b) {
  let s = "";
  if (b - a < 24) {
    for (let x = a; x < b; x++) s += String.fromCharCode(tb[x]);
    return s;
  }
  for (let x = a; x < b; x += 8192) s += String.fromCharCode.apply(null, tb.subarray(x, Math.min(b, x + 8192)));
  return s;
}

// Kontrollord → type, slått opp én gang per navn (en fil har millioner av kontrollord).
const K = {
  OTHER: 0, U: 1, CHAR: 2, BREAK: 3, UC: 4, F: 5, FS: 6, B: 7, I: 8, STRIKE: 9, STRIKED: 10, UL: 11, ULNONE: 12,
  CF: 13, HIGHLIGHT: 14, CB: 15, SUPER: 16, SUB: 17, NOSUPERSUB: 18, UP: 19, DN: 20, REVISED: 21, PLAIN: 22, V: 23,
  DELETED: 24, DEFF: 25, ANSICPG: 26, MAC: 27, PC: 28, PCA: 29, FONTTBL: 30, COLORTBL: 31, FIELD: 32, FX: 33,
  ANCHOR: 34, BIN: 35, SOFT: 36, XCOLORTBL: 37,
};
const KINDS = new Map(Object.entries({
  u: K.U, uc: K.UC, f: K.F, fs: K.FS, b: K.B, i: K.I, strike: K.STRIKE, striked: K.STRIKED, ulnone: K.ULNONE,
  cf: K.CF, highlight: K.HIGHLIGHT, cb: K.CB, chcbpat: K.CB, super: K.SUPER, sub: K.SUB, nosupersub: K.NOSUPERSUB,
  up: K.UP, dn: K.DN, revised: K.REVISED, plain: K.PLAIN, v: K.V, deleted: K.DELETED, deff: K.DEFF,
  ansicpg: K.ANSICPG, mac: K.MAC, pc: K.PC, pca: K.PCA, fonttbl: K.FONTTBL, colortbl: K.COLORTBL, field: K.FIELD,
  bin: K.BIN, expandedcolortbl: K.XCOLORTBL,
}));
const D_ANCHOR = 1;
const D_TEXT = 2;
const D_CONTAINER = 4;
const D_SKIP = 8;
const D_FLDINST = 16;
const D_FLDRSLT = 32;
const D_FONTSUB = 64;
const D_BKSTART = 128;
const D_BKEND = 256;
const D_ATTACH = 512;

function wordInfo(name) {
  let kind = KINDS.get(name) || K.OTHER;
  if (CHAR_WORDS.has(name)) kind = K.CHAR;
  else if (BREAKS.has(name)) kind = K.BREAK;
  else if (SOFT_BREAKS.has(name)) kind = K.SOFT;
  else if (UNDERLINES.has(name)) kind = K.UL;
  else if (EFFECTS[name]) kind = K.FX;
  else if (ANCHOR_WORDS.has(name)) kind = K.ANCHOR;
  const dest = (ANCHOR_DEST.has(name) ? D_ANCHOR : 0) | (TEXT_DEST.has(name) ? D_TEXT : 0)
    | (CONTAINER_DEST.has(name) ? D_CONTAINER : 0) | (SKIP_DEST.has(name) ? D_SKIP : 0)
    | (name === "fldinst" ? D_FLDINST : 0) | (name === "fldrslt" ? D_FLDRSLT : 0)
    | (FONT_SUBDEST.has(name) ? D_FONTSUB : 0) | (name === "bkmkstart" ? D_BKSTART : 0) | (name === "bkmkend" ? D_BKEND : 0)
    | (name === "NeXTGraphic" ? D_ATTACH : 0);
  return { name, kind, dest, code: CHAR_WORDS.get(name) ?? 0, bit: EFFECTS[name] || 0 };
}

// Korte navn (≤ 9 bokstaver) slås opp på et tall regnet ut av bokstavene, uten å lage en ny streng.
const WORDS = new Map();
function wordAt(bytes, a, b) {
  if (b - a > 9) return wordInfo(bytes.toString("latin1", a, b));
  let key = 0;
  for (let x = a; x < b; x++) {
    const ch = bytes[x];
    key = key * 53 + (ch >= 0x61 ? ch - 0x60 : ch - 0x40 + 26);
  }
  let w = WORDS.get(key);
  if (w === undefined) {
    w = wordInfo(bytes.toString("latin1", a, b));
    if (WORDS.size < 4096) WORDS.set(key, w);
  }
  return w;
}

// Tall i typede tabeller, lagret i blokker på 65 536: ingen dobbel kapasitet og ingen kopi når tabellen vokser
// (bare første blokk vokser fra 1024). Brukes for run-er og avsnitt.
const CB = 16;
const CS = 1 << CB;
const CM = CS - 1;
class Col {
  constructor(Type) {
    this.Type = Type;
    this.c = [new Type(1024)];
  }

  // Plass til indeks i (= antallet så langt). Gir samlet kapasitet.
  grow(i) {
    const ci = i >>> CB;
    if (ci === this.c.length) this.c.push(new this.Type(CS));
    else {
      const a = this.c[ci];
      const b = new this.Type(Math.min(CS, a.length * 2));
      b.set(a);
      this.c[ci] = b;
    }
    return (this.c.length - 1) * CS + this.c[this.c.length - 1].length;
  }

  get(i) {
    return this.c[i >>> CB][i & CM];
  }

  set(i, v) {
    this.c[i >>> CB][i & CM] = v;
  }

  bytes() {
    return this.c.reduce((n, a) => n + a.byteLength, 0);
  }
}

// Run-er som får tekst (11 byte per run, ingen tekstkopi). Run-ene til et avsnitt legges inn samlet når avsnittet er
// lest, så avsnitt j eier run-ene first(j) … first(j + 1) − 1. Run-er som står urørt (ankre, avsnitt uten bokstaver)
// lagres ikke.
class Runs {
  constructor() {
    this.count = 0;
    this.start = new Col(Int32Array);
    this.end = new Col(Int32Array);
    this.uc = new Col(Uint8Array);
    this.flags = new Col(Uint8Array);
    this.tag = new Col(Uint8Array);
    this.cap = 1024;
  }

  add(start, end, uc, flags, tag) {
    const r = this.count;
    if (r === this.cap) {
      for (const col of [this.start, this.end, this.uc, this.flags]) col.grow(r);
      this.cap = this.tag.grow(r);
    }
    this.count++;
    this.start.set(r, start);
    this.end.set(r, end);
    this.uc.set(r, uc);
    this.flags.set(r, flags);
    this.tag.set(r, tag);
    return r;
  }

  bytes() {
    return this.start.bytes() + this.end.bytes() + this.uc.bytes() + this.flags.bytes() + this.tag.bytes();
  }
}

// Avsnitt som skal oversettes, i den rekkefølgen de er lest (en fotnote før avsnittet den står i): første run,
// mellomrom i kantene og antall merker + flagg (9 byte per avsnitt). Tekst bare i core (strengen som oversettes,
// frigjøres etter oversettelsen) og edges (mellomrom foran og bak kjernen, som settes tilbake uendret; like verdier
// deles; edgeBytes er det de koster).
class Jobs {
  constructor(runs) {
    this.runs = runs;
    this.count = 0;
    this.core = [];
    this.edges = [];
    this.edgeIds = new Map();
    this.edgeBytes = 0;
    this.first = new Col(Int32Array);
    this.edge = new Col(Int32Array);
    this.info = new Col(Uint8Array);
    this.cap = 1024;
  }

  add(first, nTags, flags, edges, core) {
    const j = this.count;
    if (j === this.cap) {
      this.first.grow(j);
      this.edge.grow(j);
      this.cap = this.info.grow(j);
    }
    this.count++;
    this.first.set(j, first);
    this.info.set(j, nTags | (flags << 3));
    let e = -1;
    if (edges) {
      e = this.edgeIds.get(edges);
      if (e === undefined) {
        e = this.edges.push(edges) - 1;
        this.edgeIds.set(edges, e);
        this.edgeBytes += 80 + 2 * edges.length; // strengen, listeplass og oppslag
      }
    }
    this.edge.set(j, e);
    if (core !== null) this.core.push(core);
    return j;
  }

  nTags(j) {
    return this.info.get(j) & 7;
  }

  flags(j) {
    return this.info.get(j) >> 3;
  }

  len(j) {
    return (j + 1 < this.count ? this.first.get(j + 1) : this.runs.count) - this.first.get(j);
  }

  bytes() {
    return this.first.bytes() + this.edge.bytes() + this.info.bytes();
  }
}

// Gjenbrukte oppslag for analysen av ett avsnitt.
const SUMS = new Map();
const SIG_TAG = new Map();
const SEG_NAT = new Map();
const SEG_HAS = new Map();
const FINAL = new Map();
const SLOTS = new Map();
const USEFUL = new Set();
const FMT_SIGS = new Set();
const PARTS = [];

// Kladd for analysen av ett avsnitt, gjenbrukes (slippes etter lesingen når den er blitt stor). 27 byte per plass.
const S = { cap: 0 };
const SCRATCH_I32 = ["letters", "solid", "prov", "nat", "fin", "toff"];
const SCRATCH_U8 = ["alnum", "keep", "target"];
function releaseScratch() {
  if (S.cap > 4096) for (const k of Object.keys(S)) S[k] = k === "cap" ? 0 : null;
}
function scratch(m) {
  if (m <= S.cap) return S;
  let cap = 64;
  while (cap < m) cap *= 2;
  for (const k of SCRATCH_I32) S[k] = new Int32Array(cap);
  for (const k of SCRATCH_U8) S[k] = new Uint8Array(cap);
  S.cap = cap;
  return S;
}

// Avsnittet som leses i én tekstsammenheng (brødtekst, fotnote, topptekst …): tegnene i tbuf og run-ene (m stk.):
// hvor i filen de står (rs–re), reservetegn (ru), flagg (rf), format (rsig) og hvor i tbuf de starter (rts).
// 18 byte per run-plass og 2 per tegn; tabellene til en fotnote, et felt o.l. krympes igjen når den er lest.
const CTX_I32 = ["rs", "re", "rsig", "rts"];
const CTX_U8 = ["ru", "rf"];
const CTX_RUNS = 64;
const CTX_CHARS = 256;
const ctxSize = (c) => 2 * c.tbuf.length + 18 * c.rs.length;
function newCtx() {
  const c = { tbuf: null, tlen: 0, m: 0, open: -1, anchor: false, opaque: false, field: null };
  resetCtx(c);
  return c;
}
function resetCtx(c) {
  c.tbuf = new Uint16Array(CTX_CHARS);
  for (const k of CTX_I32) c[k] = new Int32Array(CTX_RUNS);
  for (const k of CTX_U8) c[k] = new Uint8Array(CTX_RUNS);
}
function growCtx(c) {
  for (const k of [...CTX_I32, ...CTX_U8]) {
    const a = new c[k].constructor(c.m * 2);
    a.set(c[k]);
    c[k] = a;
  }
}
function growText(c, min) {
  const t = new Uint16Array(Math.max(c.tbuf.length * 2, min));
  t.set(c.tbuf.subarray(0, c.tlen));
  c.tbuf = t;
}

// Et eget, flatt eksemplar av en streng (trim/slice gir en bit som holder hele originalen i live; join kopierer).
const own = (s) => (s.length < 13 ? s : [s.slice(0, 1), s.slice(1)].join(""));
const WIDE = /[^\x00-\xff]/; // strengen trenger 2 byte per tegn i V8

// Leser RTF-en byte for byte. Returnerer run-er, avsnitt å oversette og reparasjoner av strukturen.
// keepCore: false når ferdige oversettelser skal legges inn (apply); da trengs ikke kildeteksten (minne).
function parseRtf(bytes, { keepCore = true } = {}) {
  const n = bytes.length;
  const runs = new Runs();
  const jobs = new Jobs(runs);
  const fontCp = new Map();
  const fontKey = new Map();
  const colors = [];
  const alphas = []; // gjennomsiktighet fra \expandedcolortbl (Cocoa), der den ikke er 100 %
  let xcolor = null; // fargen som leses i \expandedcolortbl: { n (nummer), space (komponenter), c: [...] }
  const sigIds = new Map();
  const sigPos = [];
  const sigVis = []; // det som synes på mellomrom og tab: understreking, gjennomstreking, utheving, innsatt tekst
  const visIds = new Map();
  let ansiCp = 1252;
  let deff = 0;
  let fontDef = 0;
  let fontName = "";
  let color = null;
  let skip = 0; // reservetegn etter \uN som skal hoppes over
  let skipRun = -1;
  let lastBare = -1; // slutten på siste kontrollord uten mellomrom etter
  let pending = false; // et kontrollord avsluttet reservetegn som manglet
  let opaque = 0;
  let textChars = 0; // tegn i strengene som skal oversettes
  let strBytes = 0; // det kildestrengene koster i V8
  let byteGrowth = 0; // tegn lest fra én byte (\'hh eller rå byte ≥ 0x80) blir \uN? i utfilen om teksten står
  let dpBytes = 0; // største justering (DP) og gjenbrukte resultater ved innlegging
  let scratchCap = 64; // plassene kladden for analysen trenger for det største avsnittet så langt
  let rootEnd = -1;
  let truncAt = -1; // filen slutter midt i en \-sekvens: den fjernes
  let bin = null;
  let bkName = ""; // navnet i bokmerket som leses
  let bkOpen = null; // bokmerke som nettopp startet: { c, name, was }; slutter det rett etter, er det ikke et anker
  const stack = [];
  const pool = [newCtx()];
  const ctxs = [pool[0]];
  let ctxBytes = ctxSize(pool[0]);
  let g = {
    mode: SKIP, uc: 1, table: 0, star: false, pushed: false, anchor: false, isField: false, field: null, inst: false,
    hidden: false, deleted: false, font: -1, fs: 24, b: 0, i: 0, ul: "", strike: 0, cf: "", bg: "", pos: 0,
    rev: 0, fx: 0, sig: -1, bk: 0, first: false,
  };

  // Minnevakten (se COLLECT_BUDGET): regnes ut når et avsnitt er lagt til og når kladden vokser.
  const memory = { collect: 0, apply: 0 }; // største anslag så langt (byte over det kjøringen selv bruker)
  // Tabellene over formater, skrifter og farger trengs bare mens filen leses, men regnes med hele veien (målt i Node:
  // V8 slipper dem ikke alltid før strengene er sendt videre). Målt med flate nøkler: om lag 130 B per format, 60–90 B
  // per skrift og 40 B per farge; regnet med plass til at en Map eller liste vokser. tableBytes er formatene,
  // skriftnavnene og gjennomsiktighetene; resten regnes ut av størrelsen på tabellene.
  let tableBytes = 0;
  let tableAdds = 0;
  function tableGrew(bytes) {
    tableBytes += bytes;
    if ((++tableAdds & 1023) === 0) checkMemory();
  }
  function checkMemory() {
    const J = jobs.count;
    const fixed = n + runs.bytes() + jobs.bytes() + jobs.edgeBytes;
    const scratchBytes = 27 * scratchCap; // kladden for analysen (regnet ut for denne filen, så svaret er det samme hver gang)
    const tables = tableBytes + 88 * fontCp.size + 56 * colors.length;
    const parsing = 12 * J + ctxBytes + scratchBytes; // listen over kildestrengene (med vekstrom) og kladden
    const collect = fixed + tables + strBytes + Math.max(parsing, 64 * J);
    // Oversettelsene: inntil 1,3 ganger så lange, 2 B per tegn, hode og litt til. Utfilen: den lengre teksten, og æøå,
    // ’ og – blir \uN.
    const translations = Math.round(2.6 * textChars) + 24 * J;
    const out = n + (textChars >> 1) + byteGrowth + 8 * J;
    const apply = fixed + tables + translations + 8 * J
      + Math.max(28 * J, out + 12 * J + dpBytes, ctxBytes + scratchBytes);
    if (collect > memory.collect) memory.collect = collect;
    if (apply > memory.apply) memory.apply = apply;
    if (textChars > MAX_TEXT_MB * MB) throw new Error(TOO_MUCH_TEXT);
    if (collect > COLLECT_BUDGET || apply > APPLY_BUDGET) throw new Error(TOO_BIG);
  }

  const top = () => ctxs[ctxs.length - 1];
  const closeRun = () => {
    top().open = -1;
  };
  // Noe som ikke er tekst står her i avsnittet (bilde, fotnote, symbol …): run-en slutter, og teksten etter merkes.
  const markAnchor = () => {
    const c = top();
    c.open = -1;
    c.anchor = true;
    bkOpen = null;
  };
  const curFont = () => (g.font >= 0 ? g.font : deff);
  const codepage = () => {
    const cp = fontCp.get(curFont());
    return cp == null ? ansiCp : cp;
  };
  // 0 = ikke tekst her, 1 = tekst, 2 = synlig, men ikke tekst å oversette (skjult, slettet, symbolskrift, og tekst
  // mellom \* og kontrollordet i en skadet fil – lesere som hopper over gruppen, ville ellers skjult oversettelsen)
  const textState = () => {
    if (g.mode !== TEXT) return 0;
    return g.star || g.hidden || g.deleted || fontCp.get(curFont()) === -1 ? 2 : 1;
  };

  let memo = null; // sist beregnede format: de fleste run-er i et avsnitt har samme
  function sigOf() {
    if (g.sig < 0) {
      const f = curFont();
      const mm = memo;
      if (mm && mm.f === f && mm.fs === g.fs && mm.b === g.b && mm.i === g.i && mm.ul === g.ul && mm.strike === g.strike
        && mm.cf === g.cf && mm.bg === g.bg && mm.pos === g.pos && mm.rev === g.rev && mm.fx === g.fx) {
        g.sig = mm.id;
        return g.sig;
      }
      const key = `${fontKey.get(f) ?? `#${f}`}|${g.fs}|${g.b}${g.i}|${g.ul}|${g.strike}|${g.cf}|${g.bg}|${g.pos}|${g.rev}|${g.fx}`;
      let id = sigIds.get(key);
      if (id === undefined) {
        id = sigPos.length;
        sigIds.set(own(key), id); // flat kopi: strengen over er et tre av biter (flere hundre byte)
        sigPos.push(g.pos);
        // \ulw understreker bare ord, ikke mellomrom.
        const vis = `${g.ul === "ulw" ? "" : g.ul}|${g.strike}|${g.bg}|${g.rev}`;
        let v = visIds.get(vis);
        if (v === undefined) {
          visIds.set(own(vis), (v = visIds.size));
          tableBytes += 96 + vis.length;
        }
        sigVis.push(v);
        tableGrew(144 + key.length);
      }
      g.sig = id;
      memo = { f, fs: g.fs, b: g.b, i: g.i, ul: g.ul, strike: g.strike, cf: g.cf, bg: g.bg, pos: g.pos, rev: g.rev, fx: g.fx, id };
    }
    return g.sig;
  }

  function setSig(field, v) {
    if (g[field] !== v) {
      g[field] = v;
      g.sig = -1;
    }
  }

  function colorOf(param) {
    const p = param || 0;
    const k = colors[p];
    const a = alphas[p]; // Cocoa: samme farge med annen gjennomsiktighet er et annet format
    return (k === undefined ? (p ? `#${p}` : "") : k) + (a === undefined ? "" : `/${a}`);
  }

  // Slutten av en farge i \expandedcolortbl: en komponent mer enn fargerommet har, er gjennomsiktigheten.
  function finishXColor() {
    const x = xcolor;
    if (x.space && x.c.length > x.space && x.c[x.space] < 100000) {
      alphas[x.n] = x.c[x.space];
      tableGrew(24);
    }
    xcolor = { n: x.n + 1, space: 0, c: [] };
  }

  function finishFontName() {
    const name = fontName.trim();
    if (name) {
      if (isSymbolFont(name)) fontCp.set(fontDef, -1);
      fontKey.set(fontDef, name.replace(FONT_SCRIPT, "").toLowerCase());
      tableGrew(96 + name.length);
    }
    fontName = "";
  }

  function tableText(a, b) {
    for (let x = a; x < b; x++) {
      const ch = bytes[x];
      if (ch === 0x3b) {
        if (g.table === FONTS) finishFontName();
        else if (g.table === XCOLORS) finishXColor();
        else {
          const k = color.set ? `${color.r},${color.g},${color.b}` : "";
          colors.push(k === "0,0,0" ? "" : k); // svart = automatisk farge
          tableGrew(0);
          color = { r: 0, g: 0, b: 0, set: false };
        }
      } else if (g.table === FONTS && ch >= 0x20 && ch < 0x7f && fontName.length < 64) {
        fontName += String.fromCharCode(ch);
      }
    }
  }

  // Et langt avsnitt kan deles her, ved et linjeskift: det forrige tegnet (forbi mellomrom og avsluttende anførsels-
  // tegn/parenteser) avslutter en setning, eller er selv et linjeskift.
  function sentenceBreak(c) {
    const tb = c.tbuf;
    for (let x = c.tlen - 1, stop = Math.max(0, c.tlen - 64); x >= stop; x--) {
      const ch = tb[x];
      if (ch === 0x0a) return true;
      if (charClass(ch) & 4 || CLOSERS.has(ch)) continue;
      if (ch !== 0x2e) return SENTENCE_END.has(ch);
      // «.»: ikke etter en forkortelse (ordet foran, med punktum inni, høyst 5 tegn)
      let y = x;
      const word = (q) => q > 0 && (tb[q - 1] === 0x2e || (charClass(tb[q - 1]) & 1) !== 0);
      while (x - y < 6 && word(y)) y--;
      return word(y) || !ABBREVIATIONS.has(decode(tb, y, x).toLowerCase());
    }
    return false;
  }

  // Kladden for avsnittet vokser: regnes med i minnevakten.
  function grew(c, before) {
    ctxBytes += ctxSize(c) - before;
    checkMemory();
  }

  // code -1: hører til run-en (myk bindestrek, kontrolltegn), men starter ingen ny run.
  function addCode(start, end, code) {
    const c = top();
    // Langt avsnitt: nytt avsnitt ved et linjeskift (etter setningsslutt eller to linjeskift; over UNIT_BREAK ved et
    // hvilket som helst); enormt avsnitt: ved et mellomrom, eller uansett (minne).
    if (code >= 0 && c.tlen >= UNIT_SOFT
      && ((code === 0x0a && (c.tlen >= UNIT_BREAK || sentenceBreak(c)))
        || (c.tlen >= UNIT_HARD && (code === 0x20 || code === 0x09)) || c.tlen >= UNIT_MAX)) {
      c.open = -1;
      finishUnit(c);
    }
    let r = c.open;
    if (r < 0) {
      if (code < 0) return -1;
      if (c.m === c.rs.length) {
        const before = ctxSize(c);
        growCtx(c);
        grew(c, before);
      }
      bkOpen = null;
      r = c.m++;
      c.rs[r] = start;
      c.ru[r] = g.uc > 255 ? 255 : g.uc;
      c.rf[r] = (start === lastBare ? PREFIX : 0) | (c.anchor ? AFTER : 0) | (pending ? PENDING : 0);
      c.rsig[r] = sigOf();
      c.rts[r] = c.tlen;
      c.anchor = false;
      c.open = r;
    }
    if (code >= 0) {
      if (c.tlen === c.tbuf.length) {
        const before = ctxSize(c);
        growText(c, 0);
        grew(c, before);
      }
      c.tbuf[c.tlen++] = code;
    }
    c.re[r] = end;
    return r;
  }

  function addAscii(a, b) {
    const c = top();
    if (c.tlen + (b - a) >= UNIT_HARD) {
      for (let x = a; x < b; x++) addCode(x, x + 1, bytes[x]); // kan dele avsnittet
      return;
    }
    addCode(a, a + 1, bytes[a]);
    a++;
    if (c.tlen + (b - a) > c.tbuf.length) {
      const before = ctxSize(c);
      growText(c, c.tlen + (b - a));
      grew(c, before);
    }
    const tb = c.tbuf;
    let t = c.tlen;
    for (let x = a; x < b; x++) tb[t++] = bytes[x];
    c.tlen = t;
    c.re[c.open] = b;
  }

  // \softline, \softpage, \softcol: skift som ikke er påkrevd (bare der teksten brøt da filen ble lagret; vises
  // ikke). Kontrollordet står urørt mellom run-ene; Grok får et mellomrom, så ordene ikke klistres sammen. Mellomrommet
  // regnes til run-en foran (det skrives ikke i filen, men kan komme med i oversettelsen der).
  function softBreak() {
    const c = top();
    c.open = -1;
    if (textState() !== 1 || !c.m || c.anchor || charClass(c.tbuf[c.tlen - 1]) & 4) return;
    if (c.tlen === c.tbuf.length) {
      const before = ctxSize(c);
      growText(c, 0);
      grew(c, before);
    }
    c.tbuf[c.tlen++] = 0x20;
  }

  // Tegnord og kontrollsymboler (\tab, \emdash, \~ …).
  function text(start, end, code) {
    const st = textState();
    if (st === 1) addCode(start, end, code);
    else if (st === 2) markAnchor();
    else closeRun();
  }

  // Én byte tekst (\'hh eller rå byte ≥ 0x80) i gjeldende skrifts tegntabell.
  function byteText(start, end, b) {
    const st = textState();
    if (st !== 1) {
      if (st === 2) markAnchor();
      else closeRun();
      return;
    }
    const table = CODEPAGES[codepage()];
    if (!table) {
      // Flerbyte/ukjent tabell: hele avsnittet blir stående uoversatt, byte for byte.
      closeRun();
      top().opaque = true;
    } else if (b >= 0x80) {
      addCode(start, end, table.charCodeAt(b - 0x80));
      byteGrowth += end - start === 1 ? 8 : 5; // \'e6 (4 B) eller rå byte (1 B) → \u230? (7 B), inntil 1,3 ganger
    } else addCode(start, end, b === 9 ? 9 : b < 0x20 || b === 0x7f ? -1 : b);
  }

  function pushCtx() {
    const depth = ctxs.length;
    if (!pool[depth]) {
      pool[depth] = newCtx();
      ctxBytes += ctxSize(pool[depth]);
    }
    const c = pool[depth];
    c.field = g.field;
    ctxs.push(c);
  }

  // first: gruppen står rett etter en annen { (Cocoas vedlegg: {{\NeXTGraphic …}¬}).
  function openGroup(first) {
    if (stack.length >= MAX_DEPTH) throw new Error(DAMAGED);
    stack.push(g);
    g = { ...g, star: false, pushed: false, anchor: false, isField: false, bk: 0, first };
    if (stack.length === 1) g.mode = TEXT; // rotgruppen
  }

  // true når rotgruppen lukkes (resten av filen leses ikke).
  function closeGroup() {
    const closing = g;
    if (closing.table === FONTS && stack[stack.length - 1].table !== FONTS) finishFontName();
    if (closing.pushed) {
      const c = top();
      finishUnit(c);
      ctxs.pop();
      // Kladden til en fotnote, et felt o.l. krympes når den er stor (brødteksten beholder sin; regnes i vakten).
      if (c.rs.length > 16 * CTX_RUNS || c.tbuf.length > 16 * CTX_CHARS) {
        ctxBytes -= ctxSize(c);
        resetCtx(c);
        ctxBytes += ctxSize(c);
      }
    }
    g = stack.pop();
    if (!stack.length) return true;
    if (g.mode === TEXT) {
      if (closing.isField) {
        if (closing.field.letters) finishUnit(top()); // lenke o.l.: avsnittet deles
        else markAnchor(); // sidetall o.l.
      } else if (closing.bk) bookmark(closing.bk, bkName.trim());
      else if (closing.anchor) markAnchor();
    }
    return false;
  }

  // Et bokmerke er et anker, unntatt et tomt bokmerke (start rett fulgt av slutten med samme navn, som Words _GoBack):
  // det markerer bare et punkt, og teksten rundt skal ikke få merker for det.
  function bookmark(kind, name) {
    const c = top();
    if (kind === 1) {
      const was = c.anchor;
      markAnchor();
      bkOpen = { c, name, was };
    } else if (bkOpen && bkOpen.c === c && bkOpen.name === name) {
      c.anchor = bkOpen.was;
      bkOpen = null;
    } else markAnchor();
  }

  function destination(w, starred) {
    const d = w.dest;
    if (d & D_ANCHOR) g.anchor = true;
    if (d & D_FLDINST && g.field) g.inst = true;
    if (d & (D_BKSTART | D_BKEND)) {
      g.bk = d & D_BKSTART ? 1 : 2;
      bkName = "";
    }
    // Vedlegg (RTFD): den ytre gruppen med tegnet som holder vedlegget, er ankeret; ingenting i den er tekst.
    if (d & D_ATTACH && g.first && stack.length >= 3) {
      const outer = stack[stack.length - 1];
      outer.mode = SKIP;
      outer.anchor = true;
    }
    if (g.mode === SKIP) return;
    // Resultatet av et SYMBOL-felt er et symboltegn, ikke tekst.
    if (d & D_FLDRSLT && g.field && /^\s*SYMBOL\b/i.test(g.field.inst)) g.mode = SKIP;
    else if (d & D_TEXT) {
      g.mode = TEXT;
      if (!g.pushed) {
        g.pushed = true;
        pushCtx();
      }
    } else if (d & D_CONTAINER) g.mode = CONTAINER;
    else if (starred || d & D_SKIP) g.mode = SKIP;
  }

  function plain() {
    g.font = -1;
    g.fs = 24;
    g.b = g.i = g.strike = g.pos = g.rev = g.fx = 0;
    g.ul = g.cf = g.bg = "";
    g.hidden = g.deleted = false;
    g.sig = -1;
  }

  function controlWord(w, param, start, end) {
    const kind = w.kind;
    if (kind === K.U && param !== null) {
      const code = param & 0xffff;
      const st = textState();
      // U+F000–U+F0FF: symbolskrift slik LibreOffice skriver den (\fcharset0 + \u-3913) – et tegn, ikke tekst.
      // U+2028 (Cocoa/TextEdit sitt linjeskift) er et linjeskift som \line.
      if (st === 1 && (code < 0xf000 || code > 0xf0ff)) skipRun = addCode(start, end, code === 0x2028 ? 0x0a : code);
      else {
        if (st === 0) closeRun();
        else markAnchor();
        skipRun = -1;
      }
      skip = g.uc;
      return;
    }
    if (kind === K.CHAR && !g.star) {
      text(start, end, w.code);
      return;
    }
    if (kind === K.SOFT && !g.star) {
      softBreak();
      return;
    }
    closeRun();
    if (g.star) {
      g.star = false;
      if (g.table) g.table = 0;
      if (kind === K.XCOLORTBL) {
        g.mode = SKIP;
        g.table = XCOLORS;
        alphas.length = 0;
        xcolor = { n: 0, space: 0, c: [] };
      } else destination(w, true);
      return;
    }
    if (g.table === FONTS) {
      if (kind === K.F) {
        finishFontName();
        fontDef = param || 0;
      } else if (w.name === "fcharset" || w.name === "cpg") {
        fontCp.set(fontDef, w.name === "cpg" ? param : param in CHARSET_CP ? CHARSET_CP[param] : null);
        tableGrew(0);
      } else if (w.dest & D_FONTSUB) g.table = 0;
      return;
    }
    if (g.table === COLORS) {
      if (w.name === "red" || w.name === "green" || w.name === "blue") {
        color[w.name[0]] = param || 0;
        color.set = true;
      }
      return;
    }
    if (g.table === XCOLORS) {
      // Maks fem komponenter (CMYK + alfa); resten ignoreres, så en konstruert fil ikke kan fylle minnet.
      if (w.name === "c") { if (xcolor.c.length < 5) xcolor.c.push(param || 0); }
      else if (w.name.startsWith("cs")) xcolor.space = COLOR_SPACES[w.name.toLowerCase()] || 0;
      return;
    }
    switch (kind) {
      case K.BREAK: if (g.mode === TEXT) endUnit(); return;
      case K.UC: g.uc = Math.max(0, param == null ? 1 : param); return;
      case K.F: setSig("font", param || 0); return;
      case K.FS: setSig("fs", param == null ? 24 : param); return;
      case K.B: setSig("b", param === 0 ? 0 : 1); return;
      case K.I: setSig("i", param === 0 ? 0 : 1); return;
      case K.STRIKE: setSig("strike", param === 0 ? 0 : 1); return;
      case K.STRIKED: setSig("strike", param === 0 ? 0 : 2); return;
      case K.UL: setSig("ul", param === 0 ? "" : w.name); return;
      case K.ULNONE: setSig("ul", ""); return;
      case K.CF: setSig("cf", colorOf(param)); return;
      case K.HIGHLIGHT: setSig("bg", param ? `h${param}` : ""); return;
      case K.CB: {
        const k = colorOf(param);
        setSig("bg", k && k !== "255,255,255" ? `c${k}` : "");
        return;
      }
      case K.SUPER: setSig("pos", param === 0 ? 0 : 1); return;
      case K.SUB: setSig("pos", param === 0 ? 0 : 2); return;
      case K.NOSUPERSUB: setSig("pos", 0); return;
      case K.UP: setSig("pos", param === 0 ? 0 : 3); return;
      case K.DN: setSig("pos", param === 0 ? 0 : 4); return;
      case K.REVISED: setSig("rev", param === 0 ? 0 : 1); return;
      case K.FX: setSig("fx", param === 0 ? g.fx & ~w.bit : g.fx | w.bit); return;
      case K.PLAIN: plain(); return;
      case K.V: g.hidden = param !== 0; return;
      case K.DELETED: g.deleted = param !== 0; return;
      case K.DEFF: deff = param || 0; g.sig = -1; return;
      case K.ANSICPG: ansiCp = param || 1252; return;
      case K.MAC: ansiCp = 10000; return;
      case K.PC: ansiCp = 437; return;
      case K.PCA: ansiCp = 850; return;
      case K.FONTTBL: g.mode = SKIP; g.table = FONTS; return;
      case K.COLORTBL:
        g.mode = SKIP;
        g.table = COLORS;
        colors.length = 0;
        color = { r: 0, g: 0, b: 0, set: false };
        return;
      case K.FIELD:
        if (g.mode === TEXT) {
          g.isField = true;
          g.field = { letters: false, inst: "" };
        }
        return;
      case K.ANCHOR: if (g.mode === TEXT) markAnchor(); return;
      default: if (w.dest) destination(w, false);
    }
  }

  const endUnit = () => finishUnit(top());

  // Avsnittet er ferdig lest: finn grunnformat, merk uthevinger og ankre, og lag strengen som skal oversettes.
  function finishUnit(c) {
    const m = c.m;
    if (c.opaque) opaque++; // avsnitt vi ikke kan lese (også når det bare består av flerbyte-tegn)
    else if (m) analyzeUnit(c, m);
    c.tlen = 0;
    c.m = 0;
    c.open = -1;
    c.anchor = false;
    c.opaque = false;
    bkOpen = null;
  }

  function analyzeUnit(c, m) {
    while (scratchCap < m) scratchCap *= 2;
    const { letters, alnum, solid, keep, prov, nat, fin, target, toff } = scratch(m);
    const tb = c.tbuf;
    const rts = c.rts;
    const RS = c.rsig;
    const RF = c.rf;
    const tailAnchor = c.anchor; // et anker står etter siste run
    const endOf = (k) => (k + 1 < m ? rts[k + 1] : c.tlen);
    let total = 0;
    let marks = false;
    const sig0 = RS[0];
    let simple = true; // ett format, ingen ankre: ingen merker
    for (let k = 0; k < m; k++) {
      const b = endOf(k);
      let l = 0;
      let an = 0;
      let so = 0;
      for (let x = rts[k]; x < b; x++) {
        const code = tb[x];
        const cls = CLASS[code] || charClass(code);
        if (cls & 1) l++;
        if (cls & 3) an++;
        if (!(cls & 4)) so++;
        if (code === 0x27e6 || code === 0x27e7 || code === 0x301a || code === 0x301b) marks = true;
      }
      letters[k] = l;
      alnum[k] = an ? 1 : 0;
      solid[k] = so;
      // Hevet/senket uten bokstaver (fotnotetall, H₂O) står urørt og er et anker.
      keep[k] = l === 0 && sigPos[RS[k]] !== 0 ? 1 : 0;
      if (keep[k] || RS[k] !== sig0 || (k && RF[k] & AFTER)) simple = false;
      total += l;
    }
    if (!total) return;
    let baseSig = sig0;
    let nTags = 0;
    let segMask = 0;
    if (simple) {
      fin.fill(0, 0, m);
      target.fill(1, 0, m);
    } else {
      // Grunnformat: formatet med flest bokstaver.
      const sums = SUMS;
      sums.clear();
      let best = 0;
      for (let k = 0; k < m; k++) {
        if (keep[k] || !letters[k]) continue;
        const s = RS[k];
        const v = (sums.get(s) || 0) + letters[k];
        sums.set(s, v);
        if (v > best) {
          best = v;
          baseSig = s;
        }
      }
      // Formater med ord eller tall (utenom grunnformatet) får merker, også der de bare har tegnsetting.
      // Tegnsetting i et format som ellers ikke har ord (fet kolon, farget ►, «•\t», « - ») står urørt, som et anker.
      const fmtSigs = FMT_SIGS;
      fmtSigs.clear();
      for (let k = 0; k < m; k++) if (!keep[k] && alnum[k] && RS[k] !== baseSig) fmtSigs.add(RS[k]);
      for (let k = 0; k < m; k++) {
        const sig = RS[k];
        if (!keep[k] && sig !== baseSig && !fmtSigs.has(sig) && solid[k]) keep[k] = 1;
      }
      // Blankt felt: mellomrom/tab i et format som synes på mellomrom (understreket ____-linje av tab, signaturlinje,
      // uthevet tomrom), også når formatet har ord andre steder i avsnittet («{\ul Navn:}{\ul\tab\tab}»). Det står
      // urørt der det står, med formatet sitt; ett enkelt mellomrom mellom to ord blir likevel med i teksten (ellers
      // ville ordene klistres sammen).
      for (let k = 0; k < m; k++) {
        if (keep[k] || solid[k]) continue;
        const sig = RS[k];
        if (sig === baseSig || sigVis[sig] === sigVis[baseSig]) continue;
        const a = rts[k];
        const b = endOf(k);
        let blank = b - a >= 2 || a === 0 || b >= c.tlen || (CLASS[tb[a - 1]] & 4) !== 0 || (CLASS[tb[b]] & 4) !== 0;
        for (let x = a; x < b && !blank; x++) if (tb[x] === 9) blank = true;
        if (blank) keep[k] = 1;
      }
      // Mellomrom, tab eller linjeskift alene inntil et anker (bilde, symbol, fotnotemerke) står også urørt, på samme
      // side av ankeret og med formatet sitt: «resultat {bilde}\line {\i Kilde}», «{\ul Navn}\tab {bilde}». Flere
      // slike run-er etter hverandre regnes sammen. Unntak: rene mellomrom som går over i tekst i samme format på den
      // andre siden; de følger teksten (og settes tilbake på rett side av ankeret etter oversettelsen).
      const blankRun = (q) => !keep[q] && !solid[q] && endOf(q) > rts[q];
      const hardWs = (q) => {
        for (let x = rts[q], b = endOf(q); x < b; x++) if (tb[x] === 9 || tb[x] === 10) return true;
        return false;
      };
      for (let k = 0; k < m; k++) {
        if (!blankRun(k) || (k > 0 && blankRun(k - 1) && !(RF[k] & AFTER))) continue;
        // k … e-1: run-er med bare mellomrom etter hverandre, uten anker mellom.
        let e = k + 1;
        while (e < m && blankRun(e) && !(RF[e] & AFTER)) e++;
        const before = (RF[k] & AFTER) !== 0 || (k > 0 && keep[k - 1] === 1);
        const after = e < m ? keep[e] === 1 || (RF[e] & AFTER) !== 0 : tailAnchor;
        if (!before && !after) continue;
        let bridge = !(before && after);
        for (let q = k; q < e && bridge; q++) if (hardWs(q) || RS[q] !== RS[k]) bridge = false;
        const o = before ? e : k - 1; // tekstsiden
        if (bridge && o >= 0 && o < m && !keep[o] && solid[o] && RS[o] === RS[k]) continue;
        for (let q = k; q < e; q++) keep[q] = 1;
      }

      // Merker: ett per format som avviker (nummer i tekstrekkefølge), og ett per tekststrekk etter et anker som
      // ellers ikke kan skilles fra teksten foran ankeret. Høyst 6: får ikke alle plass, beholdes formatene i
      // tekstrekkefølge (resten sendes som vanlig tekst), og strekkene etter ankre deler plassene som er igjen (minst
      // én), så fotnotemerker aldri flytter seg. Strekkene regnes ut på nytt når formater faller bort (teksten på begge
      // sider av et fotnotemerke kan da få samme format).
      const sigTag = SIG_TAG;
      const segNat = SEG_NAT;
      sigTag.clear();
      let formats = 0;
      if (!marks) {
        for (let k = 0; k < m; k++) {
          const sig = RS[k];
          if (!keep[k] && solid[k] && sig !== baseSig && fmtSigs.has(sig) && !sigTag.has(sig)) sigTag.set(sig, ++formats);
        }
      }
      // Foreløpige merker når de første `limit` formatene får merke; gir antall strekk som trenger eget merke.
      const tagRuns = (limit) => {
        segNat.clear();
        let nextId = formats + 1;
        let last = -1;
        let seg = 0;
        let segN = 0;
        let anchor = false;
        for (let k = 0; k < m; k++) {
          if (keep[k]) {
            anchor = true;
            continue;
          }
          if (RF[k] & AFTER) anchor = true;
          const sig = RS[k];
          const f0 = marks || sig === baseSig ? 0 : sigTag.get(sig) || 0;
          const n0 = f0 <= limit ? f0 : 0;
          target[k] = sig === baseSig || n0 ? 1 : 0;
          let t;
          if (marks) t = 0;
          else if (anchor && last === n0 && !solid[k]) {
            // Bare mellomrom rett etter ankeret: merket venter til teksten som faktisk står etter ankeret.
            prov[k] = n0;
            nat[k] = n0;
            seg = 0;
            continue;
          } else if (anchor && last === n0) {
            t = nextId++;
            segNat.set(t, n0);
            seg = t;
            segN = n0;
          } else if (!anchor && seg && segN === n0) t = seg;
          else {
            t = n0;
            seg = 0;
          }
          prov[k] = t;
          nat[k] = n0;
          last = t;
          anchor = false;
        }
        // Et strekk uten mottaker eller uten annet enn mellomrom trenger ikke merke.
        const useful = USEFUL;
        useful.clear();
        if (segNat.size) {
          const has = SEG_HAS;
          has.clear();
          for (let k = 0; k < m; k++) {
            if (keep[k] || !segNat.has(prov[k])) continue;
            const h = has.get(prov[k]) || 0;
            has.set(prov[k], h | (target[k] ? 1 : 0) | (solid[k] ? 2 : 0));
          }
          for (let k = 0; k < m; k++) {
            if (keep[k] || !segNat.has(prov[k])) continue;
            if (has.get(prov[k]) !== 3) prov[k] = nat[k];
            else useful.add(prov[k]);
          }
        }
        return useful.size;
      };
      let limit = formats;
      let slots;
      for (;;) {
        const segs = tagRuns(limit);
        if (limit + segs <= MAX_TAGS) {
          slots = segs;
          break;
        }
        if (segs && limit < MAX_TAGS) {
          slots = MAX_TAGS - limit;
          break;
        }
        limit = segs ? MAX_TAGS - 1 : MAX_TAGS;
      }
      // Endelige nummer 1–6 i den rekkefølgen merkene står i teksten (en run med bare mellomrom får ingen merker).
      // Går ikke strekkene opp i plassene, brukes et nummer igjen for et senere strekk: et strekk står aldri inntil et
      // annet strekk (det står et format eller vanlig tekst mellom), og bitene legges ut i rekkefølge.
      const final = FINAL;
      const slotNo = SLOTS;
      final.clear();
      slotNo.clear();
      let segCount = 0;
      for (let k = 0; k < m; k++) {
        const t = prov[k];
        if (keep[k] || !t || !solid[k] || final.has(t)) continue;
        if (!segNat.has(t)) final.set(t, ++nTags);
        else {
          const slot = segCount++ % slots;
          let no = slotNo.get(slot);
          if (no === undefined) {
            no = ++nTags;
            slotNo.set(slot, no);
            segMask |= 1 << (no - 1);
          }
          final.set(t, no);
        }
      }
      for (let k = 0; k < m; k++) {
        if (keep[k]) continue;
        const f = prov[k] ? final.get(prov[k]) ?? -1 : 0;
        if (f === -1) {
          fin[k] = 0;
          target[k] = 0;
        } else fin[k] = f;
      }
    }

    // Strengen: run-ene i rekkefølge, uthevinger og strekk etter ankre i ⟦n⟧…⟦/n⟧. toff = hvor run-en starter i
    // avsnittets tekst uten ankre (strengen uten merker).
    const parts = PARTS;
    parts.length = 0;
    let tp = 0;
    for (let k = 0; k < m;) {
      if (keep[k]) {
        k++;
        continue;
      }
      const t = fin[k];
      let e = k + 1;
      while (e < m && !keep[e] && fin[e] === t && !(RF[e] & AFTER)) e++;
      const b = e < m ? rts[e] : c.tlen;
      for (let x = k; x < e; x++) toff[x] = tp + rts[x] - rts[k];
      tp += b - rts[k];
      const s = decode(tb, rts[k], b);
      if (!t) parts.push(s);
      else if (segMask & (1 << (t - 1))) parts.push(`⟦${t}⟧`, s, `⟦/${t}⟧`);
      else {
        const core = s.trim();
        const lead = s.slice(0, s.length - s.trimStart().length);
        if (core) parts.push(lead, `⟦${t}⟧`, core, `⟦/${t}⟧`, s.slice(lead.length + core.length));
        else parts.push(s); // bare mellomrom: ingen merker
      }
      k = e;
    }
    const str = parts.join("");
    const trimmed = str.trim();
    if (!trimmed) return;
    const lead = str.slice(0, str.length - str.trimStart().length);
    const trail = str.slice(lead.length + trimmed.length);
    const core = lead || trail ? own(trimmed) : trimmed;
    const trailStart = tp - trail.length;

    // Run-ene i avsnittet legges inn: merke, anker foran (og om det stod mellomrom på hver side), grunnformatets run.
    const first = runs.count;
    let idx = 0;
    let baseK = -1;
    let baseLetters = -1;
    let prevEnd = -1; // der forrige run i avsnittet sluttet i tbuf
    let gapBefore = false;
    let leadK = 0;
    let leadCut = 0;
    let trailK = 0;
    let trailCut = 0;
    for (let k = 0; k < m; k++) {
      if (keep[k]) {
        gapBefore = true;
        continue;
      }
      let f = RF[k];
      if (target[k]) {
        // En run med bare mellomrom tar tekst bare når ingen run med tekst i originalen passer (ellers kunne teksten
        // etter et anker havne i mellomrommet foran ankeret: «{\b fet} {\b fet}{fotnote} vanlig»).
        if (solid[k]) f |= TARGET;
        if (RS[k] === baseSig && letters[k] > baseLetters) {
          baseLetters = letters[k];
          baseK = idx;
        }
      }
      if (gapBefore || f & AFTER) {
        f |= GAP;
        if (prevEnd > 0 && CLASS[tb[prevEnd - 1]] & 4) f |= WSB;
        if (CLASS[tb[rts[k]]] & 4) f |= WSA;
        // Mellomrom foran/bak teksten som går over ankeret, deles ved ankeret når det settes tilbake.
        if (idx && toff[k] > 0 && toff[k] < lead.length) {
          leadK = idx;
          leadCut = toff[k];
        }
        if (idx && trail && toff[k] > trailStart) {
          trailK = idx;
          trailCut = toff[k] - trailStart;
        }
      }
      runs.add(c.rs[k], c.re[k], c.ru[k], f, fin[k]);
      prevEnd = endOf(k);
      gapBefore = false;
      idx++;
    }
    runs.flags.set(first + (baseK < 0 ? 0 : baseK), runs.flags.get(first + (baseK < 0 ? 0 : baseK)) | BASE);
    let flags = marks ? LITERAL : 0;
    if (str.includes("[") || str.includes("［")) flags |= BRACKETS | (/[[［]\s*\//.test(str) ? BRSLASH : 0);
    if (gapBefore || tailAnchor) flags |= TAILGAP | (CLASS[tb[prevEnd - 1]] & 4 ? TAILWS : 0);
    let edges = "";
    if (lead || trail) {
      edges = lead + EDGE_SEP + trail;
      if (leadK || trailK) edges += `${EDGE_SEP}${leadK},${leadCut},${trailK},${trailCut}`;
    }
    jobs.add(first, nTags, flags, edges, keepCore ? core : null);
    textChars += core.length;
    strBytes += (16 + core.length * (nTags || WIDE.test(core) ? 2 : 1) + 7) & ~7;
    if (nTags) {
      // Justeringen ved innlegging: biter (om lag 2 per merket strekk) × run-er, og gjenbrukte resultater.
      const cells = Math.min(DP_MAX, (2 * idx + 2) * (idx + 1));
      dpBytes = Math.max(dpBytes, 4 * cells + (cells >= DP_CACHE ? 4 * CACHE_MAX : 0) + 20 * (idx + 1));
    }
    checkMemory(); // stopper tidlig
    if (c.field) c.field.letters = true;
  }

  let i = 0;
  while (i < n) {
    const c = bytes[i];
    if (c === 0x7b || c === 0x7d) {
      closeRun();
      skip = 0;
      skipRun = -1;
      lastBare = -1;
      if (c === 0x7b) openGroup(i > 0 && bytes[i - 1] === 0x7b);
      else if (stack.length && closeGroup()) {
        rootEnd = i + 1;
        break;
      }
      i++;
      continue;
    }
    if (c === 0x0d || c === 0x0a) {
      i++; // linjeskift i kildefilen er ikke tekst
      continue;
    }
    if (c === 0x5c) {
      const start = i;
      const d = i + 1 < n ? bytes[i + 1] : -1;
      if (d < 0 || (d === 0x27 && i + 3 >= n)) {
        truncAt = i; // «\» eller «\'h» helt til slutt
        break;
      }
      if (isLetter(d)) {
        let j = i + 2;
        while (j < n && isLetter(bytes[j])) j++;
        const w = wordAt(bytes, i + 1, j);
        let k = j;
        let param = null;
        let numStart = j;
        if (k < n && (isDigit(bytes[k]) || (bytes[k] === 0x2d && k + 1 < n && isDigit(bytes[k + 1])))) {
          const neg = bytes[k] === 0x2d;
          if (neg) k++;
          numStart = k;
          let v = 0;
          while (k < n && isDigit(bytes[k])) v = v * 10 + bytes[k++] - 0x30;
          param = neg ? -v : v;
        }
        let end = k;
        let bare = true;
        if (end < n && bytes[end] === 0x20) {
          end++;
          bare = false;
        }
        if (w.kind === K.BIN && param > 0) {
          if (end + param > n) bin = { start: numStart, end: k, text: String(n - end) }; // avkuttet binærdata
          end = Math.min(n, end + param); // rå binærdata
          bare = false;
        }
        i = end;
        // Reservetegn kan være tegnord (\emdash); andre kontrollord (\par, \f …) avslutter reserven,
        // ellers kunne vi slettet struktur sammen med run-en.
        if (skip > 0 && w.kind === K.CHAR) {
          skip--;
          if (skipRun >= 0) top().re[skipRun] = end;
        } else {
          pending = skip > 0;
          skip = 0;
          controlWord(w, param, start, end);
          pending = false;
        }
        lastBare = bare ? end : -1;
        continue;
      }
      if (d === 0x27 && i + 3 < n && isHex(bytes[i + 2]) && isHex(bytes[i + 3])) {
        i += 4;
        if (skip > 0) {
          skip--;
          if (skipRun >= 0) top().re[skipRun] = i;
        } else byteText(start, i, hexVal(bytes[start + 2]) * 16 + hexVal(bytes[start + 3]));
        lastBare = -1;
        continue;
      }
      i += 2;
      const sym = CHAR_SYMBOLS.get(d);
      if (skip > 0 && sym !== undefined) {
        skip--;
        if (skipRun >= 0) top().re[skipRun] = i;
      } else {
        skip = 0;
        if (d === 0x0d || d === 0x0a) {
          closeRun(); // \<linjeskift> = \par
          if (g.mode === TEXT) endUnit();
        } else if (d === 0x2a) {
          closeRun();
          g.star = true;
        } else if (sym !== undefined) text(start, i, sym);
        else closeRun();
      }
      lastBare = -1;
      continue;
    }
    // Vanlig tekst
    if (skip > 0) {
      i++;
      skip--;
      if (skipRun >= 0) top().re[skipRun] = i;
      lastBare = -1;
      continue;
    }
    const st = textState();
    if (st !== 1) {
      let j = i + 1;
      while (j < n) {
        const b = bytes[j];
        if (b === 0x5c || b === 0x7b || b === 0x7d) break;
        j++;
      }
      if (g.table) tableText(i, j);
      else if (g.inst) {
        if (g.field.inst.length < 32) g.field.inst += bytes.toString("latin1", i, Math.min(j, i + 32));
      } else if (g.bk) {
        if (bkName.length < 64) bkName += bytes.toString("latin1", i, Math.min(j, i + 64));
      } else if (st === 2) markAnchor();
      else closeRun();
      i = j;
      lastBare = -1;
      continue;
    }
    if (c >= 0x20 && c < 0x7f) {
      let j = i + 1;
      while (j < n) {
        const b = bytes[j];
        if (b < 0x20 || b >= 0x7f || b === 0x5c || b === 0x7b || b === 0x7d) break;
        j++;
      }
      addAscii(i, j);
      i = j;
    } else {
      if (c >= 0x80) byteText(i, i + 1, c);
      else addCode(i, i + 1, c === 9 ? 9 : -1); // tab eller kontrolltegn
      i++;
    }
    lastBare = -1;
  }

  // Reparasjoner: det som står etter rotgruppen (annet enn mellomrom) tas bort; mangler } på slutten,
  // legges de til (etter å ha fjernet en avsluttende \ og rettet lengden på avkuttet \bin).
  const repair = { end: n, append: "", bin: null };
  if (rootEnd >= 0) {
    for (let x = rootEnd; x < n; x++) {
      const b = bytes[x];
      if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x00 && b !== 0x0c && b !== 0x1a) {
        repair.end = rootEnd;
        break;
      }
    }
  } else {
    const open = stack.length;
    while (stack.length) {
      closeRun();
      closeGroup();
    }
    if (truncAt >= 0) repair.end = truncAt;
    repair.bin = bin;
    repair.append = "}".repeat(open);
  }
  finishUnit(ctxs[0]);
  releaseScratch();
  repair.needed = repair.end !== n || Boolean(repair.append) || Boolean(repair.bin);
  checkMemory();
  return { runs, jobs, opaque, repair, textChars, memory };
}

// Tekst → RTF: ASCII som den er (\ { } escapes), alt annet som \uN med reservetegn etter \ucN.
// Skrives rett inn i utfilen (ingen streng på størrelse med avsnittet); encodeRtfText er samme regel som streng.
// asU: første tegn skrives som \uN uansett (run-er med PENDING).
function encodedLength(text, uc, asU = false) {
  let len = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (asU && i === 0) len += 2 + String(c > 0x7fff ? c - 0x10000 : c).length + (uc > 0 ? uc : 1);
    else if (c === 0x0a) len += 6;
    else if (c === 0x09) len += 5;
    else if (c === 0x5c || c === 0x7b || c === 0x7d) len += 2;
    else if (c < 0x20 || c === 0x7f) continue;
    else if (c < 0x80) len++;
    else len += 2 + String(c > 0x7fff ? c - 0x10000 : c).length + (uc > 0 ? uc : 1);
  }
  return len;
}

function encodeInto(buf, pos, text, uc, asU = false) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (asU && i === 0) {
      pos += buf.write(`\\u${c > 0x7fff ? c - 0x10000 : c}`, pos, "latin1");
      if (uc > 0) for (let k = 0; k < uc; k++) buf[pos++] = 0x3f;
      else buf[pos++] = 0x20;
    } else if (c === 0x0a) pos += buf.write("\\line ", pos, "latin1");
    else if (c === 0x09) pos += buf.write("\\tab ", pos, "latin1");
    else if (c === 0x5c || c === 0x7b || c === 0x7d) {
      buf[pos++] = 0x5c;
      buf[pos++] = c;
    } else if (c < 0x20 || c === 0x7f) continue;
    else if (c < 0x80) buf[pos++] = c;
    else {
      pos += buf.write(`\\u${c > 0x7fff ? c - 0x10000 : c}`, pos, "latin1");
      if (uc > 0) for (let k = 0; k < uc; k++) buf[pos++] = 0x3f;
      else buf[pos++] = 0x20;
    }
  }
  return pos;
}

function encodeRtfText(text, uc) {
  const buf = Buffer.alloc(encodedLength(text, uc));
  encodeInto(buf, 0, text, uc);
  return buf.toString("latin1");
}

// Merkevarianter fra modellen rettes før tolkningen: «⟦ 1 ⟧», «⟦ /1 ⟧», «⟦１⟧», «〚1〛» → «⟦1⟧»; andre ⟦ og ⟧ er rester og
// fjernes. «[1]…[/1]» brukes som merker bare når oversettelsen ikke har ⟦ ⟧, originalen hadde ⟦1⟧ (nummeret finnes)
// og ikke har [/ som tekst; har originalen [ (kildehenvisning «[1]»), bare [n] som har en [/n] etter seg (den nærmeste
// foran), så «[1]» som tekst står. Ikke i avsnitt der ⟦ ⟧ er tekst i originalen.
const TAG_ODD = new RegExp(TAG_STRAY.source); // finnes det noe annet enn ⟦n⟧ og ⟦/n⟧?
// Et merke som fjernes, tar med seg mellomrommet på én side når det står mellomrom på begge («rød ⟦ bil» → «rød bil»);
// siden med tab eller linjeskift blir stående.
const TAG_WS = /(\s*)⟦\/?\d+⟧(\s*)/g;
const TAG_STRAY_WS = new RegExp(`(\\s*)(?:${TAG_STRAY.source})(\\s*)`, "g");
const HARD_WS = /[\t\n]/;
const SOFT_EDGES = /^[^\S\t\n]+|[^\S\t\n]+$/g; // mellomrom (ikke tab og linjeskift) først og sist
const dropMarker = (m, a, b) => {
  if (!a || !b) return a + b;
  if (!HARD_WS.test(b)) return a;
  return HARD_WS.test(a) ? a + b : b;
};
const digitsOf = (d) => {
  if (/^\d+$/.test(d)) return Number(d);
  const s = d.normalize("NFKC");
  return /^\d+$/.test(s) ? Number(s) : -1;
};
function normalizeMarkers(t, nTags, jf) {
  if (jf & LITERAL) return t;
  if (/[⟦⟧〚〛]/.test(t)) {
    if (!TAG_ODD.test(t)) return t; // bare riktige merker
    return t.replace(TAG_VARIANT, (m, sl, d) => {
      const v = digitsOf(d);
      return v >= 0 ? `⟦${sl}${v}⟧` : m;
    }).replace(TAG_STRAY_WS, dropMarker);
  }
  if (!nTags || jf & BRSLASH || !BRACKET_CLOSE.test(t)) return t;
  const ok = (d) => digitsOf(d) >= 1 && digitsOf(d) <= nTags;
  if (!(jf & BRACKETS)) return t.replace(BRACKET_TAG, (m, sl, d) => (ok(d) ? `⟦${sl}${digitsOf(d)}⟧` : m));
  // Bare par: hver [/n] tar den nærmeste åpne [n] foran seg.
  const ms = [...t.matchAll(BRACKET_TAG)];
  const open = new Map();
  const use = new Uint8Array(ms.length);
  ms.forEach((m, x) => {
    if (!ok(m[2])) return;
    const v = digitsOf(m[2]);
    const list = open.get(v) || [];
    if (!m[1]) open.set(v, [...list, x]);
    else if (list.length) {
      use[list.pop()] = 1;
      use[x] = 1;
    }
  });
  let out = "";
  let pos = 0;
  ms.forEach((m, x) => {
    if (!use[x]) return;
    out += `${t.slice(pos, m.index)}⟦${m[1]}${digitsOf(m[2])}⟧`;
    pos = m.index + m[0].length;
  });
  return out + t.slice(pos);
}

// Oversatt tekst med ⟦n⟧-merker → biter [{ tag, text, w }]. null ved ubalanserte eller ukjente merker.
function parsePieces(full, nTags) {
  const pieces = [];
  let pos = 0;
  let open = 0;
  for (const m of full.matchAll(TAG)) {
    const n = Number(m[2]);
    if (m[1] ? open !== n : open || n < 1 || n > nTags) return null;
    if (m.index > pos) pieces.push({ tag: open, text: full.slice(pos, m.index) });
    open = m[1] ? 0 : n;
    pos = m.index + m[0].length;
  }
  if (open) return null;
  if (pos < full.length) pieces.push({ tag: 0, text: full.slice(pos) });
  for (const p of pieces) {
    let w = 0;
    for (let x = 0; x < p.text.length; x++) if (!(charClass(p.text.charCodeAt(x)) & 4)) w++;
    p.w = w;
  }
  return pieces;
}

// Kladd for plasseringen, gjenbrukt mellom avsnittene (ingen nye tabeller per avsnitt: de ville hopet seg opp som
// minne som ennå ikke er gitt tilbake). Slippes når utfilen er skrevet.
const PL = { runs: 0, cand: null, weak: null, pieces: 0, match: null, slot: null, cells: 0, f: null };
function placeScratch(len, P) {
  if (len > PL.runs) {
    PL.runs = Math.max(len, 2 * PL.runs, 64);
    PL.cand = new Int8Array(PL.runs);
    PL.weak = new Uint8Array(PL.runs);
  }
  if (P > PL.pieces) {
    PL.pieces = Math.max(P, 2 * PL.pieces, 64);
    PL.match = new Int32Array(PL.pieces);
    PL.slot = new Int32Array(PL.pieces);
  }
  return PL;
}
function dpScratch(cells) {
  if (cells > PL.cells) {
    PL.cells = Math.max(cells, Math.min(2 * PL.cells, DP_MAX));
    PL.f = new Int32Array(PL.cells);
  }
  return PL.f;
}
function releasePlaceScratch() {
  Object.assign(PL, { runs: 0, cand: null, weak: null, pieces: 0, match: null, slot: null, cells: 0, f: null });
}

// Største rekkefølgebevarende kobling bit → run med samme merke, vektet med antall tegn. Run-er uten eget format
// (weak: mellomrom/tegn i et format uten ord) tas bare når ingen vanlig run passer. match[i] = run eller -1.
// DP over biter × run-er opp til DP_MAX celler (noen få ms); ellers grådig i lineær tid.
function align(pieces, cand, weak, R, match) {
  const P = pieces.length;
  match.fill(-1, 0, P);
  if ((P + 1) * (R + 1) > DP_MAX) {
    // Grådig: hver bit tar neste ledige vanlige run med samme merke (lister per merke, pekere som bare går fram).
    const lists = new Map();
    for (let j = 0; j < R; j++) {
      if (weak[j]) continue;
      let l = lists.get(cand[j]);
      if (!l) lists.set(cand[j], (l = { at: 0, js: [] }));
      l.js.push(j);
    }
    let pos = 0;
    for (let i = 0; i < P; i++) {
      const p = pieces[i];
      const l = p.w ? lists.get(p.tag) : null;
      if (!l) continue;
      while (l.at < l.js.length && l.js[l.at] < pos) l.at++;
      if (l.at < l.js.length) {
        match[i] = l.js[l.at];
        pos = l.js[l.at++] + 1;
      }
    }
    return match;
  }
  const W = R + 1;
  const f = dpScratch((P + 1) * W);
  f.fill(0, P * W, (P + 1) * W); // siste rad og siste kolonne er 0
  for (let i = 0; i < P; i++) f[i * W + R] = 0;
  for (let i = P - 1; i >= 0; i--) {
    const tag = pieces[i].tag;
    const w2 = 2 * pieces[i].w;
    const row = i * W;
    const next = row + W;
    for (let j = R - 1; j >= 0; j--) {
      let v = f[next + j];
      const s = f[row + j + 1];
      if (s > v) v = s;
      if (w2 && cand[j] === tag) {
        const sc = w2 - weak[j] + f[next + j + 1];
        if (sc > v) v = sc;
      }
      f[row + j] = v;
    }
  }
  let i = 0;
  let j = 0;
  while (i < P && j < R) {
    const here = f[i * W + j];
    const p = pieces[i];
    const sc = p.w && cand[j] === p.tag ? 2 * p.w - weak[j] : 0;
    // Ved likt resultat: koble nå; ellers heller hoppe over biten (den legges inntil naboen) enn run-en.
    if (sc && sc + f[(i + 1) * W + j + 1] === here) match[i++] = j++;
    else if (f[(i + 1) * W + j] === here) i++;
    else j++;
  }
  return match;
}

const isSpace = (s, at) => at >= 0 && at < s.length && (charClass(s.charCodeAt(at)) & 4) !== 0;
const OPENING = /[([{«“‘„]$/;
const CLOSING = /^[.,;:!?)\]}»”’…]/;

// Legger den oversatte teksten i run-ene til ett avsnitt. Gir tekst per run (plass k: run first(j) + k; "" = run-en
// tømmes), eller null når oversettelsen er tom eller bare merker (avsnittet står da urørt).
// st: { cache, lost, count } – cache: justeringer som gjenbrukes i skriverunden; lost: avsnitt der merkene gikk tapt.
function placeJob(runs, jobs, j, translated, st) {
  const len = jobs.len(j);
  const first = jobs.first.get(j);
  const nTags = jobs.nTags(j);
  const jf = jobs.flags(j);
  const norm = normalizeMarkers(String(translated ?? "").replace(/\r\n?/g, "\n"), nTags, jf);
  // Har modellen mistet alle merkene, stod tab og linjeskift først og sist inni et merke (kjernen har ingen mellomrom i
  // kantene utenfor merkene): de blir stående, bare mellomrom tas bort.
  const t = nTags && !norm.includes("⟦") ? norm.replace(SOFT_EDGES, "") : norm.trim();
  if (!(jf & LITERAL ? t : t.replace(TAG, "").trim())) return null;
  const txt = new Array(len).fill("");
  const pieces = nTags ? parsePieces(t, nTags) : null;
  let match = null;
  let cand = null;
  let matched = false;
  const P = pieces ? pieces.length : 0;
  if (pieces) {
    const sc = placeScratch(len, P);
    cand = sc.cand;
    const weak = sc.weak;
    for (let k = 0; k < len; k++) {
      cand[k] = runs.tag.get(first + k);
      weak[k] = runs.flags.get(first + k) & TARGET ? 0 : 1;
    }
    match = st.cache.get(j);
    if (match) {
      st.cache.delete(j);
      st.cached -= match.length;
    } else {
      match = align(pieces, cand, weak, len, sc.match);
      const cells = (P + 1) * (len + 1);
      if (st.count && cells >= DP_CACHE && cells <= DP_MAX && st.cached + P <= CACHE_MAX) {
        st.cache.set(j, match.slice(0, P));
        st.cached += P;
      }
    }
    for (let x = 0; x < P && !matched; x++) if (match[x] >= 0) matched = true;
  }
  if (!matched) {
    // Ugyldige merker: alt i grunnformatets run; merker som ikke er tekst i originalen, fjernes (tab og linjeskift
    // først og sist blir stående, som over).
    if (nTags && st.count) st.lost++;
    let base = 0;
    while (base < len - 1 && !(runs.flags.get(first + base) & BASE)) base++;
    const all = nTags ? norm.replace(SOFT_EDGES, "") : t;
    txt[base] = jf & LITERAL ? all : all.replace(TAG_WS, dropMarker);
    withEdges(jobs, j, txt);
    return txt;
  }
  if (st.count && !t.includes("⟦")) st.lost++; // alle merkene er borte: teksten havner i run-ene uten merke
  // Biter uten egen run legges inntil naboen (helst en med samme merke), så rekkefølgen holder.
  const slot = PL.slot;
  slot.set(match.subarray(0, P));
  for (let a = 0; a < P;) {
    if (slot[a] >= 0) {
      a++;
      continue;
    }
    let e = a;
    while (e < P && match[e] < 0) e++;
    const prev = a > 0 ? slot[a - 1] : -1;
    const next = e < P ? match[e] : -1;
    if (e === a + 1 && !pieces[a].w && prev >= 0 && next >= 0) {
      // Bare mellomrom mellom to plasserte biter: i en run med samme merke mellom dem, om det finnes en
      // («⟦1⟧fet⟦/1⟧ ⟦2⟧kursiv⟦/2⟧»: mellomrommet blir verken fet eller kursivt).
      let r = prev + 1;
      while (r < next && cand[r] !== pieces[a].tag) r++;
      if (r < next) {
        slot[a] = r;
        a = e;
        continue;
      }
    }
    let useNext = false;
    for (let x = a; x < e; x++) {
      const p = pieces[x];
      // Mellomrom blir hos forrige; tekst går til neste bare når den har samme merke som den og ikke som forrige.
      if (!useNext && next >= 0 && (prev < 0 || (p.w && cand[prev] !== p.tag && cand[next] === p.tag))) useNext = true;
      slot[x] = useNext ? next : prev;
    }
    a = e;
  }
  for (let x = 0; x < P; x++) txt[slot[x]] += pieces[x].text;
  withEdges(jobs, j, txt);
  fixGaps(runs, jobs, j, first, txt);
  return txt;
}

// Mellomrom foran og bak avsnittets tekst settes tilbake der de stod: i første og siste run, og delt ved et anker
// når de gikk over det («logo ⟦bilde⟧ \tab»).
function withEdges(jobs, j, txt) {
  const e = jobs.edge.get(j);
  if (e < 0) return;
  const [lead, trail, split] = jobs.edges[e].split(EDGE_SEP);
  const [leadK, leadCut, trailK, trailCut] = split ? split.split(",").map(Number) : [0, 0, 0, 0];
  const last = txt.length - 1;
  // Mellomrom har ikke synlig format, så de kan stå i første/siste run uansett format.
  if (lead) {
    if (leadK) {
      txt[leadK] = lead.slice(leadCut) + txt[leadK];
      txt[0] = lead.slice(0, leadCut) + txt[0];
    } else txt[0] = lead + txt[0];
  }
  if (trail) {
    if (trailK) {
      txt[trailK - 1] += trail.slice(0, trailCut);
      txt[last] += trail.slice(trailCut);
    } else txt[last] += trail;
  }
}

// Ved hvert anker: stod det mellomrom foran eller bak ankeret i originalen, skal det stå der i resultatet også.
// Mellomrom på feil side flyttes; mangler det (modellen tok bort mellomrommet inni merket), settes ett inn –
// men ikke foran tegnsetting som «.» eller etter «(». Stod det mellomrom på begge sider og står begge nå på én side
// (mellomrommet i kanten av en uthevet run står utenfor merket), flyttes ett over i stedet for at ett settes inn.
function fixGaps(runs, jobs, j, first, txt) {
  const len = txt.length;
  const jf = jobs.flags(j);
  let p = -1; // siste run foran ankeret med tekst
  let nx = 0; // første run etter ankeret med tekst
  for (let q = 0; q <= len; q++) {
    if (q > 0 && txt[q - 1]) p = q - 1;
    let wantB;
    let wantA;
    if (q < len) {
      const f = runs.flags.get(first + q);
      if (!(f & GAP) || q === 0) continue;
      wantB = (f & WSB) !== 0;
      wantA = (f & WSA) !== 0;
    } else {
      if (!(jf & TAILGAP)) continue;
      wantB = (jf & TAILWS) !== 0;
      wantA = false;
    }
    if (nx < q) nx = q;
    while (nx < len && !txt[nx]) nx++;
    const before = p >= 0 ? txt[p] : "";
    const after = nx < len ? txt[nx] : "";
    let hb = isSpace(before, before.length - 1);
    let ha = isSpace(after, 0);
    if (wantB && !hb && before) {
      const w = ha && !wantA ? /^\s+/.exec(after)[0] : "";
      if (w) {
        txt[p] = before + w;
        txt[nx] = after.slice(w.length);
        ha = false;
      } else if (wantA && ha && isSpace(after, 1)) {
        txt[p] = before + after[0];
        txt[nx] = after.slice(1);
      } else if (!OPENING.test(before)) txt[p] = before + " ";
      hb = true;
    }
    if (wantA && !ha && after) {
      const cur = txt[p] || "";
      const w = hb && !wantB && p >= 0 ? /\s+$/.exec(cur)[0] : "";
      if (w) {
        txt[p] = cur.slice(0, cur.length - w.length);
        txt[nx] = w + txt[nx];
      } else if (wantB && p >= 0 && isSpace(cur, cur.length - 1) && isSpace(cur, cur.length - 2)) {
        txt[p] = cur.slice(0, -1);
        txt[nx] = cur[cur.length - 1] + txt[nx];
      } else if (!CLOSING.test(after)) txt[nx] = " " + txt[nx];
    }
  }
}

// Utfilen skrives i én buffer med riktig størrelse: første runde regner ut lengden, andre runde skriver run-ene
// i filrekkefølge. Plasseringen regnes ut på nytt i andre runde (så de nye tekstene aldri ligger i minnet samtidig),
// men de dyre justeringene gjenbrukes.
// order er avsnittene sortert etter der første run står i filen, translated[k] oversettelsen av avsnitt order[k]
// (null: ingen avsnitt endres, bare reparasjoner).
function buildOutput(bytes, doc, translated, order, onWarning) {
  const { runs, jobs, repair } = doc;
  const limit = repair.end;
  let size = limit + repair.append.length;
  if (repair.bin) size += repair.bin.text.length - (repair.bin.end - repair.bin.start);
  const st = { cache: new Map(), cached: 0, lost: 0, count: true };
  if (translated) {
    for (let k = 0; k < order.length; k++) {
      const j = order[k];
      const txt = placeJob(runs, jobs, j, translated[k], st);
      if (!txt) continue;
      const first = jobs.first.get(j);
      for (let x = 0; x < txt.length; x++) {
        const r = first + x;
        size -= runs.end.get(r) - runs.start.get(r);
        const v = txt[x];
        if (!v) continue;
        const f = runs.flags.get(r);
        size += (f & PREFIX ? 1 : 0) + encodedLength(v, runs.uc.get(r), (f & PENDING) !== 0);
      }
    }
    if (st.lost && onWarning) onWarning(markersWarning(st.lost));
  }
  st.count = false;
  const buf = Buffer.allocUnsafe(size);
  let pos = 0;
  let cursor = 0;
  if (translated) {
    // Avsnittene flettes i filrekkefølge: et avsnitt kan ha andre (fotnote, tekstboks) mellom run-ene sine.
    const open = []; // påbegynte avsnitt: { txt, r (neste run), end, k }
    let next = 0;
    for (;;) {
      let e = null;
      for (const o of open) if (!e || runs.start.get(o.r) < runs.start.get(e.r)) e = o;
      if (next < order.length) {
        const j = order[next];
        const first = jobs.first.get(j);
        if (!e || runs.start.get(first) < runs.start.get(e.r)) {
          const txt = placeJob(runs, jobs, j, translated[next++], st);
          if (txt) open.push({ txt, r: first, end: first + txt.length, k: 0 }); // null: avsnittet står urørt
          continue;
        }
      }
      if (!e) break;
      const r = e.r++;
      const v = e.txt[e.k++];
      if (e.r === e.end) open.splice(open.indexOf(e), 1);
      pos += bytes.copy(buf, pos, cursor, runs.start.get(r));
      cursor = runs.end.get(r);
      if (!v) continue; // tømt
      const f = runs.flags.get(r);
      if (f & PREFIX) buf[pos++] = 0x20; // skiller kontrollordet foran fra ny tekst
      pos = encodeInto(buf, pos, v, runs.uc.get(r), (f & PENDING) !== 0);
    }
  }
  if (repair.bin) {
    pos += bytes.copy(buf, pos, cursor, repair.bin.start);
    pos += buf.write(repair.bin.text, pos, "latin1");
    cursor = repair.bin.end;
  }
  pos += bytes.copy(buf, pos, cursor, limit);
  if (repair.append) pos += buf.write(repair.append, pos, "latin1");
  releasePlaceScratch();
  if (pos !== size) throw new Error(`RTF: feil lengde på utfilen (${pos} ≠ ${size}).`);
  return buf;
}

const what = (count) => (count === 1 ? "Ett avsnitt" : `${count} avsnitt`);

function charsetWarning(count) {
  return {
    code: "rtf_charset",
    message: `${what(count)} står uoversatt: teksten er lagret med et eldre tegnsett (f.eks. japansk, kinesisk eller koreansk uten Unicode) som ikke kan leses.`,
  };
}

function markersWarning(count) {
  return {
    code: "markers_lost",
    message: `${what(count)} fikk enklere formatering: oversettelsen mistet merkene som holder uthevede ord, fotnotemerker og bilder på plass. All teksten er med, men noe formatering kan ha flyttet seg.`,
  };
}

async function translateRtf(buffer, ctx = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!RTF_START.test(bytes.toString("latin1", 0, Math.min(64, bytes.length)))) throw new Error(NOT_RTF);
  const doc = parseRtf(bytes, { keepCore: !ctx.apply });
  const { jobs } = doc;
  if (doc.opaque && ctx.onWarning) ctx.onWarning(charsetWarning(doc.opaque));
  if (!jobs.count) return doc.repair.needed && !ctx.collect ? buildOutput(bytes, doc, null, null) : bytes;

  // Avsnittene i dokumentrekkefølge, etter der første run står (en fotnote avsluttes før avsnittet den står i).
  const { runs } = doc;
  const order = new Int32Array(jobs.count);
  for (let j = 0; j < jobs.count; j++) order[j] = j;
  order.sort((a, b) => runs.start.get(jobs.first.get(a)) - runs.start.get(jobs.first.get(b)));
  const strings = new Array(jobs.count);
  for (let k = 0; k < jobs.count; k++) strings[k] = ctx.apply ? "" : jobs.core[order[k]];
  jobs.core = null;
  const translated = await translateStrings({ ...ctx, strings });
  if (ctx.collect) return bytes; // skyjobbens første steg trenger bare strengene
  strings.length = 0; // kildeteksten trengs ikke lenger (minne)

  return buildOutput(bytes, doc, translated, order, ctx.onWarning);
}

module.exports = { translateRtf, parseRtf, encodeRtfText, CODEPAGES, DAMAGED, TOO_BIG, TOO_MUCH_TEXT };
