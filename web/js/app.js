import {
  api, upload, h, fill, icon, extBadge, baseName, dirName, extOf, plural, formatBytes, formatClock, formatDuration,
  dayLabel, LANGUAGE_LABELS, remember, recall, confirmDialog, toast, logout, reportErrors, initMenu,
  changePassword, passwordProblem, track, trackPage,
} from "./api.js";

reportErrors();
initMenu();

// Samme liste som SUPPORTED i src/core.js. Serveren sjekker uansett; dette er for å kunne forklare med én gang.
const SUPPORTED = new Set([".docx", ".pptx", ".xlsx", ".pdf", ".txt", ".md", ".csv", ".html", ".htm", ".rtf"]);
const OLD_OFFICE = new Set([".doc", ".ppt", ".xls"]);
const PERMANENT = new Set([400, 413, 415, 422]); // gjelder bare den ene filen; resten kan oversettes
const ACTIVE = new Set(["sent", "working"]);
const LANG_KEY = "innnorsk.language";
const SEEN_KEY = "innnorsk.seenDone";

const SKIP_TEXT = {
  lock: () => "Midlertidige filer som Word og Office lager mens et dokument er åpent (navnet starter med ~$). Selve dokumentet er med.",
  hidden: () => "Skjulte systemfiler, som .DS_Store og Thumbs.db. Det er ikke dokumenter.",
  type: () => "Filtyper som ikke kan oversettes, for eksempel bilder.",
  empty: () => "Tomme filer.",
  big: () => `Filer som er større enn ${state.limits.maxFileMb} MB.`,
  duplicate: () => "Filer som allerede ligger i listen.",
  many: () => `Mer enn ${state.limits.maxFilesPerSending} filer på en gang. Ta gjerne resten etterpå.`,
};
const HARMLESS = new Set(["lock", "hidden", "duplicate", "empty"]);
// Hvor en feilmelding ble vist (for eierens logg).
const SHOWN_WHERE = { send: "ved sending", mine: "i Mine filer", toast: "som kort beskjed", password: "ved passordbytte", start: "da siden åpnet" };

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;

const state = {
  me: null,
  translator: "oversetteren",
  // { file, path, status: "waiting" | "uploading" | "ready" | "skip" | "error", pct, error, permanent, fileId, info, abort, el }
  // ready = lastet opp og klar; skip = lastet opp, men kan ikke oversettes (skannet/skadet) og hoppes over.
  queue: [],
  draft: null, // sendingen på serveren (utkast) som filene lastes opp til
  pumping: null, // løftet til opplastingskøen mens den går
  estimate: null, // beregnet tid (sekunder) for utkastet, fra serveren
  estimateFor: "", // hvilke filer estimatet gjelder (fil-ID-er)
  sending: false,
  sendings: [],
  limits: { maxFileMb: 50, maxFilesPerSending: 50 }, // fra /api/auth/me; serveren sjekker uansett
  fetchedAt: 0, // når listen sist ble hentet (etaSeconds/estimateSeconds gjelder fra da)
  statuses: new Map(), // fil-ID → status sist vi tegnet, for å merke overganger
  seen: null, // ferdige fil-ID-er hun har sett (localStorage)
  fresh: new Set(), // ferdige siden forrige besøk; fremheves så lenge siden er åpen
  pollTimer: 0,
  failures: 0,
};

// Brytes bare mellom delene i «Startet kl. 14:05 · Bokmål · 2 filer», ikke inni dem.
const nbsp = (text) => text.replace(/ /g, "\u00a0");
// «kl. 14:32» og «ca. 3 min» deles aldri over to linjer.
const at = (time) => `kl.\u00a0${formatClock(time)}`;
const dur = (seconds) => nbsp(formatDuration(seconds));

function say(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

function bar(percent, label) {
  const fillEl = h("span", { class: "bar-fill" });
  fillEl.style.width = `${percent}%`;
  return h("div", { class: "bar", role: "progressbar", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(percent)) }, fillEl);
}

const chosenLanguage = () => document.querySelector('input[name="lang"]:checked').value;
const isBusyUploading = () => state.queue.some((item) => item.status === "waiting" || item.status === "uploading");
const readyItems = () => state.queue.filter((item) => item.status === "ready");
// Hoppes over: serveren fant ingen tekst (skannet/skadet), eller filen ble avvist ved opplasting (for stor o.l.).
const isSkipped = (item) => item.status === "skip" || (item.status === "error" && item.permanent);
const isRetryable = (item) => item.status === "error" && !item.permanent;
const draftId = () => (state.draft ? state.draft.id : null);

// ---------- Til eierens logg (ingenting av dette vises på siden) ----------

// En feilmelding hun fikk se, ordrett.
function reportShown(where, message, { status, sendingId = draftId() } = {}) {
  if (!message) return;
  track("client.error_shown", `Feilmelding vist ${SHOWN_WHERE[where]}: «${message}»`, { where, message, status }, { sendingId });
}

// Filene nettleseren ikke tok med, med grunnen hun fikk se (og overskriften over listen).
function reportSkipped(skipped, headline, hints, harmless) {
  const files = Object.entries(skipped).flatMap(([reason, items]) => items.map(({ path, size }) => ({ name: baseName(path), size, reason })));
  const names = files.slice(0, 5).map((f) => f.name).join(", ") + (files.length > 5 ? ` og ${files.length - 5} til` : "");
  const reasons = Object.fromEntries(Object.keys(skipped).map((r) => [r, SKIP_TEXT[r]()]));
  track("client.file_rejected", `${headline} ${names}`, { headline, total: files.length, reasons, hints, files: files.slice(0, 40) },
    { sendingId: draftId(), level: harmless ? "info" : "warn" });
}

