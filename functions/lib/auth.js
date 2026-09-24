const enc = new TextEncoder();

function b64url(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlFromString(s) {
  return b64url(enc.encode(s));
}

function fromB64url(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function safeEqual(a, b) {
  const aa = enc.encode(String(a || ""));
  const bb = enc.encode(String(b || ""));
  const len = Math.max(aa.length, bb.length, 1);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (aa[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signPayload(secret, payload) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `${b64urlFromString(payload)}.${b64url(sig)}`;
}

export async function verifyToken(secret, token) {
  if (!token || !token.includes(".")) return null;
  const [p, s] = token.split(".");
  if (!p || !s) return null;
  const payloadBytes = fromB64url(p);
  const payload = new TextDecoder().decode(payloadBytes);
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, fromB64url(s), payloadBytes);
  if (!ok) return null;
  const parts = payload.split("|");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const exp = Number(parts[2]);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return { user: parts[1], exp };
}

export function cookieHeader(token, request, maxAge) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const bits = [
    `innnorsk=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function readCookie(request) {
  const raw = request.headers.get("Cookie") || "";
  const m = raw.match(/(?:^|;\s*)innnorsk=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export async function requireUser(request, env) {
  const secret = env.SESSION_SECRET;
  if (!secret) return { error: json({ error: "Server mangler SESSION_SECRET." }, 500) };
  const session = await verifyToken(secret, readCookie(request));
  if (!session) return { error: json({ error: "Ikke innlogget." }, 401) };
  return { user: session.user };
}
