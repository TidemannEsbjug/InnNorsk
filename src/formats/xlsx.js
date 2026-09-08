const XLSX = require("xlsx");
const { translateStrings } = require("../grok");

function looksNumeric(value) {
  if (typeof value === "number") return true;
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (!t) return true;
  if (/^[=+\-/*]/.test(t) && /[A-Z]+\d+/i.test(t)) return true;
  if (/^[\d\s.,:%€$krNOK\-]+$/.test(t) && /\d/.test(t)) return true;
  return false;
}

async function translateXlsxBuffer(buffer, ctx) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const jobs = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheet["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[addr];
        if (!cell) continue;
        if (cell.f) continue;
        if (cell.t !== "s" && cell.t !== "str") continue;
        const value = cell.v == null ? "" : String(cell.v);
        if (!value.trim() || looksNumeric(value)) continue;
        jobs.push({ sheet, addr, value });
      }
    }
  }

  if (!jobs.length) {
    return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  }

  const translated = await translateStrings({
    ...ctx,
    strings: jobs.map((j) => j.value),
  });

  jobs.forEach((job, i) => {
    const cell = job.sheet[job.addr];
    cell.v = translated[i];
    cell.w = undefined;
    cell.t = "s";
  });

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

module.exports = { translateXlsxBuffer };
