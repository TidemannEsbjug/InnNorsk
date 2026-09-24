// Felles hjelpere for alle sidene: API-kall, opplasting, trygg DOM-bygging og norsk formatering.

const OFFLINE = "Fikk ikke kontakt med serveren. Sjekk internettforbindelsen og prøv igjen.";

function failure(status, data) {
  const err = new Error((data && data.error) || `Noe gikk galt på serveren (feilkode ${status}). Prøv igjen om litt.`);
  err.status = status;
  return err;
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// På innloggingssiden er 401 et vanlig svar, ikke et tegn på utløpt økt.
function toLogin(status) {
  if (status !== 401 || location.pathname === "/login") return false;
  location.href = "/login";
  return true;
}

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
    const err = new Error(OFFLINE);
    err.status = 0;
    throw err;
  }
  if (toLogin(res.status)) throw failure(401, { error: "Du er logget ut. Logg inn på nytt." });
  const data = parse(await res.text());
  if (!res.ok) throw failure(res.status, data);
  return data;
}

// Rå filopplasting med fremdrift (fetch kan ikke rapportere opplastingsfremdrift).
export function upload(url, blob, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("PUT", url);
    xhr.setRequestHeader("X-InnNorsk", "1");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener("load", () => {
      if (signal) signal.removeEventListener("abort", abort);
      if (toLogin(xhr.status)) return;
      const data = parse(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(failure(xhr.status, data));
    });
    xhr.addEventListener("error", () => reject(Object.assign(new Error("Opplastingen ble brutt. Sjekk internettforbindelsen og prøv igjen."), { status: 0 })));
    xhr.addEventListener("abort", () => reject(new DOMException("Avbrutt", "AbortError")));
    if (signal) {
      if (signal.aborted) return xhr.abort();
      signal.addEventListener("abort", abort);
    }
    xhr.send(blob);
  });
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

// Som replaceChildren, men hopper over null/false.
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

export function plural(n, one, many) {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

// Omtrentlig varighet: "under 1 min", "ca. 12 min", "ca. 1 t 5 min".
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

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// "I dag", "I går" eller "12. september" (med år hvis det ikke er i år).
export function formatDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days === 0) return "I dag";
  if (days === 1) return "I går";
  return d.toLocaleDateString("nb-NO", {
    day: "numeric",
    month: "long",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
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

// "akkurat nå", "for 5 sekunder siden", "for 3 min siden", "om 2 dager".
export function relativeTime(value) {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return "";
  const diff = (Date.now() - t) / 1000;
  const abs = Math.abs(diff);
  if (abs < 5) return "akkurat nå";
  let text;
  if (abs < 60) text = `${Math.floor(abs)} sekunder`;
  else if (abs < 90 * 60) text = `${Math.round(abs / 60)} min`;
  else if (abs < 36 * 3600) text = `${Math.round(abs / 3600)} t`;
  else {
    const days = Math.round(abs / 86400);
    text = `${days} ${days === 1 ? "dag" : "dager"}`;
  }
  return diff >= 0 ? `for ${text} siden` : `om ${text}`;
}

const STATUS_LABELS = {
  draft: "Ikke startet",
  queued: "Venter på tur",
  running: "Oversetter",
  done: "Ferdig",
  partial: "Delvis ferdig",
  failed: "Feilet",
  cancelled: "Avbrutt",
  ready: "Klar",
  working: "Oversetter",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || "";
}

export const LANGUAGE_LABELS = { bokmal: "Bokmål", nynorsk: "Nynorsk" };

export function remember(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Privat modus eller blokkert lagring: siden virker fortsatt, bare uten å huske.
  }
}

export function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Vennlig bekreftelse i stedet for nettleserens confirm(). Gir true når brukeren sier ja.
export function confirmDialog({ title, text, confirm = "Ja", cancel = "Avbryt", danger = false }) {
  return new Promise((resolve) => {
    const cancelButton = h("button", { type: "submit", value: "cancel", class: "btn btn-secondary" }, cancel);
    const dialog = h("dialog", { class: "modal", "aria-labelledby": "confirm-title" },
      h("form", { method: "dialog", class: "modal-body" },
        h("h2", { id: "confirm-title" }, title),
        text ? h("p", null, text) : null,
        h("div", { class: "modal-actions" },
          cancelButton,
          h("button", { type: "submit", value: "ok", class: `btn ${danger ? "btn-danger" : "btn-primary"}` }, confirm)
        )
      )
    );
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    cancelButton.focus();
  });
}

// Kort beskjed nederst på skjermen som forsvinner av seg selv.
export function toast(message) {
  let box = document.getElementById("toast");
  if (!box) {
    box = h("div", { id: "toast", class: "toast", role: "status" });
    document.body.append(box);
  }
  box.textContent = message;
  box.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.remove("show"), 4000);
}

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
        context: { userAgent: navigator.userAgent },
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
