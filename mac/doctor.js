// «doctor»: sjekkliste med ✓/✗ og hva som må gjøres når noe er galt.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { grokRequest } = require("../src/grok");
const { LABEL, loadConfig, readToken } = require("./config");
const { createApi } = require("./api");
const { createTransport, formatCommand } = require("./grok-cli");
const { run, findCommand } = require("./system");
const { version } = require("../package.json");

const SETUP = "Kjør: node mac/innnorsk-mottak.js setup";
const PROBE = [
  "Du er en profesjonell oversetter til norsk bokmål.",
  "Returner KUN et JSON-array med nøyaktig 1 streng.",
  "",
  JSON.stringify(["Good morning"]),
].join("\n");

function probeAnswer(text) {
  try {
    const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    if (typeof arr[0] === "string") return arr[0];
  } catch {
    // ikke JSON-array
  }
  return text.trim().slice(0, 60);
}

// Én ekte oversettelse av en liten tekst, uten nye forsøk.
async function probeGrok(grok) {
  let command = "";
  let costUsd;
  const transport = createTransport(grok, { onSpawn: (cmd, args) => (command = formatCommand(cmd, args)) });
  const started = Date.now();
  try {
    const text = await grokRequest({ transport, input: PROBE, timeoutMs: 120000, onCall: (c) => (costUsd = c.costUsd) });
    const seconds = ((Date.now() - started) / 1000).toFixed(1).replace(".", ",");
    return { ok: true, command, seconds, costUsd, answer: probeAnswer(text) };
  } catch (err) {
    return { ok: false, command, err };
  }
}

async function doctor({ paths, output = process.stdout }) {
  const print = (line = "") => output.write(line + "\n");
  let problems = 0;
  const ok = (text) => print(`✓ ${text}`);
  const note = (text) => print(`    ${text}`);
  const bad = (text, fix) => {
    problems++;
    print(`✗ ${text}`);
    if (fix) print(`    → ${fix}`);
  };
  const finish = () => {
    print(`\nLogg: ${paths.logFile}`);
    print(problems ? `${problems} ting må fikses.` : "Alt ser bra ut. Mottaket er klart.");
    return problems ? 1 : 0;
  };

  print(`InnNorsk mottak – sjekkliste (versjon ${version})\n`);
  let config;
  try {
    const loaded = loadConfig(paths);
    config = loaded.config;
    if (loaded.exists && config.siteUrl) ok(`Oppsett: ${paths.configFile}`);
    else bad("Mottaket er ikke satt opp ennå.", SETUP);
  } catch (err) {
    bad(err.message, SETUP);
    return finish();
  }

  const saved = await readToken(paths, config);
  if (saved) ok(`Agent-tokenet er lagret i ${saved.where}`);
  else bad("Fant ikke agent-tokenet.", SETUP);

  if (config.siteUrl) {
    const api = createApi({ siteUrl: config.siteUrl, token: saved ? saved.token : "" });
    try {
      await api.health();
      ok(`Nettstedet svarer: ${config.siteUrl}`);
    } catch (err) {
      bad(`Nettstedet svarer ikke: ${err.message}`, "Sjekk adressen i ~/.innnorsk/config.json og at Mac-en er på nett.");
    }
    if (saved) {
      try {
        const files = await api.poll({ host: os.hostname(), version, state: "idle", stateMessage: "Sjekk fra doctor", grokOk: null });
        const waiting = files.length === 1 ? "1 fil venter" : `${files.length || "ingen"} filer venter`;
        ok(`Tokenet er godtatt – ${waiting}`);
      } catch (err) {
        const fix = err.status === 401 ? `Tokenet må være det samme som AGENT_TOKEN i Cloudflare. ${SETUP}` : "Prøv igjen om litt.";
        bad(`Tokenet ble ikke godtatt: ${err.message}`, fix);
      }
    }
  }

  const found = findCommand(config.grok.command, { home: paths.home });
  if (!found) {
    bad(
      `Fant ikke Grok CLI («${config.grok.command}»).`,
      "Installer Grok Build CLI, kjør «grok login», og sett full sti i «grok.command» i ~/.innnorsk/config.json."
    );
  } else {
    if (found !== config.grok.command) note(`Tips: sett "command": "${found}" under "grok" i config.json, så finner launchd den alltid.`);
    const full = await probeGrok({ ...config.grok, command: found });
    note(`Kommando: ${full.command}`);
    if (full.ok) {
      const cost = Number.isFinite(full.costUsd) ? ` – kostnad $${full.costUsd.toFixed(4)}` : "";
      ok(`Grok CLI oversatte en prøvetekst på ${full.seconds} s («${full.answer}»)${cost}`);
    } else if (full.err.code === "auth") {
      bad(full.err.message, "Kjør «grok login» i Terminal (som samme bruker), og så doctor igjen.");
    } else if (full.err.code === "no_key") {
      bad(full.err.message, "Installer Grok Build CLI eller rett «grok.command» i ~/.innnorsk/config.json.");
    } else {
      note(`Feilet: ${full.err.message}`);
      const minimal = await probeGrok({ command: found, args: [], effort: null, model: null });
      note(`Prøver med bare --prompt-file: ${minimal.command}`);
      if (minimal.ok) {
        bad(
          `Grok CLI virker bare uten de ekstra flaggene (svarte «${minimal.answer}» på ${minimal.seconds} s).`,
          'Din Grok-versjon kjenner ikke alle flaggene. Sett "args": [] og "effort": null under "grok" i ~/.innnorsk/config.json, og legg tilbake de flaggene «grok --help» viser.'
        );
      } else {
        bad(`Grok CLI feilet også slik: ${minimal.err.message}`, "Kjør kommandoen over selv i Terminal for å se hva som skjer.");
      }
    }
  }

  try {
    fs.mkdirSync(config.outputDir, { recursive: true });
    const probe = path.join(config.outputDir, `.innnorsk-skrivetest-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe);
    ok(`Kan skrive til ${config.outputDir}`);
  } catch (err) {
    bad(`Kan ikke skrive til ${config.outputDir}: ${err.message}`, "Velg en annen mappe med setup.");
  }

  const r = await run(paths.bins.launchctl, ["print", `gui/${process.getuid()}/${LABEL}`]);
  const state = ((r.stdout.match(/^\s*state = (.+)$/m) || [])[1] || "").trim();
  const pid = (r.stdout.match(/^\s*pid = (\d+)$/m) || [])[1];
  if (r.code === 0 && state === "running") ok(`Mottaket kjører i bakgrunnen (launchd, pid ${pid || "?"})`);
  else if (r.code === 0) bad(`Mottaket er lastet i launchd, men kjører ikke nå (${state || "ukjent"}).`, `Se loggen: ${paths.logFile}`);
  else bad("Mottaket er ikke lastet i launchd.", r.missing ? "launchctl finnes bare på macOS." : SETUP);

  return finish();
}

module.exports = { doctor };
