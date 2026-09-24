// Ende-til-ende i ekte nettleser (Playwright/Chromium) mot wrangler dev + falsk xAI. Kaller ALDRI det ekte API-et.
//   npm run e2e                     skjermbilder i <tmp>/innnorsk-e2e (E2E_SHOTS=<mappe> for et annet sted)
// Krever global Playwright med Chromium og python3 med python-docx og openpyxl (lager testdokumentene).
// Feiler ved konsollfeil, CSP-brudd og vannrett rulling på mobil.
const assert = require("node:assert/strict");
const { execFileSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JSZip = require("jszip");
const workerDev = require("../helpers/worker-dev");
const mockServer = require("../helpers/mock-xai-server");

const SHOTS = process.env.E2E_SHOTS || path.join(os.tmpdir(), "innnorsk-e2e");
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 375, height: 812 };
// Bare dummyverdier.
const ADMIN = { username: "eier", password: "eier-testpassord-123" };
const SVETLANA = { username: "svetlana", password: "testpassord-123" };
const AUTH_MESSAGE = /problem hos oss/;
const EXPECTED_ERROR = "e2e-test";

function loadPlaywright() {
  const candidates = ["playwright"];
  try {
    candidates.push(path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "playwright"));
  } catch {
    // npm mangler: prøv standardstien under
  }
  candidates.push("/opt/node22/lib/node_modules/playwright");
  for (const name of candidates) {
    try {
      return require(name);
    } catch {
      // neste kandidat
    }
  }
  throw new Error("Fant ikke Playwright. Installer det globalt: npm i -g playwright");
}

const step = (text) => console.log(`• ${text}`);

// Testdokumentene lages med ekte Word/Excel-biblioteker, så de ligner filer fra virkeligheten.
function makeFixtures(dir) {
  const script = String.raw`
import os, sys
from docx import Document
from docx.shared import Pt
from openpyxl import Workbook
d = sys.argv[1]
doc = Document()
run = doc.add_paragraph().add_run("Application for a kindergarten place")
run.bold = True
run.font.size = Pt(20)
for i in range(30):
    doc.add_paragraph(f"Paragraph {i + 1}: We would like to apply for a place for our daughter Åse Øvrebø. Thank you.")
table = doc.add_table(rows=3, cols=2)
for r, (a, b) in enumerate([("Name", "Åse Øvrebø"), ("Date of birth", "12.03.2021"), ("Wishes", "Close to home")]):
    table.cell(r, 0).text = a
    table.cell(r, 1).text = b
doc.save(os.path.join(d, "Søknad æøå.docx"))
wb = Workbook()
ws = wb.active
ws.title = "Budget"
ws.append(["Item", "Amount", "Comment"])
ws.append(["Rent", 12000, "Paid every month"])
ws.append(["Food", 4500, "Groceries for the family"])
ws["B4"] = "=SUM(B2:B3)"
wb.save(os.path.join(d, "budsjett.xlsx"))
`;
  execFileSync("python3", ["-c", script, dir]);
  const paragraphs = Array.from({ length: 1100 }, (_, i) => `Note ${i + 1}: Remember to call the school about the trip on Friday.`);
  fs.writeFileSync(path.join(dir, "notater.txt"), `${paragraphs.join("\n\n")}\n`);
  fs.writeFileSync(path.join(dir, "tall.csv"), "Name,Amount,Comment\nRent,12000,Paid every month\nFood,4500,Groceries\n");
  const folder = path.join(dir, "Mappe");
  fs.mkdirSync(path.join(folder, "Undermappe"), { recursive: true });
  fs.writeFileSync(path.join(folder, "brev.txt"), "Dear neighbour,\n\nThe party starts at six.\n");
  fs.writeFileSync(path.join(folder, "Undermappe", "notat.md"), "# Shopping list\n\nMilk, bread and cheese.\n");
  fs.writeFileSync(path.join(folder, ".DS_Store"), "x");
  return {
    docx: path.join(dir, "Søknad æøå.docx"),
    xlsx: path.join(dir, "budsjett.xlsx"),
    txt: path.join(dir, "notater.txt"),
    csv: path.join(dir, "tall.csv"),
    folder,
  };
}

// Playwright kan ikke blande filstier og buffere i samme filvalg.
const fromDisk = (file) => ({ name: path.basename(file), mimeType: "application/octet-stream", buffer: fs.readFileSync(file) });

