import {
  api, h, fill, formatBytes, formatNumber, relativeTime, statusLabel, LANGUAGE_LABELS,
  confirmDialog, logout, reportErrors,
} from "./api.js";

reportErrors();

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const TABS = ["oversikt", "jobber", "logg", "okter", "brukere"];
const LEVEL_LABELS = { debug: "Feilsøking", info: "Info", warn: "Advarsel", error: "Feil" };
const EVENT_TYPES = {
  System: ["system.bootstrap", "user.seeded", "server.error", "client.error", "retention.sweep", "admin.test_api"],
  Innlogging: ["auth.login", "auth.login_failed", "auth.locked", "auth.logout", "auth.password_changed", "session.revoked"],
  Brukere: ["user.created", "user.updated", "user.password_reset"],
  Jobber: ["job.created", "job.queued", "job.started", "job.finished", "job.cancelled", "job.failed", "job.deleted"],
  Filer: ["file.uploaded", "file.rejected", "file.analyzed", "file.analysis_failed", "file.started", "file.done", "file.failed", "file.warning", "file.deleted"],
  Grok: ["grok.retry", "grok.error"],
  Nedlasting: ["download.file", "download.original", "download.zip"],
};
const PAGE = 100;

let me = null;
let users = [];
let activeTab = "";
let logEvents = [];
let logTimer = 0;
let searchTimer = 0;

// ---------- Formatering ----------

const pad = (n) => String(n).padStart(2, "0");

function formatTs(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "–";
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Nøyaktig varighet for feilsøking: "48 s", "5 min 12 s", "2 t 3 min", "3 d 4 t".
function formatElapsed(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "–";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  if (s < 86400) return `${Math.floor(s / 3600)} t ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} t`;
}

function formatMs(ms) {
  if (ms == null) return "–";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString("nb-NO", { maximumFractionDigits: 1 })} s`;
}

function decimal(n, digits) {
  return n == null ? "–" : Number(n).toLocaleString("nb-NO", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function secondsBetween(from, to) {
  return from && to ? (new Date(to) - new Date(from)) / 1000 : null;
}

function userName(id) {
  if (id == null) return "";
  const user = users.find((u) => u.id === id);
  return user ? user.username : `#${id}`;
}

function deviceLabel(ua) {
  const s = ua || "";
  const browser = /Edg\//.test(s) ? "Edge"
    : /OPR\/|Opera/.test(s) ? "Opera"
      : /Firefox\/|FxiOS/.test(s) ? "Firefox"
        : /Chrome\/|CriOS/.test(s) ? "Chrome"
          : /Safari\//.test(s) ? "Safari" : "Ukjent nettleser";
  const os = /iPhone/.test(s) ? "iPhone"
    : /iPad/.test(s) ? "iPad"
      : /Android/.test(s) ? "Android"
        : /Windows/.test(s) ? "Windows"
          : /Macintosh|Mac OS X/.test(s) ? "Mac"
            : /Linux/.test(s) ? "Linux" : "";
  return os ? `${browser} på ${os}` : browser;
}

