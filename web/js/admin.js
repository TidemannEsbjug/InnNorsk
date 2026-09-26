import {
  api, upload, h, fill, icon, extBadge, dirName, baseName, plural, formatBytes, formatClock, formatDuration, formatNumber,
  formatSeconds, formatWhen, relativeTime, LANGUAGE_LABELS, confirmDialog, toast, logout, reportErrors, initMenu, newSaltedProof,
  describeAgent,
} from "./api.js";

reportErrors();
initMenu();

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const LOG_PAGE = 100;
const SENDINGS_PAGE = 50;
const TIMELINE_MAX = 200;
const ONLINE_MS = 2 * 60000; // økten flyttes fram hvert minutt mens siden er åpen

const STATUS = { draft: "Utkast", sent: "I kø", working: "Oversettes", done: "Ferdig", failed: "Feilet" };
const SENDING_STATUS = { draft: "Utkast", sent: "Startet", done: "Ferdig", deleted: "Slettet" };
const LEVELS = { debug: "Debug", info: "Info", warn: "Advarsel", error: "Feil" };
// «agent» finnes bare i gamle hendelser fra Mac-tiden.
const SOURCES = { web: "Nettside", ios: "iPhone", system: "System", workflow: "Oversetter", agent: "Mac (tidligere)" };
const OUTPUT_SOURCE = { cloud: "sky", manual: "manuell", agent: "Mac" };
// Det som skjedde i nettleseren hennes (web/js/api.js track).
const TYPE_LABELS = {
  "client.page": "Åpnet siden",
  "client.file_rejected": "Filer ikke tatt med",
  "client.upload_failed": "Opplasting feilet",
  "client.error_shown": "Feilmelding vist",
  "client.error": "Feil i nettleseren",
};
// Hvorfor en sending ble slettet (sendings.deleted_reason); «expired» har egen tekst.
const SENDING_DELETED = {
  cleanup: " (tomt utkast, ryddet bort av nettsiden)",
  language: " (byttet språk – filene ble lastet opp på nytt i en ny sending)",
};
// Filer hun fjernet fra et utkast eller erstattet (files.deleted_reason); «sending» = slettet med sendingen.
const FILE_REMOVED = {
  removed: ["Fjernet", (who) => `Fjernet av ${who}`],
  cleanup: ["Fjernet", () => "Fjernet av nettsiden (var ikke lenger i listen)"],
  replaced: ["Erstattet", () => "Erstattet – samme fil lastet opp på nytt"],
};

let me = null;
let current = "";
let timer = 0;
let sendings = [];
let sendingsLimit = SENDINGS_PAGE;
let resultTarget = null; // filen en manuell oversettelse skal lastes opp til
let logUsers = null; // brukerne i «Bruker»-filteret, hentet én gang
const replyDrafts = new Map();
const callsCache = new Map(); // fil-ID → { calls, count } for «Grok-kall», så åpne lister overlever oppdatering
const timelineCache = new Map(); // sending-ID → { events, more } for «Historikk»
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

// USD med nok desimaler til at små beløp synes: $0.0042, $1.27.
function money(usd) {
  const n = Number(usd);
  return `$${n.toFixed(n !== 0 && Math.abs(n) < 1 ? 4 : 2)}`;
}

// «2 min 41 s» og «ca. 3 min» deles ikke over to linjer.
const glue = (text) => String(text).replace(/ /g, "\u00a0");

// Felt kan komme i camelCase eller rett fra databasen (snake_case).
const field = (obj, camel, snake) => (obj[camel] !== undefined ? obj[camel] : obj[snake]);

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
  const overview = await api("/api/admin/overview");
  renderTranslator(overview.translator || {}, overview.estimator);
  renderStats(overview);
  renderActivity(overview.activity || []);
  renderDevices(Array.isArray(overview.devices) ? overview.devices : (await api("/api/admin/devices")).devices || []);
}

// ---------- Aktivitet per bruker (Oversikt) ----------

function renderActivity(list) {
  fill($("activity"), list.map(activityCard));
  $("activity").hidden = !list.length;
}

const ago = (value) => (value ? h("span", { title: formatWhen(value) }, relativeTime(value)) : "–");

