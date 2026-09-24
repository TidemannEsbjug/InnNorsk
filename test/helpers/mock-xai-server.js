// Falsk xAI over HTTP for wrangler dev og tester (pek XAI_BASE_URL hit). Kaller ALDRI det ekte API-et.
// Samme svar og moduser som mock-grok.js (upper, mismatch, flaky429, fail401, fail403, slow), med tokens i usage.
//   const xai = await require("./mock-xai-server").start({ mode: "slow", delayMs: 800 });
//   xai.url · xai.state (calls, requests: [{ model, input, auth }]) · xai.setMode("fail401", delayMs) · await xai.close()
// Modus kan også byttes under kjøring: POST /__mode {"mode":"upper","delayMs":0}.
// Fra kommandolinjen: node test/helpers/mock-xai-server.js [port] [modus] [delayMs]
const http = require("node:http");
const { respond } = require("./mock-grok");

function start({ port = 0, mode = "upper", delayMs = 200 } = {}) {
  const state = { mode, delayMs, calls: 0, strings: 0, chars: 0, requests: [] };
  const setMode = (next, ms) => {
    state.mode = next;
    if (ms != null) state.delayMs = ms;
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const send = (status, body, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return send(400, { error: "Invalid JSON" });
      }
      if (req.method === "POST" && req.url === "/__mode") {
        setMode(body.mode || state.mode, body.delayMs);
        return send(200, { mode: state.mode, delayMs: state.delayMs });
      }
      if (req.method !== "POST" || req.url !== "/v1/responses") return send(404, { error: "Not found" });
      if (!/^Bearer \S+/.test(req.headers.authorization || "")) return send(401, { error: "Missing API key" });
      const r = respond(state, body);
      state.requests[state.requests.length - 1].auth = true;
      const timer = setTimeout(() => {
        if (!res.destroyed) send(r.status, r.body, r.headers);
      }, r.delayMs);
      res.on("close", () => clearTimeout(timer));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        setMode,
        close: () => new Promise((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
      });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  const [port, mode, delayMs] = process.argv.slice(2);
  start({ port: Number(port) || 18080, mode, delayMs: delayMs ? Number(delayMs) : undefined }).then((xai) => {
    console.log(`Falsk xAI på ${xai.url} (modus ${xai.state.mode}). Bytt: curl -X POST ${xai.url}/__mode -d '{"mode":"slow","delayMs":1500}'`);
  });
}
