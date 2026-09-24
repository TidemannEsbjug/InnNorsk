import {
  api, upload, h, fill, icon, formatDuration, formatClock, formatDay, formatBytes, plural, relativeTime,
  startOfDay, LANGUAGE_LABELS, remember, recall, confirmDialog, toast, logout, reportErrors,
} from "./api.js";

reportErrors();

const SUPPORTED = [".docx", ".pptx", ".xlsx", ".pdf", ".txt", ".md", ".csv", ".html", ".htm", ".rtf"];
const ACTIVE = new Set(["queued", "running"]);
const TITLE = "InnNorsk";
const LAST_VISIT = "innnorsk.lastVisit";
const LANGUAGE = "innnorsk.language";

const SKIP_REASONS = {
  lock: "Midlertidige filer fra Word eller Office (navnet starter med ~$). De lages automatisk og er ikke ekte dokumenter.",
  hidden: "Skjulte filer og systemfiler.",
  type: "Filtyper som ikke kan oversettes.",
  empty: "Tomme filer.",
  duplicate: "Filer du allerede har lagt til.",
  big: () => `Filer som er større enn ${state.limits.maxFileMb} MB.`,
  many: () => `Flere enn ${state.limits.maxFilesPerJob} dokumenter på en gang. Oversett gjerne resten etterpå.`,
};

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const smooth = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

const state = {
  lang: recall(LANGUAGE) === "nynorsk" ? "nynorsk" : "bokmal",
  gen: 0, // økes når utkastet forkastes, så svar fra gamle opplastinger ignoreres
  job: null,
  files: [],
  sources: new Map(), // fileId → lokal fil, så filene kan lastes opp på nytt hvis språket byttes
  uploads: [], // { file, path, status: "waiting" | "uploading" | "error", pct, error, controller }
  creating: null,
  pumping: false,
  view: "setup",
  seq: 0,
  applied: 0,
  polling: false,
  pollTimer: 0,
  tickTimer: 0,
  lastOk: 0,
  failures: 0,
  notify: false,
  spoken: "",
  documents: [],
  lastVisit: recall(LAST_VISIT),
  limits: { maxFileMb: 30, maxFilesPerJob: 100 }, // oppdateres fra serveren ved oppstart
};

// ---------- Små hjelpere ----------

function baseName(path) {
  return String(path || "").slice(String(path || "").lastIndexOf("/") + 1);
}

function dirName(path) {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i + 1) : "";
}

