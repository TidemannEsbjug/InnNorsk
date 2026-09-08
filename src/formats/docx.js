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

function collectParagraphs(xml) {
  const paras = [];
  const re = /<w:p\b[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[0];
    const texts = [];
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let t;
    while ((t = tRe.exec(block))) {
      texts.push(decodeXmlEntities(t[1]));
    }
    paras.push({
      start: m.index,
      end: m.index + block.length,
      xml: block,
      text: texts.join(""),
    });
  }
  return paras;
}

function replaceParagraphText(paraXml, translated) {
  const tRe = /<w:t\b[^>]*>[\s\S]*?<\/w:t>/g;
  const matches = [...paraXml.matchAll(tRe)];
  if (!matches.length) return paraXml;

  let used = false;
  let out = paraXml;
  // Replace from the end so indexes stay valid if we rebuild via sequential replace.
  // Simpler: rebuild by walking matches.
  let cursor = 0;
  let rebuilt = "";
  matches.forEach((match, i) => {
    rebuilt += paraXml.slice(cursor, match.index);
    const full = match[0];
    const attrMatch = full.match(/^<w:t([^>]*)>/);
    const attrs = attrMatch ? attrMatch[1] : "";
    const withSpace = attrs.includes("xml:space") ? attrs : `${attrs} xml:space="preserve"`;
    if (i === 0) {
      rebuilt += `<w:t${withSpace}>${escapeXml(translated)}</w:t>`;
      used = true;
    } else {
      rebuilt += `<w:t${withSpace}></w:t>`;
    }
    cursor = match.index + full.length;
  });
  rebuilt += paraXml.slice(cursor);
  return used ? rebuilt : paraXml;
}

async function translateDocxBuffer(buffer, ctx) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter(
    (n) => !zip.files[n].dir && isTranslatablePart(n)
  );

  for (const name of names) {
    let xml = await zip.file(name).async("string");
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

    // Apply from the end of the file so offsets remain valid.
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
