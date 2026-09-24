// Tidsestimat for oversettelser. Ren modul: ingen env, ingen I/O — enkel å teste.
// Modell per Grok-kall: t = a + b · tegn (sekunder).

export const DEFAULTS = { a: 8, b: 0.006 };
export const CHUNK_SIZE = 4; // batcher per Workflow-steg (samme som workflow.js)
const FILE_OVERHEAD_S = 3; // prepare + assemble
const MIN_SAMPLES = 8;
const PRIOR_WEIGHT = 20;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// rows: vellykkede grok_calls { input_chars, ms }. Minste kvadraters metode, blandet med standardverdiene
// slik at få målinger ikke gir ville estimater.
export function fitParams(rows) {
  const pts = (rows || [])
    .map((r) => [Number(r.input_chars), Number(r.ms) / 1000])
    .filter(([x, y]) => x > 0 && y > 0 && Number.isFinite(x) && Number.isFinite(y));
  const n = pts.length;
  const fallback = { ...DEFAULTS, samples: n, source: "default" };
  if (n < MIN_SAMPLES) return fallback;
  const mx = pts.reduce((s, [x]) => s + x, 0) / n;
  const my = pts.reduce((s, [, y]) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
  }
  if (sxx <= 0) return fallback;
  const b = clamp(sxy / sxx, 0.0002, 0.2);
  const a = clamp(my - b * mx, 0.5, 120);
  const w = n / (n + PRIOR_WEIGHT);
  return {
    a: w * a + (1 - w) * DEFAULTS.a,
    b: w * b + (1 - w) * DEFAULTS.b,
    samples: n,
    source: "fitted",
  };
}

const work = (chars, params) => params.a + params.b * chars;

// Longest Processing Time first: grådig fordeling på n parallelle kall.
export function makespan(batchChars, params, n) {
  const loads = new Array(Math.max(1, n)).fill(0);
  const jobs = batchChars.map((c) => work(c, params)).sort((x, y) => y - x);
  for (const t of jobs) {
    let min = 0;
    for (let i = 1; i < loads.length; i++) if (loads[i] < loads[min]) min = i;
    loads[min] += t;
  }
  return Math.max(...loads);
}

const flat = (plan) => (plan || []).flat();

// plan: number[][] (tegn per batch, per kall). Stegene kjøres i rekkefølge, CHUNK_SIZE batcher om gangen.
export function predictFile(plan, params, n) {
  const batches = flat(plan);
  let total = FILE_OVERHEAD_S;
  for (let i = 0; i < batches.length; i += CHUNK_SIZE) {
    total += makespan(batches.slice(i, i + CHUNK_SIZE), params, n);
  }
  return total;
}

// files: [{ plan }]
export function predictJob(files, params, n) {
  return files.reduce((s, f) => s + predictFile(f.plan, params, n), 0);
}

function confidenceFor(w) {
  if (w < 3) return "lav";
  if (w < 10) return "middels";
  return "høy";
}

// files: [{ id, plan }] som fortsatt teller; doneBatches: [{ file_id, idx, chars, ms }].
// now/startedAt: ms eller ISO. Returnerer fremdrift og ETA som korrigeres etter faktisk tempo.
export function computeProgress({ files, doneBatches, startedAt, now, params, n }) {
  const p = params || DEFAULTS;
  const ids = new Set(files.map((f) => f.id));
  const done = (doneBatches || []).filter((b) => ids.has(b.file_id));
  const all = files.flatMap((f) => flat(f.plan));
  const totalChars = all.reduce((s, c) => s + c, 0);
  const doneChars = done.reduce((s, b) => s + Number(b.chars || 0), 0);
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const startMs = startedAt == null ? null : typeof startedAt === "number" ? startedAt : Date.parse(startedAt);
  const elapsed = startMs == null ? 0 : Math.max(0, (nowMs - startMs) / 1000);

  const predictedTotal = predictJob(files, p, n);
  const totalWork = all.reduce((s, c) => s + work(c, p), 0);
  const wallPerWork = totalWork > 0 ? predictedTotal / totalWork : 0;
  const predictedDone = wallPerWork * done.reduce((s, b) => s + work(Number(b.chars || 0), p), 0);
  const w = done.length;

  let secondsRemaining;
  if (w === 0) {
    secondsRemaining = Math.max(0, predictedTotal - elapsed);
  } else {
    // Faktisk tempo (r) teller mer jo flere batcher som er ferdige.
    const r = predictedDone > 0 ? elapsed / predictedDone : 1;
    const adjusted = (r * w + 3) / (w + 3);
    secondsRemaining = Math.max(0, predictedTotal - predictedDone) * adjusted;
  }
  secondsRemaining = Math.round(secondsRemaining);

  return {
    doneChars,
    totalChars,
    doneBatches: w,
    totalBatches: all.length,
    percent: totalChars > 0 ? Math.min(100, Math.floor((100 * doneChars) / totalChars)) : 0,
    eta: {
      secondsRemaining,
      finishAt: new Date(nowMs + secondsRemaining * 1000).toISOString(),
      confidence: confidenceFor(w),
    },
  };
}