function activityCard(a) {
  const online = a.onlineSeenAt && Date.now() - Date.parse(a.onlineSeenAt) < ONLINE_MS;
  const w = a.week || {};
  const p = a.problems24h || {};
  const name = a.displayName || a.username;
  const week = w.sendings
    ? [plural(w.sendings, "sending", "sendinger"), plural(w.files || 0, "fil", "filer"),
      w.done ? `${formatNumber(w.done)} ferdig` : "", w.failed ? `${formatNumber(w.failed)} ikke oversatt` : ""].filter(Boolean).join(" · ")
    : "Ingen sendinger";
  return h("article", { class: "card activity", "aria-label": `Aktivitet for ${name}` },
    h("div", { class: "card-head" },
      h("div", { class: `status-head${online ? " is-ok" : ""}` },
        h("span", { class: "status-dot", "aria-hidden": "true" }),
        h("div", null,
          h("h2", null, name, a.disabled ? " " : null, a.disabled ? pill("failed", "Deaktivert") : null),
          h("p", { class: "muted small" }, online
            ? "Har siden åpen nå"
            : a.lastSeenAt ? ["Sist innom ", ago(a.lastSeenAt)] : "Har ikke vært innom ennå"))),
      h("div", { class: "item-actions" },
        button("Vis loggen", () => showLogFor(a.userId, name)),
        p.total ? button("Vis problemer", () => showLogFor(a.userId, name, { problems: true })) : null)),
    h("dl", { class: "facts" },
      fact("Sist innlogget", ago(a.lastLoginAt)),
      fact("Sist lastet opp", ago(a.lastUploadAt)),
      fact("Sist sendt", ago(a.lastSentAt)),
      fact("Sist lastet ned", ago(a.lastDownloadAt)),
      fact("Siste 7 dager", week)),
    problemsBlock(p));
}

function problemsBlock(p) {
  if (!p.total) return h("p", { class: "muted small" }, "Ingen problemer det siste døgnet.");
  const parts = [
    p.failedFiles ? plural(p.failedFiles, "fil feilet", "filer feilet") : "",
    p.errorsShown ? plural(p.errorsShown, "feilmelding vist", "feilmeldinger vist") : "",
    p.uploadProblems ? plural(p.uploadProblems, "problem med opplasting", "problemer med opplasting") : "",
  ].filter(Boolean);
  return h("div", { class: "problems" },
    h("p", { class: "small" }, h("strong", { class: "bad" }, `Problemer siste 24 t: ${plural(p.total, "hendelse", "hendelser")}`),
      parts.length ? ` · ${parts.join(" · ")}` : ""),
    h("ul", { class: "problem-list" }, (p.recent || []).map((e) => h("li", { class: `small lvl-line lvl-line-${e.level}` },
      h("time", { dateTime: e.ts, title: formatWhen(e.ts) }, formatClock(e.ts)), " ", e.message || e.type))));
}

// Til Logg, filtrert på brukeren (og eventuelt bare advarsler og feil).
function showLogFor(userId, name, { problems = false } = {}) {
  userOption(userId, name);
  $("log-user").value = String(userId);
  $("log-level").value = problems ? "problems" : "";
  $("log-source").value = "";
  $("log-type").value = "";
  $("log-q").value = "";
  select("logg", true);
}

function fact(label, value, cls = "") {
  return h("div", null, h("dt", null, label), h("dd", { class: cls }, value));
}

function renderTranslator(t, estimator) {
  const ready = t.apiKeyConfigured === true;
  const calls = Number(t.calls24h || 0);
  const failed = Number(t.failedCalls24h || 0);
  const tokens = t.tokens24h || {};
  $("key-banner").hidden = t.apiKeyConfigured !== false;
  $("translator-head").classList.toggle("is-ok", ready);
  $("translator-head").classList.toggle("is-bad", t.apiKeyConfigured === false);
  $("translator-state").textContent = t.apiKeyConfigured === false
    ? "Ikke satt opp – API-nøkkelen mangler."
    : `Klar – oversetter automatisk i skyen${t.lastCallAt ? `. Sist brukt ${relativeTime(t.lastCallAt)}.` : "."}`;
  fill($("translator-facts"),
    fact("API-nøkkel", ready ? "✓ Satt" : "✗ Mangler", ready ? "good" : "bad"),
    fact("Modell", t.model || "–"),
    fact("Sist kall", t.lastCallAt ? h("span", { title: formatWhen(t.lastCallAt) }, relativeTime(t.lastCallAt)) : "Ingen ennå"),
    fact("Kall siste 24 t", [formatNumber(calls), failed ? h("span", { class: "bad" }, ` · ${formatNumber(failed)} feilet`) : h("span", { class: "muted" }, " · 0 feilet")]),
    fact("Tokens siste 24 t", `${formatNumber(tokens.input)} inn · ${formatNumber(tokens.output)} ut`),
    t.cost24h != null ? fact("Kostnad siste 24 t", money(t.cost24h)) : null);
  renderLastError(t.lastError, t.lastErrorAt);
  renderEstimator(estimator);
}

