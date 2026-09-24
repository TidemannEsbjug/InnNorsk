// Felles hjelpere for rutene: norske feil som JSON, trygg JSON-lesing og loggkontekst.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function fail(status, message) {
  throw new HttpError(status, message);
}

// optional: tom kropp gir {} (agenten kan sende f.eks. claim uten innhold).
export async function readJson(c, { optional = false } = {}) {
  try {
    const text = await c.req.text();
    if (optional && !text.trim()) return {};
    const body = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {
    // faller gjennom til feilmeldingen under
  }
  return fail(400, "Ugyldig forespørsel.");
}

export const clientIp = (c) => c.req.header("CF-Connecting-IP") || null;

// Hvor forespørselen kommer fra, for loggen: iPhone-appen sender X-InnNorsk-Client: ios.
const clientSource = (c) => (c.req.header("X-InnNorsk-Client") === "ios" ? "ios" : "web");

export function reqCtx(c, extra = {}) {
  const user = c.get("user");
  const session = c.get("session");
  return {
    userId: user ? user.id : null,
    sessionId: session ? session.id : null,
    ip: clientIp(c),
    source: clientSource(c),
    ...extra,
  };
}

export const str = (v, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");

// Endelig tall i [min, max], ellers fallback.
export function clamp(v, min, max, fallback) {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? fallback : Math.min(max, Math.max(min, n));
}
