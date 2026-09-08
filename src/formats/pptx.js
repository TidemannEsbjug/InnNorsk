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

function runProps(runXml) {
  const m = runXml.match(/<a:rPr\b[^>]*\/>|<a:rPr\b[\s\S]*?<\/a:rPr>/);
  return m ? m[0] : "";
}

function replaceParagraphText(paraXml, translated) {
  const runRe = /<a:r\b[\s\S]*?<\/a:r>/g;
  const runs = [...paraXml.matchAll(runRe)];
  if (!runs.length) return paraXml;

  let best = 0;
  let bestLen = -1;
  runs.forEach((run, i) => {
    const len = paragraphPlainText(run[0]).replace(/\s/g, "").length;
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  });

  const tRe = /<a:t\b[^>]*>[\s\S]*?<\/a:t>/g;
  const bestRun = runs[best][0];
  const tMatches = [...bestRun.matchAll(tRe)];
  if (!tMatches.length) return paraXml;
  const attrMatch = tMatches[0][0].match(/^<a:t([^>]*)>/);
  const attrs = attrMatch ? attrMatch[1] : "";
  const rPr = runProps(bestRun);
  const lines = String(translated).split("\n");

  let runOut = "";
  let cursor = 0;
  tMatches.forEach((match, i) => {
    runOut += bestRun.slice(cursor, match.index);
    if (i === 0) {
      runOut += lines
        .map((line, li) => {
          const t = `<a:t${attrs}>${escapeXml(line)}</a:t>`;
          return li === 0 ? t : `</a:r><a:br/><a:r>${rPr}${t}`;
        })
        .join("");
    } else {
      runOut += `<a:t${attrs}></a:t>`;
    }
    cursor = match.index + match[0].length;
  });
  runOut += bestRun.slice(cursor);

  let rebuilt = "";
  cursor = 0;
  runs.forEach((run, i) => {
    rebuilt += paraXml.slice(cursor, run.index);
    if (i === best) rebuilt += runOut;
    else {
      rebuilt += run[0].replace(tRe, (full) => {
        const a = (full.match(/^<a:t([^>]*)>/) || [])[1] || "";
        return `<a:t${a}></a:t>`;
      });
    }
    cursor = run.index + run[0].length;
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
