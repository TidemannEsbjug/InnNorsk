// Klient for Workerens agent-API (/api/agent/*), med agent-tokenet som Bearer.
// Nettverksfeil, tidsavbrudd, 429 og 5xx gir ApiError med retry = true (prøv igjen, behold fila).
class ApiError extends Error {
  constructor(message, { status = 0, retry = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retry = retry;
  }
}

function createApi({ siteUrl, token, timeoutMs = 20000, transferTimeoutMs = 600000 }) {
  const base = String(siteUrl || "").replace(/\/+$/, "");

  async function call(method, pathname, { json, body, raw = false, timeout = timeoutMs } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    else if (body) headers["Content-Type"] = "application/octet-stream";
    let res;
    let data;
    try {
      res = await fetch(base + pathname, {
        method,
        headers,
        body: json !== undefined ? JSON.stringify(json) : body,
        signal: AbortSignal.timeout(timeout),
      });
      data = raw && res.ok ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (err) {
      const reason = (err.cause && (err.cause.code || err.cause.message)) || err.message;
      throw new ApiError(`Fikk ikke kontakt med ${base} (${reason}).`, { retry: true });
    }
    if (!res.ok) {
      let message = "";
      try {
        message = JSON.parse(data).error || "";
      } catch {
        // ikke JSON
      }
      if (res.status === 401) message = "Nettstedet avviste agent-tokenet (401).";
      const retry = res.status >= 500 || res.status === 429 || res.status === 408;
      throw new ApiError(message || `HTTP ${res.status} fra ${pathname}`, { status: res.status, retry });
    }
    if (raw) return data;
    try {
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  const file = (id) => `/api/agent/files/${encodeURIComponent(id)}`;
  return {
    health: () => call("GET", "/healthz"),
    poll: async (heartbeat) => ((await call("POST", "/api/agent/poll", { json: heartbeat })) || {}).files || [],
    async claim(id, leaseSeconds) {
      try {
        await call("POST", `${file(id)}/claim`, { json: { leaseSeconds } });
        return true;
      } catch (err) {
        if (err.status === 409) return false;
        throw err;
      }
    },
    original: (id) => call("GET", `${file(id)}/original`, { raw: true, timeout: transferTimeoutMs }),
    progress: (id, body) => call("POST", `${file(id)}/progress`, { json: body }),
    result: (id, { name, costUsd, buffer }) =>
      call("PUT", `${file(id)}/result?name=${encodeURIComponent(name)}&costUsd=${Number(costUsd.toFixed(6))}`, {
        body: buffer,
        timeout: transferTimeoutMs,
      }),
    fail: (id, body) => call("POST", `${file(id)}/fail`, { json: body }),
    release: (id, reason) => call("POST", `${file(id)}/release`, { json: { reason } }),
    log: (entry) => call("POST", "/api/agent/log", { json: entry, timeout: 5000 }),
  };
}

module.exports = { createApi, ApiError };
