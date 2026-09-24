// Grok CLI-transporten mot den falske CLI-en (test/helpers/fake-grok.js). Kaller aldri ekte Grok.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTransport, parseOutput } = require("../../mac/grok-cli");
const { DEFAULT_GROK_ARGS } = require("../../mac/config");
const { translateStrings, GrokError } = require("../../src/grok");
const { FAKE_GROK, machine, fakeGrok, waitFor, isAlive } = require("./helpers");

const PROMPT = 'Oversett til norsk bokmål.\n\n["Hello there", "Good morning"]';
const grok = (extra = {}) => ({ command: FAKE_GROK, args: DEFAULT_GROK_ARGS, effort: "low", ...extra });

test("JSON-svar gir tekst, bruk og kostnad; standardflagg, tom arbeidsmappe og opprydding", async (t) => {
  const m = machine(t);
  fakeGrok(t, m, "ok");
  const out = await createTransport(grok())(PROMPT, {});
  assert.deepEqual(JSON.parse(out.text), ["NB:HELLO THERE", "NB:GOOD MORNING"]);
  assert.equal(out.costUsd, 0.0007);
  assert.ok(out.usage.input_tokens > 0);

  const [call] = m.grokCalls();
  const promptFile = call.args.at(-1);
  assert.deepEqual(call.args, [...DEFAULT_GROK_ARGS, "--effort", "low", "--prompt-file", promptFile]);
  assert.deepEqual(call.cwdEntries, [], "CLI-en kjører i en tom mappe");
  assert.notEqual(path.dirname(promptFile), call.cwd);
  assert.equal(fs.existsSync(path.dirname(promptFile)), false, "midlertidige filer er slettet");
});

test("modell og effort er valgfrie, og argumentene kan byttes ut helt", async (t) => {
  const m = machine(t);
  fakeGrok(t, m, "ok");
  await createTransport(grok({ args: ["--foo"], model: "grok-4.6", effort: null }))(PROMPT, {});
  await createTransport(grok({ args: [], effort: null }))(PROMPT, { model: "grok-annen" });
  const [a, b] = m.grokCalls().map((c) => c.args.slice(0, -1));
  assert.deepEqual(a, ["--foo", "-m", "grok-4.6", "--prompt-file"]);
  assert.deepEqual(b, ["-m", "grok-annen", "--prompt-file"]);
});

test("ren tekst og pratsom CLI med statuslinjer tolkes riktig", async (t) => {
  const m = machine(t);
  fakeGrok(t, m, "plain");
  const plain = await createTransport(grok())(PROMPT, {});
  assert.deepEqual(JSON.parse(plain.text), ["NB:HELLO THERE", "NB:GOOD MORNING"]);
  assert.equal(plain.costUsd, undefined);
  assert.equal(plain.usage, null);

  process.env.FAKE_GROK_MODE = "chatty";
  const chatty = await createTransport(grok())(PROMPT, {});
  assert.match(chatty.text, /^Her er oversettelsen:/);
  assert.match(chatty.text, /"NB:GOOD MORNING"/);
  assert.equal(chatty.costUsd, 0.0007);
});

test("parseOutput: alternative feltnavn og feil i JSON-svaret", () => {
  assert.deepEqual(parseOutput('{"type":"result","result":"hei","total_cost_usd":0.002}\n'), {
    text: "hei",
    usage: null,
    costUsd: 0.002,
  });
  assert.throws(() => parseOutput('{"is_error":true,"result":"Not logged in"}'), (e) => e.code === "auth");
  assert.throws(() => parseOutput('{"error":"model overloaded"}'), (e) => e.code === "server" && /overloaded/.test(e.message));
});

test("ikke logget inn, krasj og manglende CLI gir norske GrokError-koder", async (t) => {
  const m = machine(t);
  fakeGrok(t, m, "auth");
  await assert.rejects(createTransport(grok())(PROMPT, {}), (e) => {
    assert.ok(e instanceof GrokError);
    assert.equal(e.code, "auth");
    assert.match(e.message, /grok login/);
    return true;
  });
  process.env.FAKE_GROK_MODE = "crash";
  await assert.rejects(createTransport(grok())(PROMPT, {}), (e) => {
    assert.equal(e.code, "server");
    assert.equal(e.retryable, true);
    assert.equal(e.message, "Grok CLI feilet: panic: index out of range");
    return true;
  });
  await assert.rejects(createTransport(grok({ command: path.join(m.home, "finnes-ikke") }))(PROMPT, {}), (e) => {
    assert.equal(e.code, "no_key");
    assert.match(e.message, /Fant ikke Grok CLI/);
    return true;
  });
});

test("avbrudd stopper hele prosessgruppen og rydder opp", async (t) => {
  const m = machine(t);
  const pidFile = path.join(m.home, "barnebarn.pid");
  fakeGrok(t, m, "slow", { FAKE_GROK_DELAY_MS: "20000", FAKE_GROK_PIDFILE: pidFile });
  const ac = new AbortController();
  const started = Date.now();
  const pending = createTransport(grok())(PROMPT, { signal: ac.signal });
  const grandchild = Number(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8"), { what: "barnebarnet" }));
  assert.ok(isAlive(grandchild));
  ac.abort(new Error("stopp"));
  await assert.rejects(pending, /stopp/);
  assert.ok(Date.now() - started < 10000);
  await waitFor(() => !isAlive(grandchild), { what: "at barnebarnet dør" });
  const promptFile = m.grokCalls()[0].args.at(-1);
  assert.equal(fs.existsSync(path.dirname(promptFile)), false);
});

test("gjennom translateStrings: batcher i riktig rekkefølge og kostnad per kall", async (t) => {
  const m = machine(t);
  fakeGrok(t, m, "ok");
  const strings = Array.from({ length: 60 }, (_, i) => `Sentence ${i}`);
  const calls = [];
  const out = await translateStrings({
    strings,
    transport: createTransport(grok()),
    concurrency: 2,
    targetLanguage: "nynorsk",
    onCall: (c) => calls.push(c),
  });
  assert.deepEqual(out, strings.map((s) => "NN:" + s.toUpperCase()));
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.ok && c.costUsd === 0.0007));
});
