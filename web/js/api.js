// Felles hjelpere for alle sidene: API-kall, opplasting, innlogging med PBKDF2,
// trygg DOM-bygging (alt innhold blir tekstnoder, aldri HTML) og norsk formatering.

const OFFLINE = "Fikk ikke kontakt med serveren. Sjekk internettforbindelsen og prøv igjen.";

// Samme verdi som serveren gir ut for nye passord (PBKDF2-HMAC-SHA256).
export const ITERATIONS = 310000;

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

// Utløpt økt: tilbake til innloggingen. På selve innloggingssiden er 401 et vanlig svar.
function toLogin(status) {
  if (status !== 401 || location.pathname === "/login") return false;
  location.href = "/login";
  return true;
}

export async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (method !== "GET") headers["X-InnNorsk"] = "1";
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
    throw Object.assign(new Error(OFFLINE), { status: 0 });
  }
  if (toLogin(res.status)) throw failure(401, { error: "Du er logget ut. Logg inn på nytt." });
  const data = parse(await res.text());
  if (!res.ok) throw failure(res.status, data);
  return data;
}

// Rå filopplasting med fremdrift (fetch kan ikke rapportere hvor langt opplastingen har kommet).
export function upload(url, blob, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("X-InnNorsk", "1");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener("load", () => {
      if (toLogin(xhr.status)) return;
      const data = parse(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(failure(xhr.status, data));
    });
    xhr.addEventListener("error", () => reject(Object.assign(new Error("Opplastingen ble brutt. Sjekk internettforbindelsen og prøv igjen."), { status: 0 })));
    xhr.send(blob);
  });
}

// ---------- Passord: nøkkelstrekking i nettleseren, serveren lagrer bare sha256(proof) ----------

function toBase64url(bytes) {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
}

export async function pbkdf2Proof(password, salt, iterations) {
  if (!crypto.subtle) throw new Error("Nettleseren kan ikke logge inn trygt på denne adressen. Åpne siden med https://.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64url(salt), iterations }, key, 256);
  return toBase64url(new Uint8Array(bits));
}

// Nytt passord: nettleseren lager salt og proof, serveren ser aldri selve passordet.
export async function newSaltedProof(password) {
  const salt = toBase64url(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, iterations: ITERATIONS, proof: await pbkdf2Proof(password, salt, ITERATIONS) };
}

export async function proofFor(username, password) {
  const { salt, iterations } = await api("/api/auth/salt", { method: "POST", body: { username } });
  return pbkdf2Proof(password, salt, iterations);
}

// Bytter passord for den innloggede. currentProof kan gis direkte rett etter innlogging.
export async function changePassword({ username, current, currentProof, next }) {
  const proof = currentProof || await proofFor(username, current);
  const fresh = await newSaltedProof(next);
  await api("/api/auth/password", { method: "POST", body: { currentProof: proof, ...fresh } });
}

export function passwordProblem(next, repeat, current) {
  if (next.length < 8) return "Det nye passordet må ha minst 8 tegn.";
  if (next !== repeat) return "De to passordene er ikke like. Prøv en gang til.";
  if (current && next === current) return "Velg et annet passord enn det du har nå.";
  return "";
}

// «Vis»-knapper ved passordfelt (data-for="<input-id>").
export function bindPasswordToggles(root = document) {
  for (const toggle of root.querySelectorAll(".pw-toggle")) {
    toggle.addEventListener("click", () => {
      const input = document.getElementById(toggle.dataset.for);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.textContent = show ? "Skjul" : "Vis";
      toggle.setAttribute("aria-pressed", String(show));
    });
  }
}

// ---------- DOM ----------

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

const ICONS = {
  close: "M6 6l12 12M18 6L6 18",
  check: "M5.5 12.5l4.5 4.5 8.5-9.5",
  download: "M12 4v11m-5-5l5 5 5-5M5 19.5h14",
  upload: "M12 19V8m-5 5l5-5 5 5M5 4.5h14",
  trash: "M5 7h14M10 7V5h4v2m-7 0l1 12h8l1-12",
  heart: "M12 19s-7-4.5-7-9.5A3.8 3.8 0 0 1 12 7a3.8 3.8 0 0 1 7 2.5c0 5-7 9.5-7 9.5z",
  refresh: "M19 12a7 7 0 1 1-2.1-5M19 4v4h-4",
  copy: "M9 9h10v10H9zM5 15V5h10",
};

// Liten strekikon (SVG må lages i eget navnerom, derfor ikke via h()).
export function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

export function extBadge(name) {
  const ext = extOf(name).slice(1);
  return h("span", { class: `ext ext-${ext || "fil"}`, "aria-hidden": "true" }, ext.toUpperCase() || "FIL");
}

// Meny i toppen (<details class="menu">): lukkes ved klikk utenfor og med Escape.
export function initMenu() {
  const menu = document.querySelector(".menu");
  if (!menu) return;
  document.addEventListener("click", (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !menu.open) return;
    menu.open = false;
    menu.querySelector("summary").focus();
  });
  menu.addEventListener("click", (e) => {
    if (e.target.closest(".menu-list button")) menu.open = false;
  });
}

// ---------- Tekst og tall på norsk ----------

export function baseName(path) {
  const text = String(path || "");
  return text.slice(text.lastIndexOf("/") + 1);
}

export function dirName(path) {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i + 1) : "";
}

export function extOf(name) {
  const base = baseName(name);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

export function formatNumber(n, digits = 0) {
  return Number(n || 0).toLocaleString("nb-NO", { maximumFractionDigits: digits });
}

export function plural(n, one, many) {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

// Omtrentlig varighet: "under 1 min", "ca. 12 min", "ca. 1 t 5 min".
export function formatDuration(seconds) {
  if (seconds < 60) return "under 1 min";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `ca. ${minutes} min`;
  const rest = minutes % 60;
  return `ca. ${Math.floor(minutes / 60)} t${rest ? ` ${rest} min` : ""}`;
}

const pad = (n) => String(n).padStart(2, "0");

// Klokkeslett i 24-timersformat, "14:05".
export function formatClock(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// "I dag", "I går" eller "12. september" (med år hvis det ikke er i år).
export function dayLabel(value) {
  const d = new Date(value);
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

// Inne i en setning: "i dag 14:05", "i går 09:12", "12. september 10:00".
export function formatWhen(value) {
  if (!value) return "–";
  const day = dayLabel(value);
  return `${day.startsWith("I ") ? day.toLowerCase() : day} ${formatClock(value)}`;
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
  return `${formatNumber(value, value < 10 ? 1 : 0)} ${units[unit]}`;
}

// "akkurat nå", "for 40 sekunder siden", "for 3 min siden", "for 2 dager siden".
export function relativeTime(value) {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return "";
  const diff = (Date.now() - t) / 1000;
  const abs = Math.abs(diff);
  if (abs < 10) return "akkurat nå";
  let text;
  if (abs < 60) text = `${Math.floor(abs)} sekunder`;
  else if (abs < 90 * 60) text = `${Math.round(abs / 60)} min`;
  else if (abs < 36 * 3600) text = `${Math.round(abs / 3600)} t`;
  else text = plural(Math.round(abs / 86400), "dag", "dager");
  return diff >= 0 ? `for ${text} siden` : `om ${text}`;
}

export const LANGUAGE_LABELS = { bokmal: "Bokmål", nynorsk: "Nynorsk" };

// ---------- Lagring i nettleseren (bare bekvemmelighet; siden virker uten) ----------

export function remember(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Privat modus eller blokkert lagring.
  }
}

export function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ---------- Dialoger og beskjeder ----------

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
