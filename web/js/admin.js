import {
  api, h, fill, formatBytes, formatNumber, relativeTime, statusLabel,
  LANGUAGE_LABELS, logout, reportErrors,
} from "./api.js";

reportErrors();

const $ = (id) => document.getElementById(id);
const TABS = ["oversikt", "jobber", "logg", "okter", "brukere"];
const LEVEL_LABELS = { debug: "Debug", info: "Info", warn: "Advarsel", error: "Feil" };
const EVENT_TYPES = {
  System: ["system.start", "system.stop", "server.error", "client.error", "retention.sweep", "admin.test_api"],
  Innlogging: ["auth.login", "auth.login_failed", "auth.locked", "auth.logout", "auth.password_changed", "session.revoked"],
  Brukere: ["user.created", "user.updated", "user.password_reset"],
  Jobber: ["job.created", "job.queued", "job.started", "job.finished", "job.cancelled", "job.failed"],
  Filer: ["file.uploaded", "file.rejected", "file.analyzed", "file.analysis_failed", "file.started", "file.done", "file.failed", "file.warning"],
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

// ---------- Små byggeklosser ----------

function badge(status) {
  return h("span", { class: `badge status-${status}` }, statusLabel(status));
}

function fact(label, ...value) {
  return h("div", null, h("dt", null, label), h("dd", null, ...value));
}

function card(label, value, tone, sub) {
  return h("div", { class: `card${tone ? ` ${tone}` : ""}` },
    h("p", { class: "card-label" }, label),
    h("p", { class: "card-value" }, value),
    sub ? h("p", { class: "card-sub" }, sub) : null
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
  return h("tr", { class: "empty" }, h("td", { colSpan: cols }, text));
}

function dataDetails(data) {
  if (data == null || (typeof data === "object" && !Object.keys(data).length)) return null;
  return h("details", { class: "json" },
    h("summary", null, "Data"),
    h("pre", null, JSON.stringify(data, null, 2))
  );
}

function errorDetails(message, stack) {
  if (!stack) return h("span", { class: "err-text" }, message);
  return h("details", { class: "err" }, h("summary", null, message), h("pre", null, stack));
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
  const failed = o.failedFiles24h || 0;
  const t = o.tokens24h || {};
  $("cards").replaceChildren(
    card("Brukere", formatNumber(o.users)),
    card("Aktive økter", formatNumber(o.activeSessions)),
    card("Jobber siste 24 t", formatNumber(o.jobs24h)),
    card("Feilede filer siste 24 t", formatNumber(failed), failed ? "bad" : ""),
    card("API-kall siste 24 t", formatNumber(o.calls24h)),
    card("Tokens siste 24 t", formatNumber((t.input || 0) + (t.output || 0)), "",
      `${formatNumber(t.input)} inn · ${formatNumber(t.output)} ut`),
    card("Modell", o.model || "–", o.apiKeyConfigured ? "" : "bad",
      o.apiKeyConfigured ? "API-nøkkel er satt" : "API-nøkkel mangler"),
    card("Lagring", formatBytes(o.storageBytes)),
    card("Oppetid", formatElapsed(o.uptimeSeconds), "", o.version ? `Versjon ${o.version}` : "")
  );
  const est = o.estimator || {};
  const acc = est.accuracy || {};
  $("estimator").replaceChildren(
    fact("Kilde", est.source === "fitted"
      ? `Tilpasset fra ${formatNumber(est.samples)} API-kall`
      : `Standardverdier (${formatNumber(est.samples)} vellykkede kall i historikken ennå)`),
    fact("Tid per batch", `${decimal(est.a, 1)} s + ${decimal(est.b, 4)} s per tegn`),
    fact("Treffsikkerhet", acc.jobs
      ? `Median avvik ${decimal(acc.medianAbsPctError, 0)} % over ${formatNumber(acc.jobs)} ${acc.jobs === 1 ? "jobb" : "jobber"}`
      : "Ingen ferdige jobber å sammenligne med ennå.")
  );
}

async function testApi() {
  if (!window.confirm("Dette bruker et lite API-kall. Vil du teste tilkoblingen nå?")) return;
  const button = $("btn-test-api");
  const result = $("test-result");
  button.disabled = true;
  result.className = "result";
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
  const { jobs } = await api(`/api/admin/jobs?limit=50${userId ? `&userId=${encodeURIComponent(userId)}` : ""}`);
  $("jobs-table").tBodies[0].replaceChildren(...(jobs.length ? jobs.map(jobRow) : [emptyRow(7, "Ingen jobber ennå.")]));
}

function estimateVsActual(estimate, actual) {
  if (estimate == null) return "–";
  if (actual == null || !(estimate > 0)) return `${formatElapsed(estimate)} / –`;
  const pct = Math.round(((actual - estimate) / estimate) * 100);
  return h("span", null,
    `${formatElapsed(estimate)} / ${formatElapsed(actual)} `,
    h("span", { class: `delta${Math.abs(pct) > 50 ? " bad" : ""}` }, `${pct > 0 ? "+" : ""}${pct} %`)
  );
}

function jobRow(job) {
  const actual = secondsBetween(job.startedAt, job.finishedAt);
  return h("tr", { "data-job": job.id },
    h("td", { class: "nowrap" }, h("button", { type: "button", class: "link-button", onclick: () => openDrill(job.id) }, formatTs(job.createdAt))),
    h("td", null, job.username || userName(job.userId)),
    h("td", { class: "num" }, formatNumber(job.fileCount)),
    h("td", null, badge(job.status)),
    h("td", { class: "nowrap" }, actual != null ? formatElapsed(actual) : job.status === "running" ? "pågår" : "–"),
    h("td", { class: "nowrap" }, estimateVsActual(job.estimateSeconds, actual)),
    h("td", { class: "num nowrap" }, tokens(job.usage))
  );
}

function fileRow(jobId, f) {
  const base = `/api/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(f.id)}`;
  const warnings = (f.warnings || []).map((w) => (typeof w === "string" ? w : w.message || w.code));
  return h("tr", null,
    h("td", null, f.path || f.name),
    h("td", null, badge(f.status)),
    h("td", { class: "num" }, formatNumber(f.chars)),
    h("td", { class: "num" }, formatNumber(f.batches)),
    h("td", { class: "nowrap" }, f.estimateSeconds != null ? formatElapsed(f.estimateSeconds) : "–"),
    h("td", { class: "nowrap" }, f.durationMs != null ? formatElapsed(f.durationMs / 1000) : "–"),
    h("td", { class: "msg" },
      f.error ? errorDetails(f.error, f.errorStack || f.stack) : f.message || "",
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
  return h("tr", { class: c.ok ? "" : "lvl-error" },
    h("td", { class: "nowrap" }, formatTs(c.ts)),
    h("td", null, names.get(c.fileId) || "–"),
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
  return h("li", { class: `lvl-${e.level}` },
    h("span", { class: "tl-time" }, formatTs(e.ts)),
    h("span", { class: `lvl lvl-${e.level}` }, LEVEL_LABELS[e.level] || e.level),
    h("code", null, e.type),
    h("span", { class: "tl-msg" }, e.message),
    dataDetails(e.data)
  );
}

function closeDrill() {
  $("drill").hidden = true;
  for (const row of $("jobs-table").tBodies[0].rows) row.classList.remove("selected");
}

async function openDrill(id) {
  const drill = $("drill");
  for (const row of $("jobs-table").tBodies[0].rows) row.classList.toggle("selected", row.dataset.job === id);
  drill.hidden = false;
  drill.replaceChildren(h("p", null, "Henter jobben …"));
  drill.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const { job, files = [], events = [], calls = [] } = await api(`/api/admin/jobs/${encodeURIComponent(id)}`);
    const names = new Map(files.map((f) => [f.id, f.path || f.name]));
    const actual = secondsBetween(job.startedAt, job.finishedAt);
    const chronological = [...events].sort((a, b) => (a.id || 0) - (b.id || 0));
    const usage = job.usage || {};
    fill(drill,
      h("div", { class: "drill-head" },
        h("h2", null, "Jobb ", h("code", null, job.id), " ", badge(job.status)),
        h("button", { type: "button", class: "paper quiet", onclick: closeDrill }, "Lukk")
      ),
      h("dl", { class: "facts cols" },
        fact("Bruker", job.username || userName(job.userId)),
        fact("Språk", LANGUAGE_LABELS[job.targetLanguage] || job.targetLanguage || "–"),
        fact("Modell", job.model || "–"),
        fact("Opprettet", formatTs(job.createdAt)),
        fact("Startet", formatTs(job.startedAt)),
        fact("Ferdig", formatTs(job.finishedAt)),
        fact("Estimert / faktisk", estimateVsActual(job.estimateSeconds, actual)),
        fact("Tegn", formatNumber(job.totals && job.totals.chars)),
        fact("API-kall", formatNumber(usage.calls)),
        fact("Tokens inn / ut", tokens(usage))
      ),
      job.error ? h("p", { class: "form-error" }, job.error) : null,
      h("h3", null, `Filer (${files.length})`),
      table(["Fil", "Status", "Tegn", "Batcher", "Estimert", "Tid", "Melding / feil", "Filer"],
        files.map((f) => fileRow(job.id, f)), "Ingen filer."),
      h("h3", null, `Grok-kall (${calls.length})`),
      table(["Tid", "Fil", "HTTP", "Forsøk", "Tekstbiter", "Tegn inn / ut", "Svartid", "Tokens inn / ut / tenk", "Feil"],
        calls.map((c) => callRow(names, c)), "Ingen API-kall registrert."),
      h("h3", null, `Hendelser (${events.length})`),
      chronological.length
        ? h("ol", { class: "timeline" }, chronological.map(timelineItem))
        : h("p", { class: "small-note" }, "Ingen hendelser.")
    );
    drill.focus({ preventScroll: true });
  } catch (err) {
    drill.replaceChildren(h("p", { class: "form-error" }, `Noe gikk galt: ${err.message}`));
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
  return h("tr", { class: `lvl-${e.level}${fresh ? " fresh" : ""}` },
    h("td", { class: "nowrap" }, formatTs(e.ts)),
    h("td", null, h("span", { class: `lvl lvl-${e.level}` }, LEVEL_LABELS[e.level] || e.level)),
    h("td", null, h("code", null, e.type)),
    h("td", { class: "msg" }, e.message, dataDetails(e.data)),
    h("td", null, e.username || userName(e.userId)),
    h("td", null, e.jobId ? h("button", {
      type: "button", class: "link-button mono", title: "Åpne jobben", onclick: () => showJob(e.jobId),
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
    h("td", null, h("strong", null, s.username || userName(s.userId))),
    h("td", { class: "nowrap" }, s.ip || "–"),
    h("td", { title: s.userAgent || "" }, device),
    h("td", { class: "nowrap", title: formatTs(s.lastSeenAt) }, relativeTime(s.lastSeenAt)),
    h("td", { class: "nowrap" }, formatTs(s.createdAt)),
    h("td", { class: "nowrap" }, s.revokedAt ? `Logget ut ${relativeTime(s.revokedAt)}` : ended ? "Utløpt" : relativeTime(s.expiresAt)),
    h("td", null, ended ? "" : h("button", {
      type: "button", class: "paper quiet small", onclick: () => revokeSession(s, device),
    }, "Logg ut økt"))
  );
}

async function revokeSession(s, device) {
  if (!window.confirm(`Logge ut ${s.username || "brukeren"} (${device})?`)) return;
  await guarded("okter", async () => {
    await api(`/api/admin/sessions/${encodeURIComponent(s.idPrefix || s.id)}/revoke`, { method: "POST" });
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
      h("button", { type: "button", class: "paper quiet small", onclick: () => resetPassword(u) }, "Nytt passord"),
      self ? null : h("button", {
        type: "button", class: `paper quiet small${u.disabled ? "" : " danger"}`, onclick: () => toggleDisabled(u),
      }, u.disabled ? "Aktiver" : "Deaktiver")
    )
  );
}

async function updateUser(u, patch) {
  await guarded("brukere", async () => {
    try {
      await api(`/api/admin/users/${encodeURIComponent(u.id)}`, { method: "PATCH", body: patch });
    } finally {
      await loadUsers();
    }
  });
}

function toggleDisabled(u) {
  if (!u.disabled && !window.confirm(`Deaktivere ${u.username}? Brukeren kan ikke logge inn før du aktiverer kontoen igjen.`)) return;
  updateUser(u, { disabled: !u.disabled });
}

async function resetPassword(u) {
  if (!window.confirm(`Lage nytt midlertidig passord for ${u.username}? Det gamle slutter å virke, og brukeren blir logget ut.`)) return;
  await guarded("brukere", async () => {
    const { password } = await api(`/api/admin/users/${encodeURIComponent(u.id)}/reset-password`, { method: "POST" });
    showSecret("Nytt passord er laget", u.username, password,
      "Hei! Her er et nytt midlertidig passord til InnNorsk:");
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

// ---------- Passord-vindu ----------

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
    "Du blir bedt om å lage nytt passord første gang du logger inn.",
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
  $("who").textContent = me.displayName || me.username;
  try {
    await fetchUsers();
  } catch {
    // Navn vises som #id til brukerlisten kan hentes.
  }
  selectTab(location.hash.slice(1));
}

init();
