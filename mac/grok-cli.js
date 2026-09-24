// Grok Build CLI som transport for src/grok.js (ctx.transport), i stedet for xAI-API-et.
// Hvert kall: skriv prompten til en midlertidig fil, kjør «grok … --prompt-file <fil>» i en tom mappe,
// les JSON-svaret { text, usage, total_cost_usd } (eller ren tekst) og rydd opp.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GrokError } = require("../src/grok");

const AUTH_RE = /login|auth|unauthori[sz]ed|not logged/i;
const TEXT_KEYS = ["text", "result", "response", "output"];
const COST_KEYS = ["total_cost_usd", "cost_usd", "costUsd"];
const MAX_STDOUT = 32 << 20;
const KILL_GRACE_MS = 3000;

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function commandArgs(grok, promptFile, model) {
  const args = [...(grok.args || [])];
  const m = model || grok.model;
  if (m) args.push("-m", m);
  if (grok.effort) args.push("--effort", grok.effort);
  args.push("--prompt-file", promptFile);
  return args;
}

function formatCommand(command, args) {
  return [command, ...args].map((a) => (/^[\w./:=@+-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}

// CLI-en kan skrive statuslinjer før JSON-en; prøv fra hver linje som starter med «{».
function jsonObjectIn(out) {
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("{")) continue;
    for (const candidate of [lines.slice(i).join("\n"), lines[i]]) {
      try {
        const v = JSON.parse(candidate);
        if (v && typeof v === "object" && [...TEXT_KEYS, "error", "is_error"].some((k) => k in v)) return v;
      } catch {
        // ikke JSON herfra
      }
    }
  }
  return null;
}

function cliError(detail, code) {
  if (AUTH_RE.test(detail)) {
    return new GrokError("auth", "Grok CLI er ikke logget inn. Kjør «grok login» i Terminal.");
  }
  const line = stripAnsi(detail).split("\n").map((s) => s.trim()).find(Boolean) || `avsluttet med kode ${code}`;
  return new GrokError("server", `Grok CLI feilet: ${line.slice(0, 300)}`);
}

function parseOutput(stdout) {
  const out = stripAnsi(stdout).trim();
  const data = jsonObjectIn(out);
  if (!data) return { text: out, usage: null, costUsd: undefined };
  if (data.is_error || typeof data.error === "string") {
    throw cliError(String(data.error || data.result || data.text || "ukjent feil"), 0);
  }
  return {
    text: TEXT_KEYS.map((k) => data[k]).find((v) => typeof v === "string") || "",
    usage: data.usage || null,
    costUsd: COST_KEYS.map((k) => data[k]).find((v) => Number.isFinite(v)),
  };
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // allerede borte
  }
}

// Egen prosessgruppe (detached), så et avbrudd også stopper det CLI-en selv har startet.
function execCli(command, args, { cwd, signal }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason);
    const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let outBytes = 0;
    let stderr = "";
    let killTimer = null;
    const abort = () => {
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
    };
    const finish = () => {
      clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", abort);
    };
    child.stdout.on("data", (d) => {
      outBytes += d.length;
      if (outBytes > MAX_STDOUT) killGroup(child.pid, "SIGKILL");
      else out.push(d);
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 65536) stderr += d;
    });
    if (signal) signal.addEventListener("abort", abort, { once: true });
    child.on("error", (err) => {
      finish();
      if (err.code === "ENOENT") {
        reject(new GrokError("no_key", `Fant ikke Grok CLI («${command}»). Installer den eller sett riktig sti i ~/.innnorsk/config.json.`));
      } else {
        reject(new GrokError("server", `Kunne ikke starte Grok CLI: ${err.message}`, { cause: err }));
      }
    });
    child.on("close", (code) => {
      finish();
      if (signal && signal.aborted) {
        killGroup(child.pid, "SIGKILL");
        return reject(signal.reason);
      }
      if (outBytes > MAX_STDOUT) return reject(new GrokError("bad_response", "Grok CLI skrev altfor mye."));
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr });
    });
  });
}

// grok: { command, args, model, effort } fra config.json. onSpawn(command, args) ser nøyaktig hva som kjøres.
function createTransport(grok = {}, { onSpawn } = {}) {
  const name = grok.command || "grok";
  const command = name.includes("/") ? path.resolve(name) : name; // CLI-en kjører i en annen mappe
  return async function grokCli(input, { signal, model } = {}) {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "innnorsk-grok-"));
    try {
      const promptFile = path.join(tmp, "prompt.txt");
      const cwd = path.join(tmp, "arbeid");
      await fs.promises.mkdir(cwd);
      await fs.promises.writeFile(promptFile, input, { mode: 0o600 });
      const args = commandArgs(grok, promptFile, model);
      if (onSpawn) onSpawn(command, args);
      const { code, stdout, stderr } = await execCli(command, args, { cwd, signal });
      if (code !== 0) throw cliError(stderr.trim() || stdout, code);
      return parseOutput(stdout);
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  };
}

module.exports = { createTransport, commandArgs, formatCommand, parseOutput };
