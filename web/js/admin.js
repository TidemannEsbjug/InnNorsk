import {
  api, upload, h, fill, icon, extBadge, dirName, baseName, plural, formatBytes, formatClock, formatDuration, formatNumber,
  formatWhen, relativeTime, LANGUAGE_LABELS, confirmDialog, toast, logout, reportErrors, initMenu, newSaltedProof,
} from "./api.js";

reportErrors();
initMenu();

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const LOG_PAGE = 100;

const STATUS = { draft: "Utkast", sent: "Venter", working: "Oversettes", done: "Ferdig", failed: "Feilet" };
const SENDING_STATUS = { draft: "Utkast", sent: "Sendt", done: "Ferdig", deleted: "Slettet" };
const AGENT_STATE = { idle: "Venter på filer", working: "Oversetter", error: "Har et problem" };
const LEVELS = { info: "Info", warn: "Advarsel", error: "Feil" };
const SOURCES = { web: "Nettside", agent: "Mac", ios: "iPhone", system: "System" };

let me = null;
let current = "";
let timer = 0;
let sendings = [];
let resultTarget = null; // filen en manuell oversettelse skal lastes opp til
const replyDrafts = new Map();
const log = { events: [], more: false };

// ---------- Små hjelpere ----------

function panelError(name, message) {
  const box = $(`panel-${name}`).querySelector(".panel-error");
  fill(box, message ? h("p", null, message) : null);
  box.hidden = !message;
}

function pill(status, text) {
  return h("span", { class: `pill pill-${status}` }, h("span", { class: "dot", "aria-hidden": "true" }), text);
}

function button(label, onclick, cls = "btn btn-secondary btn-small") {
  return h("button", { type: "button", class: cls, onclick }, label);
}

async function act(work, done) {
  try {
    await work();
    if (done) toast(done);
    await load();
  } catch (err) {
    toast(err.message);
  }
}

function copy(text) {
  navigator.clipboard.writeText(text).then(
    () => toast("Kopiert!"),
    () => toast("Kunne ikke kopiere automatisk. Marker teksten og kopier den selv.")
  );
}