// En opplasting som ikke gikk: det hun så ved filen, eller at hun fjernet den underveis.
function reportUpload(item, draft, err) {
  const name = baseName(item.path);
  const removed = !state.queue.includes(item);
  const retry = !removed && (err.status === 404 || err.status === 409);
  const quiet = err.aborted || removed || retry;
  const text = err.aborted || removed
    ? `Opplastingen av ${name} ble avbrutt${removed ? " (fjernet fra listen)" : ""}`
    : `Opplastingen av ${name} feilet${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}${retry ? " – lastes opp på nytt i et nytt utkast" : ""}`;
  track("client.upload_failed", text, {
    name, size: item.file.size, status: err.status || 0, message: err.aborted ? null : err.message, aborted: Boolean(err.aborted), removed, retry,
  }, { sendingId: draft.id, level: quiet ? "info" : "warn" });
}

// ---------- Velge filer ----------

function skipReason(path, file, known) {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  if (name.startsWith("~$") || name.startsWith(".~lock")) return "lock";
  if (parts.some((p) => p.startsWith(".")) || /^(thumbs\.db|desktop\.ini)$/i.test(name)) return "hidden";
  if (!SUPPORTED.has(extOf(name))) return "type";
  if (file.size === 0) return "empty";
  if (file.size > state.limits.maxFileMb * 1024 * 1024) return "big";
  if (known.has(path.toLowerCase())) return "duplicate";
  if (known.size >= state.limits.maxFilesPerSending) return "many";
  return null;
}

// Filer som slippes mens oversettelsen startes, tas ikke med (siden sier ingenting; eieren får vite det).
function reportBusy(files) {
  if (!files.length) return;
  track("client.file_rejected", `${plural(files.length, "fil", "filer")} ble sluppet mens oversettelsen startet og ble ikke tatt med`, {
    total: files.length, reasons: { busy: "(ingen melding vist)" }, files: files.slice(0, 40).map((f) => ({ name: f.name, size: f.size, reason: "busy" })),
  }, { sendingId: draftId(), level: "info" });
}

function addFiles(entries) {
  if (state.sending) {
    reportBusy(entries.map((e) => e.file));
    return;
  }
  showCompose();
  const known = new Set(state.queue.map((item) => item.path.toLowerCase()));
  const skipped = {};
  let added = 0;
  for (const { file, path } of entries) {
    const reason = skipReason(path, file, known);
    if (reason) {
      (skipped[reason] ||= []).push({ path, size: file.size });
      continue;
    }
    known.add(path.toLowerCase());
    state.queue.push({ file, path, status: "waiting", pct: 0, error: "", permanent: false, fileId: null, info: null, abort: null, el: null });
    added++;
  }
  renderSkipped(skipped);
  say($("send-error"), "");
  renderQueue();
  // Filene lastes opp og ses gjennom med én gang, så hun får vite hvor lang tid det tar før hun trykker.
  if (added) pump();
}

function renderSkipped(skipped) {
  const box = $("skipped");
  const reasons = Object.keys(skipped);
  if (!reasons.length) {
    box.hidden = true;
    return;
  }
  const total = reasons.reduce((n, r) => n + skipped[r].length, 0);
  const names = (items) => {
    const list = items.map((item) => baseName(item.path));
    return list.slice(0, 3).join(", ") + (list.length > 3 ? ` og ${list.length - 3} til` : "");
  };
  const oldOffice = (skipped.type || []).some((item) => OLD_OFFICE.has(extOf(item.path)));
  const harmless = reasons.every((r) => HARMLESS.has(r));
  const headline = harmless
    ? `Vi hoppet over ${plural(total, "fil", "filer")} – det er helt i orden:`
    : `${total === 1 ? "Én fil" : `${total} filer`} ble ikke tatt med:`;
  const hints = [
    skipped.type ? "Dette kan oversettes: Word (.docx), PowerPoint (.pptx), Excel (.xlsx), PDF, tekst (.txt, .md, .csv), nettsider (.html) og RTF." : "",
    oldOffice ? "Har du en eldre Office-fil (.doc, .ppt eller .xls)? Åpne den, velg «Lagre som» og lagre den i det nye formatet (.docx, .pptx eller .xlsx)." : "",
  ].filter(Boolean);
  fill(box,
    h("button", { type: "button", class: "icon-btn notice-close", "aria-label": "Lukk meldingen", onclick: () => { box.hidden = true; } }, icon("close")),
    h("p", null, h("strong", null, headline)),
    h("ul", null, reasons.map((r) => h("li", null, SKIP_TEXT[r](), " ", h("span", { class: "muted" }, `(${names(skipped[r])})`)))),
    hints.map((hint) => h("p", null, hint))
  );
  box.hidden = false;
  reportSkipped(skipped, headline, hints, harmless);
}

const fromList = (list) => [...list].map((file) => ({ file, path: file.webkitRelativePath || file.name }));

