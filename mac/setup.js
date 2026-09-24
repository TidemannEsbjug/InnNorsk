// «setup»: spør etter nettstedsadresse, agent-token og mappe, lagrer oppsettet og starter mottaket under launchd.
// «setup --uninstall»: stopper mottaket, fjerner det fra oppstart og sletter tokenet.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { Writable } = require("node:stream");
const { LABEL, loadConfig, saveConfig, readToken, storeToken, deleteToken, expandHome } = require("./config");
const { run, firstLine, findCommand } = require("./system");

const SCRIPT = path.join(__dirname, "innnorsk-mottak.js");
const TEMPLATE = path.join(__dirname, `${LABEL}.plist.template`);
const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

// Spørsmål i Terminal. Skjult svar (tokenet) ekkoes ikke.
function prompter(input, output) {
  let muted = false;
  const echo = new Writable({
    write(chunk, _enc, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const rl = readline.createInterface({ input, output: echo, terminal: Boolean(input.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question, fallback = "", { hidden = false, hint = fallback } = {}) {
      output.write(`${question}${hint ? ` [${hint}]` : ""}: `);
      muted = hidden;
      const { value, done } = await lines.next();
      muted = false;
      if (hidden || !input.isTTY) output.write("\n");
      if (done) throw new Error("Oppsettet ble avbrutt.");
      return value.trim() || fallback;
    },
    close: () => rl.close(),
  };
}

// Homebrew-lenken (/opt/homebrew/bin/node) overlever «brew upgrade»; stien inn i Cellar gjør ikke det.
function stableNodePath(execPath = process.execPath) {
  const real = fs.realpathSync(execPath);
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    try {
      if (fs.realpathSync(candidate) === real) return candidate;
    } catch {
      // finnes ikke
    }
  }
  return execPath;
}

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderPlist({ node, grokCommand, paths }) {
  const dirs = [path.dirname(node), grokCommand.includes("/") ? path.dirname(grokCommand) : "", ...SYSTEM_PATH];
  const values = {
    LABEL,
    NODE: node,
    SCRIPT,
    WORKDIR: path.dirname(__dirname),
    PATH: [...new Set(dirs.filter(Boolean))].join(":"),
    HOME: paths.home,
    LOG: paths.logFile,
  };
  return fs.readFileSync(TEMPLATE, "utf8").replace(/\{\{(\w+)\}\}/g, (_, key) => xmlEscape(values[key]));
}

const serviceDomain = () => `gui/${process.getuid()}`;

async function loadService(paths) {
  const launchctl = paths.bins.launchctl;
  await run(launchctl, ["bootout", `${serviceDomain()}/${LABEL}`]);
  for (let attempt = 1; ; attempt++) {
    const r = await run(launchctl, ["bootstrap", serviceDomain(), paths.plistFile]);
    if (r.code === 0) return;
    if (r.missing) throw new Error("Fant ikke launchctl. Oppsettet må kjøres på Mac-en.");
    if (attempt >= 3) throw new Error(`launchctl bootstrap feilet: ${firstLine(r.stderr) || `kode ${r.code}`}`);
    await new Promise((resolve) => setTimeout(resolve, 1000)); // launchd trenger et øyeblikk etter bootout
  }
}

async function setup({ paths, input = process.stdin, output = process.stdout }) {
  const print = (line = "") => output.write(line + "\n");
  const { config } = loadConfig(paths);
  const saved = await readToken(paths, config);
  const prompt = prompter(input, output);
  try {
    print("InnNorsk mottak – oppsett\n");
    const siteUrl = (await prompt.ask("Adressen til nettstedet (f.eks. https://innnorsk.dittnavn.workers.dev)", config.siteUrl)).replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+/.test(siteUrl)) throw new Error(`Ugyldig adresse «${siteUrl}». Den må starte med https://`);
    const token = await prompt.ask("Agent-token (AGENT_TOKEN fra Cloudflare)", saved ? saved.token : "", {
      hidden: true,
      hint: saved ? "Enter = behold det lagrede" : "",
    });
    if (!token) throw new Error("Agent-tokenet mangler.");
    const outputDir = path.resolve(expandHome(await prompt.ask("Mappe for kopier av dokumentene", config.outputDir), paths.home));

    let grok = findCommand(config.grok.command, { home: paths.home });
    if (!grok) {
      const typed = await prompt.ask(`Fant ikke Grok CLI («${config.grok.command}»). Skriv full sti, eller trykk Enter for å fortsette`, "");
      grok = typed ? findCommand(expandHome(typed, paths.home)) : null;
    }
    if (grok) config.grok.command = grok;

    Object.assign(config, { siteUrl, outputDir });
    config.tokenStore = await storeToken(paths, token);
    saveConfig(paths, config);
    for (const dir of [outputDir, path.dirname(paths.logFile), path.dirname(paths.plistFile)]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(paths.plistFile, renderPlist({ node: stableNodePath(), grokCommand: config.grok.command, paths }));
    await loadService(paths);

    print("");
    print(grok ? `✓ Grok CLI: ${grok}` : "✗ Fant ikke Grok CLI. Installer den, kjør «grok login» og så setup på nytt.");
    print(`✓ Tokenet er lagret i ${config.tokenStore === "keychain" ? "nøkkelringen (Keychain)" : paths.tokenFile}`);
    print(`✓ Oppsettet er lagret i ${paths.configFile}`);
    print(`✓ Kopier av dokumentene havner i ${outputDir}`);
    print("✓ Mottaket kjører i bakgrunnen og starter av seg selv når du logger inn.");
    print(`  Logg: ${paths.logFile}`);
    print("\nSjekk at alt virker: node mac/innnorsk-mottak.js doctor");
    return grok ? 0 : 1;
  } finally {
    prompt.close();
  }
}

async function uninstall({ paths, output = process.stdout }) {
  const print = (line = "") => output.write(line + "\n");
  await run(paths.bins.launchctl, ["bootout", `${serviceDomain()}/${LABEL}`]);
  fs.rmSync(paths.plistFile, { force: true });
  await deleteToken(paths);
  print("✓ Mottaket er stoppet og starter ikke lenger av seg selv.");
  print("✓ Agent-tokenet er slettet.");
  print(`Beholdt: oppsettet i ${paths.dir} og dokumentkopiene dine.`);
  return 0;
}

module.exports = { setup, uninstall, renderPlist, stableNodePath };
