// Ekte Word- og Excel-filer laget og lest med python-docx og openpyxl, så testene bruker dokumenter som ligner
// dem Svetlana har, og vet at resultatet åpner seg i vanlige programmer (ikke bare i vår egen kode).
const { execFileSync } = require("node:child_process");

const MAKE_DOCX = String.raw`
import sys
from docx import Document
from docx.shared import Pt
out, count = sys.argv[1], int(sys.argv[2])
doc = Document()
title = doc.add_paragraph().add_run("Application for a kindergarten place")
title.bold = True
title.font.size = Pt(20)
for i in range(count):
    doc.add_paragraph(f"Paragraph {i + 1}: We would like to apply for a place for our daughter Åse Øvrebø.")
doc.add_paragraph().add_run("Thank you for your help.").italic = True
table = doc.add_table(rows=3, cols=2)
for r, (a, b) in enumerate([("Name", "Åse Øvrebø"), ("Place", "Tromsø, near the fjord"), ("Wishes", "Close to home")]):
    table.cell(r, 0).text = a
    table.cell(r, 1).text = b
doc.save(out)
`;

const READ_DOCX = String.raw`
import sys, json
from docx import Document
d = Document(sys.argv[1])
def run(r):
    return {"text": r.text, "bold": r.bold, "italic": r.italic, "size": r.font.size.pt if r.font.size else None}
print(json.dumps({
    "paragraphs": [{"text": p.text, "runs": [run(r) for r in p.runs if r.text]} for p in d.paragraphs],
    "tables": [[[c.text for c in row.cells] for row in t.rows] for t in d.tables],
}))
`;

const MAKE_XLSX = String.raw`
import sys
from openpyxl import Workbook
from openpyxl.styles import Font
wb = Workbook()
ws = wb.active
ws.title = "Budget"
ws.append(["Item", "Amount", "Comment"])
ws.append(["Rent", 12000, "Paid every month"])
ws.append(["Food", 4500, "Groceries for the family"])
ws["B4"] = "=SUM(B2:B3)"
for c in ws[1]:
    c.font = Font(bold=True)
wb.save(sys.argv[1])
`;

const READ_XLSX = String.raw`
import sys, json
import openpyxl
ws = openpyxl.load_workbook(sys.argv[1]).active
print(json.dumps({
    "title": ws.title,
    "rows": [[c.value for c in row] for row in ws.iter_rows()],
    "bold": [c.font.bold for c in ws[1]],
}))
`;

const python = (script, ...args) => execFileSync("python3", ["-c", script, ...args.map(String)], { encoding: "utf8" });

// Overskrift (fet, 20 pt) + count avsnitt + kursiv linje + tabell 3×2, med æøå.
function makeDocx(file, count = 60) {
  python(MAKE_DOCX, file, count);
  return file;
}

// { paragraphs: [{ text, runs: [{ text, bold, italic, size }] }], tables: [[[celle]]] }
const readDocx = (file) => JSON.parse(python(READ_DOCX, file));

// Budsjett med tall, formel og fet overskriftsrad.
function makeXlsx(file) {
  python(MAKE_XLSX, file);
  return file;
}

// { title, rows: [[verdi]], bold: [overskriftsrad fet?] }
const readXlsx = (file) => JSON.parse(python(READ_XLSX, file));

module.exports = { makeDocx, readDocx, makeXlsx, readXlsx };
