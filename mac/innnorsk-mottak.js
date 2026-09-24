#!/usr/bin/env node
// InnNorsk mottak: hodeløs agent på Mac-en som henter filene Svetlana sender via nettstedet,
// oversetter dem med Grok Build CLI og legger resultatet tilbake. Se mac/README.md.
const path = require("node:path");
const { resolvePaths, loadConfig, readToken } = require("./config");
const { createAgent } = require("./agent");
const { setup, uninstall } = require("./setup");
const { doctor } = require("./doctor");
const { translateFiles } = require("./translate");

const USAGE = `InnNorsk mottak

Bruk: node mac/innnorsk-mottak.js <kommando>

  setup                  Sett opp adresse, token og mappe, og start mottaket i bakgrunnen
  setup --uninstall      Stopp mottaket og fjern det fra oppstart
  doctor                 Sjekk at alt virker
  run                    Kjør mottaket (dette er det launchd starter)
  once                   Oversett det som venter nå, og avslutt
  translate <filer eller mapper …> [--nynorsk] [--out <mappe>]
                         Oversett filer her på Mac-en, uten nettstedet`;

async function daemon(paths, once) {
  const { config, exists } = loadConfig(paths);
  if (!exists || !config.siteUrl) throw new Error("Mottaket er ikke satt opp. Kjør: node mac/innnorsk-mottak.js setup");
  const saved = await readToken(paths, config);
  if (!saved) {
    const where = config.tokenStore === "file" ? paths.tokenFile : "nøkkelringen (er den låst?)";
    throw new Error(`Fant ikke agent-tokenet i ${where}. Kjør: node mac/innnorsk-mottak.js setup`);
  }
  const agent = createAgent({ config, token: saved.token, paths });
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => agent.stop());
  return agent.run({ once });
}

function translateArgs(args) {
  const files = [];
  let nynorsk = false;
  let outDir = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--nynorsk") nynorsk = true;
    else if (args[i] === "--out") {
      outDir = args[++i];
      if (!outDir) throw new Error("--out trenger en mappe.");
    } else files.push(args[i]);
  }
  if (!files.length) throw new Error(`Oppgi minst én fil eller mappe.\n\n${USAGE}`);
  return { files, nynorsk, outDir: outDir && path.resolve(outDir) };
}

async function main([command, ...args]) {
  const paths = resolvePaths();
  const print = (line = "") => process.stdout.write(line + "\n");
  switch (command) {
    case "setup":
      return args.includes("--uninstall") ? uninstall({ paths }) : setup({ paths });
    case "doctor":
      return doctor({ paths });
    case "run":
    case "once":
      return daemon(paths, command === "once");
    case "translate": {
      const { files, ...opts } = translateArgs(args);
      return translateFiles(files, { ...opts, config: loadConfig(paths).config, paths, print });
    }
    default:
      print(USAGE);
      return [undefined, "help", "--help", "-h"].includes(command) ? 0 : 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`Feil: ${err.message}\n`);
    process.exitCode = 1;
  }
);
