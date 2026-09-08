const JSZip = require("jszip");
const { translateStrings } = require("../grok");
const { escapeXml, decodeXmlEntities } = require("../xml-util");

function isSlidePart(name) {
  return /^ppt\/(slides|notesSlides)\/.+\.xml$/.test(name);
}

function collectParagraphs(xml) {
  const paras = [];
  const re = /<a:p\b[\s\S]*?<\/a:p>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[0];
    const texts = [];
    const tRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
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
  const tRe = /<a:t\b[^>]*>[\s\S]*?<\/a:t>/g;
  const matches = [...paraXml.matchAll(tRe)];
  if (!matches.length) return paraXml;
  let cursor = 0;
  let rebuilt = "";
  matches.forEach((match, i) => {
    rebuilt += paraXml.slice(cursor, match.index);
    const full = match[0];
    const attrMatch = full.match(/^<a:t([^>]*)>/);
    const attrs = attrMatch ? attrMatch[1] : "";
    if (i === 0) {
      rebuilt += `<a:t${attrs}>${escapeXml(translated)}</a:t>`;
    } else {
      rebuilt += `<a:t${attrs}></a:t>`;
    }
    cursor = match.index + full.length;
  });
  rebuilt += paraXml.slice(cursor);
  return rebuilt;
}

async function translatePptxBuffer(buffer, ctx) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter(
    (n) => !zip.files[n].dir && isSlidePart(n)
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

    const translated = await translateStrings({ ...ctx, strings });
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

module.exports = { translatePptxBuffer };