// Mapper som slippes, leses rekursivt. Skjulte mapper (.git o.l.) hoppes over.
async function walk(entry, prefix, out) {
  if (entry.isFile) {
    try {
      out.push({ file: await new Promise((resolve, reject) => entry.file(resolve, reject)), path: prefix + entry.name });
    } catch {
      // Filen kunne ikke leses (for eksempel fjernet underveis) – hopp over den.
    }
    return;
  }
  if (!entry.isDirectory || entry.name.startsWith(".")) return;
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return;
    for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
  }
}

async function fromDrop(entries, files) {
  if (!entries.length) return fromList(files);
  const out = [];
  for (const entry of entries) await walk(entry, "", out);
  return out;
}

// ---------- Opplasting og gjennomgang (skjer med én gang filene er lagt til) ----------

async function ensureDraft() {
  if (state.draft) return state.draft;
  const note = $("note").value.trim();
  state.draft = (await api("/api/sendings", { method: "POST", body: { targetLanguage: chosenLanguage(), note: note || undefined } })).sending;
  return state.draft;
}

// reason=cleanup: nettsiden rydder selv (ikke et klikk fra henne), så eieren ser forskjellen i loggen.
function deleteServerFile(sendingId, fileId, reason = "user") {
  if (sendingId && fileId) api(`/api/sendings/${enc(sendingId)}/files/${enc(fileId)}?reason=${reason}`, { method: "DELETE" }).catch(() => {});
}

async function uploadItem(item) {
  const draft = state.draft;
  const controller = new AbortController();
  Object.assign(item, { status: "uploading", pct: 0, error: "", permanent: false, abort: controller });
  renderQueue();
  try {
    const url = `/api/sendings/${enc(draft.id)}/files?path=${enc(item.path)}`;
    const { file } = await upload(url, item.file, { signal: controller.signal, onProgress: (pct) => progressItem(item, pct) });
    if (!state.queue.includes(item) || state.draft !== draft) {
      // Fjernet (eller utkastet byttet) mens den ble lastet opp.
      deleteServerFile(draft.id, file.id, state.queue.includes(item) ? "cleanup" : "user");
      return;
    }
    // Serveren ser gjennom filen ved opplasting: «failed» betyr at den ikke kan oversettes (skannet, skadet).
    Object.assign(item, { status: file.status === "failed" ? "skip" : "ready", fileId: file.id, info: file });
  } catch (err) {
    reportUpload(item, draft, err);
    if (err.aborted || !state.queue.includes(item)) return;
    if (err.status === 404 || err.status === 409) {
      // Utkastet finnes ikke lenger, eller er startet et annet sted: begynn på et nytt.
      if (state.draft === draft) forgetDraft();
      item.status = "waiting";
      throw Object.assign(err, { gone: true });
    }
    Object.assign(item, { status: "error", error: err.message, permanent: PERMANENT.has(err.status) });
  } finally {
    item.abort = null;
    renderQueue();
  }
}

// Laster opp alle filene som venter, én om gangen. Kan kalles flere ganger; det går bare én kø.
function pump() {
  if (!state.pumping) {
    state.pumping = (async () => {
      await null; // state.pumping må være satt før køen kan bli ferdig (og nullstille den)
      let problem = "";
      let fresh = false;
      try {
        for (let guard = 0; guard < 1000; guard++) {
          const item = state.queue.find((i) => i.status === "waiting");
          if (!item) break;
          try {
            await ensureDraft();
            await uploadItem(item);
          } catch (err) {
            if (err.gone && !fresh) {
              fresh = true; // ett nytt utkast, og alt lastes opp dit
              continue;
            }
            // Fikk ikke laget utkastet: marker resten og prøv igjen når hun trykker.
            problem = err.message;
            for (const other of state.queue) {
              if (other.status === "waiting") Object.assign(other, { status: "error", error: err.message, permanent: false });
            }
            break;
          }
        }
      } finally {
        state.pumping = null;
        renderQueue();
      }
      if (!state.queue.length) dropEmptyDraft();
      else if (!problem) await refreshEstimate();
      return problem;
    })();
  }
  return state.pumping;
}

// Filer på utkastet som ikke er i listen (fjernet mens de ble lastet opp) skal ikke oversettes.
async function dropOrphans(draft, sending) {
  const known = new Set(state.queue.map((item) => item.fileId).filter(Boolean));
  const orphans = (sending.files || []).filter((f) => !known.has(f.id));
  await Promise.all(orphans.map((f) => api(`/api/sendings/${enc(draft.id)}/files/${enc(f.id)}?reason=cleanup`, { method: "DELETE" }).catch(() => {})));
  return orphans.length > 0;
}

// Beregnet tid for hele utkastet (serveren regner på filene som kan oversettes).
async function refreshEstimate() {
  const draft = state.draft;
  const key = readyItems().map((item) => item.fileId).join(",");
  if (!draft || isBusyUploading() || !key || key === state.estimateFor) return;
  try {
    let { sending } = await api(`/api/sendings/${enc(draft.id)}`);
    if (await dropOrphans(draft, sending)) ({ sending } = await api(`/api/sendings/${enc(draft.id)}`));
    if (state.draft !== draft) return;
    state.estimate = typeof sending.estimateSeconds === "number" ? sending.estimateSeconds : null;
    state.estimateFor = key;
    // Oppdater radene med serverens tekst (f.eks. «Klar – ca. 2 min»).
    const byId = new Map((sending.files || []).map((f) => [f.id, f]));
    for (const item of state.queue) if (byId.has(item.fileId)) item.info = byId.get(item.fileId);
  } catch {
    state.estimate = null; // estimatet er bare til hjelp; oversettelsen kan startes uansett
  }
  renderQueue();
}

