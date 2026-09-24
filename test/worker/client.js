// Liten HTTP-klient for integrasjonstestene: husker innloggingskapselen og setter CSRF-hodet.
const FINAL = ["done", "partial", "failed", "cancelled"];

class Client {
  constructor(base, { ip } = {}) {
    this.base = base;
    this.cookie = null;
    this.ip = ip;
  }

  async req(method, path, { json, body, headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.ip) h["CF-Connecting-IP"] = this.ip;
    if (csrf && !["GET", "HEAD"].includes(method)) h["X-InnNorsk"] = "1";
    if (json !== undefined) {
      h["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    }
    const res = await fetch(this.base + path, { method, headers: h, body, redirect: "manual" });
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

  patch(path, json, opts = {}) {
    return this.req("PATCH", path, { json, ...opts });
  }

  del(path, opts) {
    return this.req("DELETE", path, opts);
  }

  login(username, password) {
    return this.post("/api/auth/login", { username, password });
  }

  async newJob(targetLanguage = "bokmal") {
    const res = await this.post("/api/jobs", { targetLanguage });
    if (res.status !== 201) throw new Error(`Kunne ikke opprette jobb: ${res.status} ${JSON.stringify(res.data)}`);
    return res.data.job;
  }

  upload(jobId, relPath, content) {
    return this.req("PUT", `/api/jobs/${jobId}/files?path=${encodeURIComponent(relPath)}`, { body: content });
  }

  async waitFor(jobId, { timeoutMs = 60000, until = (job) => FINAL.includes(job.status) } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.get(`/api/jobs/${jobId}`);
      if (res.status !== 200) throw new Error(`GET jobb ga ${res.status}`);
      if (until(res.data.job, res.data)) return res.data;
      if (Date.now() > deadline) throw new Error(`Jobben ble ikke ferdig: ${JSON.stringify(res.data.job)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Oppretter jobb, laster opp filene ({ path: innhold }), starter og venter til den er ferdig.
  async translate(files, { targetLanguage, timeoutMs } = {}) {
    const job = await this.newJob(targetLanguage);
    for (const [path, content] of Object.entries(files)) {
      const res = await this.upload(job.id, path, content);
      if (res.status !== 201) throw new Error(`Opplasting av ${path} ga ${res.status} ${JSON.stringify(res.data)}`);
    }
    const started = await this.post(`/api/jobs/${job.id}/start`);
    if (started.status !== 200) throw new Error(`Start ga ${started.status} ${JSON.stringify(started.data)}`);
    return this.waitFor(job.id, { timeoutMs });
  }
}

async function loggedIn(base, username, password, opts) {
  const client = new Client(base, opts);
  const res = await client.login(username, password);
  if (res.status !== 200) throw new Error(`Innlogging for ${username} ga ${res.status} ${JSON.stringify(res.data)}`);
  return client;
}

module.exports = { Client, loggedIn, FINAL };
