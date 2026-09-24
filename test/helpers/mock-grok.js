// Falsk xAI Grok for tester. Kaller ALDRI det ekte API-et.
// const mock = require("./helpers/mock-grok"); mock.install({ mode: "upper" }); ... mock.uninstall();
// Moduser:
//   upper     hver streng -> "NB:" + ord i store bokstaver; mellomrom/linjeskift/tab bevares nøyaktig
//   mismatch  annethvert kall mangler siste element i arrayen
//   flaky429  hvert 3. kall (1, 4, 7 …) svarer 429 med Retry-After: 0
//   flaky500  hvert 3. kall svarer 503
//   fail401   alle kall svarer 401
//   fail403   alle kall svarer 403 { error: "string" } (som en voice-nøkkel)
//   slow      som upper, men venter opts.delayMs (standard 200 ms)
const realFetch = global.fetch;
const state = { mode: "upper", delayMs: 200, calls: 0, strings: 0, chars: 0, requests: [] };

function transform(s) {
  return "NB:" + String(s).replace(/[^\s]+/g, (w) => w.toUpperCase());
}

function extractArray(input) {
  const i = input.indexOf("\n\n[");
  if (i === -1) return null;
  const end = input.lastIndexOf("]");
  try {
    return JSON.parse(input.slice(i + 2, end + 1));
  } catch {
    return null;
  }
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function fakeFetch(url, opts = {}) {
  if (!/api\.x\.ai|127\.0\.0\.1|localhost/.test(String(url))) {
    return realFetch(url, opts);
  }
  if (!String(url).includes("/v1/responses")) return realFetch(url, opts);
  if (opts.signal && opts.signal.aborted) throw opts.signal.reason || new Error("aborted");
  state.calls++;
  const n = state.calls;
  const body = JSON.parse(opts.body);
  state.requests.push({ model: body.model, input: String(body.input || "") });
  const mode = state.mode;
  if (mode === "fail401") return json(401, { error: "Incorrect API key provided" });
  if (mode === "fail403") return json(403, { error: "The API key does not have permission (acls: api-key:endpoint:voice)" });
  if (mode === "flaky429" && n % 3 === 1) return json(429, { error: "Rate limit exceeded" }, { "retry-after": "0" });
  if (mode === "flaky500" && n % 3 === 1) return json(503, { error: "Service unavailable" });
  if (mode === "slow") {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, state.delayMs);
      if (opts.signal) opts.signal.addEventListener("abort", () => { clearTimeout(t); reject(opts.signal.reason || new Error("aborted")); });
    });
  }
  const arr = extractArray(String(body.input || ""));
  let text;
  if (!arr) {
    // Enkeltstreng-/tilkoblingsprompt: returner "OK" eller oversett siste linje.
    const m = String(body.input || "").match(/\n\n([\s\S]+)$/);
    text = /nøyaktig ett ord: OK/i.test(body.input) ? "OK" : transform(m ? m[1] : "OK");
  } else {
    state.strings += arr.length;
    state.chars += arr.reduce((acc, s) => acc + String(s).length, 0);
    let out = arr.map(transform);
    if (mode === "mismatch" && out.length > 1 && n % 2 === 1) out = out.slice(0, -1);
    text = JSON.stringify(out);
  }
  return json(200, {
    model: body.model,
    output_text: text,
    usage: { input_tokens: Math.ceil(String(body.input).length / 4), output_tokens: Math.ceil(text.length / 4) },
  });
}

function install(opts = {}) {
  state.mode = opts.mode || "upper";
  state.delayMs = opts.delayMs || 200;
  reset();
  global.fetch = fakeFetch;
  return state;
}

function reset() {
  state.calls = 0;
  state.strings = 0;
  state.chars = 0;
  state.requests = [];
}

function setMode(mode) {
  state.mode = mode;
}

function uninstall() {
  global.fetch = realFetch;
}

module.exports = { install, uninstall, reset, setMode, state, transform };
