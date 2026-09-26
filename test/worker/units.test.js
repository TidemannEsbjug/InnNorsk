// Rene funksjoner i Workeren og make-user.js, uten wrangler (raskt).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeUserSql, pbkdf2Proof, ITERATIONS } = require("../../scripts/make-user");

const load = (file) => import(pathToFileURL(path.join(__dirname, "../../worker", file)).href);

test("filstier fra nettleseren blir trygge relative stier", async () => {
  const { sanitizePath, isIgnoredName, extOf, SUPPORTED } = await load("files.js");
  assert.equal(sanitizePath("..\\..\\C:\\Windows\\ond.txt"), "Windows/ond.txt");
  assert.equal(sanitizePath("/etc/./passwd.txt"), "etc/passwd.txt");
  assert.equal(sanitizePath("Mappe//under/../søknad\u0000\u001f.docx"), "Mappe/under/søknad.docx");
  assert.equal(sanitizePath('a<b>:c"d|e?f*.txt'), "a_b__c_d_e_f_.txt");
  assert.equal(sanitizePath("../.."), "");
  assert.equal(sanitizePath(undefined), "");
  const deep = `${"mappe/".repeat(60)}fil.txt`;
  assert.ok(sanitizePath(deep).endsWith("/fil.txt") && sanitizePath(deep).length <= 240);
  assert.equal(sanitizePath(`${"x".repeat(250)}.txt`), "", "for langt filnavn");
  for (const name of ["~$rapport.docx", ".~lock.rapport.docx#", "Thumbs.db", "desktop.ini", ".DS_Store"]) assert.ok(isIgnoredName(`a/${name}`), name);
  assert.equal(isIgnoredName("rapport.docx"), false);
  assert.equal(extOf("A/B.DOCX"), ".docx");
  assert.equal(extOf(".bashrc"), "");
  assert.deepEqual([...SUPPORTED].sort(), [".csv", ".docx", ".htm", ".html", ".md", ".pdf", ".pptx", ".rtf", ".txt", ".xlsx"]);
});

test("navnet på oversettelsen: «<navn> (norsk)» med kjernens utformat, uten mappe", async () => {
  const { outputName } = await load("files.js");
  assert.equal(outputName("Søknader/Søknad æøå.docx", ".docx"), "Søknad æøå (norsk).docx");
  assert.equal(outputName("skann.v2.pdf", ".docx"), "skann.v2 (norsk).docx");
  assert.equal(outputName("notat.TXT", ".txt"), "notat (norsk).txt");
});

test("Content-Disposition har ASCII-reserve og UTF-8-navn (æøå og emoji)", async () => {
  const { contentDisposition } = await load("files.js");
  assert.equal(
    contentDisposition("Søknad Åse (norsk) 😀.docx"),
    "attachment; filename=\"Soknad Ase (norsk) _.docx\"; filename*=UTF-8''S%C3%B8knad%20%C3%85se%20%28norsk%29%20%F0%9F%98%80.docx"
  );
  assert.match(contentDisposition('a"b\\c.txt'), /^attachment; filename="a_b_c.txt";/);
});

test("statustekstene Svetlana ser", async () => {
  const { statusText, formatDuration } = await load("sendings.js");
  assert.equal(formatDuration(20), "under 1 min");
  assert.equal(formatDuration(180), "ca. 3 min");
  assert.equal(formatDuration(3900), "ca. 1 t 5 min");
  assert.equal(formatDuration(7200), "ca. 2 t");
  const now = new Date().toISOString();
  assert.equal(statusText({ status: "draft", estimate_seconds: 170 }), "Klar – ca. 3 min");
  assert.equal(statusText({ status: "draft", estimate_seconds: 12 }), "Klar – under 1 min");
  assert.equal(statusText({ status: "draft", estimate_seconds: null }), "Klar");
  assert.equal(statusText({ status: "sent" }), "I kø – starter straks");
  assert.equal(statusText({ status: "working" }), "Oversettes nå");
  assert.equal(
    statusText({ status: "working", progress_percent: 44.6, eta_seconds: 185, progress_at: now }),
    "Oversettes nå – 45 % – ca. 3 min igjen"
  );
  const minuteAgo = new Date(Date.now() - 60000).toISOString();
  assert.equal(
    statusText({ status: "working", progress_percent: 90, eta_seconds: 70, progress_at: minuteAgo }),
    "Oversettes nå – 90 % – under 1 min igjen",
    "gjenstående tid telles ned fra forrige fremdriftsmelding"
  );
  assert.equal(statusText({ status: "done" }), "Ferdig");
  assert.equal(statusText({ status: "failed" }, "Jonas"), "Kunne ikke oversettes. Jonas har fått beskjed.");
  assert.equal(statusText({ status: "failed", message: "Denne PDF-en er et bilde uten tekst og kan ikke oversettes." }, "Jonas"),
    "Denne PDF-en er et bilde uten tekst og kan ikke oversettes.", "vennlig forklaring fra analysen");
});