// Serverdata vises alltid som tekst (textContent), så det kan ikke tolkes som HTML.
function pretty(value) {
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

// ---------- Små byggeklosser ----------

function badge(status) {
  return h("span", { class: `badge status-${status}` }, statusLabel(status));
}

function level(value) {
  return h("span", { class: `lvl lvl-${value}` }, LEVEL_LABELS[value] || value);
}

function fact(label, ...value) {
  return h("div", null, h("dt", null, label), h("dd", null, ...value));
}

function stat(label, value, sub, bad) {
  return h("div", { class: `stat${bad ? " is-bad" : ""}` },
    h("p", { class: "stat-label" }, label),
    h("p", { class: "stat-value" }, value),
    sub ? h("p", { class: "stat-sub" }, sub) : null
  );
}

function table(headers, rows, emptyText) {
  return h("div", { class: "table-wrap" },
    h("table", { class: "data" },
      h("thead", null, h("tr", null, headers.map((t) => h("th", null, t)))),
      h("tbody", null, rows.length ? rows : emptyRow(headers.length, emptyText))
    )
  );
}

function emptyRow(cols, text) {
  return h("tr", { class: "empty-row" }, h("td", { colSpan: cols }, text));
}

function dataDetails(data, label = "Data") {
  if (data == null || data === "" || (typeof data === "object" && !Object.keys(data).length)) return null;
  return h("details", { class: "json" }, h("summary", null, label), h("pre", null, pretty(data)));
}

function tokens(usage) {
  if (!usage) return "–";
  return `${formatNumber(usage.inputTokens)} / ${formatNumber(usage.outputTokens)}`;
}

function panelError(panel, err) {
  const el = $(`panel-${panel}`).querySelector(".panel-error");
  el.textContent = err ? `Noe gikk galt: ${err.message}` : "";
  el.hidden = !err;
}

async function guarded(panel, fn) {
  try {
    panelError(panel, null);
    await fn();
  } catch (err) {
    panelError(panel, err);
  }
}

// ---------- Faner ----------

const LOADERS = {
  oversikt: loadOverview,
  jobber: loadJobs,
  logg: loadEvents,
  okter: loadSessions,
  brukere: loadUsers,
};

function selectTab(name, focus = false) {
  activeTab = TABS.includes(name) ? name : "oversikt";
  for (const t of TABS) {
    const on = t === activeTab;
    const tab = $(`tab-${t}`);
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  }
  if (focus) $(`tab-${activeTab}`).focus();
  if (location.hash !== `#${activeTab}`) history.replaceState(null, "", `#${activeTab}`);
  guarded(activeTab, LOADERS[activeTab]);
  syncLogTimer();
}

function setupTabs() {
  for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => selectTab(t));
  document.querySelector("[role=tablist]").addEventListener("keydown", (e) => {
    const i = TABS.indexOf(activeTab);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    selectTab(TABS[(next + TABS.length) % TABS.length], true);
  });
  window.addEventListener("hashchange", () => {
    const name = location.hash.slice(1);
    if (name !== activeTab) selectTab(name);
  });
}

// ---------- Oversikt ----------

async function loadOverview() {
  const o = await api("/api/admin/overview");
  $("key-banner").hidden = Boolean(o.apiKeyConfigured);
  const t = o.tokens24h || {};
  const storage = o.storage || {};
  fill($("stats"),
    stat("Brukere", formatNumber(o.users)),
    stat("Aktive økter", formatNumber(o.activeSessions)),
    stat("Jobber siste 24 t", formatNumber(o.jobs24h)),
    stat("Feilede filer siste 24 t", formatNumber(o.failedFiles24h), null, o.failedFiles24h > 0),
    stat("API-kall siste 24 t", formatNumber(o.calls24h)),
    stat("Tokens siste 24 t", formatNumber((t.input || 0) + (t.output || 0)), `${formatNumber(t.input)} inn · ${formatNumber(t.output)} ut`),
    stat("Modell", o.model || "–", o.apiKeyConfigured ? "API-nøkkelen er satt" : "API-nøkkelen mangler", !o.apiKeyConfigured),
    stat("Lagring", formatBytes(storage.bytes), `${formatNumber(storage.objects)} filer`)
  );
  const est = o.estimator || {};
  const acc = est.accuracy || {};
  fill($("estimator"),
    fact("Kilde", est.source === "fitted"
      ? `Tilpasset fra ${formatNumber(est.samples)} API-kall`
      : `Standardverdier (${formatNumber(est.samples)} vellykkede kall så langt)`),
    fact("Tid per batch", `${decimal(est.a, 1)} s + ${decimal(est.b, 4)} s per tegn`),
    fact("Treffsikkerhet", acc.jobs
      ? `Median avvik ${decimal(acc.medianAbsPctError, 0)} % over ${formatNumber(acc.jobs)} ${acc.jobs === 1 ? "jobb" : "jobber"}`
      : "Ingen ferdige jobber å sammenligne med ennå.")
  );
}