function forgetDraft() {
  state.draft = null;
  state.estimate = null;
  state.estimateFor = "";
  for (const item of state.queue) {
    if (item.abort) item.abort.abort();
    Object.assign(item, { fileId: null, info: null, status: "waiting", error: "", permanent: false, pct: 0 });
  }
}

// Tomt utkast: rydd bort, så det ikke blir liggende.
function dropEmptyDraft() {
  if (state.queue.length || !state.draft || state.pumping) return;
  api(`/api/sendings/${enc(state.draft.id)}?reason=cleanup`, { method: "DELETE" }).catch(() => {});
  forgetDraft();
}

function removeItem(item) {
  state.queue = state.queue.filter((other) => other !== item);
  // Er hele filen sendt, lagrer serveren den uansett: la den bli ferdig og slett den da (se uploadItem).
  if (item.abort && item.pct < 100) item.abort.abort();
  else if (item.fileId && state.draft) deleteServerFile(state.draft.id, item.fileId);
  say($("send-error"), "");
  dropEmptyDraft();
  renderQueue();
  refreshEstimate();
  $(state.queue.length ? "btn-send" : "btn-files").focus();
}

function retryItem(item) {
  Object.assign(item, { status: "waiting", error: "", permanent: false });
  say($("send-error"), "");
  renderQueue();
  pump();
}

function queueStatus(item) {
  switch (item.status) {
    case "waiting":
      return `Venter · ${formatBytes(item.file.size)}`;
    case "uploading":
      return item.pct >= 100 ? "Ser gjennom filen …" : `Laster opp … ${item.pct} %`;
    case "ready":
      return [icon("check"), (item.info && item.info.statusText) || "Klar"];
    case "skip":
      return (item.info && item.info.statusText) || "Denne filen kan ikke oversettes.";
    default:
      return item.error;
  }
}

function queueRow(item) {
  const name = baseName(item.path);
  const lock = state.sending;
  const skipped = isSkipped(item);
  const remove = skipped
    ? h("button", { type: "button", class: "btn-quiet q-action", "aria-label": `Fjern ${name}`, disabled: lock, onclick: () => removeItem(item) }, icon("close"), "Fjern fra listen")
    : h("button", { type: "button", class: "icon-btn", "aria-label": `Fjern ${name}`, disabled: lock, onclick: () => removeItem(item) }, icon("close"));
  return h("li", { class: `q q-${item.status}${skipped ? " is-skipped" : ""}` },
    extBadge(name),
    h("div", { class: "q-main" },
      h("p", { class: "q-name" }, dirName(item.path) ? h("span", { class: "q-dir" }, dirName(item.path)) : null, name),
      h("p", { class: "q-meta" }, queueStatus(item)),
      skipped ? [h("p", { class: "q-hint" }, "Denne filen blir hoppet over. De andre oversettes som vanlig."), remove] : null,
      isRetryable(item)
        ? h("button", { type: "button", class: "btn-quiet q-action", disabled: lock, onclick: () => retryItem(item) }, icon("refresh"), "Prøv igjen")
        : null,
      item.status === "uploading" ? bar(item.pct, `Opplasting av ${name}`) : null
    ),
    skipped ? null : remove
  );
}

function renderQueue() {
  fill($("queue"), state.queue.map((item) => {
    item.el = queueRow(item);
    return item.el;
  }));
  $("compose-more").hidden = !state.queue.length;
  renderSummary();
}

// «Beregnet tid» over hovedknappen, og om knappen kan trykkes.
function renderSummary() {
  const box = $("summary");
  const button = $("btn-send");
  const ready = readyItems();
  const skipped = state.queue.filter(isSkipped).length;
  const retryable = state.queue.some(isRetryable);
  const busy = isBusyUploading();
  const lang = (LANGUAGE_LABELS[chosenLanguage()] || "").toLowerCase();
  button.disabled = state.sending || !state.queue.length || (!busy && !ready.length && !retryable);
  if (state.sending) return;
  button.textContent = "Oversett til norsk";
  if (!state.queue.length) {
    fill(box);
    return;
  }
  if (busy) {
    fill(box, h("p", { class: "estimate-wait" }, h("span", { class: "spinner", "aria-hidden": "true" }), "Laster opp og ser gjennom filene …"));
    return;
  }
  if (!ready.length) {
    fill(box, retryable
      ? h("p", { class: "estimate-sub" }, "Noen filer ble ikke lastet opp. Trykk «Prøv igjen» ved filen, eller på knappen under.")
      : h("p", { class: "estimate-sub" }, "Ingen av filene kan oversettes. Legg til andre filer."));
    return;
  }
  const seconds = state.estimate != null && state.estimateFor === ready.map((item) => item.fileId).join(",")
    ? state.estimate
    : sumEstimates(ready);
  const parts = [`${plural(ready.length, "fil", "filer")} blir oversatt til ${lang}`];
  if (skipped) parts.push(`${skipped} hoppes over`);
  if (retryable) parts.push("noen er ikke lastet opp ennå");
  fill(box,
    seconds != null
      ? h("p", { class: "estimate-time" }, icon("clock"), h("span", null, "Beregnet tid: ", h("strong", null, dur(seconds))))
      : null,
    h("p", { class: "estimate-sub" }, parts.map(nbsp).join(" · ")));
}