function extOf(name) {
  const base = baseName(name);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

const jobUrl = (id, rest = "") => `/api/jobs/${enc(id)}${rest}`;
const fileUrl = (jobId, fileId, rest = "") => jobUrl(jobId, `/files/${enc(fileId)}${rest}`);
const langName = (lang) => (LANGUAGE_LABELS[lang] || "norsk").toLowerCase();

function showAlert(message) {
  fill($("alert"), message ? h("p", null, message) : null);
  $("alert").hidden = !message;
}

function extBadge(name) {
  const ext = extOf(name).slice(1);
  return h("span", { class: `ext ext-${ext || "fil"}`, "aria-hidden": "true" }, ext.toUpperCase() || "FIL");
}

function nameLine(path) {
  return h("p", { class: "file-name" },
    dirName(path) ? h("span", { class: "file-dir" }, dirName(path)) : null,
    baseName(path)
  );
}

function removeButton(name, onclick) {
  return h("button", { type: "button", class: "icon-btn", "aria-label": `Fjern ${name}`, title: "Fjern", onclick }, icon("close"));
}

function groupBy(list, keyOf) {
  const groups = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

// ---------- Steg 1: legge til filer ----------

function skipReason(path, file, known) {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  if (name.startsWith("~$") || name.startsWith(".~lock")) return "lock";
  if (parts.some((p) => p.startsWith(".")) || /^(thumbs\.db|desktop\.ini)$/i.test(name)) return "hidden";
  if (!SUPPORTED.includes(extOf(name))) return "type";
  if (file.size === 0) return "empty";
  if (file.size > state.limits.maxFileMb * 1024 * 1024) return "big";
  if (known.has(path.toLowerCase())) return "duplicate";
  if (known.size >= state.limits.maxFilesPerJob) return "many";
  return null;
}

const newUpload = (file, path) => ({ file, path, status: "waiting", pct: 0, error: "" });

function addEntries(entries) {
  showAlert("");
  const known = new Set([...state.files, ...state.uploads].map((f) => f.path.toLowerCase()));
  const skipped = {};
  let added = 0;
  for (const { file, path } of entries) {
    const reason = skipReason(path, file, known);
    if (reason) {
      (skipped[reason] ||= []).push(path);
      continue;
    }
    known.add(path.toLowerCase());
    state.uploads.push(newUpload(file, path));
    added++;
  }
  renderSkipped(skipped, added);
  renderSetup();
  pump();
}

function renderSkipped(skipped, added) {
  const box = $("skipped");
  const reasons = Object.keys(skipped);
  if (!reasons.length) {
    box.hidden = true;
    return;
  }
  const total = reasons.reduce((n, r) => n + skipped[r].length, 0);
  const names = (paths) => {
    const list = paths.map(baseName);
    return list.slice(0, 4).join(", ") + (list.length > 4 ? ` og ${list.length - 4} til` : "");
  };
  fill(box,
    h("button", { type: "button", class: "icon-btn notice-close", "aria-label": "Lukk meldingen", onclick: () => { box.hidden = true; } }, icon("close")),
    h("p", null,
      h("strong", null, total === 1 ? "Én fil ble ikke lagt til." : `${total} filer ble ikke lagt til.`),
      added ? " Resten er lagt til som vanlig." : ""),
    h("ul", null, reasons.map((r) => {
      const why = typeof SKIP_REASONS[r] === "function" ? SKIP_REASONS[r]() : SKIP_REASONS[r];
      return h("li", null, why, " ", h("span", { class: "muted" }, names(skipped[r])));
    })),
    skipped.type ? h("p", { class: "muted" }, "Dette kan oversettes: Word (.docx), PowerPoint (.pptx), Excel (.xlsx), PDF, tekstfiler (.txt, .md, .csv), nettsider (.html) og RTF.") : null
  );
  box.hidden = false;
}

function fromFileList(list) {
  return [...list].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

async function entriesFromDrop(dataTransfer) {
  // webkitGetAsEntry må hentes før første await, ellers er listen tømt.
  const roots = [...dataTransfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry())
    .filter(Boolean);
  if (!roots.length) return fromFileList(dataTransfer.files);
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path: entry.fullPath.replace(/^\/+/, "") });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const root of roots) await walk(root);
  return out;
}

// ---------- Opplasting ----------

function discardJob(id) {
  api(jobUrl(id), { method: "DELETE" }).catch(() => {});
}

// Utkastet lages først når den første filen lastes opp, med språket som er valgt da.
function ensureJob() {
  if (state.job) return Promise.resolve(state.job);
  if (!state.creating) {
    const gen = state.gen;
    state.creating = api("/api/jobs", { method: "POST", body: { targetLanguage: state.lang } }).then(({ job }) => {
      if (gen !== state.gen) {
        discardJob(job.id);
        throw new DOMException("Utdatert", "AbortError");
      }
      state.job = job;
      state.creating = null;
      return job;
    }, (err) => {
      if (gen === state.gen) state.creating = null;
      throw err;
    });
  }
  return state.creating;
}

function dropUpload(item) {
  const i = state.uploads.indexOf(item);
  if (i >= 0) state.uploads.splice(i, 1);
}

function showUploadProgress(item, pct) {
  item.pct = pct;
  if (item.fill) item.fill.style.width = `${pct}%`;
  if (item.label) item.label.textContent = uploadText(item);
}

async function pump() {
  if (state.pumping) return;
  state.pumping = true;
  let item;
  while ((item = state.uploads.find((u) => u.status === "waiting"))) {
    const gen = state.gen;
    item.status = "uploading";
    item.pct = 0;
    item.controller = new AbortController();
    renderSetup();
    try {
      const job = await ensureJob();
      const url = `${jobUrl(job.id, "/files")}?path=${enc(item.path)}`;
      const current = item;
      const { file } = await upload(url, item.file, { signal: item.controller.signal, onProgress: (pct) => showUploadProgress(current, pct) });
      if (gen === state.gen) {
        state.files.push(file);
        state.sources.set(file.id, item.file);
        dropUpload(item);
      }
    } catch (err) {
      if (err.name === "AbortError") dropUpload(item);
      else Object.assign(item, { status: "error", error: err.message });
    }
    item.controller = null;
    renderSetup();
  }
  state.pumping = false;
  renderSetup();
}

