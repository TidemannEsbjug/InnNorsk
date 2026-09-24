// Felles for testene av Mac-mottaket: midlertidig HOME, falske macOS-verktøy (security, launchctl,
// osascript) som logger kallene sine, og oppsett mot det falske agent-API-et. Bare dummyverdier.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_GROK_ARGS, resolvePaths } = require("../../mac/config");

const ROOT = path.resolve(__dirname, "../..");
const CLI = path.join(ROOT, "mac/innnorsk-mottak.js");
const FAKE_GROK = path.join(ROOT, "test/helpers/fake-grok.js");
const FAKE_ENV = ["FAKE_GROK_MODE", "FAKE_GROK_LOG", "FAKE_GROK_DELAY_MS", "FAKE_GROK_PIDFILE", "FAKE_GROK_COST"];

fs.chmodSync(FAKE_GROK, 0o755);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "innnorsk-mac-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const readLines = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// Hvert falskt verktøy logger argumentene sine i <bin>.log og har tilstand i <bin>.state.
function fakeBin(dir, name, body) {
  const file = path.join(dir, name);
  const head = [
    `#!${process.execPath}`,
    'const fs = require("fs");',
    "const args = process.argv.slice(2);",
    'const state = __filename + ".state";',
    'fs.appendFileSync(__filename + ".log", JSON.stringify(args) + "\\n");',
  ];
  fs.writeFileSync(file, [...head, body].join("\n") + "\n", { mode: 0o755 });
  return file;
}

const SECURITY = `
const store = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : {};
const key = args[args.indexOf("-s") + 1] + "/" + args[args.indexOf("-a") + 1];
if (args[0] === "add-generic-password") store[key] = args[args.indexOf("-w") + 1];
if (args[0] === "delete-generic-password") delete store[key];
fs.writeFileSync(state, JSON.stringify(store));
if (args[0] === "find-generic-password") {
  if (!(key in store)) { console.error("The specified item could not be found in the keychain."); process.exit(44); }
  console.log(store[key]);
}`;

const LAUNCHCTL = `
const loaded = fs.existsSync(state);
if (args[0] === "bootstrap") fs.writeFileSync(state, args[2]);
if (args[0] === "bootout") {
  if (!loaded) { console.error("Boot-out failed: 3: No such process"); process.exit(3); }
  fs.rmSync(state);
}
if (args[0] === "print") {
  if (!loaded) { console.error("Could not find service in domain"); process.exit(113); }
  console.log("gui/501/no.innnorsk.mottak = {\\n\\tstate = running\\n\\tpid = 4242\\n}");
}`;

// En «Mac» i en midlertidig mappe: HOME, falske verktøy, env for underprosesser og stiene mottaket bruker.
function machine(t, { keychain = true } = {}) {
  const home = tempDir(t);
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir);
  const bins = {
    security: fakeBin(binDir, "security", SECURITY),
    launchctl: fakeBin(binDir, "launchctl", LAUNCHCTL),
    osascript: fakeBin(binDir, "osascript", ""),
  };
  const env = { ...process.env, HOME: home, INNNORSK_LAUNCHCTL: bins.launchctl, INNNORSK_OSASCRIPT: bins.osascript };
  env.INNNORSK_SECURITY = keychain ? bins.security : path.join(binDir, "security-mangler");
  delete env.INNNORSK_GROK;
  const grokLog = path.join(home, "grok.log");
  return {
    home,
    bins,
    env,
    paths: resolvePaths(env),
    grokLog,
    grokCalls: () => readLines(grokLog),
    binCalls: (name) => readLines(bins[name] + ".log"),
  };
}

// Setter falsk Grok-modus for kall fra denne prosessen (og nullstiller etter testen).
function fakeGrok(t, m, mode, extra = {}) {
  const vars = { FAKE_GROK_MODE: mode, FAKE_GROK_LOG: m.grokLog, ...extra };
  Object.assign(process.env, vars);
  t.after(() => FAKE_ENV.forEach((k) => delete process.env[k]));
  return vars;
}

function agentConfig(api, m, extra = {}) {
  return {
    siteUrl: api.url,
    outputDir: path.join(m.home, "InnNorsk"),
    concurrency: 2,
    leaseSeconds: 30,
    pollSeconds: 0.2,
    pauseSeconds: 0.3,
    retryDelayMs: 1,
    tokenStore: "file",
    grok: { command: FAKE_GROK, args: DEFAULT_GROK_ARGS, model: null, effort: "low", timeoutSeconds: 20 },
    ...extra,
  };
}

function writeSetup(m, config, token) {
  fs.mkdirSync(m.paths.dir, { recursive: true });
  fs.writeFileSync(m.paths.configFile, JSON.stringify(config));
  fs.writeFileSync(m.paths.tokenFile, JSON.stringify({ token }), { mode: 0o600 });
}

async function waitFor(fn, { timeoutMs = 15000, what = "betingelsen" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Tidsavbrudd mens vi ventet på ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function runCli(args, { env, input = "" }) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env, timeout: 60000 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })
    );
    child.stdin.end(input);
  });
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

module.exports = { ROOT, CLI, FAKE_GROK, tempDir, readLines, machine, fakeGrok, agentConfig, writeSetup, waitFor, runCli, isAlive };