// Reserve hvis serveren ikke gir et samlet estimat: summen av filenes egne.
function sumEstimates(items) {
  const values = items.map((item) => item.info && item.info.estimateSeconds);
  return values.length && values.every((v) => typeof v === "number") ? values.reduce((a, b) => a + b, 0) : null;
}

function progressItem(item, pct) {
  item.pct = pct;
  if (!item.el) return;
  item.el.querySelector(".q-meta").textContent = queueStatus(item);
  const barEl = item.el.querySelector(".bar");
  if (!barEl) return;
  barEl.setAttribute("aria-valuenow", String(pct));
  barEl.firstChild.style.width = `${pct}%`;
}

// ---------- Starte oversettelsen ----------

function setSending(on, label = "Starter oversettelsen …") {
  state.sending = on;
  const button = $("btn-send");
  button.classList.toggle("is-busy", on);
  for (const id of ["btn-files", "btn-folder", "note"]) $(id).disabled = on;
  for (const radio of document.querySelectorAll('input[name="lang"]')) radio.disabled = on;
  $("drop").classList.toggle("is-disabled", on);
  renderQueue();
  if (on) button.textContent = label;
}

// Laster opp det som mangler (også filer som feilet på grunn av nettet). Gir en feilmelding eller "".
async function uploadRest() {
  for (const item of state.queue) {
    if (isRetryable(item)) Object.assign(item, { status: "waiting", error: "" });
  }
  if (isBusyUploading()) setSending(true, "Laster opp …");
  let problem = await pump();
  // Kom det nye filer til mens køen gikk, tas de også.
  for (let round = 0; round < 5 && !problem && state.queue.some((item) => item.status === "waiting"); round++) problem = await pump();
  setSending(true);
  const failed = state.queue.filter(isRetryable).length;
  if (problem) return `${problem} Trykk «Oversett til norsk» for å prøve igjen.`;
  if (failed) return `${failed === 1 ? "Én fil" : `${failed} filer`} kunne ikke lastes opp (se listen over). Fjern ${failed === 1 ? "den" : "dem"}, eller trykk «Oversett til norsk» for å prøve igjen.`;
  if (!readyItems().length) return "Ingen av filene kan oversettes. Legg til andre filer.";
  return "";
}

// Språket ble valgt etter at filene var lastet opp. Serveren som kan bytte språk på utkastet, gjør det
// sammen med meldingen; ellers lages et nytt utkast og filene lastes opp på nytt.
async function matchLanguage(targetLanguage, note) {
  if (state.draft.targetLanguage === targetLanguage) return true;
  const draft = state.draft;
  const res = await api(`/api/sendings/${enc(draft.id)}/note`, { method: "POST", body: { note, targetLanguage } });
  if (res && res.sending && res.sending.targetLanguage === targetLanguage) {
    Object.assign(draft, { targetLanguage, note });
    return true;
  }
  await api(`/api/sendings/${enc(draft.id)}?reason=language`, { method: "DELETE" }).catch(() => {});
  forgetDraft();
  return false;
}

async function send() {
  if (state.sending || !state.queue.length) return;
  const error = $("send-error");
  say(error, "");
  error.classList.remove("is-soft");
  setSending(true);
  try {
    const targetLanguage = chosenLanguage();
    const note = $("note").value.trim();
    let problem = await uploadRest();
    if (!problem && !(await matchLanguage(targetLanguage, note))) problem = await uploadRest();
    if (problem) {
      showSendError({ message: problem, status: -1 });
      return;
    }
    if ((state.draft.note || "") !== note) {
      await api(`/api/sendings/${enc(state.draft.id)}/note`, { method: "POST", body: { note } });
      state.draft.note = note;
    }
    await dropOrphans(state.draft, (await api(`/api/sendings/${enc(state.draft.id)}`)).sending);
    const { sending } = await api(`/api/sendings/${enc(state.draft.id)}/send`, { method: "POST" });
    showStarted(sending);
  } catch (err) {
    if (err.status === 404) forgetDraft();
    showSendError(err);
  } finally {
    setSending(false);
  }
}

function showSendError(err) {
  const box = $("send-error");
  // 503: oversettelsen er ikke satt opp ennå. Ingen feil hos henne – filene ligger trygt og kan startes senere.
  const soft = err.status === 503;
  const extra = soft
    ? "Filene dine er lagret, så du kan prøve igjen senere – også om du lukker siden i mellomtiden."
    : err.status === -1 ? "" : "Trykk «Oversett til norsk» for å prøve igjen – det som allerede er lastet opp, lastes ikke opp på nytt.";
  box.classList.toggle("is-soft", soft);
  fill(box, h("p", null, err.message), extra ? h("p", null, extra) : null);
  box.hidden = false;
  reportShown("send", [err.message, extra].filter(Boolean).join(" "), { status: err.status });
  if (soft) refresh();
}

function showStarted(sending) {
  const files = sending.files || [];
  const skipped = files.filter((f) => f.status === "failed").length + state.queue.filter((item) => item.status === "error").length;
  state.queue = [];
  state.draft = null;
  state.estimate = null;
  state.estimateFor = "";
  $("note").value = "";
  $("skipped").hidden = true;
  $("send-error").hidden = true;
  renderQueue();
  const seconds = typeof sending.estimateSeconds === "number" ? sending.estimateSeconds : null;
  say($("thanks-lead"), seconds != null
    ? `Beregnet tid: ${dur(seconds)} – ferdig rundt ${at(Date.now() + seconds * 1000)}.`
    : "");
  say($("thanks-skipped"), skipped
    ? `${skipped === 1 ? "Én fil" : `${skipped} filer`} kunne ikke oversettes og ble hoppet over.`
    : "");
  $("compose").hidden = true;
  $("thanks").hidden = false;
  $("thanks-title").focus();
  refresh();
}

