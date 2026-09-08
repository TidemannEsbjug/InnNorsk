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

function inlineFromText(text) {
  const lines = String(text).split("\n");
  return lines
    .map((line, i) => {
      const t = `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`;
      return i === 0
        ? `<w:r>${t}</w:r>`
        : `<w:r><w:br/></w:r><w:r>${t}</w:r>`;
    })
    .join("");
}

function paragraphXml(text, compact) {
  const spacing = compact
    ? `<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>`
    : `<w:pPr><w:spacing w:before="0" w:after="160" w:line="276" w:lineRule="auto"/></w:pPr>`;
  if (text == null || text === "") {
    return `<w:p>${spacing}</w:p>`;
  }
  return `<w:p>${spacing}${inlineFromText(text)}</w:p>`;
}

function documentXml(paragraphs, compact) {
  const body = paragraphs.map((p) => paragraphXml(p, compact)).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body>
</w:document>`;
}

async function buildSimpleDocx(paragraphs, { compact } = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.folder("_rels").file(".rels", RELS);
  const word = zip.folder("word");
  word.file("document.xml", documentXml(paragraphs.filter((p) => p != null), compact));
  word.file("styles.xml", STYLES);
  word.folder("_rels").file("document.xml.rels", DOC_RELS);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}

module.exports = { buildSimpleDocx, inlineFromText };
