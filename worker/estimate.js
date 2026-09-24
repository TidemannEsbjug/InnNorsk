// Tidsestimat for oversettelsen (rene funksjoner, ingen I/O).
// Én batch tar t = a + b·tegn sekunder; a og b tilpasses fra de siste vellykkede Grok-kallene.
// Workflowen tar batchene i steg à CHUNK, med `workers` batcher parallelt, og hvert steg koster litt ekstra tid.
export const DEFAULT_PARAMS = { a: 8, b: 0.006 };
export const CHUNK = 4;
const STEP_OVERHEAD_S = 3;
const MIN_SAMPLES = 8;
const PRIOR_SAMPLES = 20; // så mye vekt standardverdiene har i tilpasningen
const PRIOR_BATCHES = 3; // så mye vekt «som beregnet» har i live-estimatet

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const batchSeconds = (chars, params) => params.a + params.b * chars;

// rows: [{ input_chars, ms }] → { a, b, samples, source: "default" | "fitted" } (minste kvadraters metode).
export function fitParams(rows) {
  const points = rows.filter((r) => r.input_chars > 0 && r.ms > 0).map((r) => [r.input_chars, r.ms / 1000]);
  const n = points.length;
  if (n < MIN_SAMPLES) return { ...DEFAULT_PARAMS, samples: n, source: "default" };
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const sxy = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const b = clamp(sxx > 0 ? sxy / sxx : DEFAULT_PARAMS.b, 0.0002, 0.2);
  const a = clamp(my - b * mx, 0.5, 120);
  const w = n / (n + PRIOR_SAMPLES);
  return { a: w * a + (1 - w) * DEFAULT_PARAMS.a, b: w * b + (1 - w) * DEFAULT_PARAMS.b, samples: n, source: "fitted" };
}

// Lengste kø når jobbene fordeles på workers, lengste først (LPT).
export function makespan(seconds, workers) {
  const loads = new Array(Math.max(1, workers)).fill(0);
  for (const s of [...seconds].sort((x, y) => y - x)) loads[loads.indexOf(Math.min(...loads))] += s;
  return Math.max(...loads);
}

// Summen over stegene: hvert steg er CHUNK batcher (i planens rekkefølge) + fast ekstra tid.
function stepsSeconds(chars, params, workers) {
  let total = 0;
  for (let i = 0; i < chars.length; i += CHUNK) {
    total += makespan(chars.slice(i, i + CHUNK).map((c) => batchSeconds(c, params)), workers) + STEP_OVERHEAD_S;
  }
  return total;
}

// plan: [[tegn per batch] per internt kall] fra analysen ved opplasting.
export const predictFile = (plan, params, workers) => stepsSeconds(plan.flat(), params, workers);

export const predictSending = (plans, params, workers) => plans.reduce((t, plan) => t + predictFile(plan, params, workers), 0);

// Gjenstående tid for en fil under arbeid. batches: [{ idx, chars }] i rekkefølge; done: Map(idx → ms).
// Forholdet faktisk/beregnet for ferdige batcher justerer resten, veid mot 1 som om det var PRIOR_BATCHES til.
export function liveEta(batches, done, params, workers) {
  let actual = 0;
  let predicted = 0;
  let count = 0;
  for (const b of batches) {
    if (!done.has(b.idx)) continue;
    actual += done.get(b.idx) / 1000;
    predicted += batchSeconds(b.chars, params);
    count++;
  }
  const r = predicted > 0 ? actual / predicted : 1;
  const ratio = (r * count + PRIOR_BATCHES) / (count + PRIOR_BATCHES);
  let remaining = 0;
  for (let i = 0; i < batches.length; i += CHUNK) {
    const left = batches.slice(i, i + CHUNK).filter((b) => !done.has(b.idx)).map((b) => b.chars);
    if (left.length) remaining += stepsSeconds(left, params, workers);
  }
  return remaining * ratio;
}
