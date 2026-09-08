const JSZip = require("jszip");
const { translateStrings } = require("../grok");
const { escapeXml, decodeXmlEntities } = require("../xml-util");

const TEXT_FILES = [
  /^word\/document\.xml$/,
  /^word\/header\d*\.xml$/,
  /^word\/footer\d*\.xml$/,
  /^word\/footnotes\.xml$/,
  /^word\/endnotes\.xml$/,
];

function isTranslatablePart(name) {
  return TEXT_FILES.some((re) => re.test(name));
}

function paragraphPlainText(block) {
  let text = "";
  const tokenRe = /<w:tab\b[^/]*\/>|<w:br\b[^/]*\/>|<w:cr\b[^/]*\/>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let t;
  while ((t = tokenRe.exec(block))) {
    if (t[0].startsWith("<w:tab")) text += "\t";
    else if (t[0].startsWith("<w:br") || t[0].startsWith("<w:cr")) text += "\n";
    else text += decodeXmlEntities(t[1] || "");
  }
  return text;
}

function collectParagraphs(xml) {
  const paras = [];
  const re = /<w:p\b[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[0];
    paras.push({
      start: m.index,
      end: m.index + block.length,
      xml: block,
      text: paragraphPlainText(block),
    });
  }
  return paras;
}

function firstRunFormattedText(translated, sampleAttrs) {
  const attrs = sampleAttrs || "";
  const withSpace = attrs.includes("xml:space") ? attrs : `${attrs} xml:space="preserve"`;
  const lines = String(translated).split("\n");
  return lines
    .map((line, i) => {
      const t = `<w:t${withSpace}>${escapeXml(line)}</w:t>`;
      return i === 0 ? t : `<w:br/>${t}`;
    })
    .join("");
}

function replaceParagraphText(paraXml, translated) {
  const tRe = /<w:t\b[^>]*>[\s\S]*?<\/w:t>/g;
  const matches = [...paraXml.matchAll(tRe)];
  if (!matches.length) return paraXml;

  const attrMatch = matches[0][0].match(/^<w:t([^>]*)>/);
  const attrs = attrMatch ? attrMatch[1] : "";
  let cursor = 0;
  let rebuilt = "";
  matches.forEach((match, i) => {
    rebuilt += paraXml.slice(cursor, match.index);
    if (i === 0) {
      rebuilt += firstRunFormattedText(translated, attrs);
    } else {
      const innerAttr = match[0].match(/^<w:t([^>]*)>/);
      const a = innerAttr ? innerAttr[1] : "";
      const withSpace = a.includes("xml:space") ? a : `${a} xml:space="preserve"`;
      rebuilt += `<w:t${withSpace}></w:t>`;
    }
    cursor = match.index + match[0].length;
  });
  rebuilt += paraXml.slice(cursor);
  return rebuilt;
}

async function translateDocxBuffer(buffer, ctx) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter(
    (n) => !zip.files[n].dir && isTranslatablePart(n)
  );

  for (const name of names) {
    const xml = await zip.file(name).async("string");
    const paras = collectParagraphs(xml);
    const indexes = [];
    const strings = [];
    paras.forEach((p, i) => {
      if (p.text.trim()) {
        indexes.push(i);
        strings.push(p.text);
      }
    });
    if (!strings.length) continue;

    const translated = await translateStrings({
      ...ctx,
      strings,
    });

    const mapped = paras.map((p) => p.xml);
    indexes.forEach((paraIndex, n) => {
      mapped[paraIndex] = replaceParagraphText(paras[paraIndex].xml, translated[n]);
    });

    let rebuilt = "";
    let cursor = 0;
    paras.forEach((p, i) => {
      rebuilt += xml.slice(cursor, p.start);
      rebuilt += mapped[i];
      cursor = p.end;
    });
    rebuilt += xml.slice(cursor);
    zip.file(name, rebuilt);
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

module.exports = { translateDocxBuffer };
