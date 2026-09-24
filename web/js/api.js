// Felles hjelpere for alle sidene: API-kall, trygg DOM-bygging og norsk formatering.

export async function api(path, { method = "GET", body } = {}) {
  const headers = { "X-InnNorsk": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new Error("Fikk ikke kontakt med serveren. Sjekk internettforbindelsen og prøv igjen.");
  }
  // På innloggingssiden er 401 et vanlig svar, ikke et tegn på utløpt økt.
  if (res.status === 401 && location.pathname !== "/login") {
    location.href = "/login";
    throw new Error("Du er logget ut. Logg inn på nytt.");
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(
      (data && data.error) || `Noe gikk galt på serveren (feilkode ${res.status}). Prøv igjen om litt.`
    );
    err.status = res.status;
    throw err;
  }
  return data;
}

// Lager et element. Strenger blir tekstnoder, så innhold fra serveren blir aldri tolket som HTML.
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node && !key.includes("-")) node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  append(node, children);
  return node;
}

// Som replaceChildren, men hopper over null/false (replaceChildren ville skrevet «null»).
export function fill(node, ...children) {
  node.replaceChildren();
  append(node, children);
}

function append(node, children) {
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatNumber(n) {
  return Number(n || 0).toLocaleString("nb-NO");
}

// Omtrentlig varighet for estimater: "under 1 min", "ca. 12 min", "ca. 1 t 5 min".
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "–";
  if (seconds < 60) return "under 1 min";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `ca. ${minutes} min`;
  const rest = minutes % 60;
  return `ca. ${Math.floor(minutes / 60)} t${rest ? ` ${rest} min` : ""}`;
}

const pad = (n) => String(n).padStart(2, "0");

export function formatClock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  const day =
    days === 0 ? "i dag"
      : days === 1 ? "i går"
        : d.toLocaleDateString("nb-NO", { day: "numeric", month: "short", year: days > 300 ? "numeric" : undefined });
  return `${day} kl. ${formatClock(d)}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function formatBytes(n) {
  const bytes = Number(n || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString("nb-NO", { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

// "akkurat nå", "for 3 min siden", "om 2 dager".
export function relativeTime(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = (Date.now() - t) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "akkurat nå";
  let text;
  if (abs < 90 * 60) text = `${Math.round(abs / 60)} min`;
  else if (abs < 36 * 3600) text = `${Math.round(abs / 3600)} t`;
  else {
    const days = Math.round(abs / 86400);
    text = `${days} ${days === 1 ? "dag" : "dager"}`;
  }
  return diff >= 0 ? `for ${text} siden` : `om ${text}`;
}

const STATUS_LABELS = {
  draft: "Ikke startet",
  queued: "I kø",
  running: "Oversetter",
  done: "Ferdig",
  partial: "Delvis ferdig",
  failed: "Feilet",
  cancelled: "Avbrutt",
  ready: "Klar",
  working: "Oversetter",
  skipped: "Hoppet over",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || "";
}

export const LANGUAGE_LABELS = { bokmal: "Bokmål", nynorsk: "Nynorsk" };

export async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // Selv om serveren ikke svarer, skal brukeren til innloggingssiden.
  }
  location.href = "/login";
}

// Sender uventede JavaScript-feil til serverloggen, maks 5 i minuttet.
export function reportErrors() {
  const sent = [];
  const send = (message, stack) => {
    const now = Date.now();
    while (sent.length && now - sent[0] > 60000) sent.shift();
    if (sent.length >= 5) return;
    sent.push(now);
    fetch("/api/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-InnNorsk": "1" },
      body: JSON.stringify({
        level: "error",
        message: String(message || "Ukjent feil").slice(0, 500),
        stack: stack ? String(stack).slice(0, 4000) : undefined,
        url: location.pathname + location.hash,
      }),
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => {});
  };
  window.addEventListener("error", (e) => send(e.message, e.error && e.error.stack));
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    send(reason && reason.message ? reason.message : String(reason), reason && reason.stack);
  });
}
