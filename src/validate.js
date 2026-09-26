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

// RTF: må starte med {\rtf, ha balanserte krøllparenteser og bare mellomrom/NUL etter rotgruppen.
// \{ \} og rådata etter \binN teller ikke (samme regel som formats/rtf.js). Leser bytene direkte.
const RTF_TAIL = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x1a, 0x20]);
const isDigit = (c) => c >= 0x30 && c <= 0x39;

function validateRtf(buffer) {
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const n = bytes.length;
  const errors = [];
  if (!/^(?:\xEF\xBB\xBF)?\s*\{\\rtf/.test(bytes.toString("latin1", 0, Math.min(64, n)))) {
    errors.push("Mangler RTF-hode ({\\rtf)");
  }
  let depth = 0;
  let i = 0;
  while (i < n) {
    const c = bytes[i];
    if (c === 0x5c) {
      // \binN (+ ett mellomrom): N byte rådata som ikke leses
      if (bytes[i + 1] === 0x62 && bytes[i + 2] === 0x69 && bytes[i + 3] === 0x6e && isDigit(bytes[i + 4])) {
        let j = i + 4;
        let len = 0;
        while (j < n && isDigit(bytes[j])) len = len * 10 + bytes[j++] - 0x30;
        if (j < n && bytes[j] === 0x20) j++;
        i = j + len;
      } else i += 2;
      continue;
    }
    if (c === 0x7b) depth++;
    else if (c === 0x7d) {
      if (depth === 0) {
        errors.push(`For mange } (posisjon ${i})`);
        break;
      }
      if (--depth === 0) {
        for (let x = i + 1; x < n; x++) {
          if (!RTF_TAIL.has(bytes[x])) {
            errors.push(bytes[x] === 0x7d ? `For mange } (posisjon ${x})` : `Innhold etter slutten av dokumentet (posisjon ${x})`);
            break;
          }
        }
        return errors;
      }
    }
    i++;
  }
  if (depth > 0) errors.push(`${depth} gruppe(r) mangler }`);
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
  } else if (ext === ".rtf") {
    errors = validateRtf(buffer);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validateOutput };
