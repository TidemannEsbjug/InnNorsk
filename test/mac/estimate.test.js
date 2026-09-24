// Tidsmodellen for estimater: tilpasning fra historikk, blanding med farten i filen, og norsk tidsformat.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const estimate = require("../../mac/estimate");
const { tempDir } = require("./helpers");

test("fitModel: standard med lite historikk, ellers minste kvadraters linje", () => {
  assert.deepEqual(estimate.fitModel([]), { a: 6, b: 0.004 });
  const samples = [1000, 2000, 4000, 6000, 8000].map((chars) => ({ chars, ms: (2 + 0.01 * chars) * 1000 }));
  const { a, b } = estimate.fitModel(samples);
  assert.ok(Math.abs(a - 2) < 1e-9 && Math.abs(b - 0.01) < 1e-12);
  const flat = [1000, 1000, 1000, 1000, 1000].map((chars) => ({ chars, ms: 5000 }));
  assert.deepEqual(estimate.fitModel(flat), { a: 0, b: 0.005 }, "samme lengde overalt: bare fart per tegn");
});

test("stats.json lagres, leses og kuttes til de siste kallene", (t) => {
  const file = path.join(tempDir(t), "stats.json");
  assert.deepEqual(estimate.loadSamples(file), []);
  const many = Array.from({ length: 350 }, (_, i) => ({ chars: i + 1, ms: 1000 }));
  estimate.saveSamples(file, [...many, { chars: 0, ms: 5 }]);
  const loaded = estimate.loadSamples(file);
  assert.equal(loaded.length, 299, "300 lagret, tomme batcher filtrert bort");
  fs.writeFileSync(file, "ikke json");
  assert.deepEqual(estimate.loadSamples(file), []);
});

test("estimatet starter fra modellen og glir over mot farten i denne filen", () => {
  let now = 0;
  const plan = { calls: [[1000, 1000, 1000, 1000]], chars: 4000, batches: 4 };
  const est = estimate.createEstimator({ plan, model: { a: 6, b: 0.004 }, concurrency: 2, now: () => now });
  assert.deepEqual(est.snapshot(), { percent: 0, etaSeconds: 20, done: 0, total: 4 }, "(4·6 + 4000·0,004) / 2");
  now = 5000;
  assert.equal(est.snapshot().etaSeconds, 15, "tiden siden forrige batch trekkes fra");
  now = 20000;
  est.batchDone(1000);
  est.batchDone(1000);
  const half = est.snapshot();
  assert.equal(half.percent, 50);
  assert.equal(half.etaSeconds, 15, "halvt modell (10 s), halvt observert (20 s)");
  est.batchDone(1000);
  est.batchDone(1000);
  assert.equal(est.snapshot().percent, 99, "100 % først når resultatet er levert");
});

test("formatDuration på norsk", () => {
  assert.equal(estimate.formatDuration(20), "under 1 min");
  assert.equal(estimate.formatDuration(170), "ca. 3 min");
  assert.equal(estimate.formatDuration(3900), "ca. 1 t 5 min");
});