async function testApi() {
  const ok = await confirmDialog({
    title: "Teste API-tilkoblingen?",
    text: "Dette sender én liten forespørsel til xAI og koster et lite API-kall. Du kan teste én gang i minuttet.",
    confirm: "Ja, test nå",
  });
  if (!ok) return;
  const button = $("btn-test-api");
  const result = $("test-result");
  button.disabled = true;
  result.className = "result-line";
  result.textContent = "Tester …";
  try {
    const r = await api("/api/admin/test-api", { method: "POST" });
    result.classList.add(r.ok ? "ok" : "bad");
    result.textContent = r.ok
      ? `Tilkoblingen virker (${formatMs(r.ms)}).${r.sample ? ` Grok svarte: «${r.sample}»` : ""}`
      : `Feilet: ${r.error || "ukjent feil"}`;
  } catch (err) {
    result.classList.add("bad");
    result.textContent = `Feilet: ${err.message}`;
  } finally {
    button.disabled = false;
  }
}

// ---------- Jobber ----------

async function loadJobs() {
  const userId = $("jobs-user").value;
  const { jobs } = await api(`/api/admin/jobs?limit=50${userId ? `&userId=${enc(userId)}` : ""}`);
  $("jobs-table").tBodies[0].replaceChildren(...(jobs.length ? jobs.map(jobRow) : [emptyRow(8, "Ingen jobber ennå.")]));
}

function estimateVsActual(estimate, actual) {
  if (estimate == null) return "–";
  if (actual == null || !(estimate > 0)) return `${formatElapsed(estimate)} / –`;
  const pct = Math.round(((actual - estimate) / estimate) * 100);
  return h("span", null,
    `${formatElapsed(estimate)} / ${formatElapsed(actual)} `,
    h("span", { class: `delta${Math.abs(pct) > 50 ? " bad" : ""}` }, `(${pct > 0 ? "+" : ""}${pct} %)`)
  );
}

function jobRow(job) {
  return h("tr", { "data-job": job.id },
    h("td", { class: "nowrap" }, h("button", { type: "button", class: "btn-link", onclick: () => openDrill(job.id) }, formatTs(job.createdAt))),
    h("td", null, job.username || userName(job.userId)),
    h("td", null, LANGUAGE_LABELS[job.targetLanguage] || job.targetLanguage || "–"),
    h("td", { class: "num" }, formatNumber(job.fileCount)),
    h("td", null, badge(job.status), job.deleted ? h("span", { class: "deleted" }, "slettet av bruker") : null),
    h("td", { class: "nowrap" }, estimateVsActual(job.estimateSeconds, secondsBetween(job.startedAt, job.finishedAt))),
    h("td", { class: "num" }, formatNumber(job.usage && job.usage.calls)),
    h("td", { class: "num nowrap" }, tokens(job.usage))
  );
}

function fileRow(jobId, f) {
  const base = `/api/jobs/${enc(jobId)}/files/${enc(f.id)}`;
  const warnings = (f.warnings || []).map((w) => (typeof w === "string" ? w : w.message || w.code));
  return h("tr", { class: f.status === "failed" ? "row-error" : "" },
    h("td", { class: "msg" }, f.path || f.name),
    h("td", null, badge(f.status)),
    h("td", { class: "num" }, formatNumber(f.chars)),
    h("td", { class: "num" }, formatNumber(f.batches)),
    h("td", { class: "nowrap" }, f.estimateSeconds != null ? formatElapsed(f.estimateSeconds) : "–"),
    h("td", { class: "nowrap" }, f.durationMs != null ? formatElapsed(f.durationMs / 1000) : "–"),
    h("td", { class: "msg" },
      f.message || "",
      f.error && f.error !== f.message ? h("div", { class: "hint mono" }, f.error) : null,
      dataDetails(f.errorDetails, "Feildetaljer"),
      warnings.length ? h("details", { class: "json" },
        h("summary", null, `${warnings.length} ${warnings.length === 1 ? "advarsel" : "advarsler"}`),
        h("ul", null, warnings.map((w) => h("li", null, w)))) : null
    ),
    h("td", { class: "nowrap" },
      h("a", { href: `${base}/original`, download: "" }, "Original"),
      f.status === "done" ? [" · ", h("a", { href: `${base}/download`, download: "" }, "Resultat")] : null
    )
  );
}