// lastError kan være en tekst eller { message, at/ts, status }.
function renderLastError(error, at) {
  const box = $("translator-error");
  if (!error) {
    box.hidden = true;
    return;
  }
  const message = typeof error === "string" ? error : error.message || error.error || JSON.stringify(error);
  const when = (typeof error === "object" && (error.at || error.ts)) || at;
  const status = typeof error === "object" ? error.status : null;
  fill(box,
    h("p", { class: "small" }, h("strong", null, "Siste feil"), when ? ` · ${relativeTime(when)} (${formatWhen(when)})` : "", status ? ` · HTTP ${status}` : ""),
    h("p", { class: "small bad" }, message));
  box.hidden = false;
}

function renderEstimator(e) {
  if (!e || e.a == null || e.b == null) {
    $("estimator").textContent = "";
    return;
  }
  const samples = Number(e.samples || 0);
  const fitted = e.source ? !/^(default|standard)$/i.test(e.source) : samples >= 8;
  $("estimator").textContent = `Tidsestimat per del: ${formatNumber(e.a, 1)} s + ${formatNumber(e.b, 4)} s per tegn · ${fitted
    ? `tilpasset fra ${plural(samples, "måling", "målinger")}`
    : `standardverdier${samples ? ` (${plural(samples, "måling", "målinger")} så langt)` : " (ingen målinger ennå)"}`}`;
}

$("btn-test-api").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const ok = await confirmDialog({ title: "Teste API-tilkoblingen?", text: "Dette bruker et lite API-kall.", confirm: "Test nå" });
  if (!ok) return;
  const result = $("test-api-result");
  btn.disabled = true;
  btn.classList.add("is-busy");
  btn.textContent = "Tester …";
  result.className = "test-result";
  say(result, "");
  try {
    const res = await api("/api/admin/test-api", { method: "POST" });
    const ms = res.ms != null ? ` på ${formatNumber(res.ms / 1000, 1)} s` : "";
    result.classList.add(res.ok ? "is-ok" : "is-bad");
    say(result, res.ok
      ? `✓ Tilkoblingen virker. Svar${ms}${res.sample ? `: «${String(res.sample).slice(0, 200)}»` : "."}`
      : `✗ Tilkoblingen virker ikke${ms}: ${res.error || "ukjent feil"}`);
  } catch (err) {
    result.classList.add("is-bad");
    say(result, `✗ ${err.message}`);
  }
  btn.disabled = false;
  btn.classList.remove("is-busy");
  btn.textContent = "Test API-tilkobling";
  if (current === "oversikt") load(true);
});

function say(el, text) {
  el.textContent = text;
  el.hidden = !text;
}

