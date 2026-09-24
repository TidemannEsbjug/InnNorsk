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
  const core = require("../../src/core");
  assert.deepEqual([...SUPPORTED].sort(), [...core.SUPPORTED].sort(), "samme filtyper som kjernen");
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
  assert.equal(statusText({ status: "draft" }, true), "Ikke sendt ennå");
  assert.equal(statusText({ status: "sent" }, true), "Mottatt – oversettes snart");
  assert.equal(statusText({ status: "sent" }, false), "Mottatt – oversettelsen starter når oversetteren er klar");
  assert.equal(statusText({ status: "working" }, true), "Oversettes nå");
  assert.equal(
    statusText({ status: "working", progress_percent: 44.6, eta_seconds: 185, progress_at: now }, true),
    "Oversettes nå – 45 % – ca. 3 min igjen"
  );
  const minuteAgo = new Date(Date.now() - 60000).toISOString();
  assert.equal(
    statusText({ status: "working", progress_percent: 90, eta_seconds: 70, progress_at: minuteAgo }, true),
    "Oversettes nå – 90 % – under 1 min igjen",
    "gjenstående tid telles ned fra forrige fremdriftsmelding"
  );
  assert.equal(statusText({ status: "done" }, false), "Ferdig");
  assert.equal(statusText({ status: "failed" }, true), "Oversetteren ser på denne filen");
  assert.equal(statusText({ status: "failed", message: "Denne PDF-en er skannet." }, true), "Denne PDF-en er skannet.");
});

test("hemmeligheter vaskes bort fra hendelser og logglinjer", async () => {
  const { scrub, redactSecrets } = await load("log.js");
  const env = { AGENT_TOKEN: "agent-hemmelig-1234567890", SALT_PEPPER: "pepper-hemmelig", APNS_KEY_P8: "-----BEGIN PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldY\n-----END PRIVATE KEY-----" };
  assert.deepEqual(scrub({ password: "x", proof: "y", nested: { authorization: "Bearer z", inputTokens: 5 }, note: "Bearer abc.def" }), {
    password: "[skjult]", proof: "[skjult]", nested: { authorization: "[skjult]", inputTokens: 5 }, note: "Bearer [skjult]",
  });
  assert.equal(scrub("nøkkel: -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- slutt"), "nøkkel: [skjult] slutt");
  const text = redactSecrets(env, "agent-hemmelig-1234567890 pepper-hemmelig QUJDREVGR0hJSktMTU5PUFFSU1RVVldY ok");
  assert.equal(text, "[skjult] [skjult] [skjult] ok");
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