// Glemmer utkastet (og sletter det på serveren). Filene på maskinen din blir ikke berørt.
function resetDraft() {
  state.gen++;
  for (const u of state.uploads) if (u.controller) u.controller.abort();
  if (state.job && state.job.status === "draft") discardJob(state.job.id);
  state.job = null;
  state.files = [];
  state.sources.clear();
  state.creating = null;
}

function removeUpload(item) {
  if (item.controller) item.controller.abort();
  else dropUpload(item);
  renderSetup();
}

function retryUpload(item) {
  Object.assign(item, { status: "waiting", error: "" });
  renderSetup();
  pump();
}

async function removeFile(file, button) {
  button.disabled = true;
  try {
    await api(fileUrl(state.job.id, file.id), { method: "DELETE" });
    state.files = state.files.filter((f) => f !== file);
    state.sources.delete(file.id);
  } catch (err) {
    showAlert(`Klarte ikke å fjerne ${file.name}. ${err.message}`);
  }
  renderSetup();
}

async function clearAll() {
  const ok = await confirmDialog({
    title: "Fjerne alle dokumentene fra listen?",
    text: "Originalene på maskinen din blir ikke berørt.",
    confirm: "Ja, fjern alle",
    cancel: "Nei",
  });
  if (!ok) return;
  resetDraft();
  state.uploads = [];
  $("skipped").hidden = true;
  renderSetup();
  $("btn-files").focus();
}

// ---------- Steg 2: språk ----------

function chooseLanguage(lang) {
  if (lang === state.lang) return;
  state.lang = lang;
  remember(LANGUAGE, lang);
  if (state.job || state.creating) {
    // Utkastet er laget for det andre språket: lag et nytt og last opp filene på nytt i bakgrunnen.
    const again = [
      ...state.files.map((f) => newUpload(state.sources.get(f.id), f.path)),
      ...state.uploads.map((u) => newUpload(u.file, u.path)),
    ].filter((u) => u.file);
    resetDraft();
    state.uploads = again;
    pump();
  }
  renderSetup();
}

// ---------- Tegning av steg 1–3 ----------

function uploadText(item) {
  if (item.status === "error") return item.error;
  if (item.status === "waiting") return "Venter på å bli lastet opp";
  return item.pct >= 100 ? "Leser dokumentet …" : `Laster opp … ${item.pct} %`;
}

function fileRow(file) {
  const failed = file.status === "failed";
  return h("li", { class: `file${failed ? " is-failed" : ""}` },
    extBadge(file.name),
    h("div", { class: "file-main" },
      nameLine(file.path || file.name),
      h("p", { class: "file-meta" }, failed
        ? file.message || file.error || "Dette dokumentet kan ikke oversettes."
        : `Klar – tar ${formatDuration(file.estimateSeconds)}`),
      failed ? h("p", { class: "file-hint" }, "Det blir ikke med i oversettelsen. Du kan fjerne det fra listen.") : null
    ),
    removeButton(file.name, (e) => removeFile(file, e.currentTarget))
  );
}

function uploadRow(item) {
  const error = item.status === "error";
  item.fill = h("span", { class: "mini-fill" });
  item.fill.style.width = `${item.pct}%`;
  item.label = h("p", { class: "file-meta" }, uploadText(item));
  return h("li", { class: `file is-${item.status}` },
    extBadge(item.path),
    h("div", { class: "file-main" },
      nameLine(item.path),
      item.label,
      item.status === "uploading" ? h("span", { class: "mini-bar", "aria-hidden": "true" }, item.fill) : null,
      error ? h("button", { type: "button", class: "btn-link", onclick: () => retryUpload(item) }, "Prøv igjen") : null
    ),
    removeButton(baseName(item.path), () => removeUpload(item))
  );
}

