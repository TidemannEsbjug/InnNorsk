// «translate»: oversett filer her på Mac-en uten nettstedet (samme formatkjerne og Grok CLI som mottaket).
// Utfilen heter «<navn> (norsk).<ext>» og legges ved siden av originalen, eller i --out.
const fs = require("node:fs");
const path = require("node:path");
const core = require("../src/core");
const { createTransport } = require("./grok-cli");
const estimate = require("./estimate");
const { norskName } = require("./local-files");

const OWN_OUTPUT = / \(norsk\)\.[^.]+$/;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Mapper gås gjennom rekursivt; der tas bare støttede dokumenter med (ikke låsefiler eller egne utfiler).
function expand(input) {
  if (!fs.statSync(input).isDirectory()) return [input];
  return fs
    .readdirSync(input, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name, "nb"))
    .flatMap((e) => {
      const full = path.join(input, e.name);
      if (e.isDirectory()) return expand(full);
      const ok = core.SUPPORTED.includes(core.extOf(e.name)) && !core.isIgnoredName(e.name) && !OWN_OUTPUT.test(e.name);
      return ok ? [full] : [];
    });
}

async function translateFiles(inputs, { nynorsk = false, outDir = null, config, paths, print }) {
  const transport = createTransport(config.grok);
  const model = estimate.fitModel(estimate.loadSamples(paths.statsFile));
  const samples = [];
  let failed = 0;
  let done = 0;
  let totalCost = 0;
  const files = [];
  for (const input of inputs) {
    if (fs.existsSync(input)) files.push(...expand(input));
    else {
      print(`✗ Fant ikke ${input}`);
      failed++;
    }
  }
  for (const file of files) {
    const name = path.basename(file);
    const ext = core.extOf(name);
    try {
      if (!core.SUPPORTED.includes(ext)) throw new Error(`Filtypen ${ext || "(ukjent)"} støttes ikke.`);
      const input = fs.readFileSync(file);
      const plan = await core.analyzeBuffer(input, ext);
      const est = estimate.createEstimator({ plan, model, concurrency: config.concurrency });
      print(`→ ${name} (${plural(plan.batches, "del", "deler")}, ${estimate.formatDuration(est.snapshot().etaSeconds)})`);
      const started = Date.now();
      let cost = 0;
      const result = await core.translateBuffer(input, ext, {
        transport,
        targetLanguage: nynorsk ? "nynorsk" : "bokmal",
        concurrency: config.concurrency,
        timeoutMs: config.grok.timeoutSeconds * 1000,
        retryDelayMs: config.retryDelayMs,
        onBatch: (b) => {
          samples.push({ chars: b.chars, ms: b.ms });
          est.batchDone(b.chars);
          const s = est.snapshot();
          if (s.done < s.total) print(`  ${Math.round(s.percent)} % – ${estimate.formatDuration(s.etaSeconds)} igjen`);
        },
        onCall: (c) => {
          if (Number.isFinite(c.costUsd)) cost += c.costUsd;
        },
        onWarning: (w) => print(`  ! ${w.message}`),
      });
      const dest = path.join(outDir || path.dirname(file), norskName(name, result.outExt));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, result.buffer);
      totalCost += cost;
      done++;
      print(`✓ ${dest} (${Math.round((Date.now() - started) / 1000)} s, $${cost.toFixed(4)})`);
    } catch (err) {
      failed++;
      print(`✗ ${name}: ${err.message}`);
    }
  }
  if (samples.length) estimate.saveSamples(paths.statsFile, [...estimate.loadSamples(paths.statsFile), ...samples]);
  print(`\n${done} av ${plural(files.length, "fil", "filer")} oversatt. Kostnad: $${totalCost.toFixed(4)}.`);
  return failed ? 1 : 0;
}

module.exports = { translateFiles };