test("slettede filer: admin ser når og hvorfor, og når de slettes for godt; hun ser ingenting nytt", async () => {
  const { serializeFile } = await load("sendings.js");
  const f = {
    id: "f1", sending_id: "s1", rel_path: "Mappe/brev.txt", name: "brev.txt", ext: ".txt", bytes: 5, status: "done",
    output_name: "brev (norsk).txt", output_bytes: 9, deleted_at: "2026-09-01T10:00:00.000Z", deleted_reason: "sending", purged_at: null,
  };
  const admin = serializeFile(f, "Jonas", true, 30);
  assert.deepEqual([admin.deletedAt, admin.deletedReason, admin.purgedAt, admin.purgeAt],
    ["2026-09-01T10:00:00.000Z", "sending", null, "2026-10-01T10:00:00.000Z"]);
  const purged = serializeFile({ ...f, purged_at: "2026-10-01T10:15:00.000Z" }, "Jonas", true, 30);
  assert.deepEqual([purged.purgedAt, purged.purgeAt], ["2026-10-01T10:15:00.000Z", null]);
  assert.equal(serializeFile({ ...f, deleted_at: null, deleted_reason: null }, "Jonas", true, 30).purgeAt, null);
  const hers = serializeFile(f, "Jonas");
  for (const key of ["deletedAt", "deletedReason", "purgedAt", "purgeAt", "error", "outputSource"]) assert.equal(key in hers, false, key);
});

test("klientloggen: bare kjente typer, og data fra nettleseren er et lite objekt (for stort → bare starten)", async () => {
  const { clientData, ACTIVITY } = await load("routes/clientlog.js");
  assert.deepEqual(Object.keys(ACTIVITY).sort(), ["client.error_shown", "client.file_rejected", "client.page", "client.upload_failed"]);
  assert.deepEqual(clientData({ name: "brev.docx", size: 12 }), { name: "brev.docx", size: 12 });
  for (const bad of [null, undefined, "tekst", [1, 2], 5]) assert.deepEqual(clientData(bad), {});
  const big = clientData({ text: "x".repeat(5000) });
  assert.equal(big.truncated, true);
  assert.equal(big.preview.length, 4000);
  assert.ok(big.preview.startsWith('{"text":"xxx'));
});

test("estimatet: standardmodell, tilpasning fra Grok-kall, steg à 4 batcher og live-justering", async () => {
  const { fitParams, predictFile, predictSending, liveEta, makespan, DEFAULT_PARAMS } = await load("estimate.js");
  assert.deepEqual(fitParams([]), { a: 8, b: 0.006, samples: 0, source: "default" });
  assert.equal(fitParams(Array.from({ length: 7 }, () => ({ input_chars: 1000, ms: 5000 }))).source, "default", "under 8 kall");

  // 40 kall som følger t = 2 + 0,001·tegn nøyaktig: vektet 40/60 mot standardverdiene.
  const rows = Array.from({ length: 40 }, (_, i) => ({ input_chars: 1000 + i * 150, ms: (2 + 0.001 * (1000 + i * 150)) * 1000 }));
  const fit = fitParams(rows);
  assert.equal(fit.source, "fitted");
  assert.equal(fit.samples, 40);
  assert.ok(Math.abs(fit.a - ((40 / 60) * 2 + (20 / 60) * 8)) < 1e-9, `a=${fit.a}`);
  assert.ok(Math.abs(fit.b - ((40 / 60) * 0.001 + (20 / 60) * 0.006)) < 1e-9, `b=${fit.b}`);
  const wild = fitParams(Array.from({ length: 30 }, (_, i) => ({ input_chars: 100 + i, ms: 600000 - i * 10000 })));
  assert.ok(wild.a <= 120 && wild.b >= 0.0002, "klemt innenfor grensene");

  assert.equal(makespan([5, 4, 3, 3], 2), 8, "LPT: 5+3 og 4+3");
  assert.equal(makespan([5, 4], 1), 9);
  const p = { a: 10, b: 0.01 };
  // To kall: [1000, 500] og [1000, 1000, 2000] → steg [1000, 500, 1000, 1000] + [2000].
  const plan = [[1000, 500], [1000, 1000, 2000]];
  const step1 = makespan([20, 15, 20, 20], 2) + 3;
  const step2 = 30 + 3;
  assert.equal(predictFile(plan, p, 2), step1 + step2);
  assert.equal(predictFile([], p, 2), 0);
  assert.equal(predictSending([plan, [[1000]]], p, 2), step1 + step2 + 20 + 3);
  assert.equal(predictFile([[100]], DEFAULT_PARAMS, 2), 8 + 0.6 + 3);

  const batches = [1000, 500, 1000, 1000, 2000].map((chars, idx) => ({ idx, chars }));
  assert.equal(liveEta(batches, new Map(), p, 2), predictFile(plan, p, 2), "ingenting ferdig = estimatet");
  // To batcher tok dobbelt så lang tid som beregnet (r = 2, vekt 2 mot 3): resten × (2·2 + 3)/(2 + 3) = 1,4.
  const done = new Map([[0, 40000], [1, 30000]]);
  const rest = makespan([20, 20], 2) + 3 + 30 + 3;
  assert.ok(Math.abs(liveEta(batches, done, p, 2) - rest * 1.4) < 1e-9);
  assert.equal(liveEta(batches, new Map(batches.map((b) => [b.idx, 1000])), p, 2), 0, "alt ferdig");
});