// 14 tegn uten forvekslbare tegn (0/O, 1/l/I), trukket uten skjevhet.
function generatePassword(length = 14) {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

// "Safari på iPhone", "Chrome på Windows", "InnNorsk Varsel (iPhone)".
function describeAgent(ua = "") {
  if (/CFNetwork|InnNorsk/i.test(ua)) return "InnNorsk Varsel (iPhone)";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : "";
  return [browser, os].filter(Boolean).join(" på ") || ua.slice(0, 60) || "Ukjent nettleser";
}

// ---------- Faner ----------

const TABS = {
  oversikt: { load: loadOverview, every: 10000 },
  sendinger: { load: loadSendings, every: 10000 },
  logg: { load: loadLog, auto: mergeLog, every: 5000 },
  okter: { load: loadSessions },
  brukere: { load: loadUsers },
};
const NAMES = Object.keys(TABS);

function select(name, focus) {
  current = name;
  for (const key of NAMES) {
    const on = key === name;
    const tab = $(`tab-${key}`);
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${key}`).hidden = !on;
  }
  if (focus) $(`tab-${name}`).focus();
  history.replaceState(null, "", `#${name}`);
  load();
}

async function load(auto = false) {
  clearTimeout(timer);
  const name = current;
  const tab = TABS[name];
  try {
    await (auto && tab.auto ? tab.auto : tab.load)(auto);
    panelError(name, "");
  } catch (err) {
    panelError(name, err.message);
  }
  if (name === current && tab.every && !document.hidden) timer = setTimeout(() => load(true), tab.every);
}

// Automatisk oppdatering skal ikke overskrive noe man holder på å skrive.
function busyTyping() {
  const el = document.activeElement;
  return Boolean(el && el.matches("textarea, input:not([type=checkbox]), select") && $(`panel-${current}`).contains(el));
}

for (const name of NAMES) $(`tab-${name}`).addEventListener("click", () => select(name));
document.querySelector(".tabs").addEventListener("keydown", (e) => {
  const i = NAMES.indexOf(current);
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: NAMES.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  select(NAMES[(next + NAMES.length) % NAMES.length], true);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load(true);
});

// ---------- Oversikt ----------

async function loadOverview() {
  const [overview, { devices }] = await Promise.all([api("/api/admin/overview"), api("/api/admin/devices")]);
  renderAgent(overview.agent || {});
  renderStats(overview);
  renderDevices(devices || []);
}

function renderAgent(agent) {
  const seen = agent.lastSeenAt;
  const grok = agent.grokOk == null ? "ukjent" : agent.grokOk ? "virker" : "virker ikke";
  fill($("agent"),
    h("div", { class: `agent-status ${agent.online ? "is-online" : "is-offline"}` },
      h("span", { class: "agent-dot", "aria-hidden": "true" }),
      h("div", null,
        h("h2", null, agent.online ? "Mac-en er på nett" : "Mac-en svarer ikke"),
        h("p", { class: "muted" }, seen
          ? `Sist sett ${relativeTime(seen)} (kl. ${formatClock(seen)})`
          : "Mac-en har ikke meldt seg ennå. Kjør «node mac/innnorsk-mottak.js setup» på Mac-en."))),
    agent.stateMessage
      ? h("p", { class: `notice ${agent.state === "error" ? "notice-error" : "notice-soft"}` }, agent.stateMessage)
      : null,
    seen
      ? h("dl", { class: "facts" },
        h("div", null, h("dt", null, "Tilstand"), h("dd", null, AGENT_STATE[agent.state] || agent.state || "–")),
        h("div", null, h("dt", null, "Grok CLI"), h("dd", { class: agent.grokOk === false ? "bad" : "" }, grok)),
        h("div", null, h("dt", null, "Maskin"), h("dd", null, agent.host || "–")),
        h("div", null, h("dt", null, "Versjon"), h("dd", null, agent.version || "–")))
      : null
  );
}

function renderStats({ counts = {}, storage = {}, users }) {
  const tile = (value, label, cls = "") => h("div", { class: `stat ${cls}` }, h("span", { class: "stat-value" }, value), h("span", { class: "stat-label" }, label));
  fill($("stats"),
    tile(formatNumber(counts.waiting), "Venter"),
    tile(formatNumber(counts.working), "Oversettes nå"),
    tile(formatNumber(counts.doneToday), "Ferdig i dag"),
    tile(formatNumber(counts.failed), "Feilet", counts.failed ? "stat-bad" : ""),
    tile(formatBytes(storage.bytes), `Lagret · ${plural(storage.files || 0, "fil", "filer")}`),
    typeof users === "number" ? tile(formatNumber(users), "Brukere") : null
  );
}

function renderDevices(devices) {
  if (!devices.length) {
    fill($("devices"), h("li", { class: "muted" }, "Ingen iPhone er registrert ennå. Åpne InnNorsk Varsel på telefonen og logg inn som admin."));
    return;
  }
  fill($("devices"), devices.map((d) => h("li", { class: "item" },
    h("div", { class: "item-main" },
      h("p", null, h("strong", null, d.name || "iPhone"), " ", pill(d.disabledAt ? "failed" : "done", d.disabledAt ? "Deaktivert" : "Aktiv"), " ", h("span", { class: "tag" }, d.env)),
      h("p", { class: "muted small" }, `Registrert ${formatWhen(d.createdAt)}`, d.lastOkAt ? ` · sist varslet ${relativeTime(d.lastOkAt)}` : ""),
      d.lastError ? h("p", { class: "small bad" }, d.lastError) : null),
    button("Fjern", async () => {
      const ok = await confirmDialog({ title: "Fjerne denne enheten?", text: "Den får ikke flere varsler før appen registrerer seg på nytt.", confirm: "Fjern", danger: true });
      if (ok) act(() => api(`/api/admin/devices/${enc(d.token)}`, { method: "DELETE" }), "Enheten er fjernet.");
    })
  )));
}

$("btn-test-push").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("push-result").textContent = "Sender …";
  try {
    const { sent, failed, errors } = await api("/api/admin/test-push", { method: "POST" });
    $("push-result").textContent = sent
      ? `Testvarsel sendt til ${plural(sent, "enhet", "enheter")}.${failed ? ` ${failed} feilet: ${(errors || []).join(", ")}` : ""}`
      : `Ingen varsler ble sendt.${errors && errors.length ? ` ${errors.join(", ")}` : " Er det registrert en iPhone?"}`;
  } catch (err) {
    $("push-result").textContent = err.message;
  }
  btn.disabled = false;
});