function renderSetup() {
  const rows = [...state.files.map(fileRow), ...state.uploads.map(uploadRow)];
  fill($("file-list"), rows);
  $("file-list").hidden = !rows.length;
  $("files-foot").hidden = rows.length < 2;

  for (const input of document.querySelectorAll("input[name=lang]")) input.checked = input.value === state.lang;

  const ready = state.files.filter((f) => f.status === "ready");
  const busy = state.uploads.some((u) => u.status !== "error");
  const seconds = ready.reduce((n, f) => n + (f.estimateSeconds || 0), 0);
  const summary = $("summary");
  if (busy) fill(summary, "Vent litt mens dokumentene lastes opp …");
  else if (ready.length) {
    fill(summary,
      `${plural(ready.length, "dokument", "dokumenter")} blir oversatt til ${langName(state.lang)}. `,
      h("strong", null, `Beregnet tid: ${formatDuration(seconds)}`)
    );
  } else if (rows.length) fill(summary, "Ingen av dokumentene kan oversettes. Prøv gjerne med andre filer.");
  else fill(summary, "Legg til minst ett dokument først, så kan du starte.");
  $("btn-start").disabled = busy || !ready.length || !state.job;
}

// ---------- Steg 3: start, følg med og avbryt ----------

async function start() {
  const button = $("btn-start");
  const error = $("start-error");
  button.disabled = true;
  error.hidden = true;
  try {
    const { job } = await api(jobUrl(state.job.id, "/start"), { method: "POST" });
    state.uploads = [];
    state.sources.clear();
    state.lastOk = Date.now();
    state.failures = 0;
    applyJob(job, state.files);
    window.scrollTo({ top: 0, behavior: smooth() });
    $("working-title").focus({ preventScroll: true });
    schedulePoll();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    renderSetup();
  }
}

async function refresh() {
  const id = state.job.id;
  const mine = ++state.seq;
  const data = await api(jobUrl(id));
  // Et eldre svar som kommer sent, skal ikke overskrive et nyere.
  if (mine < state.applied || !state.job || state.job.id !== id) return;
  state.applied = mine;
  state.lastOk = Date.now();
  state.failures = 0;
  applyJob(data.job, data.files || []);
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!state.job || !ACTIVE.has(state.job.status)) return;
  const delay = state.failures
    ? Math.min(30000, 2000 * 2 ** (state.failures - 1))
    : document.hidden ? 5000 : 1500;
  state.pollTimer = setTimeout(poll, delay);
}

async function poll() {
  if (state.polling || !state.job) return;
  clearTimeout(state.pollTimer);
  state.polling = true;
  try {
    await refresh();
  } catch (err) {
    if (err.status === 404) {
      jobVanished();
      return;
    }
    state.failures++;
    renderConnection();
  } finally {
    state.polling = false;
  }
  schedulePoll();
}

function jobVanished() {
  state.job = null;
  state.files = [];
  setView("setup");
  renderSetup();
  showAlert("Vi finner ikke denne oversettelsen lenger. Den kan ha blitt slettet.");
}

async function cancel() {
  const ok = await confirmDialog({
    title: "Vil du avbryte oversettelsen?",
    text: "Dokumenter som allerede er ferdige, beholder du under «Mine dokumenter». Resten blir ikke oversatt.",
    confirm: "Ja, avbryt",
    cancel: "Nei, fortsett",
    danger: true,
  });
  if (!ok || !state.job || !ACTIVE.has(state.job.status)) return;
  try {
    await api(jobUrl(state.job.id, "/cancel"), { method: "POST" });
    await refresh();
  } catch (err) {
    toast(`Klarte ikke å avbryte. ${err.message}`);
  }
}

function applyJob(job, files) {
  const wasActive = Boolean(state.job && ACTIVE.has(state.job.status));
  state.job = job;
  state.files = files;
  if (ACTIVE.has(job.status)) {
    setView("working");
    renderWorking();
    return;
  }
  setView("done");
  renderDone();
  if (wasActive) finished();
}