function renderStats({ counts = {}, storage = {}, users, limits = {} }) {
  const tile = (value, label, cls = "") => h("div", { class: `stat ${cls}` }, h("span", { class: "stat-value" }, value), h("span", { class: "stat-label" }, label));
  // Tak mot uventet forbruk (MAX_CHARS_PER_DAY, MAX_CHARS_PER_MONTH, MAX_STORAGE_GB i wrangler.jsonc).
  const limitTile = (l, label, format) => {
    if (!l || !l.cap) return null;
    const pct = Math.min(100, Math.round((100 * l.used) / l.cap));
    return tile(`${pct} %`, `${label} · ${format(l.used)} av ${format(l.cap)}`, pct >= 90 ? "stat-bad" : "");
  };
  const chars = (n) => `${formatNumber(n)} tegn`;
  fill($("stats"),
    tile(formatNumber(counts.waiting), "I kø"),
    tile(formatNumber(counts.working), "Oversettes nå"),
    tile(formatNumber(counts.doneToday), "Ferdig i dag"),
    tile(formatNumber(counts.failed), "Feilet", counts.failed ? "stat-bad" : ""),
    tile(formatBytes(storage.bytes), `Lagret · ${plural(storage.files || 0, "fil", "filer")}`),
    // Slettet av brukeren, men fortsatt i R2 (og med i lagringstaket) til cron sletter det for godt.
    storage.deletedBytes
      ? tile(formatBytes(storage.deletedBytes), `Slettet, beholdes ${plural(storage.retainDays || 0, "dag", "dager")} · ${plural(storage.deletedFiles || 0, "fil", "filer")}`)
      : null,
    typeof users === "number" ? tile(formatNumber(users), "Brukere") : null,
    limitTile(limits.day, "Tak siste døgn", chars),
    limitTile(limits.month, "Tak siste 30 dager", chars),
    limitTile(limits.storage, "Lagringstak", formatBytes)
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

// Med «Vis også slettede»: sendinger og filer Svetlana har slettet (til de slettes for godt), gamle utkast og historikk.
async function loadSendings(auto) {
  if (auto && busyTyping()) return;
  const withDeleted = $("sendings-deleted").checked;
  const max = withDeleted ? 500 : 200;
  sendings = (await api(`/api/admin/sendings?limit=${sendingsLimit}${withDeleted ? "&all=1" : ""}`)).sendings || [];
  const open = new Set([...$("sendings").querySelectorAll("details[open]")].map((d) => d.dataset.key));
  const deleted = sendings.filter((s) => s.deletedAt).length;
  $("sendings-count").textContent = `${plural(sendings.length, "sending", "sendinger")}${deleted ? `, herav ${formatNumber(deleted)} slettet` : ""} (de siste ${sendingsLimit})`;
  fill($("sendings"), sendings.length
    ? sendings.map((s) => sendingCard(s, open))
    : h("p", { class: "card muted" }, "Ingen sendinger ennå."));
  $("sendings-more").hidden = sendings.length < sendingsLimit || sendingsLimit >= max;
}

function countsText(c = {}) {
  return [
    c.done ? `${c.done} ferdig` : "",
    c.working ? `${c.working} oversettes` : "",
    c.waiting ? `${c.waiting} venter` : "",
    c.failed ? `${c.failed} feilet` : "",
  ].filter(Boolean).join(" · ");
}

// Sum av kall, tokens og kostnad for filene i en sending.
function totals(files) {
  const sum = (camel, snake) => files.reduce((n, f) => n + Number(field(f, camel, snake) || 0), 0);
  const costs = files.map((f) => field(f, "costUsd", "cost_usd")).filter((c) => c != null);
  return {
    calls: sum("calls", "calls"),
    input: sum("inputTokens", "input_tokens"),
    output: sum("outputTokens", "output_tokens"),
    cost: costs.length ? costs.reduce((a, b) => a + Number(b), 0) : null,
  };
}

function sendingFacts(s) {
  const t = totals(s.files);
  const started = s.startedAt || s.sentAt;
  const took = s.finishedAt && started ? (Date.parse(s.finishedAt) - Date.parse(started)) / 1000 : null;
  const active = s.files.some((f) => f.status === "sent" || f.status === "working");
  const est = s.estimateSeconds;
  return [
    // Mens noe er underveis er estimatet gjenstående tid; etterpå det som var beregnet.
    est != null && (active || est > 0) ? (active ? `${glue(formatDuration(est))} igjen` : `estimert ${glue(formatDuration(est))}`) : "",
    took != null && took >= 0 ? `tok ${glue(formatSeconds(took))}` : "",
    t.calls ? plural(t.calls, "kall", "kall") : "",
    t.input || t.output ? `${formatNumber(t.input + t.output)} tokens` : "",
    t.cost != null ? money(t.cost) : "",
  ].filter(Boolean).join(" · ");
}

function sendingCard(s, open) {
  const who = s.displayName || s.username || "Ukjent";
  const facts = sendingFacts(s);
  const deleted = Boolean(s.deletedAt);
  return h("article", { class: `card acard${deleted ? " is-deleted" : ""}` },
    h("div", { class: "acard-head" },
      h("div", null,
        h("h3", null, who, s.username && s.displayName ? h("span", { class: "muted" }, ` (${s.username})`) : null),
        h("p", { class: "muted small" }, [
          s.sentAt ? `Startet ${formatWhen(s.sentAt)}` : `Opprettet ${formatWhen(s.createdAt)}`,
          LANGUAGE_LABELS[s.targetLanguage],
          plural(s.counts ? s.counts.total : s.files.length, "fil", "filer"),
          countsText(s.counts),
        ].filter(Boolean).join(" · ")),
        facts ? h("p", { class: "muted small" }, facts) : null),
      pill(s.status, SENDING_STATUS[s.status] || s.status)),
    deleted ? deletedNote(s, who) : retainedNote(s, who),
    s.note ? h("p", { class: "my-note" }, h("span", { class: "muted" }, `Melding fra ${who}: `), `«${s.note}»`) : null,
    h("ul", { class: "afiles" }, s.files.map((f) => adminFile(f, open, s, who))),
    timelineDetails(s, open),
    s.status === "draft" || deleted ? null : replyForm(s, who)
  );
}

// Tidligste tidspunkt noe av det slettede slettes for godt.
const firstPurge = (files) => files.map((f) => f.purgeAt).filter(Boolean).sort()[0];

// «Slettet av Svetlana i dag 14:05», og om filene fortsatt kan lastes ned.
function deletedNote(s, who) {
  const text = s.deletedReason === "expired"
    ? `Slettet automatisk ${formatWhen(s.deletedAt)} (utkastet ble aldri sendt)`
    : `Slettet av ${s.deletedBy || who} ${formatWhen(s.deletedAt)}${SENDING_DELETED[s.deletedReason] || ""}`;
  const kept = s.files.filter((f) => !f.purgedAt);
  const purged = s.files.filter((f) => f.purgedAt);
  return h("div", { class: "deleted-note" },
    h("p", null, h("strong", null, text)),
    kept.length
      ? h("p", { class: "small" }, `${who} ser ikke filene lenger. Du kan laste dem ned til ${formatWhen(firstPurge(kept))}; da slettes de for godt.`,
        " ", purgeButton(s))
      : purged.length ? h("p", { class: "small muted" }, `Filene ble slettet for godt ${formatWhen(purged[0].purgedAt)}.`) : null);
}

// Filer hun har fjernet eller erstattet i en sending som ellers finnes.
function retainedNote(s, who) {
  const kept = s.files.filter((f) => f.deletedAt && !f.purgedAt);
  if (!kept.length) return null;
  return h("p", { class: "small muted" },
    `${plural(kept.length, "fil", "filer")} som ${who} har fjernet eller erstattet, kan lastes ned til ${formatWhen(firstPurge(kept))}.`, " ", purgeButton(s));
}

function purgeButton(s) {
  return h("button", {
    type: "button",
    class: "btn-quiet",
    onclick: async () => {
      const ok = await confirmDialog({
        title: "Slette filene for godt nå?",
        text: "Originalene og oversettelsene som er slettet her, fjernes fra lagringen med én gang. Historikken blir stående.",
        confirm: "Slett for godt",
        danger: true,
      });
      if (ok) act(() => api(`/api/admin/sendings/${enc(s.id)}/purge`, { method: "POST" }), "Filene er slettet for godt.");
    },
  }, icon("trash"), "Slett for godt nå");
}

// «Tid: estimert ca. 3 min, faktisk 2 min 41 s · 6 kall · 12 345 inn / 6 789 ut tokens · $0.0123»
function fileMetrics(f) {
  const est = field(f, "estimateSeconds", "estimate_seconds");
  const dur = field(f, "durationSeconds", "duration_seconds");
  const calls = field(f, "calls", "calls");
  const input = field(f, "inputTokens", "input_tokens");
  const output = field(f, "outputTokens", "output_tokens");
  const cost = field(f, "costUsd", "cost_usd");
  // durationSeconds er medgått tid så langt mens filen oversettes.
  const took = dur != null ? `${f.status === "working" ? "hittil" : "faktisk"} ${glue(formatSeconds(dur))}` : "";
  const time = [est != null ? `estimert ${glue(formatDuration(est))}` : "", took].filter(Boolean).join(", ");
  return [
    time ? `Tid: ${time}` : "",
    calls ? plural(Number(calls), "kall", "kall") : "",
    input || output ? `Tokens: ${formatNumber(input)} inn / ${formatNumber(output)} ut` : "",
    cost != null ? `Kostnad: ${money(cost)}` : "",
  ].filter(Boolean).join(" · ");
}

function adminFile(f, open, s, who) {
  // Fjernet eller erstattet av henne (ikke slettet sammen med sendingen).
  const removed = FILE_REMOVED[f.deletedReason];
  // Slettet (av henne eller med sendingen): kan lastes ned til den slettes for godt, men ikke endres.
  const frozen = Boolean(f.deletedAt || s.deletedAt);
  const stored = !f.purgedAt;
  // Filer i et utkast (også de som ikke kunne leses) er ikke sendt; serveren avviser kø og manuell opplasting.
  const sent = !frozen && f.status !== "draft" && s.status !== "draft";
  const stopped = frozen && ["sent", "working"].includes(f.status);
  const source = field(f, "outputSource", "output_source");
  const facts = [
    f.bytes != null ? formatBytes(f.bytes) : "",
    f.attempts > 1 ? plural(f.attempts, "forsøk", "forsøk") : "",
    source ? `resultat: ${OUTPUT_SOURCE[source] || source}` : "",
    f.status === "working" && f.progress ? `${Math.round(f.progress.percent || 0)} %${f.progress.etaSeconds != null ? `, ${formatDuration(f.progress.etaSeconds)} igjen` : ""}` : "",
    f.finishedAt ? `ferdig ${formatWhen(f.finishedAt)}` : "",
  ].filter(Boolean).join(" · ");
  const metrics = fileMetrics(f);
  const key = `err-${f.id}`;
  const calls = field(f, "calls", "calls");
  const hasCalls = calls != null ? Number(calls) > 0 : ["working", "done", "failed"].includes(f.status);
  // Det hun ser ved filen, der det sier noe mer enn statusen («Klar – ca. 3 min», «Denne PDF-en er et bilde …»).
  const seen = !frozen && ["draft", "failed"].includes(f.status) && f.statusText;
  const outputName = field(f, "outputName", "output_name");
  return h("li", { class: `afile${removed ? " is-removed" : ""}` },
    extBadge(f.name),
    h("div", { class: "afile-main" },
      h("p", { class: "afile-name" }, dirName(f.path || "") ? h("span", { class: "q-dir" }, dirName(f.path)) : null, f.name || baseName(f.path)),
      h("p", { class: "small" },
        removed ? pill("deleted", removed[0]) : pill(f.status, stopped ? "Stoppet" : STATUS[f.status] || f.status),
        " ", h("span", { class: "muted" }, facts)),
      removed ? h("p", { class: "small muted" }, `${removed[1](who)} ${formatWhen(f.deletedAt)}`) : null,
      seen ? h("p", { class: "small muted" }, `${who} ser: «${f.statusText}»`) : null,
      metrics ? h("p", { class: "small metrics" }, metrics) : null,
      f.error ? h("p", { class: "small bad" }, f.error) : null,
      f.errorDetails
        ? h("details", { class: "small", "data-key": key, open: open.has(key) }, h("summary", null, "Tekniske detaljer"), h("pre", null, f.errorDetails))
        : null,
      hasCalls ? callsDetails(f, open) : null),
    h("div", { class: "afile-actions" },
      stored ? h("a", { class: "btn-quiet", href: `/api/files/${enc(f.id)}/original`, download: "" }, icon("download"), "Original") : null,
      // En tidligere oversettelse kan lastes ned også mens filen oversettes på nytt, eller etter at den er slettet.
      stored && outputName
        ? h("a", { class: "btn-quiet", href: `/api/files/${enc(f.id)}/result`, download: "" }, icon("download"), f.status === "done" ? "Oversettelse" : "Forrige oversettelse")
        : null,
      stored ? null : h("span", { class: "small muted purged" }, `Slettet for godt ${formatWhen(f.purgedAt)}`),
      sent ? h("button", { type: "button", class: "btn-quiet", onclick: () => pickResult(f) }, icon("upload"), "Last opp oversettelse") : null,
      sent && ["failed", "working", "done"].includes(f.status)
        ? h("button", { type: "button", class: "btn-quiet", onclick: () => requeue(f) }, icon("refresh"), "Sett i kø igjen")
        : null)
  );
}

// Sett i kø igjen = oversett på nytt i skyen (nye API-kall).
async function requeue(f) {
  if (f.status !== "failed") {
    const ok = await confirmDialog({
      title: `Oversette «${f.name}» på nytt?`,
      text: f.status === "working"
        ? "Filen oversettes akkurat nå. Bruk dette bare hvis den har stått fast. Den starter på nytt, og det bruker nye API-kall."
        : "Filen er allerede ferdig. Den oversettes på nytt i skyen, og det bruker nye API-kall.",
      confirm: "Oversett på nytt",
    });
    if (!ok) return;
  }
  act(() => api(`/api/admin/files/${enc(f.id)}/status`, { method: "POST", body: { status: "sent" } }), `${f.name} er satt i kø og oversettes på nytt.`);
}

// «Grok-kall»: hentes først når listen åpnes, og bare på nytt når antallet kall har endret seg.
function callsDetails(f, open) {
  const key = `calls-${f.id}`;
  const calls = field(f, "calls", "calls");
  const body = h("div", { class: "calls-body" });
  const details = h("details", { class: "small calls", "data-key": key, open: open.has(key) },
    h("summary", null, calls != null ? `Grok-kall (${formatNumber(calls)})` : "Grok-kall"),
    body);
  const cached = callsCache.get(f.id);
  if (cached) renderCalls(body, cached.calls);
  details.addEventListener("toggle", () => {
    if (details.open) loadCalls(f, body);
  });
  return details;
}

async function loadCalls(f, body) {
  const count = field(f, "calls", "calls");
  const cached = callsCache.get(f.id);
  if (cached && cached.count === count && f.status !== "working") return;
  if (!cached) fill(body, h("p", { class: "muted" }, "Henter kallene …"));
  try {
    const { calls } = await api(`/api/admin/files/${enc(f.id)}/calls`);
    callsCache.set(f.id, { calls: calls || [], count });
    renderCalls(body, calls || []);
  } catch (err) {
    fill(body, h("p", { class: "bad" }, err.message));
  }
}

function renderCalls(body, calls) {
  if (!calls.length) {
    fill(body, h("p", { class: "muted" }, "Ingen kall registrert for denne filen."));
    return;
  }
  const num = (c, camel, snake) => Number(field(c, camel, snake) || 0);
  const failed = calls.filter((c) => !isOk(c)).length;
  const input = calls.reduce((n, c) => n + num(c, "inputTokens", "input_tokens"), 0);
  const output = calls.reduce((n, c) => n + num(c, "outputTokens", "output_tokens"), 0);
  const avg = calls.reduce((n, c) => n + num(c, "ms", "ms"), 0) / calls.length;
  const costs = calls.map((c) => field(c, "costUsd", "cost_usd")).filter((v) => v != null);
  const cell = (value, cls) => h("td", cls ? { class: cls } : null, value);
  fill(body,
    h("p", { class: "muted calls-sum" }, [
      plural(calls.length, "kall", "kall"),
      failed ? `${failed} feilet` : "",
      `${formatNumber(input)} tokens inn · ${formatNumber(output)} ut`,
      `snitt ${formatNumber(avg / 1000, 1)} s`,
      costs.length ? money(costs.reduce((a, b) => a + Number(b), 0)) : "",
    ].filter(Boolean).join(" · ")),
    h("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "Grok-kall" },
      h("table", { class: "calls-table" },
        h("thead", null, h("tr", null, [["Tid"], ["ms", "num"], ["Status"], ["Forsøk", "num"], ["Tokens inn", "num"], ["Tokens ut", "num"]]
          .map(([t, cls]) => h("th", { scope: "col", class: cls }, t)))),
        // Feilen står på egen rad under kallet, i full bredde (den kan være lang).
        calls.map((c) => {
          const ok = isOk(c);
          const d = new Date(c.ts);
          return h("tbody", { class: ok ? "" : "is-bad" },
            h("tr", null,
              cell(h("time", { dateTime: c.ts, title: d.toLocaleString("nb-NO") }, `${formatClock(c.ts)}:${String(d.getSeconds()).padStart(2, "0")}`)),
              cell(formatNumber(num(c, "ms", "ms")), "num"),
              cell(c.status != null ? `${c.status}${ok ? " ✓" : ""}` : ok ? "✓" : "–", ok ? "good" : "bad"),
              cell(formatNumber(num(c, "attempt", "attempt") || 1), "num"),
              cell(formatNumber(num(c, "inputTokens", "input_tokens")), "num"),
              cell(formatNumber(num(c, "outputTokens", "output_tokens")), "num")),
            c.error ? h("tr", { class: "err-row" }, h("td", { colSpan: 6 }, h("p", { class: "err-text" }, h("span", { class: "err-label" }, "Feil: "), c.error))) : null);
        }))));
}

const isOk = (c) => (c.ok != null ? Boolean(c.ok) : c.status >= 200 && c.status < 300);

// «Historikk»: alt i loggen for sendingen, eldste først (opprettet, filer lastet opp eller avvist, sendt, oversatt,
// lastet ned, slettet …). Hentes når den åpnes, og på nytt ved hver oppdatering så lenge den er åpen.
function timelineDetails(s, open) {
  const key = `timeline-${s.id}`;
  const body = h("div", { class: "timeline-body" });
  const details = h("details", { class: "small timeline", "data-key": key, open: open.has(key) }, h("summary", null, "Historikk"), body);
  const cached = timelineCache.get(s.id);
  if (cached) renderTimeline(body, cached, s);
  details.addEventListener("toggle", () => {
    if (details.open) loadTimeline(s, body);
  });
  return details;
}

async function loadTimeline(s, body) {
  if (!timelineCache.has(s.id)) fill(body, h("p", { class: "muted" }, "Henter historikken …"));
  try {
    const { events, nextBeforeId } = await api(`/api/admin/events?sendingId=${enc(s.id)}&limit=${TIMELINE_MAX}`);
    const entry = { events: (events || []).reverse(), more: Boolean(nextBeforeId) };
    timelineCache.set(s.id, entry);
    renderTimeline(body, entry, s);
  } catch (err) {
    fill(body, h("p", { class: "bad" }, err.message));
  }
}

// Hvem: avsenderen med navn, andre med brukernavn, ellers kilden (Workflowen og cron logger som «System»).
function actor(ev, s) {
  if (ev.userId != null && ev.userId === s.userId) return s.displayName || ev.username;
  return ev.username || SOURCES[ev.source] || ev.source || "";
}

function renderTimeline(body, { events, more }, s) {
  if (!events.length) {
    fill(body, h("p", { class: "muted" }, "Ingen hendelser for denne sendingen."));
    return;
  }
  fill(body,
    more ? h("p", { class: "muted" }, `Viser de siste ${TIMELINE_MAX} hendelsene.`) : null,
    h("ol", { class: "timeline-list" }, events.map((ev) => {
      const d = new Date(ev.ts);
      return h("li", { class: `tl lvl-line lvl-line-${ev.level}` },
        h("time", { dateTime: ev.ts, title: d.toLocaleString("nb-NO") }, `${formatWhen(ev.ts)}:${String(d.getSeconds()).padStart(2, "0")}`),
        h("span", { class: "tl-who" }, actor(ev, s)),
        h("span", { class: "tl-msg" }, ev.message || ev.type, TYPE_LABELS[ev.type] ? h("span", { class: "muted" }, ` · ${TYPE_LABELS[ev.type]}`) : null));
    })));
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
$("sendings-deleted").addEventListener("change", () => {
  sendingsLimit = SENDINGS_PAGE;
  load();
});
$("sendings-more").addEventListener("click", () => {
  sendingsLimit += SENDINGS_PAGE;
  load();
});

// ---------- Logg ----------

// «Bruker»-filteret: brukerne hentes én gang (og en bruker legges til med én gang ved «Vis loggen» fra Oversikt).
function userOption(id, name, username) {
  const list = $("log-user");
  if ([...list.options].some((o) => o.value === String(id))) return;
  list.append(h("option", { value: String(id) }, username && username !== name ? `${name} (${username})` : name));
}

async function loadLogUsers() {
  if (logUsers) return;
  logUsers = (await api("/api/admin/users")).users || [];
  for (const u of logUsers) userOption(u.id, u.displayName || u.username, u.username);
}

function logUrl(beforeId) {
  const params = new URLSearchParams();
  for (const [key, id] of [["level", "log-level"], ["userId", "log-user"], ["source", "log-source"], ["type", "log-type"], ["q", "log-q"]]) {
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
      TYPE_LABELS[ev.type] ? h("span", { class: "ev-label" }, TYPE_LABELS[ev.type]) : null,
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
  await loadLogUsers().catch(() => {}); // filteret er bare til hjelp; loggen vises uansett
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
      h("p", { class: "muted small" }, [
        u.lastSeenAt ? `Sist aktiv ${relativeTime(u.lastSeenAt)}` : "",
        u.lastLoginAt ? `sist innlogget ${relativeTime(u.lastLoginAt)}` : "har ikke logget inn ennå",
        `opprettet ${formatWhen(u.createdAt)}`,
      ].filter(Boolean).join(" · ").replace(/^./, (ch) => ch.toUpperCase()))),
    h("div", { class: "item-actions" },
      button("Vis aktivitet", () => showLogFor(u.id, u.displayName || u.username)),
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
      ? "Her er et nytt passord til Oversetter:"
      : "Her er innloggingen din til Oversetter, der du kan få dokumenter oversatt til norsk:",
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