test("hemmeligheter vaskes bort fra hendelser og logglinjer", async () => {
  const { scrub, redactSecrets } = await load("log.js");
  const env = { XAI_API_KEY: "nokkel-hemmelig-1234567890", SALT_PEPPER: "pepper-hemmelig", APNS_KEY_P8: "-----BEGIN PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldY\n-----END PRIVATE KEY-----" };
  assert.deepEqual(scrub({ password: "x", proof: "y", nested: { authorization: "Bearer z", inputTokens: 5 }, note: "Bearer abc.def" }), {
    password: "[skjult]", proof: "[skjult]", nested: { authorization: "[skjult]", inputTokens: 5 }, note: "Bearer [skjult]",
  });
  assert.equal(scrub("nøkkel: -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- slutt"), "nøkkel: [skjult] slutt");
  assert.equal(scrub("feil med xai-AbCdEf0123456789 her"), "feil med [skjult] her");
  const text = redactSecrets(env, "nokkel-hemmelig-1234567890 pepper-hemmelig QUJDREVGR0hJSktMTU5PUFFSU1RVVldY ok");
  assert.equal(text, "[skjult] [skjult] [skjult] ok");
});

test("konfig: modell, samtidighet og priser (tom pris = ukjent)", async () => {
  const { config } = await load("config.js");
  const empty = config({ XAI_PRICE_INPUT_PER_M: "", XAI_PRICE_OUTPUT_PER_M: "" });
  assert.deepEqual([empty.model, empty.concurrency, empty.priceInputPerM, empty.priceOutputPerM], ["grok-4.6", 2, null, null]);
  const set = config({ XAI_MODEL: "grok-x", GROK_CONCURRENCY: "3", XAI_PRICE_INPUT_PER_M: "0.2", XAI_PRICE_OUTPUT_PER_M: "0" });
  assert.deepEqual([set.model, set.concurrency, set.priceInputPerM, set.priceOutputPerM], ["grok-x", 3, 0.2, 0]);
  assert.equal(empty.retainDeletedDays, 30, "slettede filer beholdes 30 dager som standard");
  assert.equal(config({ RETAIN_DELETED_DAYS: "7" }).retainDeletedDays, 7);
  assert.equal(config({ RETAIN_DELETED_DAYS: "0" }).retainDeletedDays, 30, "0 eller tull gir standardverdien");
  const { costUsd } = await load("xai.js");
  assert.equal(costUsd({ XAI_PRICE_INPUT_PER_M: "2", XAI_PRICE_OUTPUT_PER_M: "10" }, 1500, 300), 0.006);
  assert.equal(costUsd({ XAI_PRICE_INPUT_PER_M: "2" }, 1500, 300), null);
});

test("make-user lager SQL med salt og verifier – aldri passordet", async () => {
  const sql = makeUserSql({ username: "Svetlana", displayName: "Svetlana O'Hara", role: "user", password: "hemmelig-passord-1" });
  assert.doesNotMatch(sql, /hemmelig-passord-1/);
  assert.match(sql, /ON CONFLICT\(username\) DO UPDATE/);
  assert.match(sql, /'Svetlana O''Hara'/, "fnutter escapes");
  const [, salt] = /'user', '([A-Za-z0-9_-]{22})', 310000/.exec(sql);
  const [, verifier] = /310000, '([0-9a-f]{64})'/.exec(sql);
  const proof = pbkdf2Proof("hemmelig-passord-1", salt, ITERATIONS);
  assert.equal(Buffer.from(proof, "base64url").length, 32);
  assert.equal(verifier, crypto.createHash("sha256").update(proof).digest("hex"));
  // Samme utregning som WebCrypto i nettleseren (PBKDF2-SHA256, 256 bit).
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("hemmelig-passord-1"), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(salt, "base64url"), iterations: ITERATIONS }, key, 256);
  assert.equal(Buffer.from(bits).toString("base64url"), proof);
  assert.throws(() => makeUserSql({ username: "a b", password: "hemmelig-passord-1" }), /Brukernavnet/);
  assert.throws(() => makeUserSql({ username: "ab", password: "kort" }), /minst 8 tegn/);
  assert.throws(() => makeUserSql({ username: "ab", role: "sjef", password: "hemmelig-passord-1" }), /Rollen/);
});

test("falske salt for ukjente brukere er stabile og ser ut som ekte", async () => {
  const { fakeSalt } = await load("auth.js");
  const env = { SALT_PEPPER: "test" };
  assert.equal(fakeSalt(env, "Ukjent"), fakeSalt(env, " ukjent "));
  assert.notEqual(fakeSalt(env, "ukjent"), fakeSalt(env, "ukjent2"));
  assert.notEqual(fakeSalt(env, "ukjent"), fakeSalt({ SALT_PEPPER: "annet" }, "ukjent"));
  assert.equal(fakeSalt(env, "ukjent").length, crypto.randomBytes(16).toString("base64url").length);
});