function callRow(names, c) {
  return h("tr", { class: c.ok ? "" : "row-error" },
    h("td", { class: "nowrap" }, formatTs(c.ts)),
    h("td", { class: "msg" }, names.get(c.fileId) || "–"),
    h("td", { class: "num" }, c.status || "–"),
    h("td", { class: "num" }, c.attempt),
    h("td", { class: "num" }, c.items),
    h("td", { class: "num nowrap" }, `${formatNumber(c.inputChars)} / ${formatNumber(c.outputChars)}`),
    h("td", { class: "num nowrap" }, formatMs(c.ms)),
    h("td", { class: "num nowrap" }, `${formatNumber(c.inputTokens)} / ${formatNumber(c.outputTokens)} / ${formatNumber(c.reasoningTokens)}`),
    h("td", { class: "msg" }, c.error || "")
  );
}

function timelineItem(e) {
  return h("li", { class: `row-${e.level}` },
    h("span", { class: "tl-time" }, formatTs(e.ts)),
    level(e.level),
    h("code", null, e.type),
    h("span", null, e.message),
    dataDetails(e.data)
  );
}

function closeDrill() {
  $("drill").hidden = true;
  for (const row of $("jobs-table").tBodies[0].rows) row.classList.remove("is-selected");
}

async function openDrill(id) {
  const drill = $("drill");
  for (const row of $("jobs-table").tBodies[0].rows) row.classList.toggle("is-selected", row.dataset.job === id);
  drill.hidden = false;
  fill(drill, h("p", null, "Henter jobben …"));
  drill.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const { job, files = [], events = [], calls = [] } = await api(`/api/admin/jobs/${enc(id)}`);
    const names = new Map(files.map((f) => [f.id, f.path || f.name]));
    const usage = job.usage || {};
    fill(drill,
      h("div", { class: "drill-head" },
        h("h2", null, "Jobb ", h("code", null, job.id), badge(job.status),
          job.deleted ? h("span", { class: "deleted" }, "slettet av bruker") : null),
        h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: closeDrill }, "Lukk")
      ),
      h("dl", { class: "facts" },
        fact("Bruker", job.username || userName(job.userId)),
        fact("Språk", LANGUAGE_LABELS[job.targetLanguage] || job.targetLanguage || "–"),
        fact("Modell", job.model || "–"),
        fact("Opprettet", formatTs(job.createdAt)),
        fact("Startet", formatTs(job.startedAt)),
        fact("Ferdig", formatTs(job.finishedAt)),
        fact("Estimert / faktisk", estimateVsActual(job.estimateSeconds, secondsBetween(job.startedAt, job.finishedAt))),
        fact("Tegn", formatNumber(job.totals && job.totals.chars)),
        fact("API-kall", formatNumber(usage.calls)),
        fact("Tokens inn / ut", tokens(usage))
      ),
      job.error ? h("p", { class: "form-error" }, job.error) : null,
      h("h3", null, `Filer (${files.length})`),
      table(["Fil", "Status", "Tegn", "Batcher", "Estimert", "Tid", "Melding / feil", "Last ned"],
        files.map((f) => fileRow(job.id, f)), "Ingen filer."),
      h("h3", null, `Grok-kall (${calls.length})`),
      table(["Tid", "Fil", "HTTP", "Forsøk", "Biter", "Tegn inn / ut", "Svartid", "Tokens inn / ut / tenk", "Feil"],
        calls.map((c) => callRow(names, c)), "Ingen API-kall registrert."),
      h("h3", null, `Hendelser (${events.length})`),
      events.length
        ? h("ol", { class: "timeline" }, [...events].sort((a, b) => (a.id || 0) - (b.id || 0)).map(timelineItem))
        : h("p", { class: "hint" }, "Ingen hendelser.")
    );
    drill.focus({ preventScroll: true });
  } catch (err) {
    fill(drill, h("p", { class: "form-error" }, `Noe gikk galt: ${err.message}`));
  }
}