// ---------- Sendinger ----------

async function loadSendings(auto) {
  if (auto && busyTyping()) return;
  sendings = (await api("/api/admin/sendings?limit=50")).sendings || [];
  const open = new Set([...$("sendings").querySelectorAll("details[open]")].map((d) => d.dataset.key));
  $("sendings-count").textContent = `${plural(sendings.length, "sending", "sendinger")} (de siste 50)`;
  fill($("sendings"), sendings.length
    ? sendings.map((s) => sendingCard(s, open))
    : h("p", { class: "card muted" }, "Ingen sendinger ennå."));
}

function countsText(c = {}) {
  return [
    c.done ? `${c.done} ferdig` : "",
    c.working ? `${c.working} oversettes` : "",
    c.waiting ? `${c.waiting} venter` : "",
    c.failed ? `${c.failed} feilet` : "",
  ].filter(Boolean).join(" · ");
}

function sendingCard(s, open) {
  const who = s.displayName || s.username || "Ukjent";
  return h("article", { class: "card acard" },
    h("div", { class: "acard-head" },
      h("div", null,
        h("h3", null, who, s.username && s.displayName ? h("span", { class: "muted" }, ` (${s.username})`) : null),
        h("p", { class: "muted small" }, [
          s.sentAt ? `Sendt ${formatWhen(s.sentAt)}` : `Opprettet ${formatWhen(s.createdAt)}`,
          LANGUAGE_LABELS[s.targetLanguage],
          plural(s.files.length, "fil", "filer"),
          countsText(s.counts),
        ].filter(Boolean).join(" · "))),
      pill(s.status, SENDING_STATUS[s.status] || s.status)),
    s.note ? h("p", { class: "my-note" }, h("span", { class: "muted" }, `Melding fra ${who}: `), `«${s.note}»`) : null,
    h("ul", { class: "afiles" }, s.files.map((f) => adminFile(f, open))),
    s.status === "draft" ? null : replyForm(s, who)
  );
}

function adminFile(f, open) {
  const facts = [
    f.bytes != null ? formatBytes(f.bytes) : "",
    f.attempts ? plural(f.attempts, "forsøk", "forsøk") : "",
    f.costUsd != null ? `$${Number(f.costUsd).toFixed(4)}` : "",
    f.outputSource === "manual" ? "lastet opp manuelt" : "",
    f.status === "working" && f.progress ? `${Math.round(f.progress.percent)} %${f.progress.etaSeconds != null ? `, ${formatDuration(f.progress.etaSeconds)} igjen` : ""}` : "",
    f.status === "working" && f.leaseUntil ? `lås til ${formatClock(f.leaseUntil)}` : "",
    f.finishedAt ? `ferdig ${formatWhen(f.finishedAt)}` : "",
  ].filter(Boolean).join(" · ");
  const key = `err-${f.id}`;
  return h("li", { class: "afile" },
    extBadge(f.name),
    h("div", { class: "afile-main" },
      h("p", { class: "afile-name" }, dirName(f.path || "") ? h("span", { class: "q-dir" }, dirName(f.path)) : null, f.name || baseName(f.path)),
      h("p", { class: "small" }, pill(f.status, STATUS[f.status] || f.status), " ", h("span", { class: "muted" }, facts)),
      f.error ? h("p", { class: "small bad" }, f.error) : null,
      f.errorDetails
        ? h("details", { class: "small", "data-key": key, open: open.has(key) }, h("summary", null, "Tekniske detaljer"), h("pre", null, f.errorDetails))
        : null),
    h("div", { class: "afile-actions" },
      h("a", { class: "btn-quiet", href: `/api/files/${enc(f.id)}/original`, download: "" }, icon("download"), "Original"),
      f.status === "done" ? h("a", { class: "btn-quiet", href: `/api/files/${enc(f.id)}/result`, download: "" }, icon("download"), "Oversettelse") : null,
      f.status === "draft" ? null : h("button", { type: "button", class: "btn-quiet", onclick: () => pickResult(f) }, icon("upload"), "Last opp oversettelse"),
      ["failed", "working", "done"].includes(f.status)
        ? h("button", { type: "button", class: "btn-quiet", onclick: () => act(() => api(`/api/admin/files/${enc(f.id)}/status`, { method: "POST", body: { status: "sent" } }), `${f.name} er satt i kø igjen.`) }, icon("refresh"), "Sett i kø igjen")
        : null)
  );
}

