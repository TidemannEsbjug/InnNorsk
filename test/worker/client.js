// Liten HTTP-klient for integrasjonstestene: husker innloggingskapselen, setter CSRF-hodet og logger inn
// som nettleseren gjør (salt → PBKDF2-bevis → login). Med { bearer } er den Mac-agenten i stedet.
const crypto = require("node:crypto");
const { pbkdf2Proof, ITERATIONS } = require("../../scripts/make-user");

// PBKDF2 med 310 000 runder tar ~0,1 s; samme passord og salt regnes bare ut én gang.
const proofs = new Map();
function proofFor(password, salt, iterations) {
  const key = `${password}\0${salt}\0${iterations}`;
  if (!proofs.has(key)) proofs.set(key, pbkdf2Proof(password, salt, iterations));
  return proofs.get(key);
}

// Som newSaltedProof i nettleseren: nytt tilfeldig salt + bevis for et nytt passord.
function newSecret(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  return { salt, iterations: ITERATIONS, proof: proofFor(password, salt, ITERATIONS) };
}

// Venter til fn() gir en sann verdi (f.eks. noe som logges etter svaret via waitUntil) og returnerer den.
async function eventually(fn, { timeoutMs = 5000, what = "betingelsen" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Tidsavbrudd: ${what} ble aldri oppfylt`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

class Client {
  constructor(base, { ip, bearer } = {}) {
    this.base = base;
    this.cookie = null;
    this.ip = ip;
    this.bearer = bearer;
  }

  async req(method, path, { json, body, headers = {}, csrf = !this.bearer } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.ip) h["CF-Connecting-IP"] = this.ip;
    if (this.bearer) h.Authorization = `Bearer ${this.bearer}`;
    if (csrf && !["GET", "HEAD"].includes(method)) h["X-InnNorsk"] = "1";
    if (json !== undefined) {
      h["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    }
    const init = { method, headers: h, body, redirect: "manual" };
    if (body && typeof body.getReader === "function") init.duplex = "half";
    const res = await fetch(this.base + path, init);
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0];
      this.cookie = pair.endsWith("=") ? null : pair;
    }
    const type = res.headers.get("content-type") || "";
    const raw = Buffer.from(await res.arrayBuffer());
    const data = type.includes("application/json") ? JSON.parse(raw.toString("utf8")) : raw;
    return { status: res.status, headers: res.headers, data, setCookie };
  }

  get(path, opts) {
    return this.req("GET", path, opts);
  }

  post(path, json, opts = {}) {
    return this.req("POST", path, { json, ...opts });
  }

  put(path, body, opts = {}) {
    return this.req("PUT", path, { body, ...opts });
  }

  patch(path, json, opts = {}) {
    return this.req("PATCH", path, { json, ...opts });
  }

  del(path, opts) {
    return this.req("DELETE", path, opts);
  }

  async login(username, password) {
    const { data } = await this.post("/api/auth/salt", { username });
    return this.post("/api/auth/login", { username, proof: proofFor(password, data.salt, data.iterations) });
  }

  async newSending(targetLanguage = "bokmal", note) {
    const res = await this.post("/api/sendings", { targetLanguage, note });
    if (res.status !== 201) throw new Error(`Kunne ikke opprette sending: ${res.status} ${JSON.stringify(res.data)}`);
    return res.data.sending;
  }

  upload(sendingId, relPath, content, opts) {
    return this.put(`/api/sendings/${sendingId}/files?path=${encodeURIComponent(relPath)}`, content, opts);
  }

  // Oppretter en sending, laster opp filene ({ sti: innhold }) og sender den. Returnerer sendingen.
  async send(files, { targetLanguage, note } = {}) {
    const sending = await this.newSending(targetLanguage, note);
    for (const [relPath, content] of Object.entries(files)) {
      const res = await this.upload(sending.id, relPath, content);
      if (res.status !== 201) throw new Error(`Opplasting av ${relPath} ga ${res.status} ${JSON.stringify(res.data)}`);
    }
    const sent = await this.post(`/api/sendings/${sending.id}/send`);
    if (sent.status !== 200) throw new Error(`Send ga ${sent.status} ${JSON.stringify(sent.data)}`);
    return sent.data.sending;
  }
}

module.exports = { Client, proofFor, newSecret, eventually };