function showCompose() {
  if ($("compose").hidden) {
    $("thanks").hidden = true;
    $("compose").hidden = false;
  }
}

// ---------- Mine filer ----------

// etaSeconds er gjenstående tid da listen ble hentet.
function etaText(progress) {
  if (!progress || progress.etaSeconds == null) return "Beregner hvor lang tid det tar …";
  const finish = state.fetchedAt + progress.etaSeconds * 1000;
  const left = (finish - Date.now()) / 1000;
  if (left < 20) return "Straks ferdig …";
  return `${dur(left)} igjen – ferdig rundt ${at(finish)}`;
}

// Kort tekst i pillen; en eventuell forklaring vises under.
function pillParts(file, percent) {
  const text = file.statusText || "";
  switch (file.status) {
    case "working":
      return [file.progress ? `Oversettes nå – ${percent} %` : "Oversettes nå", ""];
    case "done":
      return ["Ferdig", ""];
    case "failed":
      // «Kunne ikke oversettes. Jens har fått beskjed.» eller en grunn («Denne PDF-en er et bilde …»).
      return ["Ikke oversatt", text.replace(/^Kunne ikke oversettes\.?\s*/, "")];
    case "sent":
      return [text || "I kø – starter straks", ""];
    default:
      return [text || "Ikke startet", ""];
  }
}

function fileRow(file) {
  const fresh = state.fresh.has(file.id);
  const known = state.statuses.has(file.id);
  const percent = file.progress ? Math.max(0, Math.min(100, Math.round(file.progress.percent || 0))) : 0;
  const [pill, detail] = pillParts(file, percent);
  const outName = file.outputName || file.name;
  return h("li", { class: `row row-${file.status}${fresh ? " is-new" : ""}${known ? "" : " appear"}`, id: `file-${file.id}` },
    extBadge(file.name),
    h("div", { class: "row-main" },
      h("p", { class: "row-name" },
        dirName(file.path || "") ? h("span", { class: "q-dir" }, dirName(file.path)) : null,
        file.name,
        fresh ? h("span", { class: "new-tag" }, "Ny") : null),
      h("p", { class: "row-status" },
        h("span", { class: `pill pill-${file.status}` }, h("span", { class: "dot", "aria-hidden": "true" }), pill),
        file.status === "done" && file.finishedAt
          ? h("span", { class: "row-detail" }, `${at(file.finishedAt)}${file.outputBytes ? ` · ${nbsp(formatBytes(file.outputBytes))}` : ""}`)
          : null
      ),
      detail ? h("p", { class: "row-why" }, detail) : null,
      file.status === "working" ? [bar(percent, `Fremdrift for ${file.name}`), h("p", { class: "row-eta" }, etaText(file.progress))] : null
    ),
    file.status === "done"
      ? h("div", { class: "row-actions" },
        h("a", { class: "btn btn-primary btn-download", href: `/api/files/${enc(file.id)}/result`, download: "", "data-key": `dl-${file.id}`, "aria-label": `Last ned ${outName}` }, icon("download"), "Last ned"),
        h("a", { class: "link-small", href: `/api/files/${enc(file.id)}/original`, download: "", "data-key": `og-${file.id}`, "aria-label": `Original: ${file.name}` }, "Original"))
      : null
  );
}

// Når flere filer er underveis: når blir hele sendingen ferdig?
function sendingEta(s) {
  const active = s.files.filter((f) => ACTIVE.has(f.status));
  if (s.status === "draft" || typeof s.estimateSeconds !== "number" || !active.length) return null;
  if (active.length < 2 && active[0].status === "working") return null; // filens egen linje sier det samme
  const finish = state.fetchedAt + s.estimateSeconds * 1000;
  const left = (finish - Date.now()) / 1000;
  return h("p", { class: "sending-eta" }, icon("clock"),
    left < 20 ? "Straks ferdig …" : `Alt er ferdig rundt ${at(finish)} (${dur(left)})`);
}

function sendingBlock(s) {
  const lang = LANGUAGE_LABELS[s.targetLanguage] || "";
  const when = s.status === "draft" ? "Ikke startet" : `Startet kl. ${formatClock(s.sentAt || s.createdAt)}`;
  return h("article", { class: "sending" },
    h("div", { class: "sending-head" },
      h("p", { class: "sending-meta" }, [when, lang, plural(s.files.length, "fil", "filer")].filter(Boolean).map(nbsp).join(" · ")),
      h("button", { type: "button", class: "btn-quiet", "data-key": `del-${s.id}`, onclick: () => removeSending(s) }, icon("trash"), "Slett")
    ),
    s.note ? h("p", { class: "my-note" }, h("span", { class: "muted" }, "Din melding: "), `«${s.note}»`) : null,
    s.status === "draft"
      ? s.files.some((f) => f.status === "draft")
        ? h("div", { class: "draft-box" },
          h("p", null, "Disse filene er ikke oversatt ennå – kanskje ble siden lukket underveis."),
          h("button", { type: "button", class: "btn btn-primary btn-small", "data-key": `send-${s.id}`, onclick: (e) => sendDraft(s, e.currentTarget) }, "Oversett nå"))
        : h("div", { class: "draft-box" }, h("p", null, "Ingen av disse filene kan oversettes. Du kan slette dem."))
      : null,
    sendingEta(s),
    h("ul", { class: "rows" }, s.files.map(fileRow)),
    s.reply
      ? h("div", { class: "reply" },
        h("p", { class: "reply-from" }, icon("heart"), `Hilsen fra ${state.translator}`),
        h("p", { class: "reply-text" }, s.reply))
      : null
  );
}