function replyForm(s, who) {
  const id = `reply-${s.id}`;
  const area = h("textarea", { id, rows: 2, maxLength: 2000, placeholder: `For eksempel: Her er det! Si fra om noe er uklart.` });
  area.value = replyDrafts.has(s.id) ? replyDrafts.get(s.id) : s.reply || "";
  area.addEventListener("input", () => replyDrafts.set(s.id, area.value));
  return h("form", {
    class: "reply-form",
    onsubmit: (e) => {
      e.preventDefault();
      act(async () => {
        await api(`/api/admin/sendings/${enc(s.id)}/reply`, { method: "POST", body: { reply: area.value.trim() } });
        replyDrafts.delete(s.id);
      }, `Hilsenen er lagret. ${who} ser den under «Mine filer».`);
    },
  },
  h("label", { for: id }, `Hilsen til ${who}`),
  area,
  h("button", { type: "submit", class: "btn btn-secondary btn-small" }, s.reply ? "Oppdater hilsenen" : "Lagre hilsenen"));
}

function pickResult(file) {
  resultTarget = file;
  $("result-input").click();
}

$("result-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const target = resultTarget;
  e.target.value = "";
  if (!file || !target) return;
  toast(`Laster opp ${file.name} …`);
  await act(() => upload(`/api/admin/files/${enc(target.id)}/result?name=${enc(file.name)}`, file, {
    onProgress: (pct) => toast(`Laster opp ${file.name} … ${pct} %`),
  }), "Oversettelsen er lastet opp og merket som ferdig.");
});
$("sendings-refresh").addEventListener("click", () => load());

// ---------- Logg ----------

function logUrl(beforeId) {
  const params = new URLSearchParams();
  for (const [key, id] of [["level", "log-level"], ["source", "log-source"], ["type", "log-type"], ["q", "log-q"]]) {
    const value = $(id).value.trim();
    if (value) params.set(key, value);
  }
  if (beforeId) params.set("beforeId", beforeId);
  params.set("limit", String(LOG_PAGE));
  return `/api/admin/events?${params}`;
}

function eventData(ev) {
  let data = ev.data ?? ev.dataJson ?? null;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      // Ikke JSON: vis teksten som den er.
    }
  }
  const extra = { ip: ev.ip, userId: ev.userId, sessionId: ev.sessionId, sendingId: ev.sendingId, fileId: ev.fileId, data };
  const shown = Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null && v !== ""));
  return Object.keys(shown).length ? JSON.stringify(shown, null, 2) : "";
}

function eventRow(ev, isNew) {
  const d = new Date(ev.ts);
  const when = formatWhen(ev.ts);
  const details = eventData(ev);
  return h("li", { class: `ev ev-${ev.level}${isNew ? " appear" : ""}` },
    h("div", { class: "ev-head" },
      h("time", { dateTime: ev.ts, title: d.toLocaleString("nb-NO") }, `${when[0].toUpperCase()}${when.slice(1)}:${String(d.getSeconds()).padStart(2, "0")}`),
      h("span", { class: `lvl lvl-${ev.level}` }, LEVELS[ev.level] || ev.level),
      h("code", { class: "ev-type" }, ev.type),
      h("span", { class: "muted" }, [SOURCES[ev.source] || ev.source, ev.username].filter(Boolean).join(" · "))),
    ev.message ? h("p", { class: "ev-msg" }, ev.message) : null,
    details ? h("details", null, h("summary", null, "Detaljer"), h("pre", null, details)) : null
  );
}

function renderLog() {
  fill($("log"), log.events.length ? log.events.map((ev) => eventRow(ev, false)) : h("li", { class: "muted" }, "Ingen hendelser med disse filtrene."));
  $("log-more").hidden = !log.more;
}

async function loadLog() {
  const { events } = await api(logUrl());
  log.events = events || [];
  log.more = log.events.length === LOG_PAGE;
  renderLog();
}

// Automatisk oppdatering legger bare nye hendelser øverst, så åpne detaljer og «Last flere» blir stående.
async function mergeLog() {
  if (!$("log-auto").checked) return;
  const { events } = await api(logUrl());
  const top = log.events.length ? log.events[0].id : 0;
  const newer = (events || []).filter((ev) => ev.id > top);
  if (!newer.length) return;
  if (!log.events.length) return loadLog();
  log.events = [...newer, ...log.events];
  $("log").prepend(...newer.map((ev) => eventRow(ev, true)));
}

