const JSZip = require("jszip");
const { translateStrings } = require("../grok");
const { escapeXml, decodeXmlEntities } = require("../xml-util");

function isSlidePart(name) {
  return /^ppt\/(slides|notesSlides)\/.+\.xml$/.test(name);
}

function paragraphPlainText(block) {
  let text = "";
  const tokenRe = /<a:br\b[^/]*\/>|<a:tab\b[^/]*\/>|<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
  let t;
  while ((t = tokenRe.exec(block))) {
    if (t[0].startsWith("<a:br")) text += "\n";
    else if (t[0].startsWith("<a:tab")) text += "\t";
    else text += decodeXmlEntities(t[1] || "");
  }
  return text;
}

function collectParagraphs(xml) {
  const paras = [];
  const re = /<a:p\b[\s\S]*?<\/a:p>/g;
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

function replaceParagraphText(paraXml, translated) {
  const tRe = /<a:t\b[^>]*>[\s\S]*?<\/a:t>/g;
  const matches = [...paraXml.matchAll(tRe)];
  if (!matches.length) return paraXml;
  const attrMatch = matches[0][0].match(/^<a:t([^>]*)>/);
  const attrs = attrMatch ? attrMatch[1] : "";
  const lines = String(translated).split("\n");
  let cursor = 0;
  let rebuilt = "";
  matches.forEach((match, i) => {
    rebuilt += paraXml.slice(cursor, match.index);
    if (i === 0) {
      rebuilt += lines
        .map((line, li) => {
          const t = `<a:t${attrs}>${escapeXml(line)}</a:t>`;
          return li === 0 ? t : `</a:r><a:br/><a:r>${t}`;
        })
        .join("");
    } else {
      rebuilt += `<a:t${attrs}></a:t>`;
    }
    cursor = match.index + match[0].length;
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
