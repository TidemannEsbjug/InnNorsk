// Kommandolinjen: translate, setup (med falske security/launchctl), setup --uninstall og doctor.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const { LABEL } = require("../../mac/config");
const { stableNodePath } = require("../../mac/setup");
const { startFakeAgentApi } = require("../helpers/fake-agent-api");
const { minimalDocx } = require("../helpers/fixtures");
const { CLI, FAKE_GROK, machine, agentConfig, writeSetup, runCli } = require("./helpers");

const TOKEN = "dummy-token-for-setup-test";
const UID = process.getuid();
const readPlist = (file) =>
  JSON.parse(execFileSync("python3", ["-c", "import plistlib,sys,json; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))", file]));

test("translate skriver «(norsk)»-filer ved siden av originalen, i mapper og med --out/--nynorsk", async (t) => {
  const m = machine(t);
  const docs = path.join(m.home, "Dokumenter");
  fs.mkdirSync(path.join(docs, "Under"), { recursive: true });
  fs.writeFileSync(path.join(docs, "Brev.txt"), "Hello\n\nWorld\n");
  fs.writeFileSync(path.join(docs, "Under", "Notat.docx"), await minimalDocx(["Good morning"]));
  fs.writeFileSync(path.join(docs, "~$Notat.docx"), "låsefil");
  fs.writeFileSync(path.join(docs, "Bilde.png"), "ikke et dokument");
  const env = { ...m.env, INNNORSK_GROK: FAKE_GROK, FAKE_GROK_MODE: "ok", FAKE_GROK_LOG: m.grokLog };

  const first = await runCli(["translate", docs], { env });
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(fs.readFileSync(path.join(docs, "Brev (norsk).txt"), "utf8"), "NB:HELLO\n\nNB:WORLD\n");
  const xml = await (await JSZip.loadAsync(fs.readFileSync(path.join(docs, "Under", "Notat (norsk).docx")))).file("word/document.xml").async("string");
  assert.match(xml, /NB:GOOD MORNING/);
  assert.match(first.stdout, /2 av 2 filer oversatt\. Kostnad: \$0\.0014\./);
  assert.equal(m.grokCalls().length, 2, "låsefil, bilde og ingen egne utfiler");

  const again = await runCli(["translate", docs], { env });
  assert.match(again.stdout, /2 av 2 filer oversatt/, "egne (norsk)-filer oversettes ikke på nytt");

  const out = path.join(m.home, "ut");
  const nn = await runCli(["translate", path.join(docs, "Brev.txt"), "--nynorsk", "--out", out], { env });
  assert.equal(nn.code, 0);
  assert.equal(fs.readFileSync(path.join(out, "Brev (norsk).txt"), "utf8"), "NN:HELLO\n\nNN:WORLD\n");

  const bad = await runCli(["translate", path.join(docs, "Bilde.png"), path.join(docs, "borte.docx")], { env });
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /✗ Fant ikke .*borte\.docx/);
  assert.match(bad.stdout, /✗ Bilde\.png: Filtypen \.png støttes ikke\./);
});

test("setup lagrer token i nøkkelringen, skriver plist med absolutte stier og starter launchd", async (t) => {
  const m = machine(t);
  const env = { ...m.env, INNNORSK_GROK: FAKE_GROK };
  const input = `https://innnorsk.example.workers.dev/\n${TOKEN}\n~/Dokumenter/InnNorsk\n`;
  const r = await runCli(["setup"], { env, input });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, new RegExp(TOKEN), "tokenet vises ikke");
  assert.match(r.stdout, /Mottaket kjører i bakgrunnen/);

  const config = JSON.parse(fs.readFileSync(m.paths.configFile, "utf8"));
  assert.equal(config.siteUrl, "https://innnorsk.example.workers.dev");
  assert.equal(config.outputDir, path.join(m.home, "Dokumenter", "InnNorsk"));
  assert.equal(config.tokenStore, "keychain");
  assert.equal(config.grok.command, FAKE_GROK);
  assert.ok(fs.statSync(config.outputDir).isDirectory());
  assert.equal(fs.existsSync(m.paths.tokenFile), false);
  assert.deepEqual(m.binCalls("security").find((c) => c[0] === "add-generic-password"), [
    "add-generic-password", "-s", LABEL, "-a", "agent-token", "-U", "-w", TOKEN,
  ]);

  const plist = readPlist(m.paths.plistFile);
  assert.equal(m.paths.plistFile, path.join(m.home, "Library/LaunchAgents/no.innnorsk.mottak.plist"));
  assert.equal(plist.Label, LABEL);
  assert.deepEqual(plist.ProgramArguments, [stableNodePath(), CLI, "run"]);
  assert.ok(plist.ProgramArguments.slice(0, 2).every((p) => path.isAbsolute(p)));
  assert.equal(plist.RunAtLoad, true);
  assert.equal(plist.KeepAlive, true);
  assert.equal(plist.EnvironmentVariables.HOME, m.home);
  const PATH = plist.EnvironmentVariables.PATH.split(":");
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", path.dirname(FAKE_GROK)]) assert.ok(PATH.includes(dir), dir);
  const log = path.join(m.home, "Library/Logs/InnNorsk/mottak.log");
  assert.equal(plist.StandardOutPath, log);
  assert.equal(plist.StandardErrorPath, log);
  assert.ok(fs.existsSync(path.dirname(log)));
  assert.deepEqual(m.binCalls("launchctl"), [
    ["bootout", `gui/${UID}/${LABEL}`],
    ["bootstrap", `gui/${UID}`, m.paths.plistFile],
  ]);

  const again = await runCli(["setup"], { env, input: "\n\n\n" });
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /Enter = behold det lagrede/);
  assert.equal(m.binCalls("security").filter((c) => c[0] === "add-generic-password").at(-1).at(-1), TOKEN);
  assert.deepEqual(m.binCalls("launchctl").at(-2), ["bootout", `gui/${UID}/${LABEL}`]);

  const un = await runCli(["setup", "--uninstall"], { env });
  assert.equal(un.code, 0);
  assert.equal(fs.existsSync(m.paths.plistFile), false);
  assert.deepEqual(m.binCalls("launchctl").at(-1), ["bootout", `gui/${UID}/${LABEL}`]);
  assert.equal(m.binCalls("security").at(-1)[0], "delete-generic-password");
  assert.ok(fs.existsSync(m.paths.configFile), "oppsettet beholdes");
});

