// Falsk xAI over HTTP (POST /v1/responses) for wrangler dev og manuelle tester. Kaller ALDRI det ekte API-et.
// Samme moduser og samme oversettelse som mock-grok.js (upper, mismatch, flaky429, flaky500, fail401, fail403, slow).
// I tillegg: tekst som inneholder FAIL_MARKER får alltid 400 (gir én fil som feiler, f.eks. for «partial»).
//
//   const mock = await require("./mock-xai-server").start({ mode: "slow", delayMs: 300 });
//   mock.url  → http://127.0.0.1:<port>   (sett XAI_BASE_URL til denne)
//   mock.setMode("fail401"); mock.state.calls; await mock.close();
// Styring over HTTP: POST /__mode {mode, delayMs} · GET /__state · POST /__reset
// CLI: node test/helpers/mock-xai-server.js [port] [mode] [delayMs]
const http = require("node:http");
const { transform } = require("./mock-grok");

const MODES = ["upper", "mismatch", "flaky429", "flaky500", "fail401", "fail403", "slow"];
const FAIL_MARKER = "[[mock-400]]";

function extractArray(input) {
  const i = input.indexOf("\n\n[");
  if (i === -1) return null;
  try {
    return JSON.parse(input.slice(i + 2, input.lastIndexOf("]") + 1));
  } catch {
    return null;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function start({ port = 0, mode = "upper", delayMs = 200 } = {}) {
  const state = { mode, delayMs, calls: 0, strings: 0, chars: 0, requests: [] };

  function setMode(next, nextDelay) {
    if (!MODES.includes(next)) throw new Error(`Ukjent modus: ${next}`);
    state.mode = next;
    if (nextDelay != null) state.delayMs = Number(nextDelay);
  }

  function reset() {
    Object.assign(state, { calls: 0, strings: 0, chars: 0, requests: [] });
  }

  async function respond(req, res) {
    state.calls++;
    const n = state.calls;
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: "Invalid JSON" });
    }
    const input = String(body.input || "");
    state.requests.push({ model: body.model, input, authorization: Boolean(req.headers.authorization) });
    const m = state.mode;
    if (m === "fail401") return send(res, 401, { error: "Incorrect API key provided" });
    if (m === "fail403") return send(res, 403, { error: "The API key does not have permission (acls: api-key:endpoint:voice)" });
    if (m === "flaky429" && n % 3 === 1) return send(res, 429, { error: "Rate limit exceeded" }, { "retry-after": "0" });
    if (m === "flaky500" && n % 3 === 1) return send(res, 503, { error: "Service unavailable" });
    if (input.includes(FAIL_MARKER)) return send(res, 400, { error: "Bad request (mock)" });
    if (m === "slow") {
      const aborted = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), state.delayMs);
        res.on("close", () => {
          clearTimeout(t);
          resolve(!res.writableFinished);
        });
      });
      if (aborted) return;
    }
    const arr = extractArray(input);
    let text;
    if (!arr) {
      const single = input.match(/\n\n([\s\S]+)$/);
      text = /nøyaktig ett ord: OK/i.test(input) ? "OK" : transform(single ? single[1] : "OK");
    } else {
      state.strings += arr.length;
      state.chars += arr.reduce((acc, s) => acc + String(s).length, 0);
      let out = arr.map(transform);
      if (m === "mismatch" && out.length > 1 && n % 2 === 1) out = out.slice(0, -1);
      text = JSON.stringify(out);
    }
    send(res, 200, {
      model: body.model,
      output_text: text,
      usage: { input_tokens: Math.ceil(input.length / 4), output_tokens: Math.ceil(text.length / 4) },
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/v1/responses") return await respond(req, res);
      if (req.method === "POST" && req.url === "/__mode") {
        const { mode: next, delayMs: nextDelay } = JSON.parse((await readBody(req)) || "{}");
        setMode(next, nextDelay);
        return send(res, 200, { mode: state.mode, delayMs: state.delayMs });
      }
      if (req.method === "POST" && req.url === "/__reset") {
        reset();
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && req.url === "/__state") {
        const { requests, ...rest } = state;
        return send(res, 200, { ...rest, requests: requests.length });
      }
      send(res, 404, { error: "Not found" });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        state,
        setMode,
        reset,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = { start, MODES, FAIL_MARKER };

if (require.main === module) {
  const [port, mode, delayMs] = process.argv.slice(2);
  start({ port: Number(port) || 0, mode: mode || "upper", delayMs: Number(delayMs) || 200 }).then((mock) => {
    console.log(`Falsk xAI lytter på ${mock.url} (modus ${mock.state.mode}, ${mock.state.delayMs} ms)`);
  });
}