// ---------- Logg ----------

function logUrl(beforeId) {
  const params = new URLSearchParams();
  for (const [key, id] of [["level", "log-level"], ["type", "log-type"], ["userId", "log-user"], ["q", "log-q"]]) {
    const value = $(id).value.trim();
    if (value) params.set(key, value);
  }
  if (beforeId != null) params.set("beforeId", beforeId);
  params.set("limit", PAGE);
  return `/api/admin/events?${params}`;
}

function logRow(e, fresh) {
  return h("tr", { class: `row-${e.level}${fresh ? " is-fresh" : ""}` },
    h("td", { class: "nowrap" }, formatTs(e.ts)),
    h("td", null, level(e.level)),
    h("td", null, h("code", null, e.type)),
    h("td", { class: "msg" }, e.message, dataDetails(e.data)),
    h("td", null, e.username || userName(e.userId)),
    h("td", null, e.jobId ? h("button", {
      type: "button", class: "btn-link mono", title: "Åpne jobben", onclick: () => showJob(e.jobId),
    }, e.jobId) : ""),
    h("td", { class: "nowrap" }, e.ip || "")
  );
}

function showJob(id) {
  selectTab("jobber");
  openDrill(id);
}

async function loadEvents() {
  const { events } = await api(logUrl());
  logEvents = events;
  $("log-table").tBodies[0].replaceChildren(...(events.length ? events.map((e) => logRow(e)) : [emptyRow(7, "Ingen hendelser passer filteret.")]));
  $("log-more").hidden = events.length < PAGE;
}

async function moreEvents() {
  const last = logEvents[logEvents.length - 1];
  if (!last) return;
  const { events } = await api(logUrl(last.id));
  logEvents.push(...events);
  $("log-table").tBodies[0].append(...events.map((e) => logRow(e)));
  $("log-more").hidden = events.length < PAGE;
}

async function refreshEvents() {
  const top = logEvents[0];
  const { events } = await api(logUrl());
  const fresh = top ? events.filter((e) => e.id > top.id) : events;
  if (!fresh.length) return;
  // Mange nye på en gang kan gi hull i listen; da laster vi den på nytt.
  if (!top || fresh.length === events.length) return loadEvents();
  logEvents.unshift(...fresh);
  $("log-table").tBodies[0].prepend(...fresh.map((e) => logRow(e, true)));
}

function syncLogTimer() {
  clearInterval(logTimer);
  if ($("log-auto").checked && activeTab === "logg" && !document.hidden) {
    logTimer = setInterval(() => guarded("logg", refreshEvents), 5000);
  }
}

function setupLog() {
  const typeSelect = $("log-type");
  for (const [group, types] of Object.entries(EVENT_TYPES)) {
    typeSelect.append(h("optgroup", { label: group }, types.map((t) => h("option", { value: t }, t))));
  }
  const reload = () => guarded("logg", loadEvents);
  for (const id of ["log-level", "log-type", "log-user"]) $(id).addEventListener("change", reload);
  $("log-q").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(reload, 350);
  });
  $("log-filters").addEventListener("submit", (e) => {
    e.preventDefault();
    reload();
  });
  $("log-auto").addEventListener("change", syncLogTimer);
  $("log-more").addEventListener("click", () => guarded("logg", moreEvents));
  document.addEventListener("visibilitychange", syncLogTimer);
}

// ---------- Økter ----------

async function loadSessions() {
  const { sessions } = await api(`/api/admin/sessions?all=${$("sessions-all").checked ? 1 : 0}`);
  $("sessions-table").tBodies[0].replaceChildren(
    ...(sessions.length ? sessions.map(sessionRow) : [emptyRow(7, "Ingen aktive økter.")])
  );
}