function renderMine() {
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
  const time = (s) => Date.parse(s.sentAt || s.createdAt) || 0;
  const list = state.sendings
    .filter((s) => s.files.length && !(state.draft && s.id === state.draft.id))
    .sort((a, b) => time(b) - time(a));
  if (!list.length) {
    fill($("groups"), h("div", { class: "empty" },
      h("img", { src: "/img/te.svg", alt: "", width: 160, height: 128 }),
      h("p", null, "Her dukker oversettelsene opp."),
      h("p", { class: "muted" }, "Når du har startet en oversettelse, kan du følge med her og laste ned når den er ferdig.")));
  } else {
    const days = new Map();
    for (const s of list) {
      const day = dayLabel(s.sentAt || s.createdAt);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(s);
    }
    fill($("groups"), [...days].map(([day, items]) => h("section", { class: "day" },
      h("h3", { class: "day-title" }, day),
      items.map(sendingBlock))));
  }
  if (focused) {
    const again = document.querySelector(`[data-key="${CSS.escape(focused)}"]`);
    if (again) again.focus();
  }
}

// Ferdige filer: velkommen-tilbake, «(1 klar)» i fanen og opplesning for skjermleser.
function trackDone() {
  const files = state.sendings.flatMap((s) => s.files);
  const done = files.filter((f) => f.status === "done");
  if (!state.seen) {
    let stored = null;
    try {
      stored = JSON.parse(recall(SEEN_KEY));
    } catch {
      // Ødelagt verdi: behandles som første besøk.
    }
    state.seen = new Set(Array.isArray(stored) ? stored : done.map((f) => f.id));
    const fresh = done.filter((f) => !state.seen.has(f.id));
    if (fresh.length) {
      $("welcome-text").textContent = `${plural(fresh.length, "fil", "filer")} er ferdig oversatt siden sist.`;
      $("welcome").hidden = false;
    }
  }
  const finishedNow = done.filter((f) => state.statuses.has(f.id) && state.statuses.get(f.id) !== "done");
  if (finishedNow.length) {
    $("announce").textContent = finishedNow.length === 1
      ? `${finishedNow[0].name} er ferdig oversatt.`
      : `${finishedNow.length} filer er ferdig oversatt.`;
  }
  for (const f of done) if (!state.seen.has(f.id)) state.fresh.add(f.id);
  if (!document.hidden) {
    state.seen = new Set(done.map((f) => f.id));
    remember(SEEN_KEY, JSON.stringify([...state.seen]));
  }
  const ready = done.filter((f) => !state.seen.has(f.id)).length;
  document.title = ready ? `(${ready} ${ready === 1 ? "klar" : "klare"}) Oversetter` : "Oversetter";
}

function schedule() {
  clearTimeout(state.pollTimer);
  const busy = state.sendings.some((s) => s.status !== "draft" && s.files.some((f) => ACTIVE.has(f.status)));
  let delay = busy ? 5000 : 30000;
  if (document.hidden) delay = busy ? 60000 : 0; // i bakgrunnen: bare sjekk sakte om noe er underveis
  if (state.failures) delay = Math.min(60000, 5000 * 2 ** state.failures);
  if (delay) state.pollTimer = setTimeout(refresh, delay);
}

async function refresh() {
  clearTimeout(state.pollTimer);
  try {
    const { sendings } = await api("/api/sendings");
    state.fetchedAt = Date.now();
    state.sendings = sendings || [];
    state.failures = 0;
    $("mine-error").hidden = true;
    trackDone();
    renderMine();
    state.statuses = new Map(state.sendings.flatMap((s) => s.files).map((f) => [f.id, f.status]));
  } catch (err) {
    state.failures++;
    if (err.status !== 401) {
      const message = "Fikk ikke hentet filene dine akkurat nå. Vi prøver igjen av oss selv.";
      // Bare første gang meldingen dukker opp, ikke for hvert nye forsøk.
      if ($("mine-error").hidden) reportShown("mine", message, { status: err.status, sendingId: null });
      fill($("mine-error"), h("p", null, message));
      $("mine-error").hidden = false;
    }
  }
  schedule();
}

