// Falsk APNs over HTTP for wrangler dev og tester. Kaller ALDRI Apple.
// Tar imot POST /3/device/<token>, sjekker ES256-JWT-en mot den offentlige nøkkelen og husker alt som kom inn.
//   const apns = await require("./mock-apns").start({ publicKey });
//   apns.url → http://127.0.0.1:<port>  (sett APNS_BASE_URL til denne)
//   apns.pushes → [{ token, topic, pushType, priority, payload, jwt: { header, claims }, jwtValid, status }]
//   apns.failToken(token, 410 | 400)  → svarer Unregistered / BadDeviceToken for dette tokenet
//   await apns.waitFor((pushes) => pushes.length >= 1); apns.reset(); await apns.close();
const http = require("node:http");
const crypto = require("node:crypto");

const REASONS = { 400: "BadDeviceToken", 403: "InvalidProviderToken", 404: "BadPath", 410: "Unregistered" };

function decodeJwt(jwt, publicKey) {
  const [h, c, s] = String(jwt || "").split(".");
  try {
    const header = JSON.parse(Buffer.from(h, "base64url"));
    const claims = JSON.parse(Buffer.from(c, "base64url"));
    const valid = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s, "base64url")
    );
    return { header, claims, valid };
  } catch {
    return { header: null, claims: null, valid: false };
  }
}

function start({ publicKey } = {}) {
  const pushes = [];
  const failures = new Map();

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const match = /^\/3\/device\/([0-9a-fA-F]+)$/.exec(req.url);
      const send = (status, reason) => {
        res.writeHead(status, { "content-type": "application/json", "apns-id": crypto.randomUUID() });
        res.end(reason ? JSON.stringify({ reason }) : "");
      };
      if (req.method !== "POST" || !match) return send(404, REASONS[404]);
      const token = match[1];
      const auth = req.headers.authorization || "";
      const jwt = decodeJwt(auth.replace(/^bearer /i, ""), publicKey);
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        // ugyldig kropp registreres som null
      }
      const entry = {
        token,
        topic: req.headers["apns-topic"],
        pushType: req.headers["apns-push-type"],
        priority: req.headers["apns-priority"],
        payload,
        jwt: { header: jwt.header, claims: jwt.claims },
        jwtValid: jwt.valid,
        status: jwt.valid ? failures.get(token) || 200 : 403,
      };
      pushes.push(entry);
      return send(entry.status, REASONS[entry.status]);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        pushes,
        failToken: (token, status = 410) => failures.set(token, status),
        reset: () => {
          pushes.length = 0;
          failures.clear();
        },
        async waitFor(until = (p) => p.length > 0, timeoutMs = 5000) {
          const deadline = Date.now() + timeoutMs;
          while (!until(pushes)) {
            if (Date.now() > deadline) throw new Error(`Falsk APNs fikk ikke forventet push: ${JSON.stringify(pushes)}`);
            await new Promise((r) => setTimeout(r, 50));
          }
          return pushes;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { start };