function sessionRow(s) {
  const ended = Boolean(s.revokedAt) || new Date(s.expiresAt) < Date.now();
  const device = deviceLabel(s.userAgent);
  return h("tr", { class: ended ? "muted" : "" },
    h("td", null, h("strong", null, s.username || "–"), me && s.username === me.username ? h("span", { class: "tag" }, "deg") : null),
    h("td", { title: s.userAgent || "" }, device),
    h("td", { class: "nowrap" }, s.ip || "–"),
    h("td", { class: "nowrap", title: formatTs(s.lastSeenAt) }, relativeTime(s.lastSeenAt)),
    h("td", { class: "nowrap" }, formatTs(s.createdAt)),
    h("td", { class: "nowrap" }, s.revokedAt ? `Logget ut ${relativeTime(s.revokedAt)}` : ended ? "Utløpt" : relativeTime(s.expiresAt)),
    h("td", { class: "actions" }, ended ? "" : h("button", {
      type: "button", class: "btn btn-secondary btn-small", onclick: () => revokeSession(s, device),
    }, "Logg ut"))
  );
}

async function revokeSession(s, device) {
  const ok = await confirmDialog({
    title: "Logge ut økten?",
    text: `${s.username || "Brukeren"} blir logget ut på ${device} og må logge inn på nytt der.`,
    confirm: "Logg ut økten",
    danger: true,
  });
  if (!ok) return;
  await guarded("okter", async () => {
    await api(`/api/admin/sessions/${enc(s.idPrefix)}/revoke`, { method: "POST" });
    await loadSessions();
  });
}

// ---------- Brukere ----------

async function fetchUsers() {
  ({ users } = await api("/api/admin/users"));
  for (const id of ["jobs-user", "log-user"]) {
    const select = $(id);
    const current = select.value;
    select.replaceChildren(select.options[0], ...users.map((u) => h("option", { value: String(u.id) }, u.username)));
    select.value = current;
  }
}

async function loadUsers() {
  await fetchUsers();
  $("users-table").tBodies[0].replaceChildren(...(users.length ? users.map(userRow) : [emptyRow(7, "Ingen brukere.")]));
}

function userRow(u) {
  const self = Boolean(me && u.id === me.id);
  const role = h("select", {
    "aria-label": `Rolle for ${u.username}`,
    disabled: self,
    title: self ? "Du kan ikke endre din egen rolle" : null,
    onchange: (e) => updateUser(u, { role: e.target.value }),
  },
  h("option", { value: "user", selected: u.role === "user" }, "Bruker"),
  h("option", { value: "admin", selected: u.role === "admin" }, "Administrator"));
  return h("tr", { class: u.disabled ? "muted" : "" },
    h("td", null, h("strong", null, u.username), self ? h("span", { class: "tag" }, "deg") : null),
    h("td", null, u.displayName || ""),
    h("td", null, role),
    h("td", null, u.disabled ? "Deaktivert" : u.mustChangePassword ? "Må lage nytt passord" : "Aktiv"),
    h("td", { class: "nowrap" }, u.lastLoginAt ? relativeTime(u.lastLoginAt) : "Aldri"),
    h("td", { class: "nowrap" }, formatTs(u.createdAt)),
    h("td", { class: "actions" },
      h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: () => resetPassword(u) }, "Nytt passord"),
      self ? null : h("button", {
        type: "button", class: "btn btn-secondary btn-small", onclick: () => toggleDisabled(u),
      }, u.disabled ? "Aktiver" : "Deaktiver")
    )
  );
}

async function updateUser(u, patch) {
  await guarded("brukere", async () => {
    try {
      await api(`/api/admin/users/${enc(u.id)}`, { method: "PATCH", body: patch });
    } finally {
      await loadUsers();
    }
  });
}

