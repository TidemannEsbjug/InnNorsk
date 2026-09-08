function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function replaceTaggedText(xml, tagName, replacements) {
  const re = new RegExp(`<${tagName}(\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, "g");
  let i = 0;
  return xml.replace(re, (full, attrs, inner) => {
    if (i >= replacements.length) return full;
    const next = replacements[i++];
    if (next === null || next === undefined) return full;
    const attr = attrs || "";
    const space = attr.includes("xml:space") ? attr : `${attr} xml:space="preserve"`;
    return `<${tagName}${space}>${escapeXml(next)}</${tagName}>`;
  });
}

function extractTaggedText(xml, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml))) {
    out.push(decodeXmlEntities(m[1]));
  }
  return out;
}

module.exports = { escapeXml, decodeXmlEntities, replaceTaggedText, extractTaggedText };