async function removeSending(s) {
  const ok = await confirmDialog({
    title: "Slette disse filene?",
    text: `${plural(s.files.length, "fil", "filer")} og oversettelsene fjernes fra «Mine filer». Det kan ikke angres.`,
    confirm: "Ja, slett",
    cancel: "Nei, behold",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/sendings/${enc(s.id)}`, { method: "DELETE" });
    state.sendings = state.sendings.filter((other) => other.id !== s.id);
    renderMine();
    toast("Filene er slettet.");
    $("mine").focus();
  } catch (err) {
    toast(err.message);
    reportShown("toast", err.message, { status: err.status, sendingId: s.id });
  }
}

async function sendDraft(s, button) {
  button.disabled = true;
  try {
    await api(`/api/sendings/${enc(s.id)}/send`, { method: "POST" });
    toast("Oversettelsen er i gang.");
    refresh();
  } catch (err) {
    toast(err.message);
    reportShown("toast", err.message, { status: err.status, sendingId: s.id });
    button.disabled = false;
  }
}

// ---------- Passord ----------

function openPassword(forced) {
  const dialog = $("pw-dialog");
  $("pw-form").reset();
  for (const id of ["pw-current", "pw-new", "pw-repeat"]) $(id).type = "password";
  say($("pw-error"), "");
  $("pw-lead").hidden = !forced;
  $("pw-close").hidden = forced;
  dialog.dataset.forced = forced ? "1" : "";
  dialog.showModal();
  $("pw-current").focus();
}

$("pw-dialog").addEventListener("cancel", (e) => {
  if (e.currentTarget.dataset.forced) e.preventDefault();
});
$("pw-close").addEventListener("click", () => $("pw-dialog").close());
$("pw-show").addEventListener("change", (e) => {
  for (const id of ["pw-current", "pw-new", "pw-repeat"]) $(id).type = e.target.checked ? "text" : "password";
});
$("pw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const current = $("pw-current").value;
  const next = $("pw-new").value;
  const error = $("pw-error");
  const problem = current ? passwordProblem(next, $("pw-repeat").value, current) : "Skriv inn passordet du bruker nå.";
  say(error, problem);
  reportShown("password", problem, { sendingId: null });
  if (problem) return;
  const button = $("pw-save");
  button.disabled = true;
  button.textContent = "Lagrer …";
  try {
    await changePassword({ username: state.me.username, current, next });
    state.me.mustChangePassword = false;
    $("pw-dialog").close();
    toast("Passordet er byttet.");
  } catch (err) {
    say(error, err.message);
    reportShown("password", err.message, { status: err.status, sendingId: null });
  }
  button.disabled = false;
  button.textContent = "Lagre nytt passord";
});

// ---------- Oppstart og hendelser ----------

function personalize({ user, translatorName, limits }) {
  state.me = user;
  if (limits) Object.assign(state.limits, limits);
  $("drop-help").textContent = `Word, PowerPoint, Excel, PDF og tekstfiler, opptil ${state.limits.maxFileMb} MB per fil. Du kan også slippe en hel mappe.`;
  const t = translatorName || "oversetteren";
  state.translator = t;
  $("hello").textContent = `Hei, ${user.displayName || user.username}!`;
  $("note-label").textContent = `Melding til ${t} (valgfritt)`;
  $("admin-link").hidden = user.role !== "admin";
}

$("btn-files").addEventListener("click", () => $("input-files").click());
$("btn-folder").addEventListener("click", () => $("input-folder").click());
for (const id of ["input-files", "input-folder"]) {
  $(id).addEventListener("change", (e) => {
    addFiles(fromList(e.target.files));
    e.target.value = "";
  });
}
$("drop").addEventListener("click", (e) => {
  if (!e.target.closest("button") && !state.sending) $("input-files").click();
});

// Slipp filer hvor som helst på siden; slippsonen lyser opp mens man drar.
let dragDepth = 0;
const hasFiles = (e) => Boolean(e.dataTransfer) && Array.from(e.dataTransfer.types).includes("Files");
const dragging = (on) => $("drop").classList.toggle("is-over", on);
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dragging(true);
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dragging(false);
});
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = state.sending ? "none" : "copy";
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dragging(false);
  if (state.sending) {
    reportBusy([...e.dataTransfer.files]);
    return;
  }
  // Oppføringene må hentes før første await; etterpå er de borte.
  const entries = [...e.dataTransfer.items]
    .filter((item) => item.kind === "file" && item.webkitGetAsEntry)
    .map((item) => item.webkitGetAsEntry())
    .filter(Boolean);
  fromDrop(entries, [...e.dataTransfer.files]).then(addFiles);
});

const savedLang = recall(LANG_KEY);
for (const radio of document.querySelectorAll('input[name="lang"]')) {
  radio.checked = radio.value === (savedLang === "nynorsk" ? "nynorsk" : "bokmal");
  radio.addEventListener("change", () => {
    remember(LANG_KEY, radio.value);
    renderSummary();
  });
}

$("btn-send").addEventListener("click", send);
$("btn-more").addEventListener("click", () => {
  showCompose();
  $("btn-files").focus();
});
$("btn-password").addEventListener("click", () => openPassword(false));
$("btn-logout").addEventListener("click", logout);
$("welcome-close").addEventListener("click", () => {
  $("welcome").hidden = true;
});
$("welcome-go").addEventListener("click", (e) => {
  const first = document.querySelector(".row.is-new");
  if (!first) return;
  e.preventDefault();
  first.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  const link = first.querySelector(".btn-download");
  if (link) link.focus({ preventScroll: true });
});

window.addEventListener("beforeunload", (e) => {
  if (state.sending || isBusyUploading()) e.preventDefault();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) schedule();
  else refresh();
});

api("/api/auth/me").then((me) => {
  personalize(me);
  trackPage();
  renderQueue();
  if (me.user.mustChangePassword) openPassword(true);
  refresh();
}).catch((err) => {
  if (err.status === 401) return;
  fill($("mine-error"), h("p", null, err.message));
  $("mine-error").hidden = false;
  reportShown("start", err.message, { status: err.status, sendingId: null });
});