function finished() {
  remember(LAST_VISIT, new Date().toISOString());
  loadDocuments();
  const ok = state.job.status === "done" || state.job.status === "partial";
  if (state.notify && document.hidden && ok) {
    try {
      new Notification("Dokumentene dine er ferdige", { body: "InnNorsk er ferdig med oversettelsen.", icon: "/img/icon.png" });
    } catch {
      // Enkelte mobilnettlesere tillater bare varsler fra service workers.
    }
  }
  $("done").scrollIntoView({ behavior: smooth(), block: "start" });
  $("done-title").focus({ preventScroll: true });
}

function setView(view) {
  state.view = view;
  $("setup").hidden = view !== "setup";
  $("working").hidden = view !== "working";
  $("done").hidden = view !== "done";
  clearInterval(state.tickTimer);
  if (view === "working") {
    state.tickTimer = setInterval(tick, 1000);
    tick();
  } else {
    state.spoken = "";
  }
  if (view === "setup") document.title = TITLE;
}

// ---------- Arbeidskortet ----------

function etaText(job) {
  if (job.status === "queued") return "Starter straks …";
  const eta = job.eta;
  if (!eta) return "Regner ut hvor lang tid det tar …";
  if (eta.secondsRemaining < 10) return "Straks ferdig …";
  return `${formatDuration(eta.secondsRemaining)} igjen – ferdig rundt kl. ${formatClock(eta.finishAt)}`;
}

const FILE_STATES = {
  ready: "Venter",
  queued: "Venter",
  done: "Ferdig",
  failed: "Kunne ikke oversettes",
  cancelled: "Avbrutt",
};

function workRow(file) {
  const pct = Math.floor((file.progress && file.progress.percent) || 0);
  return h("li", { class: `wf is-${file.status}` },
    h("span", { class: "wf-mark", "aria-hidden": "true" }, file.status === "done" ? icon("check") : null),
    h("span", { class: "wf-name" }, baseName(file.path || file.name)),
    h("span", { class: "wf-state" }, file.status === "working" ? `Oversetter … ${pct} %` : FILE_STATES[file.status] || "")
  );
}

function announce(text) {
  if (text === state.spoken) return;
  state.spoken = text;
  $("announce").textContent = text;
}

function renderWorking() {
  const job = state.job;
  const running = job.status === "running";
  const pct = Math.max(0, Math.min(100, Math.floor((job.progress && job.progress.percent) || 0)));
  const current = job.currentFile;
  const index = current ? state.files.findIndex((f) => f.id === current.id) + 1 : 0;

  if (!running) fill($("now"), "Dokumentene står i kø og blir tatt straks.");
  else if (current) {
    fill($("now"), "Nå: ", h("strong", null, baseName(current.name)),
      state.files.length > 1 && index ? ` (dokument\u00a0${index}\u00a0av\u00a0${state.files.length})` : "");
  } else fill($("now"), "Gjør klar neste dokument …");

  $("bar").setAttribute("aria-valuenow", String(pct));
  $("bar-fill").style.width = `${pct}%`;
  $("pct").textContent = `${pct} %`;
  $("eta").textContent = etaText(job);
  $("eta-hint").hidden = !(running && job.eta && job.eta.confidence === "lav");
  fill($("work-files"), state.files.map(workRow));
  $("work-files").classList.toggle("is-long", state.files.length > 6);
  $("btn-notify").hidden = state.notify || !("Notification" in window) || Notification.permission === "denied";
  $("notify-on").hidden = !state.notify;
  document.title = `(${pct} %) ${TITLE}`;
  announce(running ? `Oversettelsen er ${Math.floor(pct / 10) * 10} % ferdig.` : "Oversettelsen venter på tur.");
  renderConnection();
}

function renderConnection() {
  // Én bom kan være tilfeldig; først ved to på rad sier vi fra.
  const lost = state.failures >= 2;
  $("lost").hidden = !lost;
  $("heartbeat").classList.toggle("is-lost", lost);
  tick();
}

function tick() {
  $("hb-time").textContent = relativeTime(state.lastOk);
}

async function enableNotify() {
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  state.notify = permission === "granted";
  if (!state.notify) toast("Da får du ikke beskjed, men du ser det her på siden når det er ferdig.");
  if (state.view === "working") renderWorking();
}

// ---------- Ferdig-kortet ----------

