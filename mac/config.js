// Stier, oppsett (~/.innnorsk/config.json) og agent-tokenet (nøkkelringen, ellers ~/.innnorsk/agent.json).
// Miljøvariabler overstyrer alt maskinspesifikt, slik at testene kan kjøre på Linux:
//   HOME, INNNORSK_SECURITY, INNNORSK_LAUNCHCTL, INNNORSK_OSASCRIPT, INNNORSK_GROK
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run } = require("./system");

const LABEL = "no.innnorsk.mottak";
const KEYCHAIN_ACCOUNT = "agent-token";

const DEFAULT_GROK_ARGS = [
  "--no-auto-update",
  "--output-format",
  "json",
  "--max-turns",
  "1",
  "--disable-web-search",
  "--no-subagents",
  "--permission-mode",
  "defaultMode",
];

const DEFAULTS = {
  siteUrl: "",
  outputDir: "",
  concurrency: 2,
  leaseSeconds: 900,
  pollSeconds: 20,
  pauseSeconds: 300,
  tokenStore: "keychain",
  grok: { command: "grok", args: DEFAULT_GROK_ARGS, model: null, effort: "low", timeoutSeconds: 240 },
};

function resolvePaths(env = process.env) {
  const home = env.HOME || os.homedir();
  const dir = path.join(home, ".innnorsk");
  return {
    env,
    home,
    dir,
    configFile: path.join(dir, "config.json"),
    tokenFile: path.join(dir, "agent.json"),
    statsFile: path.join(dir, "stats.json"),
    plistFile: path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    logFile: path.join(home, "Library", "Logs", "InnNorsk", "mottak.log"),
    defaultOutputDir: path.join(home, "InnNorsk"),
    bins: {
      security: env.INNNORSK_SECURITY || "security",
      launchctl: env.INNNORSK_LAUNCHCTL || "launchctl",
      osascript: env.INNNORSK_OSASCRIPT || "osascript",
    },
  };
}

function expandHome(p, home) {
  const s = String(p || "").trim();
  return s === "~" || s.startsWith("~/") ? path.join(home, s.slice(1)) : s;
}

// { config, exists }. Manglende felt fylles med standardverdier.
function loadConfig(paths) {
  let saved = {};
  const exists = fs.existsSync(paths.configFile);
  if (exists) {
    try {
      saved = JSON.parse(fs.readFileSync(paths.configFile, "utf8"));
    } catch (err) {
      throw new Error(`Kunne ikke lese ${paths.configFile}: ${err.message}`);
    }
  }
  const config = { ...DEFAULTS, ...saved, grok: { ...DEFAULTS.grok, ...(saved.grok || {}) } };
  config.outputDir = path.resolve(expandHome(config.outputDir || paths.defaultOutputDir, paths.home));
  if (paths.env.INNNORSK_GROK) config.grok.command = paths.env.INNNORSK_GROK;
  return { config, exists };
}

function saveConfig(paths, config) {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + "\n");
}

const keychainArgs = (cmd) => [cmd, "-s", LABEL, "-a", KEYCHAIN_ACCOUNT];

function readTokenFile(paths) {
  try {
    return String(JSON.parse(fs.readFileSync(paths.tokenFile, "utf8")).token || "").trim();
  } catch {
    return "";
  }
}

// { token, where } eller null.
async function readToken(paths, config) {
  if (config.tokenStore !== "file") {
    const r = await run(paths.bins.security, [...keychainArgs("find-generic-password"), "-w"]);
    if (r.code === 0 && r.stdout.trim()) return { token: r.stdout.trim(), where: "nøkkelringen (Keychain)" };
  }
  const token = readTokenFile(paths);
  return token ? { token, where: paths.tokenFile } : null;
}

// Lagrer i nøkkelringen; finnes ikke `security` (eller feiler den), i en fil bare eieren kan lese.
async function storeToken(paths, token) {
  const r = await run(paths.bins.security, [...keychainArgs("add-generic-password"), "-U", "-w", token]);
  if (r.code === 0) {
    fs.rmSync(paths.tokenFile, { force: true });
    return "keychain";
  }
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.tokenFile, JSON.stringify({ token }) + "\n", { mode: 0o600 });
  fs.chmodSync(paths.tokenFile, 0o600);
  return "file";
}

async function deleteToken(paths) {
  await run(paths.bins.security, keychainArgs("delete-generic-password"));
  fs.rmSync(paths.tokenFile, { force: true });
}

module.exports = {
  LABEL,
  DEFAULT_GROK_ARGS,
  DEFAULTS,
  resolvePaths,
  expandHome,
  loadConfig,
  saveConfig,
  readToken,
  storeToken,
  deleteToken,
};