$("log-more").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const { events } = await api(logUrl(log.events[log.events.length - 1].id));
    log.events.push(...(events || []));
    log.more = (events || []).length === LOG_PAGE;
    $("log").append(...(events || []).map((ev) => eventRow(ev, false)));
    $("log-more").hidden = !log.more;
  } catch (err) {
    toast(err.message);
  }
  btn.disabled = false;
});

let filterTimer = 0;
$("log-filters").addEventListener("submit", (e) => e.preventDefault());
$("log-filters").addEventListener("input", (e) => {
  if (e.target.id === "log-auto") return;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => load(), e.target.tagName === "SELECT" ? 0 : 350);
});

// ---------- Økter ----------

async function loadSessions() {
  const { sessions } = await api(`/api/admin/sessions?all=${$("sessions-all").checked ? 1 : 0}`);
  fill($("sessions"), (sessions || []).length ? sessions.map(sessionRow) : h("li", { class: "muted" }, "Ingen økter."));
}

function sessionRow(s) {
  const active = !s.revokedAt && Date.parse(s.expiresAt) > Date.now();
  const id = s.idPrefix || s.id;
  return h("li", { class: "item" },
    h("div", { class: "item-main" },
      h("p", null,
        h("strong", null, s.displayName || s.username || `Bruker ${s.userId}`), " ",
        s.current ? h("span", { class: "tag" }, "Denne økten") : null, " ",
        pill(active ? "done" : "deleted", active ? "Aktiv" : "Avsluttet")),
      h("p", { class: "muted small" }, `Innlogget ${formatWhen(s.createdAt)} · sist aktiv ${relativeTime(s.lastSeenAt)} · utløper ${formatWhen(s.expiresAt)}`),
      h("p", { class: "muted small" }, [describeAgent(s.userAgent), s.ip ? `IP ${s.ip}` : ""].filter(Boolean).join(" · ")),
      s.revokedAt ? h("p", { class: "small" }, `Avsluttet ${formatWhen(s.revokedAt)}${s.revokedReason ? `: ${s.revokedReason}` : ""}`) : null),
    active
      ? button("Logg ut", async () => {
        if (s.current && !(await confirmDialog({ title: "Logge ut deg selv?", text: "Dette er økten du bruker nå.", confirm: "Logg ut" }))) return;
        act(() => api(`/api/admin/sessions/${enc(id)}/revoke`, { method: "POST" }), "Økten er avsluttet.");
      })
      : null
  );
}

$("sessions-all").addEventListener("change", () => load());

// ---------- Brukere ----------

async function loadUsers() {
  const { users } = await api("/api/admin/users");
  fill($("users"), (users || []).map(userRow));
}

function userRow(u) {
  const self = me && u.id === me.id;
  const disabled = Boolean(u.disabled);
  return h("li", { class: "item" },
    h("div", { class: "item-main" },
      h("p", null,
        h("strong", null, u.displayName || u.username), " ", h("span", { class: "muted" }, u.username), " ",
        u.role === "admin" ? h("span", { class: "tag" }, "Admin") : null, " ",
        disabled ? pill("failed", "Deaktivert") : null, " ",
        u.mustChangePassword ? h("span", { class: "tag" }, "Må lage passord") : null,
        self ? h("span", { class: "tag" }, "Deg") : null),
      h("p", { class: "muted small" }, `${u.lastLoginAt ? `Sist innlogget ${relativeTime(u.lastLoginAt)}` : "Har ikke logget inn ennå"} · opprettet ${formatWhen(u.createdAt)}`)),
    h("div", { class: "item-actions" },
      button("Nytt passord", () => resetPassword(u)),
      button("Endre navn", () => rename(u)),
      self ? null : button(disabled ? "Aktiver" : "Deaktiver", () => patchUser(u, { disabled: !disabled }, disabled ? "Brukeren er aktivert." : "Brukeren er deaktivert og logget ut.")),
      self ? null : button(u.role === "admin" ? "Gjør til bruker" : "Gjør til admin", () => patchUser(u, { role: u.role === "admin" ? "user" : "admin" }, "Rollen er endret.")))
  );
}