function warningNote(file) {
  const n = (file.warnings || []).length;
  if (!n) return null;
  return h("p", { class: "file-hint" }, n === 1
    ? "Merk: Én liten tekstbit står fortsatt på originalspråket."
    : `Merk: ${n} små tekstbiter står fortsatt på originalspråket.`);
}

function resultRow(job, file) {
  if (file.status === "done") {
    const name = baseName(file.outputName || file.name);
    return h("li", { class: "result" },
      extBadge(name),
      h("div", { class: "file-main" },
        h("p", { class: "file-name" }, name),
        h("p", { class: "file-meta" }, `${LANGUAGE_LABELS[job.targetLanguage] || ""} · ${formatBytes(file.outputBytes)}`),
        warningNote(file)
      ),
      h("a", {
        class: "btn btn-primary btn-download", href: fileUrl(job.id, file.id, "/download"), download: "", "aria-label": `Last ned ${name}`,
      }, icon("download"), "Last ned")
    );
  }
  // Samme melding som overskriften (f.eks. når hele jobben stoppet) gjentas ikke på hver fil.
  const message = file.message && file.message !== job.error ? file.message : "Ble ikke oversatt.";
  const why = file.status === "failed" ? message : "Ble ikke oversatt fordi oversettelsen ble avbrutt.";
  return h("li", { class: `result is-${file.status === "failed" ? "failed" : "cancelled"}` },
    extBadge(file.name),
    h("div", { class: "file-main" },
      h("p", { class: "file-name" }, baseName(file.path || file.name)),
      h("p", { class: "file-meta" }, why)
    )
  );
}

function renderDone() {
  const job = state.job;
  const files = state.files;
  const done = files.filter((f) => f.status === "done");
  const lang = langName(job.targetLanguage);
  const text = {
    done: [
      done.length === 1 ? "Ferdig! Dokumentet er oversatt." : "Ferdig! Dokumentene er oversatt.",
      done.length === 1 ? `Dokumentet er oversatt til ${lang}.` : `Alle ${done.length} dokumentene er oversatt til ${lang}.`,
    ],
    partial: [
      "Nesten alt gikk fint",
      `${done.length} av ${files.length} dokumenter er oversatt til ${lang}. Under ser du hva som skjedde med resten.`,
    ],
    failed: [
      "Det gikk dessverre ikke denne gangen",
      job.error || "Ingen av dokumentene kunne oversettes. Under ser du hvorfor.",
    ],
    cancelled: [
      "Oversettelsen ble avbrutt",
      done.length
        ? `${plural(done.length, "dokument", "dokumenter")} ble ferdig før du avbrøt, og kan lastes ned.`
        : "Ingen dokumenter ble ferdige før du avbrøt.",
    ],
  }[job.status] || ["Oversettelsen er avsluttet", ""];
  $("done-title").textContent = text[0];
  $("done-lead").textContent = text[1];
  $("done-mark").className = `done-mark is-${job.status}`;
  $("done-mark").replaceChildren(icon(done.length ? "check" : "info"));
  const sorted = [...done, ...files.filter((f) => f.status !== "done")];
  fill($("results"), sorted.map((f) => resultRow(job, f)));
  $("done-hint").hidden = !done.length;
  const zip = $("zip-link");
  zip.hidden = done.length < 2;
  zip.href = jobUrl(job.id, "/download.zip");
  document.title = done.length && job.status !== "cancelled" ? `✓ Ferdig – ${TITLE}` : TITLE;
}

function translateMore() {
  state.job = null;
  state.files = [];
  state.uploads = [];
  state.sources.clear();
  $("skipped").hidden = true;
  showAlert("");
  setView("setup");
  renderSetup();
  window.scrollTo({ top: 0, behavior: smooth() });
  $("btn-files").focus({ preventScroll: true });
}

// ---------- Mine dokumenter ----------

async function loadDocuments() {
  try {
    const { documents } = await api("/api/documents");
    state.documents = documents || [];
  } catch (err) {
    fill($("doc-groups"), h("p", { class: "empty" }, `Klarte ikke å hente dokumentene dine. ${err.message}`));
    return false;
  }
  renderDocuments();
  return true;
}

function isNew(doc) {
  return Boolean(state.lastVisit) && new Date(doc.finishedAt) > new Date(state.lastVisit);
}