// Navnene i zip-filens sentralkatalog, med UTF-8-flagget (bit 11) som Windows trenger for æøå.
function zipEntries(buf) {
  const out = [];
  for (let i = buf.indexOf("PK\x01\x02"); i !== -1; i = buf.indexOf("PK\x01\x02", i + 4)) {
    const flags = buf.readUInt16LE(i + 8);
    const len = buf.readUInt16LE(i + 28);
    out.push({ name: buf.subarray(i + 46, i + 46 + len).toString("utf8"), utf8: Boolean(flags & 0x800) });
  }
  return out;
}

async function main() {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(SHOTS, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "innnorsk-e2e-files-"));
  const files = makeFixtures(tmp);
  const problems = [];
  let mock;
  let dev;
  let browser;

  try {
    mock = await mockServer.start({ mode: "slow", delayMs: 400 });
    dev = await workerDev.start({
      mockUrl: mock.url,
      vars: {
        ADMIN_USERNAME: ADMIN.username,
        ADMIN_PASSWORD: ADMIN.password,
        SEED_USER_USERNAME: "Svetlana",
        SEED_USER_PASSWORD: SVETLANA.password,
        XAI_API_KEY: "mock",
      },
    });
    const base = dev.url;
    // Med C-locale kan ikke Chromium lagre filnavn med æøå, og kaller nedlastingen «download».
    const utf8 = /utf-?8/i.test(process.env.LC_ALL || process.env.LANG || "");
    browser = await chromium.launch({ env: { ...process.env, ...(utf8 ? {} : { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }) } });

    async function newContext() {
      const context = await browser.newContext({
        viewport: DESKTOP,
        locale: "nb-NO",
        timezoneId: "Europe/Oslo",
        acceptDownloads: true,
        ignoreHTTPSErrors: true, // bare for Google Fonts bak en eventuell proxy
      });
      // Skrifter er pynt: kan de ikke hentes, brukes reserveskriften uten feil i konsollen.
      await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (route) => {
        try {
          await route.fulfill({ response: await route.fetch() });
        } catch {
          await route.fulfill({ status: 200, contentType: "text/css", body: "" });
        }
      });
      await context.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP-brudd: ${e.violatedDirective} ${e.blockedURI}`));
      });
      return context;
    }

    function watch(page, label) {
      const report = (text) => {
        if (!text.includes(EXPECTED_ERROR)) problems.push(`${label}: ${text}`);
      };
      page.on("console", (m) => m.type() === "error" && report(m.text()));
      page.on("pageerror", (e) => report(`pageerror ${e.message}`));
      return page;
    }

    // Skjermbilde på PC og mobil, og sjekk at mobilen ikke får vannrett rulling.
    async function shot(page, name, selector) {
      const target = selector ? page.locator(selector) : page;
      const opts = selector ? {} : { fullPage: true };
      await target.screenshot({ path: path.join(SHOTS, `e2e-${name}-desktop.png`), ...opts });
      await page.setViewportSize(MOBILE);
      await page.waitForTimeout(200);
      await target.screenshot({ path: path.join(SHOTS, `e2e-${name}-mobile.png`), ...opts });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) problems.push(`${name}: vannrett rulling på 375 px (${overflow} px for bredt)`);
      await page.setViewportSize(DESKTOP);
    }

    const text = (page, selector) => page.locator(selector).innerText();
    const startResponse = (page) =>
      page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/jobs\/[a-z2-7]+\/start$/.test(r.url()));
    const jobUrl = (id) => `${base}/api/jobs/${id}`;

    async function waitForJob(context, id, until) {
      const deadline = Date.now() + 120000;
      for (;;) {
        const { job } = await (await context.request.get(jobUrl(id))).json();
        if (until(job)) return job;
        assert.ok(Date.now() < deadline, `jobben ${id} ble ikke ferdig: ${job.status}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    async function login(page, { username, password }) {
      await page.goto(`${base}/`);
      await page.waitForURL(/\/login$/);
      await page.fill("#username", username);
      await page.fill("#password", password);
      await page.click("#login-submit");
      await page.waitForURL(`${base}/`);
    }

    // ---------- a) Innlogging ----------
    step("a) Svetlana logger inn med små bokstaver");
    const ctx = await newContext();
    let page = watch(await ctx.newPage(), "svetlana");
    await page.goto(`${base}/login`);
    await page.waitForSelector("#login-form");
    await shot(page, "login");
    await login(page, SVETLANA);
    await page.waitForSelector("#doc-groups .empty");
    assert.equal(await text(page, "#hello"), "Hei, Svetlana!");
    assert.equal(await page.locator("#pw-dialog").evaluate((d) => d.open), false, "ingen tvungen passordbytte");
    assert.equal(await page.locator("#admin-link").isHidden(), true);
    assert.match(await text(page, "#doc-groups"), /Du har ingen ennå/);
    await shot(page, "main-empty");

    // ---------- b) Legg til filer ----------
    step("b) filer, mappe, og filer som hoppes over");
    await page.setInputFiles("#input-folder", files.folder);
    await page.waitForSelector("#skipped:not([hidden])");
    assert.match(await text(page, "#skipped"), /Skjulte filer og systemfiler/);
    await page.setInputFiles("#input-files", [
      ...[files.docx, files.txt, files.csv, files.xlsx].map(fromDisk),
      { name: "program.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") },
      { name: "~$lås.docx", mimeType: "application/octet-stream", buffer: Buffer.from("x") },
    ]);
    const skipped = await text(page, "#skipped");
    assert.match(skipped, /2 filer ble ikke lagt til/);
    assert.match(skipped, /Midlertidige filer fra Word.*~\$lås\.docx/s);
    assert.match(skipped, /Filtyper som ikke kan oversettes.*program\.exe/s);
    await page.waitForFunction(() => !document.getElementById("btn-start").disabled, null, { timeout: 60000 });
    assert.equal(await page.locator("#file-list .file").count(), 6);
    const summary = await text(page, "#summary");
    assert.match(summary, /6 dokumenter blir oversatt til bokmål/);
    assert.match(summary, /Beregnet tid: (ca\. \d+ min|under 1 min)/);
    assert.match(await text(page, "#file-list"), /Mappe\/Undermappe\/\s*notat\.md/);
    await shot(page, "files");

    // ---------- c) Nynorsk og start ----------
    step("c) velger nynorsk (utkastet lages på nytt) og starter");
    await page.check("input[name=lang][value=nynorsk]");
    await page.waitForFunction(() => /til nynorsk/.test(document.getElementById("summary").textContent)
      && !document.getElementById("btn-start").disabled, null, { timeout: 60000 });
    assert.equal(await page.locator("#file-list .file").count(), 6);
    const started = startResponse(page);
    await page.click("#btn-start");
    const jobId = (await (await started).json()).job.id;
    await page.waitForSelector("#working:not([hidden])");
    await page.waitForFunction(() => /igjen – ferdig rundt kl\. \d\d:\d\d|Straks ferdig/.test(document.getElementById("eta").textContent)
      && /\d+ %/.test(document.getElementById("pct").textContent), null, { timeout: 30000 });
    assert.match(await text(page, "#now"), /Nå: |Gjør klar|står i kø/);
    assert.match(await text(page, "#heartbeat"), /Sist oppdatert: (akkurat nå|for \d+ sekunder siden)/);
    assert.match(await text(page, "#working"),
      /Du kan vente her, eller lukke siden og komme tilbake senere\. Oversettelsen fortsetter, og de ferdige dokumentene blir liggende under «Mine dokumenter»\./);
    assert.match(await page.title(), /^\(\d+ %\) InnNorsk$/);
    await shot(page, "working");

    // ---------- d) Lukk siden og kom tilbake ----------
    step("d) lukker siden midt i jobben og kommer tilbake");
    await page.close({ runBeforeUnload: true });
    await new Promise((r) => setTimeout(r, 1500));
    const between = await (await ctx.request.get(jobUrl(jobId))).json();
    assert.ok(["queued", "running"].includes(between.job.status), `jobben går fortsatt (${between.job.status})`);
    page = watch(await ctx.newPage(), "svetlana-2");
    const resumed = page.waitForRequest((r) => r.url() === jobUrl(jobId));
    await page.goto(`${base}/`);
    await resumed;
    await page.waitForSelector("#working:not([hidden])");
    await page.waitForSelector("#done:not([hidden])", { timeout: 120000 });
    assert.equal(await page.title(), "✓ Ferdig – InnNorsk");
    assert.equal(await text(page, "#done-title"), "Ferdig! Dokumentene er oversatt.");
    assert.match(await text(page, "#done-lead"), /Alle 6 dokumentene er oversatt til nynorsk/);
    assert.equal(await page.locator("#results .btn-download").count(), 6);
    await page.waitForSelector("#doc-groups .doc");
    await shot(page, "done");

    // ---------- e) Nedlasting ----------
    step("e) laster ned ett dokument og zip-filen");
    const row = page.locator("#results .result", { hasText: "Søknad æøå.docx" });
    const [download] = await Promise.all([page.waitForEvent("download"), row.locator(".btn-download").click()]);
    assert.equal(download.suggestedFilename(), "Søknad æøå.docx");
    const docx = await JSZip.loadAsync(fs.readFileSync(await download.path()));
    const xml = await docx.file("word/document.xml").async("string");
    assert.match(xml, /NB:APPLICATION FOR A KINDERGARTEN PLACE/);
    assert.match(xml, /<w:tbl>/, "tabellen er med");
    assert.match(xml, /NB:ÅSE ØVREBØ/, "tabellcellene er oversatt");
    assert.match(xml, /<w:b\/>[\s\S]*<w:sz w:val="40"\/>/, "fet 20 pt overskrift er beholdt");

    const [zipDownload] = await Promise.all([page.waitForEvent("download"), page.click("#zip-link")]);
    assert.match(zipDownload.suggestedFilename(), /^InnNorsk-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
    const zipBuf = fs.readFileSync(await zipDownload.path());
    const zip = await JSZip.loadAsync(zipBuf);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    assert.deepEqual(names, ["budsjett.xlsx", "Mappe/brev.txt", "Mappe/Undermappe/notat.md", "notater.txt", "Søknad æøå.docx", "tall.csv"].sort());
    assert.ok(zipEntries(zipBuf).filter((e) => /[^\x00-\x7f]/.test(e.name)).every((e) => e.utf8), "UTF-8-flagg på norske navn");
    assert.match(await zip.file("Mappe/brev.txt").async("string"), /^NB:DEAR NEIGHBOUR,/);
    assert.match(await zip.file("tall.csv").async("string"), /NB:RENT,12000/);

    // ---------- f) Mine dokumenter ----------
    step("f) Mine dokumenter: sletter ett dokument");
    const docs = page.locator("#doc-groups .doc");
    assert.equal(await docs.count(), 6);
    assert.match(await text(page, "#doc-groups"), /6 dokumenter oversatt kl\. \d\d:\d\d/);
    await shot(page, "mine", "#mine");
    const csvDoc = docs.filter({ hasText: "tall.csv" });
    const csvHref = await csvDoc.locator("a.btn").getAttribute("href");
    await csvDoc.getByRole("button", { name: "Slett tall.csv" }).click();
    await page.waitForSelector("dialog.modal[open]");
    assert.match(await text(page, "dialog.modal[open]"), /«tall\.csv» blir slettet/);
    await page.click("dialog.modal[open] button[value=ok]");
    await page.waitForSelector("#toast.show");
    assert.equal(await text(page, "#toast"), "Dokumentet er slettet.");
    assert.equal(await docs.count(), 5);
    const gone = await ctx.request.get(`${base}${csvHref}`);
    assert.equal(gone.status(), 410);
    assert.equal((await gone.json()).error, "Dokumentet er slettet.");
    await page.reload();
    await page.waitForSelector("#doc-groups .doc");
    assert.equal(await docs.count(), 5, "fortsatt borte etter ny innlasting");

    // ---------- g) Velkommen tilbake ----------
    step("g) ny jobb, lukker siden, kommer tilbake etter at den er ferdig");
    await page.click("#btn-again").catch(() => {});
    await page.setInputFiles("#input-files", [{ name: "hilsen.txt", mimeType: "text/plain", buffer: Buffer.from("Hello from the school.\n") }]);
    await page.waitForFunction(() => !document.getElementById("btn-start").disabled);
    const started2 = startResponse(page);
    await page.click("#btn-start");
    const job2 = (await (await started2).json()).job.id;
    await page.waitForSelector("#working:not([hidden])");
    await page.close({ runBeforeUnload: true });
    await waitForJob(ctx, job2, (j) => j.status === "done");
    page = watch(await ctx.newPage(), "svetlana-3");
    await page.goto(`${base}/`);
    await page.waitForSelector("#welcome:not([hidden])");
    assert.equal(await text(page, "#welcome p"), "Velkommen tilbake! 1 dokument er ferdig og klart til nedlasting.");
    assert.equal(await page.locator("#setup").isVisible(), true);
    assert.equal(await page.locator("#doc-groups .doc", { hasText: "hilsen.txt" }).locator(".pill").innerText(), "Ny");
    await shot(page, "welcome");

    // ---------- i) Feil fra xAI ----------
    step("i) xAI avviser nøkkelen (401)");
    await fetch(`${mock.url}/__mode`, { method: "POST", body: JSON.stringify({ mode: "fail401" }) });
    await page.setInputFiles("#input-files", [{ name: "feil.txt", mimeType: "text/plain", buffer: Buffer.from("This will fail.\n") }]);
    await page.waitForFunction(() => !document.getElementById("btn-start").disabled);
    const started3 = startResponse(page);
    await page.click("#btn-start");
    const failedJob = (await (await started3).json()).job.id;
    await page.waitForSelector("#done:not([hidden])", { timeout: 60000 });
    assert.equal(await text(page, "#done-title"), "Det gikk dessverre ikke denne gangen");
    assert.match(await text(page, "#done-lead"), AUTH_MESSAGE);
    assert.doesNotMatch(await text(page, "#done"), /401|xAI|API/, "ingen teknisk sjargong for Svetlana");
    assert.equal(await page.title(), "InnNorsk");
    await shot(page, "failed");

    // ---------- j) Feil i nettleseren ----------
    step("j) en JavaScript-feil i nettleseren havner i loggen");
    const logged = page.waitForResponse((r) => r.url().endsWith("/api/client-log"));
    await page.evaluate((msg) => setTimeout(() => {
      throw new Error(msg);
    }), EXPECTED_ERROR);
    assert.equal((await logged).status(), 204);

    // ---------- h) Admin ----------
    step("h) admin: oversikt, jobber, logg, økter og brukere");
    const adminCtx = await newContext();
    const adm = watch(await adminCtx.newPage(), "admin");
    await login(adm, ADMIN);
    await adm.waitForSelector("#admin-link:not([hidden])");
    await adm.click("#admin-link");
    await adm.waitForURL(/\/admin/);
    await adm.waitForSelector("#stats .stat");
    assert.match(await text(adm, "#stats"), /API-nøkkelen er satt/);
    assert.equal(await adm.locator("#key-banner").isHidden(), true);
    await shot(adm, "admin-oversikt");

    await adm.click("#tab-jobber");
    await adm.click(`#jobs-table tr[data-job="${jobId}"] button`);
    await adm.waitForSelector("#drill h3");
    const drill = await text(adm, "#drill");
    const calls = Number(/Grok-kall \((\d+)\)/.exec(drill)[1]);
    assert.ok(calls > 40, `grok-kall i drill-down: ${calls}`);
    assert.match(drill, /Estimert \/ faktisk\s+\d+ (s|min)[^/]*\/ \d+ (s|min)/);
    await shot(adm, "admin-jobb");
    await adm.click(`#jobs-table tr[data-job="${failedJob}"] button`);
    await adm.waitForFunction((id) => document.querySelector("#drill code")?.textContent === id, failedJob);
    const failedDrill = await text(adm, "#drill");
    assert.match(failedDrill, /\[auth\] xAI avviste API-nøkkelen \(401\)/);
    assert.match(failedDrill, /grok\.error/);

    await adm.click("#tab-logg");
    await adm.waitForSelector("#log-table tbody tr code");
    const expectations = {
      "auth.login": /Svetlana/,
      "file.uploaded": /Søknad æøå\.docx/,
      "job.finished": /Oversettelsen er ferdig/,
      "download.file": /Søknad æøå\.docx lastet ned/,
      "download.zip": /InnNorsk-.*\.zip lastet ned/,
      "file.deleted": /tall\.csv slettet/,
      "client.error": new RegExp(EXPECTED_ERROR),
      "grok.error": /401/,
    };
    for (const [type, pattern] of Object.entries(expectations)) {
      await adm.selectOption("#log-type", type);
      await adm.waitForFunction((t) => {
        const codes = [...document.querySelectorAll("#log-table tbody tr code")];
        return codes.length > 0 && codes.every((c) => c.textContent === t);
      }, type);
      assert.match(await text(adm, "#log-table tbody"), pattern, type);
    }
    await adm.selectOption("#log-type", "");
    await adm.waitForFunction(() => new Set([...document.querySelectorAll("#log-table tbody tr code")].map((c) => c.textContent)).size > 3);
    await shot(adm, "admin-logg");

    await adm.click("#tab-okter");
    await adm.waitForSelector("#sessions-table tbody tr");
    const sessions = await text(adm, "#sessions-table tbody");
    assert.match(sessions, /Svetlana/);
    assert.match(sessions, /eier/);
    await shot(adm, "admin-okter");

    await adm.click("#tab-brukere");
    await adm.waitForSelector("#users-table tbody tr");
    assert.match(await text(adm, "#users-table tbody"), /Svetlana/);
    await shot(adm, "admin-brukere");

    assert.deepEqual(problems, [], "konsollfeil, CSP-brudd eller rulling på mobil");
    console.log(`\nE2E OK. Skjermbilder: ${SHOTS}`);
  } catch (err) {
    if (dev) console.error(`\n--- wrangler dev (siste linjer) ---\n${dev.logs().slice(-3000)}`);
    if (problems.length) console.error(`\n--- problemer i nettleseren ---\n${problems.join("\n")}`);
    throw err;
  } finally {
    if (browser) await browser.close();
    if (dev) await dev.stop();
    if (mock) await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
