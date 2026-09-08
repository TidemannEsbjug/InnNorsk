const JSZip = require("jszip");
const { escapeXml } = require("../xml-util");

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
</w:styles>`;

function mapFont(name) {
  const raw = String(name || "").replace(/^[A-Z]{6}\+/, "");
  const n = raw.toLowerCase();
  if (n.includes("times")) return "Times New Roman";
  if (n.includes("courier")) return "Courier New";
  if (n.includes("helvetica") || n.includes("arial")) return "Arial";
  if (n.includes("georgia")) return "Georgia";
  if (n.includes("garamond")) return "Garamond";
  if (n.includes("calibri")) return "Calibri";
  if (n.includes("cambria")) return "Cambria";
  if (n.includes("verdana")) return "Verdana";
  if (n.includes("tahoma")) return "Tahoma";
  if (n.includes("trebuchet")) return "Trebuchet MS";
  if (n.includes("palatino")) return "Palatino Linotype";
  if (n.includes("garamond")) return "Garamond";
  if (n.includes("bookman")) return "Bookman Old Style";
  if (n.includes("century")) return "Century Schoolbook";
  const cleaned = raw.replace(/[-,]?(Bold|Italic|Oblique|Regular|Medium|Light|Roman|Black|SemiBold).*$/i, "").trim();
  return cleaned || "Calibri";
}

function halfPoints(fontSizePt) {
  const pt = Number(fontSizePt) || 11;
  return Math.max(16, Math.min(192, Math.round(pt * 2)));
}

function rPrXml(style = {}) {
  const font = escapeXml(mapFont(style.fontName));
  const sz = halfPoints(style.fontSize);
  return `<w:rPr>
      <w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>
      <w:sz w:val="${sz}"/>
      <w:szCs w:val="${sz}"/>
      ${style.bold ? "<w:b/><w:bCs/>" : ""}
      ${style.italic ? "<w:i/><w:iCs/>" : ""}
    </w:rPr>`;
}

function inlineFromText(text, style) {
  const pr = rPrXml(style);
  const lines = String(text ?? "").split("\n");
  return lines
    .map((line, i) => {
      const t = `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`;
      if (i === 0) return `<w:r>${pr}${t}</w:r>`;
      return `<w:r>${pr}<w:br/></w:r><w:r>${pr}${t}</w:r>`;
    })
    .join("");
}

function normalizePara(p) {
  if (p == null) return { text: "" };
  if (typeof p === "string") return { text: p };
  return p;
}

function paragraphXml(raw, compact) {
  const p = normalizePara(raw);
  const after = p.spaceAfter != null ? p.spaceAfter : compact ? 0 : 160;
  const before = p.spaceBefore != null ? p.spaceBefore : 0;
  const line = p.lineTwips != null ? p.lineTwips : compact ? 240 : 276;
  const align = p.align && p.align !== "left" ? `<w:jc w:val="${p.align}"/>` : "";
  const spacing = `<w:pPr>${align}<w:spacing w:before="${before}" w:after="${after}" w:line="${line}" w:lineRule="auto"/></w:pPr>`;
  if (!p.text) return `<w:p>${spacing}</w:p>`;
  return `<w:p>${spacing}${inlineFromText(p.text, p)}</w:p>`;
}

function ptToTwips(pt) {
  return Math.round(Number(pt) * 20);
}

function documentXml(paragraphs, compact, page) {
  const body = paragraphs.map((p) => paragraphXml(p, compact)).join("");
  const w = page && page.widthPt ? ptToTwips(page.widthPt) : 11906;
  const h = page && page.heightPt ? ptToTwips(page.heightPt) : 16838;
  const m = page && page.marginPt != null ? ptToTwips(page.marginPt) : 1134;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr><w:pgSz w:w="${w}" w:h="${h}"/><w:pgMar w:top="${m}" w:right="${m}" w:bottom="${m}" w:left="${m}"/></w:sectPr></w:body>
</w:document>`;
}

async function buildSimpleDocx(paragraphs, { compact, page } = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.folder("_rels").file(".rels", RELS);
  const word = zip.folder("word");
  word.file("document.xml", documentXml(paragraphs.filter((p) => p != null), compact, page));
  word.file("styles.xml", STYLES);
  word.folder("_rels").file("document.xml.rels", DOC_RELS);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}

module.exports = { buildSimpleDocx, inlineFromText, mapFont };