function docRow(doc) {
  const name = baseName(doc.name);
  const original = baseName(doc.originalName || doc.path);
  return h("li", { class: "doc" },
    extBadge(name),
    h("div", { class: "file-main" },
      h("p", { class: "file-name" }, name, isNew(doc) ? h("span", { class: "pill" }, "Ny") : null),
      h("p", { class: "file-meta" },
        [LANGUAGE_LABELS[doc.targetLanguage], `kl. ${formatClock(doc.finishedAt)}`, formatBytes(doc.outputBytes)].filter(Boolean).join(" · ")),
      original && original !== name ? h("p", { class: "file-meta" }, `Original: ${original}`) : null
    ),
    h("div", { class: "doc-actions" },
      h("a", {
        class: "btn btn-small btn-primary", href: fileUrl(doc.jobId, doc.fileId, "/download"), download: "", "aria-label": `Last ned ${name}`,
      }, "Last ned"),
      h("button", {
        type: "button", class: "btn-link btn-quiet", "aria-label": `Slett ${name}`, onclick: () => deleteDocument(doc),
      }, "Slett")
    )
  );
}

function renderDocuments() {
  const docs = state.documents;
  if (!docs.length) {
    fill($("doc-groups"), h("div", { class: "empty" },
      h("p", null, "Her havner dokumentene du oversetter."),
      h("p", { class: "muted" }, "Du har ingen ennå – de dukker opp her så snart den første oversettelsen er ferdig.")));
    return;
  }
  const days = groupBy(docs, (d) => startOfDay(new Date(d.finishedAt)));
  fill($("doc-groups"), [...days.values()].map((dayDocs) => h("section", { class: "day" },
    h("h3", { class: "day-title" }, formatDay(dayDocs[0].finishedAt)),
    [...groupBy(dayDocs, (d) => d.jobId).entries()].map(([jobId, jobDocs]) => h("div", { class: "batch" },
      jobDocs.length > 1 ? h("div", { class: "batch-head" },
        h("span", null, `${plural(jobDocs.length, "dokument", "dokumenter")} oversatt kl. ${formatClock(jobDocs[0].finishedAt)}`),
        h("a", { class: "btn btn-small btn-secondary", href: jobUrl(jobId, "/download.zip"), download: "" }, "Last ned alle (.zip)")
      ) : null,
      h("ul", { class: "doc-list" }, jobDocs.map(docRow))
    ))
  )));
}