async function toggleDisabled(u) {
  if (!u.disabled) {
    const ok = await confirmDialog({
      title: `Deaktivere ${u.username}?`,
      text: "Brukeren blir logget ut og kan ikke logge inn før du aktiverer kontoen igjen. Dokumentene blir liggende.",
      confirm: "Deaktiver",
      danger: true,
    });
    if (!ok) return;
  }
  updateUser(u, { disabled: !u.disabled });
}

async function resetPassword(u) {
  const ok = await confirmDialog({
    title: `Nytt passord til ${u.username}?`,
    text: "Det gamle passordet slutter å virke, og brukeren blir logget ut overalt.",
    confirm: "Lag nytt passord",
    danger: true,
  });
  if (!ok) return;
  await guarded("brukere", async () => {
    const { password } = await api(`/api/admin/users/${enc(u.id)}/reset-password`, { method: "POST" });
    showSecret("Nytt passord er laget", u.username, password, "Hei! Her er et nytt midlertidig passord til InnNorsk:");
    await loadUsers();
  });
}

function setupUserForm() {
  const form = $("user-form");
  const error = $("user-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("new-username").value.trim();
    error.hidden = true;
    if (!username) {
      error.textContent = "Skriv inn et brukernavn.";
      error.hidden = false;
      return;
    }
    const button = $("new-submit");
    button.disabled = true;
    try {
      const { user, password } = await api("/api/admin/users", {
        method: "POST",
        body: { username, displayName: $("new-display").value.trim() || username, role: $("new-role").value },
      });
      form.reset();
      showSecret("Brukeren er opprettet", user.username, password, "Hei! Her er innloggingen din til InnNorsk:");
      await loadUsers();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
}

// ---------- Passordvindu ----------

function showSecret(title, username, password, greeting) {
  $("secret-title").textContent = title;
  $("secret-password").textContent = password;
  $("secret-message").value = [
    greeting,
    `${location.origin}/login`,
    "",
    `Brukernavn: ${username}`,
    `Midlertidig passord: ${password}`,
    "",
    "Du blir bedt om å lage ditt eget passord første gang du logger inn.",
  ].join("\n");
  $("copy-status").textContent = "";
  $("secret-dialog").showModal();
}

async function copyFrom(el, text, label) {
  const status = $("copy-status");
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = `${label} er kopiert.`;
  } catch {
    if (el.select) el.select();
    else {
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
    status.textContent = "Kunne ikke kopiere automatisk. Teksten er markert – trykk Ctrl+C (Cmd+C på Mac).";
  }
}

function setupSecretDialog() {
  const dialog = $("secret-dialog");
  $("copy-password").addEventListener("click", () => copyFrom($("secret-password"), $("secret-password").textContent, "Passordet"));
  $("copy-message").addEventListener("click", () => copyFrom($("secret-message"), $("secret-message").value, "Meldingen"));
  $("secret-close").addEventListener("click", () => dialog.close());
  // Passordet skal ikke bli liggende i siden etterpå.
  dialog.addEventListener("close", () => {
    $("secret-password").textContent = "";
    $("secret-message").value = "";
  });
}

// ---------- Oppstart ----------

async function init() {
  $("btn-logout").addEventListener("click", logout);
  $("btn-test-api").addEventListener("click", testApi);
  $("jobs-user").addEventListener("change", () => guarded("jobber", loadJobs));
  $("jobs-refresh").addEventListener("click", () => guarded("jobber", loadJobs));
  $("sessions-all").addEventListener("change", () => guarded("okter", loadSessions));
  $("sessions-refresh").addEventListener("click", () => guarded("okter", loadSessions));
  setupTabs();
  setupLog();
  setupUserForm();
  setupSecretDialog();

  try {
    ({ user: me } = await api("/api/auth/me"));
  } catch {
    return;
  }
  if (me.role !== "admin") {
    location.replace("/");
    return;
  }
  try {
    await fetchUsers();
  } catch {
    // Navn vises som #id til brukerlisten kan hentes.
  }
  selectTab(location.hash.slice(1));
}

init();
