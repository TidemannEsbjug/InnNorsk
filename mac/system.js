// Små hjelpere for macOS-verktøy (security, launchctl, osascript) og oppslag i PATH.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Kjører et program og feiler aldri: { code, stdout, stderr, missing }.
function run(command, args, { timeoutMs = 15000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err && err.code === "ENOENT") return resolve({ code: null, missing: true, stdout: "", stderr: "" });
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, missing: false, stdout: String(stdout), stderr: String(stderr) || (err ? err.message : "") });
    });
    if (input != null) child.stdin.end(input);
  });
}

function firstLine(text) {
  return String(text || "").split("\n").map((s) => s.trim()).find(Boolean) || "";
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Finner et program i PATH og i vanlige installasjonsmapper (launchd har en snau PATH).
function findCommand(command, { home, pathEnv = process.env.PATH } = {}) {
  if (!command) return null;
  if (command.includes("/")) return isExecutable(command) ? path.resolve(command) : null;
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"];
  if (home) extra.push(...[".local/bin", ".grok/bin", ".bun/bin", ".npm-global/bin"].map((d) => path.join(home, d)));
  const dirs = [...String(pathEnv || "").split(path.delimiter), ...extra].filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, command);
    if (isExecutable(file)) return file;
  }
  return null;
}

function appleScriptString(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// macOS-varsel, beste forsøk: mangler osascript (eller feiler det), skjer ingenting.
async function notify(osascript, title, message) {
  await run(osascript, ["-e", `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`], {
    timeoutMs: 5000,
  });
}

module.exports = { run, firstLine, findCommand, notify };
