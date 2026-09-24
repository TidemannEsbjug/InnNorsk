// Ekte Word-, Excel- og PDF-filer gjennom mottaket med falsk Grok CLI. Resultatene åpnes med
// python-docx og openpyxl, så vi vet at filene er gyldige for vanlige programmer, ikke bare for oss.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");
const { createAgent } = require("../../mac/agent");
const { localDate } = require("../../mac/local-files");
const { startFakeAgentApi } = require("../helpers/fake-agent-api");
const { minimalDocx, minimalPdf } = require("../helpers/fixtures");
const { machine, fakeGrok, agentConfig } = require("./helpers");

const READ_TEXT = `
import sys, docx, openpyxl
kind, path = sys.argv[1], sys.argv[2]
if kind == "docx":
    print("\\n".join(p.text for p in docx.Document(path).paragraphs))
else:
    ws = openpyxl.load_workbook(path).active
    print("\\n".join(str(c.value) for row in ws.iter_rows() for c in row if c.value is not None))
`;

const readText = (kind, file) => execFileSync("python3", ["-c", READ_TEXT, kind, file], { encoding: "utf8" });

function xlsxBuffer() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Comment"], ["Ola", "Good morning"], ["Total", 42]]), "Ark1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

test("docx, xlsx og pdf blir gyldige norske filer, på nettstedet og lokalt", async (t) => {
  const m = machine(t);
  fakeGrok(t, m, "ok");
  const api = await startFakeAgentApi();
  t.after(() => api.close());
  const agent = createAgent({ config: agentConfig(api, m), token: api.token, paths: m.paths, write: () => {} });

  const docx = api.addFile({ name: "Brev.docx", body: await minimalDocx(["Hello world", "Kind regards"]) });
  const xlsx = api.addFile({ name: "Budsjett.xlsx", body: xlsxBuffer(), targetLanguage: "nynorsk" });
  const pdf = api.addFile({ name: "Vær.pdf", body: minimalPdf() });
  assert.equal(await agent.run({ once: true }), 0);
  for (const f of [docx, xlsx, pdf]) assert.equal(f.status, "done", f.name);
  assert.equal(pdf.outputName, "Vær.docx");

  const folder = path.join(m.home, "InnNorsk", `${localDate()} Svetlana`);
  const local = (name) => {
    const file = path.join(folder, name);
    assert.ok(fs.existsSync(file), name);
    return file;
  };
  assert.deepEqual(fs.readFileSync(local("Vær (norsk).docx")), pdf.result);

  const docText = readText("docx", local("Brev (norsk).docx"));
  assert.match(docText, /NB:HELLO WORLD\nNB:KIND REGARDS/);
  const sheetText = readText("xlsx", local("Budsjett (norsk).xlsx"));
  assert.match(sheetText, /NN:GOOD MORNING/);
  assert.match(sheetText, /\b42\b/, "tall oversettes ikke");
  assert.doesNotMatch(sheetText, /NN:42/);
  const pdfText = readText("docx", local("Vær (norsk).docx"));
  assert.match(pdfText, /NB:WEATHER REPORT/);
  assert.match(pdfText, /NB:THIS IS THE FIRST LINE ABOUT BERGEN\./);
});
