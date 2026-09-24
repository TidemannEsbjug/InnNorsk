// Minimal falsk utgave av Workerens agent-API (/api/agent/*) i minnet, for å teste Mac-mottaket isolert.
//   const api = await startFakeAgentApi({ token: "dummy-agent-token" });
//   const file = api.addFile({ name: "Rapport.docx", body });
//   ... file.status, file.history, file.result, api.calls, api.events, api.heartbeats
//   api.failNext("PUT", /\/result$/, 503, 2);   // de neste 2 treffene svarer 503
//   await api.close();
const http = require("node:http");
const crypto = require("node:crypto");

const nowIso = () => new Date().toISOString();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function startFakeAgentApi({ token = "dummy-agent-token" } = {}) {
  const files = new Map();
  const calls = [];
  const events = [];
  const heartbeats = [];
  const failures = [];

  function setStatus(file, status) {
    file.status = status;
    file.history.push(status);
  }

  function publicFile(f) {
    const { id, sendingId, name, relPath, ext, bytes, targetLanguage, note, username, displayName } = f;
    return { id, sendingId, name, relPath, ext, bytes, targetLanguage, note, username, displayName };
  }

  const claimable = (f) => f.status === "sent" || (f.status === "working" && f.leaseUntil < Date.now());

  function route(req, url, body, json) {
    if (req.method === "POST" && url.pathname === "/api/agent/poll") {
      heartbeats.push({ ...json, at: nowIso() });
      const waiting = [...files.values()].filter(claimable).sort((a, b) => a.seq - b.seq);
      return [200, { files: waiting.slice(0, 20).map(publicFile) }];
    }
    if (req.method === "POST" && url.pathname === "/api/agent/log") {
      events.push(json);
      return [200, { ok: true }];
    }
    const m = url.pathname.match(/^\/api\/agent\/files\/([^/]+)\/(claim|original|progress|result|fail|release)$/);
    const file = m && files.get(decodeURIComponent(m[1]));
    if (!file) return [404, { error: "Fant ikke filen." }];
    const action = `${req.method} ${m[2]}`;
    if (action === "POST claim") {
      if (!claimable(file)) return [409, { error: "Filen er allerede tatt." }];
      setStatus(file, "working");
      file.attempts++;
      file.leaseUntil = Date.now() + json.leaseSeconds * 1000;
      return [200, { ok: true }];
    }
    if (action === "GET original") return [200, file.body];
    if (file.status !== "working") return [409, { error: "Filen er ikke under arbeid." }];
    if (action === "POST progress") {
      file.progress.push({ ...json, at: Date.now() });
      if (json.leaseSeconds) file.leaseUntil = Date.now() + json.leaseSeconds * 1000;
      return [200, { ok: true }];
    }
    if (action === "PUT result") {
      Object.assign(file, { result: body, outputName: url.searchParams.get("name"), costUsd: Number(url.searchParams.get("costUsd")) });
      setStatus(file, "done");
      return [200, { ok: true }];
    }
    if (action === "POST fail") {
      Object.assign(file, { error: json.message, errorDetails: json.details, costUsd: json.costUsd });
      setStatus(file, "failed");
      return [200, { ok: true }];
    }
    if (action === "POST release") {
      file.releaseReason = json.reason;
      file.leaseUntil = 0;
      setStatus(file, "sent");
      return [200, { ok: true }];
    }
    return [405, { error: "Ikke støttet." }];
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = await readBody(req);
    const json = /json/.test(req.headers["content-type"] || "") && body.length ? JSON.parse(body) : null;
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: json, at: Date.now() });
    const reply = (status, data) => {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
      res.writeHead(status, { "content-type": Buffer.isBuffer(data) ? "application/octet-stream" : "application/json" });
      res.end(raw);
    };
    if (url.pathname === "/healthz") return reply(200, { ok: true });
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "Ugyldig agent-token." });
    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path.test(url.pathname));
    if (failure) {
      failure.times--;
      return reply(failure.status, { error: "Midlertidig feil (test)." });
    }
    reply(...route(req, url, body, json));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let seq = 0;

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    files,
    calls,
    events,
    heartbeats,
    addFile({ name, relPath = name, body, targetLanguage = "bokmal", displayName = "Svetlana", username = "svetlana" }) {
      const id = crypto.randomBytes(10).toString("hex").slice(0, 16);
      const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
      const file = {
        id,
        sendingId: "sending-1",
        name,
        relPath,
        ext,
        bytes: body.length,
        targetLanguage,
        note: null,
        username,
        displayName,
        body,
        status: "sent",
        history: ["sent"],
        attempts: 0,
        leaseUntil: 0,
        progress: [],
        seq: seq++,
      };
      files.set(id, file);
      return file;
    },
    failNext(method, path, status, times = 1) {
      failures.push({ method, path, status, times });
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startFakeAgentApi };