test("setup uten security lagrer tokenet i en fil bare eieren kan lese", async (t) => {
  const m = machine(t, { keychain: false });
  const r = await runCli(["setup"], { env: { ...m.env, INNNORSK_GROK: FAKE_GROK }, input: `http://127.0.0.1:9\n${TOKEN}\n\n` });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(m.paths.tokenFile, "utf8")).token, TOKEN);
  assert.equal(fs.statSync(m.paths.tokenFile).mode & 0o777, 0o600);
  const config = JSON.parse(fs.readFileSync(m.paths.configFile, "utf8"));
  assert.equal(config.tokenStore, "file");
  assert.equal(config.outputDir, path.join(m.home, "InnNorsk"));

  const invalid = await runCli(["setup"], { env: m.env, input: "innnorsk.no\n" });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Ugyldig adresse/);
});

async function doctorSetup(t, mode) {
  const m = machine(t);
  const api = await startFakeAgentApi();
  t.after(() => api.close());
  writeSetup(m, agentConfig(api, m), api.token);
  execFileSync(m.bins.launchctl, ["bootstrap", `gui/${UID}`, m.paths.plistFile]);
  const r = await runCli(["doctor"], { env: { ...m.env, FAKE_GROK_MODE: mode, FAKE_GROK_LOG: m.grokLog } });
  return { m, api, ...r };
}

test("doctor: alt i orden gir bare ✓, med kommandoen som ble kjørt", async (t) => {
  const { api, code, stdout } = await doctorSetup(t, "ok");
  assert.equal(code, 0, stdout);
  assert.doesNotMatch(stdout, /✗/);
  for (const line of [
    /✓ Oppsett: .*config\.json/,
    /✓ Agent-tokenet er lagret i .*agent\.json/,
    /✓ Nettstedet svarer: http:\/\/127\.0\.0\.1/,
    /✓ Tokenet er godtatt – ingen filer venter/,
    /✓ Grok CLI oversatte en prøvetekst på [\d,]+ s \(«NB:GOOD MORNING»\) – kostnad \$0\.0007/,
    /✓ Kan skrive til .*InnNorsk/,
    /✓ Mottaket kjører i bakgrunnen \(launchd, pid 4242\)/,
    /Alt ser bra ut/,
  ]) {
    assert.match(stdout, line);
  }
  assert.match(stdout, new RegExp(`Kommando: ${FAKE_GROK} --no-auto-update --output-format json .* --effort low --prompt-file /\\S+prompt\\.txt`));
  assert.equal(api.heartbeats[0].stateMessage, "Sjekk fra doctor");
});

test("doctor: eldre Grok-versjon uten flaggene får beskjed om varianten som virker", async (t) => {
  const { m, code, stdout } = await doctorSetup(t, "minimal");
  assert.equal(code, 1);
  assert.match(stdout, /Feilet: Grok CLI feilet: error: unexpected argument '--no-auto-update' found/);
  assert.match(stdout, new RegExp(`Prøver med bare --prompt-file: ${FAKE_GROK} --prompt-file /\\S+`));
  assert.match(stdout, /✗ Grok CLI virker bare uten de ekstra flaggene \(svarte «NB:GOOD MORNING»/);
  assert.match(stdout, /"args": \[\] og "effort": null/);
  assert.equal(m.grokCalls().length, 2);
});

test("doctor: ikke logget inn i Grok, og uten oppsett", async (t) => {
  const auth = await doctorSetup(t, "auth");
  assert.equal(auth.code, 1);
  assert.match(auth.stdout, /✗ Grok CLI er ikke logget inn/);
  assert.match(auth.stdout, /→ Kjør «grok login»/);
  assert.equal(auth.m.grokCalls().length, 1, "ingen ny variant når problemet er innlogging");

  const m = machine(t);
  const bare = await runCli(["doctor"], { env: { ...m.env, INNNORSK_GROK: path.join(m.home, "grok-mangler") } });
  assert.equal(bare.code, 1);
  assert.match(bare.stdout, /✗ Mottaket er ikke satt opp ennå\.\n\s+→ Kjør: node mac\/innnorsk-mottak\.js setup/);
  assert.match(bare.stdout, /✗ Fant ikke Grok CLI/);
  assert.match(bare.stdout, /✗ Mottaket er ikke lastet i launchd/);
});
