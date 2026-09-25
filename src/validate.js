const JSZip = require("jszip");
const { XMLValidator } = require("fast-xml-parser");

const OOXML = new Set([".docx", ".pptx", ".xlsx"]);
// XML 1.0 tillater ikke disse kontrolltegnene, heller ikke som entiteter.
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|&#(?:x0*[0-8bcef]|x0*1[0-9a-f]|0*(?:[0-8]|1[1-2]|1[4-9]|2[0-9]|3[01]));/i;

async function validateOoxml(buffer) {
  const errors = [];
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    return [`Kunne ikke åpne filen som zip: ${err.message}`];
  }
  if (!zip.file("[Content_Types].xml")) errors.push("Mangler [Content_Types].xml");
  const names = Object.keys(zip.files).filter(
    (n) => !zip.files[n].dir && /\.(xml|rels)$/i.test(n)
  );
  for (const name of names) {
    const xml = await zip.file(name).async("string");
    if (ILLEGAL_XML.test(xml)) {
      errors.push(`${name}: ugyldig kontrolltegn i XML`);
      continue;
    }
    const res = XMLValidator.validate(xml, { allowBooleanAttributes: true });
    if (res !== true) {
      const e = res.err || {};
      errors.push(`${name}: ${e.msg || "ugyldig XML"} (linje ${e.line}, kolonne ${e.col})`);
    }
  }
  return errors;
}

async function validateOutput(buffer, outExt) {
  const ext = String(outExt || "").toLowerCase();
  let errors = [];
  if (!buffer || !buffer.length) {
    errors.push("Tom fil");
  } else if (OOXML.has(ext)) {
    errors = await validateOoxml(buffer);
  } else if (ext === ".pdf") {
    const head = Buffer.from(buffer.subarray(0, 1024)).toString("latin1");
    const tail = Buffer.from(buffer.subarray(Math.max(0, buffer.length - 1024))).toString("latin1");
    if (!head.includes("%PDF-")) errors.push("Mangler PDF-hode (%PDF-)");
    if (!tail.includes("%%EOF")) errors.push("Mangler PDF-slutt (%%EOF)");
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validateOutput };