function patchUser(u, body, done) {
  return act(() => api(`/api/admin/users/${enc(u.id)}`, { method: "PATCH", body }), done);
}

function rename(u) {
  const input = h("input", { type: "text", id: "rename-input", value: u.displayName || "", autocomplete: "off" });
  const dialog = h("dialog", { class: "modal", "aria-labelledby": "rename-title" },
    h("form", { method: "dialog", class: "modal-body" },
      h("h2", { id: "rename-title" }, `Endre navn på ${u.username}`),
      h("div", { class: "field" }, h("label", { for: "rename-input" }, "Visningsnavn"), input),
      h("div", { class: "modal-actions" },
        h("button", { type: "submit", value: "cancel", class: "btn btn-secondary" }, "Avbryt"),
        h("button", { type: "submit", value: "ok", class: "btn btn-primary" }, "Lagre"))));
  dialog.addEventListener("close", () => {
    const name = input.value.trim();
    dialog.remove();
    if (dialog.returnValue === "ok" && name) patchUser(u, { displayName: name }, "Navnet er endret.");
  });
  document.body.append(dialog);
  dialog.showModal();
  input.select();
}

function welcomeMessage(user, password, mustChange, reset) {
  const lines = [
    `Hei, ${user.displayName || user.username}!`,
    "",
    reset
      ? "Her er et nytt passord til InnNorsk:"
      : "Her er innloggingen din til InnNorsk, der du kan sende meg dokumenter som skal oversettes til norsk:",
    "",
    `Adresse: ${location.origin}/login`,
    `Brukernavn: ${user.username}`,
    `Passord: ${password}`,
    "",
  ];
  if (mustChange) lines.push("Første gang du logger inn, blir du bedt om å lage ditt eget passord.", "");
  lines.push(`Hilsen ${me ? me.displayName || me.username : ""}`.trim());
  return lines.join("\n");
}

function showSecret(user, password, mustChange, reset) {
  $("secret-title").textContent = reset ? `Nytt passord til ${user.displayName || user.username}` : `${user.displayName || user.username} er opprettet`;
  $("secret-password").textContent = password;
  $("secret-message").value = welcomeMessage(user, password, mustChange, reset);
  $("secret-dialog").showModal();
  $("copy-password").focus();
}

async function resetPassword(u) {
  const ok = await confirmDialog({
    title: `Lage nytt passord til ${u.displayName || u.username}?`,
    text: "Det gamle passordet slutter å virke, og brukeren logges ut overalt. Du får se det nye passordet én gang.",
    confirm: "Lag nytt passord",
  });
  if (!ok) return;
  try {
    const password = generatePassword();
    await api(`/api/admin/users/${enc(u.id)}/password`, { method: "POST", body: { ...(await newSaltedProof(password)), mustChangePassword: true } });
    showSecret(u, password, true, true);
    load();
  } catch (err) {
    toast(err.message);
  }
}

$("user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const error = $("nu-error");
  const username = $("nu-username").value.trim();
  const displayName = $("nu-name").value.trim() || username;
  const mustChangePassword = $("nu-must").checked;
  error.hidden = Boolean(username);
  error.textContent = username ? "" : "Skriv inn et brukernavn.";
  if (!username) return $("nu-username").focus();
  const btn = $("nu-save");
  btn.disabled = true;
  btn.textContent = "Oppretter …";
  try {
    const password = generatePassword();
    const salted = await newSaltedProof(password);
    const { user } = await api("/api/admin/users", {
      method: "POST",
      body: { username, displayName, role: $("nu-role").value, mustChangePassword, ...salted },
    });
    e.target.reset();
    showSecret(user || { username, displayName }, password, mustChangePassword, false);
    load();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
  btn.disabled = false;
  btn.textContent = "Opprett og lag passord";
});

$("copy-password").addEventListener("click", () => copy($("secret-password").textContent));
$("copy-message").addEventListener("click", () => copy($("secret-message").value));
$("secret-dialog").addEventListener("close", () => {
  $("secret-password").textContent = "";
  $("secret-message").value = "";
});

// ---------- Oppstart ----------

$("btn-logout").addEventListener("click", logout);

api("/api/auth/me").then(({ user }) => {
  me = user;
}).catch(() => {}).finally(() => {
  const wanted = location.hash.slice(1);
  select(NAMES.includes(wanted) ? wanted : "oversikt");
});
