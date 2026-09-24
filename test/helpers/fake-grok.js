#!/usr/bin/env node
// Falsk Grok Build CLI for tester. Kaller ALDRI ekte Grok. Oppfører seg som
// «grok … --output-format json --prompt-file <fil>»: leser prompten, oversetter JSON-arrayen på slutten
// (som mock-grok: "NB:" + store bokstaver, "NN:" for nynorsk) og skriver { text, usage, total_cost_usd }.
// FAKE_GROK_MODE:
//   ok       (standard) JSON-svar
//   plain    bare teksten, uten JSON rundt
//   chatty   statuslinjer med ANSI-farger før JSON-en (flere linjer), prat rundt arrayen, støy på stderr
//   auth     «Not logged in» på stderr, kode 1
//   crash    krasj på stderr, kode 2
//   slow     venter FAKE_GROK_DELAY_MS (standard 5000) med et barn i samme prosessgruppe (pid i FAKE_GROK_PIDFILE)
//   minimal  godtar bare --prompt-file (andre flagg: «unexpected argument», kode 2), svarer som plain
// FAKE_GROK_LOG: hvert kall legges til som én JSON-linje { args, cwd, cwdEntries, mode }.
// FAKE_GROK_COST: kostnad per kall (standard 0.0007).
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const mode = process.env.FAKE_GROK_MODE || "ok";
const args = process.argv.slice(2);
const cost = Number(process.env.FAKE_GROK_COST || 0.0007);

if (process.env.FAKE_GROK_LOG) {
  const entry = { args, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), mode };
  fs.appendFileSync(process.env.FAKE_GROK_LOG, JSON.stringify(entry) + "\n");
}

function transform(s, prefix) {
  return prefix + String(s).replace(/[^\s]+/g, (w) => w.toUpperCase());
}

function answer(prompt) {
  const prefix = /norsk nynorsk/.test(prompt) ? "NN:" : "NB:";
  const i = prompt.indexOf("\n\n[");
  if (i !== -1) {
    try {
      const arr = JSON.parse(prompt.slice(i + 2, prompt.lastIndexOf("]") + 1));
      return JSON.stringify(arr.map((s) => transform(s, prefix)));
    } catch {
      // ikke en array likevel
    }
  }
  if (/nøyaktig ett ord: OK/i.test(prompt)) return "OK";
  const m = prompt.match(/\n\n([\s\S]+)$/);
  return transform(m ? m[1] : "OK", prefix);
}

function fail(message, code) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

function respond() {
  const at = args.indexOf("--prompt-file");
  if (at === -1 || !args[at + 1]) fail("error: --prompt-file mangler", 2);
  const prompt = fs.readFileSync(args[at + 1], "utf8");
  const text = answer(prompt);
  const usage = { input_tokens: Math.ceil(prompt.length / 4), output_tokens: Math.ceil(text.length / 4) };
  if (mode === "plain" || mode === "minimal") return process.stdout.write(text + "\n");
  if (mode === "chatty") {
    process.stderr.write("Laster modeller …\n");
    process.stdout.write("\x1b[2mChecking for updates… skipped\x1b[0m\n\x1b[32m✓\x1b[0m Ready\n");
    const chatty = `Her er oversettelsen:\n\`\`\`json\n${text}\n\`\`\``;
    return process.stdout.write(JSON.stringify({ type: "result", text: chatty, usage, total_cost_usd: cost }, null, 2) + "\n");
  }
  process.stdout.write(JSON.stringify({ text, usage, total_cost_usd: cost }) + "\n");
}

if (mode === "auth") fail("Error: Not logged in. Run `grok login` to authenticate.", 1);
if (mode === "crash") fail("panic: index out of range\n    at grok::agent::run", 2);
if (mode === "minimal") {
  const extra = args.filter((a, i) => a !== "--prompt-file" && args[i - 1] !== "--prompt-file");
  if (extra.length) fail(`error: unexpected argument '${extra[0]}' found\n\nUsage: grok [OPTIONS]`, 2);
}
if (mode === "slow") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (process.env.FAKE_GROK_PIDFILE) fs.writeFileSync(process.env.FAKE_GROK_PIDFILE, String(child.pid));
  setTimeout(() => {
    child.kill();
    respond();
  }, Number(process.env.FAKE_GROK_DELAY_MS || 5000));
} else {
  respond();
}