async function deleteDocument(doc) {
  const ok = await confirmDialog({
    title: "Slette dokumentet?",
    text: `«${baseName(doc.name)}» blir slettet herfra for godt. Originalen på maskinen din blir ikke berørt.`,
    confirm: "Ja, slett",
    cancel: "Nei, behold",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(fileUrl(doc.jobId, doc.fileId), { method: "DELETE" });
    state.documents = state.documents.filter((d) => d !== doc);
    renderDocuments();
    toast("Dokumentet er slettet.");
    $("mine").focus({ preventScroll: true });
  } catch (err) {
    toast(`Klarte ikke å slette dokumentet. ${err.message}`);
  }
}

function welcomeBack() {
  const fresh = state.documents.filter(isNew).length;
  if (!fresh) return;
  $("welcome-text").textContent = fresh === 1
    ? "1 dokument er ferdig og klart til nedlasting."
    : `${fresh} dokumenter er ferdige og klare til nedlasting.`;
  $("welcome").hidden = false;
}

// ---------- Bytt passord ----------

function openPasswordDialog(required) {
  $("pw-form").reset();
  for (const id of ["pw-current", "pw-new", "pw-repeat"]) $(id).type = "password";
  $("pw-error").hidden = true;
  $("pw-ok").hidden = true;
  $("pw-lead").hidden = !required;
  $("pw-dialog").showModal();
}

function setupPasswordDialog() {
  const dialog = $("pw-dialog");
  const form = $("pw-form");
  const error = $("pw-error");
  const ok = $("pw-ok");
  const fields = [$("pw-current"), $("pw-new"), $("pw-repeat")];
  const say = (message) => {
    error.textContent = message;
    error.hidden = !message;
  };
  $("btn-password").addEventListener("click", () => openPasswordDialog(false));
  $("pw-close").addEventListener("click", () => dialog.close());
  $("pw-show").addEventListener("change", (e) => {
    for (const input of fields) input.type = e.target.checked ? "text" : "password";
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    ok.hidden = true;
    const [current, next, repeat] = fields.map((f) => f.value);
    if (!current) return say("Skriv inn passordet du bruker nå.");
    if (next.length < 8) return say("Det nye passordet må ha minst 8 tegn.");
    if (next !== repeat) return say("De to nye passordene er ikke like. Prøv en gang til.");
    say("");
    const save = $("pw-save");
    save.disabled = true;
    try {
      await api("/api/auth/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      form.reset();
      ok.hidden = false;
    } catch (err) {
      say(err.message);
    } finally {
      save.disabled = false;
    }
  });
}

// ---------- Oppstart ----------

function setupInputs() {
  const zone = $("dropzone");
  $("btn-files").addEventListener("click", () => $("input-files").click());
  $("btn-folder").addEventListener("click", () => $("input-folder").click());
  for (const id of ["input-files", "input-folder"]) {
    const input = $(id);
    input.addEventListener("change", () => {
      addEntries(fromFileList(input.files));
      input.value = "";
    });
  }
  // Klikk på selve feltet åpner filvelgeren; tastaturbrukere bruker knappene inni.
  zone.addEventListener("click", (e) => {
    if (!e.target.closest("button")) $("input-files").click();
  });

  // Filer kan slippes hvor som helst på siden mens steg 1 vises.
  const hasFiles = (e) => Boolean(e.dataTransfer) && [...e.dataTransfer.types].includes("Files");
  let depth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e) || state.view !== "setup") return;
    depth++;
    zone.classList.add("is-over");
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove("is-over");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove("is-over");
    if (!hasFiles(e) || state.view !== "setup") return;
    try {
      addEntries(await entriesFromDrop(e.dataTransfer));
    } catch {
      showAlert("Klarte ikke å lese filene du slapp. Prøv heller knappen «Velg filer».");
    }
  });

  for (const input of document.querySelectorAll("input[name=lang]")) {
    input.addEventListener("change", () => chooseLanguage(input.value));
  }
  $("btn-clear").addEventListener("click", clearAll);
  $("btn-start").addEventListener("click", start);
  $("btn-cancel").addEventListener("click", cancel);
  $("btn-retry").addEventListener("click", poll);
  $("btn-notify").addEventListener("click", enableNotify);
  $("btn-again").addEventListener("click", translateMore);
  $("btn-logout").addEventListener("click", logout);
  $("welcome-close").addEventListener("click", () => { $("welcome").hidden = true; });
  $("welcome-go").addEventListener("click", () => { $("welcome").hidden = true; });

  const wake = () => {
    if (!document.hidden && state.view === "working") poll();
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("pagehide", () => remember(LAST_VISIT, new Date().toISOString()));
}

// Fortsett en oversettelse som er i gang, også om siden ble lukket underveis.
async function resume() {
  const { jobs } = await api("/api/jobs?limit=10");
  const active = (jobs || []).find((j) => ACTIVE.has(j.status));
  if (!active) return;
  state.lastOk = Date.now();
  applyJob(active, []);
  await poll();
}

async function init() {
  setupInputs();
  setupPasswordDialog();
  renderSetup();
  let user;
  try {
    const me = await api("/api/auth/me");
    user = me.user;
    if (me.limits) state.limits = me.limits;
  } catch (err) {
    showAlert(err.message);
    return;
  }
  // Midlertidig passord: be om et eget her (en omdirigering til /login kunne gått i ring).
  if (user.mustChangePassword) openPasswordDialog(true);
  $("hello").textContent = `Hei, ${user.displayName || user.username}!`;
  $("admin-link").hidden = user.role !== "admin";
  const [docsLoaded] = await Promise.all([
    loadDocuments(),
    resume().catch((err) => showAlert(`Klarte ikke å hente oversettelsen som var i gang. ${err.message}`)),
  ]);
  if (docsLoaded) welcomeBack();
  remember(LAST_VISIT, new Date().toISOString());
}

init();
