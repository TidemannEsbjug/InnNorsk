// Tidsestimat for oversettelsen: t = a + b · tegn per batch, tilpasset fra tidligere Grok CLI-kall
// på denne Mac-en (~/.innnorsk/stats.json), blandet med farten så langt i filen som oversettes nå.
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MODEL = { a: 6, b: 0.004 };
const MIN_SAMPLES = 5;
const KEEP_SAMPLES = 300;

function loadSamples(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return (data.batches || []).filter((s) => s.chars > 0 && s.ms > 0);
  } catch {
    return [];
  }
}

function saveSamples(file, samples) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ batches: samples.slice(-KEEP_SAMPLES) }) + "\n");
}

// Minste kvadraters metode på (tegn, sekunder). For lite eller rar historikk gir standardmodellen.
function fitModel(samples) {
  if (samples.length < MIN_SAMPLES) return DEFAULT_MODEL;
  const n = samples.length;
  const mx = samples.reduce((s, p) => s + p.chars, 0) / n;
  const my = samples.reduce((s, p) => s + p.ms / 1000, 0) / n;
  const sxx = samples.reduce((s, p) => s + (p.chars - mx) ** 2, 0);
  const sxy = samples.reduce((s, p) => s + (p.chars - mx) * (p.ms / 1000 - my), 0);
  const b = sxx > 0 ? sxy / sxx : 0;
  const a = my - b * mx;
  if (b > 0 && a >= 0) return { a, b };
  return { a: 0, b: my / mx };
}

// plan = core.analyzeBuffer(...). Batchene i ett kall går `concurrency` om gangen.
function createEstimator({ plan, model = DEFAULT_MODEL, concurrency = 1, now = Date.now }) {
  const widest = Math.max(1, ...plan.calls.map((c) => c.length));
  const lanes = Math.max(1, Math.min(concurrency, widest));
  const startedAt = now();
  let lastAt = startedAt;
  let doneChars = 0;
  let doneBatches = 0;
  return {
    batchDone(chars) {
      doneChars = Math.min(plan.chars, doneChars + chars);
      doneBatches = Math.min(plan.batches, doneBatches + 1);
      lastAt = now();
    },
    snapshot() {
      const t = now();
      const leftChars = plan.chars - doneChars;
      const leftBatches = plan.batches - doneBatches;
      const modelSec = Math.max(0, (leftBatches * model.a + leftChars * model.b) / lanes - (t - lastAt) / 1000);
      const fraction = plan.chars ? doneChars / plan.chars : 0;
      const observedSec = doneChars ? ((t - startedAt) / 1000 / doneChars) * leftChars : modelSec;
      return {
        percent: Math.min(99, Math.round(fraction * 1000) / 10),
        etaSeconds: Math.round((1 - fraction) * modelSec + fraction * observedSec),
        done: doneBatches,
        total: plan.batches,
      };
    },
  };
}

function formatDuration(seconds) {
  if (seconds < 60) return "under 1 min";
  const min = Math.round(seconds / 60);
  if (min < 60) return `ca. ${min} min`;
  return `ca. ${Math.floor(min / 60)} t ${min % 60} min`;
}

module.exports = { DEFAULT_MODEL, loadSamples, saveSamples, fitModel, createEstimator, formatDuration };
