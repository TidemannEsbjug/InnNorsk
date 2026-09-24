const test = require("node:test");
const assert = require("node:assert/strict");

let est;
test.before(async () => {
  est = await import("../worker/estimate.js");
});

const close = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ""} ${actual} ≉ ${expected} (±${tol})`);

function synthetic(a, b, n) {
  return Array.from({ length: n }, (_, i) => {
    const chars = 400 + ((i * 7919) % 6600);
    return { input_chars: chars, ms: (a + b * chars) * 1000 };
  });
}

test("fitParams finner a og b og blander med standardverdiene etter antall målinger", () => {
  const n = 300;
  const fit = est.fitParams(synthetic(5, 0.01, n));
  const w = n / (n + 20);
  assert.equal(fit.source, "fitted");
  assert.equal(fit.samples, n);
  close(fit.a, w * 5 + (1 - w) * est.DEFAULTS.a, 1e-6, "a");
  close(fit.b, w * 0.01 + (1 - w) * est.DEFAULTS.b, 1e-9, "b");
});

test("fitParams faller tilbake til standard ved for få målinger eller ingen spredning", () => {
  assert.deepEqual(est.fitParams(synthetic(5, 0.01, 7)), { ...est.DEFAULTS, samples: 7, source: "default" });
  const flat = Array.from({ length: 30 }, () => ({ input_chars: 1000, ms: 9000 }));
  assert.equal(est.fitParams(flat).source, "default");
  assert.equal(est.fitParams([]).source, "default");
  assert.equal(est.fitParams([{ input_chars: 0, ms: 0 }, { input_chars: null, ms: 5 }]).samples, 0);
});

test("fitParams klemmer urimelige verdier før blanding", () => {
  // Fallende tid med flere tegn gir negativ b og stor a: b → 0.0002, a → 120.
  const rows = Array.from({ length: 20 }, (_, i) => ({ input_chars: 1000 + i * 100, ms: (500 - i * 10) * 1000 }));
  const fit = est.fitParams(rows);
  const w = 20 / 40;
  close(fit.b, w * 0.0002 + (1 - w) * est.DEFAULTS.b, 1e-12, "b");
  close(fit.a, w * 120 + (1 - w) * est.DEFAULTS.a, 1e-9, "a");
});

test("makespan fordeler batcher med LPT på n parallelle kall", () => {
  const unit = { a: 0, b: 1 };
  assert.equal(est.makespan([7, 5, 4, 3, 1], unit, 2), 10);
  assert.equal(est.makespan([7, 5, 4, 3, 1], unit, 1), 20);
  assert.equal(est.makespan([7, 5, 4, 3, 1], unit, 10), 7);
  assert.equal(est.makespan([], unit, 2), 0);
});

test("predictFile regner stegvis i biter på 4 batcher, pluss fast overhead", () => {
  const params = { a: 1, b: 0.01 }; // 100 tegn → 2 s
  const plan = [[100, 100], [100, 100, 100]];
  // Bit 1: fire batcher på to kall = 4 s. Bit 2: én batch = 2 s. Overhead 3 s.
  assert.equal(est.predictFile(plan, params, 2), 9);
  assert.equal(est.predictFile([], params, 2), 3);
  assert.equal(est.predictJob([{ plan }, { plan: [[100]] }], params, 2), 9 + 5);
});

test("computeProgress: ETA før start, synkende ETA i forventet tempo og økende sikkerhet", () => {
  const params = est.DEFAULTS;
  const plan = [Array.from({ length: 20 }, () => 500)];
  const files = [{ id: "f1", plan }];
  const total = est.predictJob(files, params, 1);
  const start = Date.parse("2026-01-01T12:00:00Z");

  const before = est.computeProgress({ files, doneBatches: [], startedAt: null, now: start, params, n: 1 });
  assert.equal(before.percent, 0);
  assert.equal(before.totalBatches, 20);
  assert.equal(before.eta.secondsRemaining, Math.round(total));
  assert.equal(before.eta.confidence, "lav");

  const perBatch = total / 20; // eksakt forventet tempo
  let last = Infinity;
  const seen = [];
  for (let k = 1; k <= 20; k++) {
    const done = Array.from({ length: k }, (_, idx) => ({ file_id: "f1", idx, chars: 500, ms: 11000 }));
    const p = est.computeProgress({ files, doneBatches: done, startedAt: start, now: start + k * perBatch * 1000, params, n: 1 });
    assert.ok(p.eta.secondsRemaining <= last, `ETA skal ikke øke (${k})`);
    last = p.eta.secondsRemaining;
    assert.equal(p.doneBatches, k);
    assert.equal(p.percent, Math.floor((100 * k) / 20));
    seen.push(p.eta.confidence);
    close(Date.parse(p.eta.finishAt), start + total * 1000, 1500, "ferdigtidspunktet holder seg");
  }
  assert.equal(last, 0);
  assert.deepEqual([seen[0], seen[2], seen[9]], ["lav", "middels", "høy"]);
});

test("computeProgress korrigerer ETA når Grok er tregere enn forventet", () => {
  const params = est.DEFAULTS;
  const files = [{ id: "f1", plan: [Array.from({ length: 20 }, () => 500)] }];
  const total = est.predictJob(files, params, 1);
  const done = Array.from({ length: 10 }, (_, idx) => ({ file_id: "f1", idx, chars: 500 }));
  const onPace = est.computeProgress({ files, doneBatches: done, startedAt: 0, now: (total / 2) * 1000, params, n: 1 });
  const slow = est.computeProgress({ files, doneBatches: done, startedAt: 0, now: total * 1000, params, n: 1 });
  assert.ok(slow.eta.secondsRemaining > onPace.eta.secondsRemaining * 1.5);
  // Batcher for filer som ikke lenger teller (feilet), ignoreres.
  const other = est.computeProgress({ files, doneBatches: [{ file_id: "x", idx: 0, chars: 99999 }], startedAt: 0, now: 0, params, n: 1 });
  assert.equal(other.doneChars, 0);
});
