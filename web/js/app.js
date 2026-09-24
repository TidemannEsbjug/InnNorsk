import {
  api, h, fill, formatDuration, formatClock, formatDateTime, formatBytes, formatNumber,
  statusLabel, LANGUAGE_LABELS, logout, reportErrors,
} from "./api.js";

reportErrors();

const SUPPORTED = [".docx", ".pptx", ".xlsx", ".pdf", ".txt", ".md", ".csv", ".html", ".htm", ".rtf"];
const ACTIVE = new Set(["queued", "running"]);
const FINAL = new Set(["done", "partial", "failed", "cancelled"]);
const IN_PROGRESS_FILE = new Set(["ready", "queued", "working"]);
const HELP = "Prøv igjen om litt. Hvis det fortsetter, si fra til den som har satt opp InnNorsk for deg.";

const SKIP_REASONS = {
  lock: "Midlertidige filer fra Word eller Office (navnet starter med ~$)",
  hidden: "Skjulte filer",
  system: "Systemfiler fra Windows (Thumbs.db, desktop.ini)",
  type: "Filtyper som ikke kan oversettes",
  empty: "Tomme filer",
  duplicate: "Allerede lagt til",
};

const $ = (id) => document.getElementById(id);
const els = {
  who: $("who"),
  adminLink: $("admin-link"),
  lang: $("lang"),
  langNote: $("lang-note"),
  dropzone: $("dropzone"),
  btnFiles: $("btn-files"),
  btnFolder: $("btn-folder"),
  inputFiles: $("input-files"),
  inputFolder: $("input-folder"),
  skipped: $("skipped"),
  inList: $("in-list"),
  btnRestart: $("btn-restart"),
  slipLabel: $("slip-label"),
  slipValue: $("slip-value"),
  slipLine: $("slip-line"),
  slipNote: $("slip-note"),
  overall: $("overall"),
  start: $("btn-start"),
  stampSub: $("stamp-sub"),
  cancel: $("btn-cancel"),
  btnNew: $("btn-new"),
  alert: $("alert"),
  utTitle: $("ut-title"),
  zip: $("zip-link"),
  outList: $("out-list"),
  utNote: $("ut-note"),
  history: $("history-list"),
};

const state = {
  job: null,
  files: [],
  uploads: [], // { file, path, status: waiting|uploading|error, pct, error, bar, xhr, removed }
  round: 0, // økes ved «Begynn på nytt», så svar fra en gammel runde ignoreres
  pumping: false,
  creatingJob: null,
  pollTimer: 0,
  pollFailures: 0,
  history: [],
};

// ---------- Hjelpere ----------

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

function baseName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirName(path) {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i + 1) : "";
}

function phase() {
  const status = state.job && state.job.status;
  if (!status || status === "draft") return "draft";
  return ACTIVE.has(status) ? "active" : "final";
}

function plural(n, one, many) {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

function showAlert(message, hint = HELP) {
  fill(els.alert,
    h("strong", null, "Noe gikk galt. "),
    message,
    hint ? h("span", { class: "alert-hint" }, hint) : null
  );
  els.alert.hidden = false;
}

function clearAlert() {
  els.alert.hidden = true;
}

function fileUrl(file) {
  return `/api/jobs/${encodeURIComponent(file.jobId || state.job.id)}/files/${encodeURIComponent(file.id)}`;
}

function zipUrl(jobId) {
  return `/api/jobs/${encodeURIComponent(jobId)}/download.zip`;
}

// ---------- Legge til filer ----------

function skipReason(path, file, known) {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  if (name.startsWith("~$") || name.startsWith(".~lock")) return "lock";
  if (parts.some((p) => p.startsWith("."))) return "hidden";
  if (/^(thumbs\.db|desktop\.ini)$/i.test(name)) return "system";
  if (!SUPPORTED.includes(extOf(name))) return "type";
  if (file.size === 0) return "empty";
  if (known.has(path.toLowerCase())) return "duplicate";
  return null;
}

function addEntries(entries) {
  if (phase() === "active") {
    showAlert("Vent til denne oversettelsen er ferdig før du legger inn nye filer.", "");
    return;
  }
  if (phase() === "final") resetRound();
  clearAlert();
  const known = new Set([...state.files.map((f) => f.path), ...state.uploads.map((u) => u.path)].map((p) => p.toLowerCase()));
  const skipped = {};
  let added = 0;
  for (const { file, path } of entries) {
    const reason = skipReason(path, file, known);
    if (reason) {
      (skipped[reason] ||= []).push(path);
      continue;
    }
    known.add(path.toLowerCase());
    state.uploads.push({ file, path, status: "waiting", pct: 0, error: "" });
    added++;
  }
  renderSkipped(skipped, added);
  render();
  pump();
}

function renderSkipped(skipped, added) {
  const reasons = Object.keys(skipped);
  if (!reasons.length) {
    els.skipped.hidden = true;
    return;
  }
  const total = reasons.reduce((n, r) => n + skipped[r].length, 0);
  const list = h("ul", null, reasons.map((r) => {
    const names = skipped[r].map(baseName);
    const shown = names.slice(0, 6).join(", ");
    const more = names.length > 6 ? ` og ${names.length - 6} til` : "";
    return h("li", null, h("strong", null, `${SKIP_REASONS[r]}: `), shown + more);
  }));
  fill(els.skipped,
    h("button", { type: "button", class: "notice-close", "aria-label": "Lukk meldingen", onclick: () => { els.skipped.hidden = true; } }, "×"),
    h("p", null, added
      ? `${plural(total, "fil ble", "filer ble")} hoppet over. De andre er lagt til.`
      : `${plural(total, "fil ble", "filer ble")} hoppet over, og ingen nye filer ble lagt til.`),
    list,
    skipped.type ? h("p", { class: "small-note" }, "Disse kan oversettes: Word (.docx), PowerPoint (.pptx), Excel (.xlsx), PDF, tekst (.txt, .md, .csv), nettsider (.html) og RTF.") : null
  );
  els.skipped.hidden = false;
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

async function ensureJob() {
  if (state.job) return state.job;
  const round = state.round;
  state.creatingJob ||= api("/api/jobs", { method: "POST", body: { targetLanguage: els.lang.value } })
    .then(({ job }) => {
      if (state.round === round) state.job = job;
      return job;
    })
    .finally(() => {
      if (state.round === round) state.creatingJob = null;
    });
  return state.creatingJob;
}

function uploadFile(jobId, item) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open("PUT", `/api/jobs/${encodeURIComponent(jobId)}/files?path=${encodeURIComponent(item.path)}`);
    xhr.setRequestHeader("X-InnNorsk", "1");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (e) => {
      if (!e.lengthComputable) return;
      item.pct = Math.round((e.loaded / e.total) * 100);
      if (item.bar) item.bar.value = item.pct;
    });
    xhr.addEventListener("load", () => {
      if (xhr.status === 401) {
        location.href = "/login";
        return;
      }
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.file) resolve(data.file);
      else if (xhr.status === 413) reject(new Error((data && data.error) || "Filen er for stor til å lastes opp."));
      else reject(new Error((data && data.error) || `Opplastingen feilet (feilkode ${xhr.status}).`));
    });
    xhr.addEventListener("error", () => reject(new Error("Opplastingen ble brutt. Sjekk internettforbindelsen og trykk «Prøv igjen».")));
    xhr.addEventListener("abort", () => reject(new Error("Opplastingen ble avbrutt.")));
    xhr.send(item.file);
  });
}

async function pump() {
  if (state.pumping) return;
  state.pumping = true;
  let uploaded = false;
  try {
    for (;;) {
      const item = state.uploads.find((u) => u.status === "waiting");
      if (!item) break;
      item.status = "uploading";
      item.pct = 0;
      render();
      try {
        const job = await ensureJob();
        if (item.removed) throw new Error("Fjernet");
        const file = await uploadFile(job.id, item);
        if (state.job && state.job.id === job.id) {
          state.files.push(file);
          uploaded = true;
        }
        dropUpload(item);
      } catch (err) {
        if (item.removed) dropUpload(item);
        else {
          item.status = "error";
          item.error = err.message;
        }
      }
      item.xhr = null;
      render();
    }
    if (uploaded) await refreshJob();
  } catch (err) {
    showAlert(err.message);
  } finally {
    state.pumping = false;
    render();
  }
}

function dropUpload(item) {
  const i = state.uploads.indexOf(item);
  if (i >= 0) state.uploads.splice(i, 1);
}

function removeUpload(item) {
  if (item.status === "uploading" && item.xhr) {
    item.removed = true;
    item.xhr.abort();
  } else {
    dropUpload(item);
    render();
  }
}

function retryUpload(item) {
  item.status = "waiting";
  item.error = "";
  render();
  pump();
}

async function removeFile(file) {
  try {
    await api(fileUrl(file), { method: "DELETE" });
    state.files = state.files.filter((f) => f.id !== file.id);
    render();
    await refreshJob();
  } catch (err) {
    showAlert(`Klarte ikke å fjerne ${file.name}. ${err.message}`);
  }
}

// ---------- Jobb ----------

async function refreshJob() {
  if (!state.job) return;
  const id = state.job.id;
  const data = await api(`/api/jobs/${encodeURIComponent(id)}`);
  if (!state.job || state.job.id !== id) return;
  const wasActive = ACTIVE.has(state.job.status);
  state.job = data.job;
  state.files = data.files || [];
  render();
  if (wasActive && FINAL.has(state.job.status)) {
    loadHistory();
    // På mobil ligger ut-kurven langt nede; vis resultatet når det er klart.
    const ut = document.querySelector(".tray.ut");
    if (ut.getBoundingClientRect().top > window.innerHeight * 0.6) ut.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function startJob() {
  if (!state.job) return;
  clearAlert();
  els.skipped.hidden = true;
  els.start.disabled = true;
  try {
    const { job } = await api(`/api/jobs/${encodeURIComponent(state.job.id)}/start`, { method: "POST" });
    state.job = job;
    await refreshJob();
    schedulePoll();
    loadHistory();
  } catch (err) {
    showAlert(err.message);
    render();
  }
}

async function cancelJob() {
  if (!state.job) return;
  const ok = window.confirm("Vil du avbryte oversettelsen?\n\nFiler som allerede er ferdige, kan du fortsatt laste ned.");
  if (!ok) return;
  els.cancel.disabled = true;
  try {
    const { job } = await api(`/api/jobs/${encodeURIComponent(state.job.id)}/cancel`, { method: "POST" });
    state.job = job;
    await refreshJob();
  } catch (err) {
    showAlert(`Klarte ikke å avbryte. ${err.message}`);
  } finally {
    els.cancel.disabled = false;
    render();
  }
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!state.job || !ACTIVE.has(state.job.status)) return;
  const base = document.hidden ? 5000 : 1500;
  const delay = Math.min(30000, base * 2 ** state.pollFailures);
  state.pollTimer = setTimeout(poll, delay);
}

async function poll() {
  try {
    await refreshJob();
    if (state.pollFailures) clearAlert();
    state.pollFailures = 0;
  } catch (err) {
    state.pollFailures++;
    if (state.pollFailures >= 2) {
      showAlert("Mistet kontakten med serveren.", "Oversettelsen fortsetter på serveren. Vi prøver igjen automatisk.");
    }
  }
  schedulePoll();
}

function resetRound() {
  clearTimeout(state.pollTimer);
  state.round++;
  state.creatingJob = null;
  for (const item of state.uploads) {
    item.removed = true;
    if (item.xhr) item.xhr.abort();
  }
  state.job = null;
  state.files = [];
  state.uploads = [];
  els.skipped.hidden = true;
  clearAlert();
  render();
}

async function openJob(id, { scroll = true } = {}) {
  if (state.uploads.some((u) => u.status !== "error")
    && !window.confirm("Opplastingen du holder på med, blir stoppet. Vil du åpne den andre oversettelsen?")) return;
  clearAlert();
  try {
    const data = await api(`/api/jobs/${encodeURIComponent(id)}`);
    resetRound();
    state.job = data.job;
    state.files = data.files || [];
    if (LANGUAGE_LABELS[state.job.targetLanguage]) els.lang.value = state.job.targetLanguage;
    render();
    schedulePoll();
    if (scroll) document.querySelector(".desk").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    showAlert(`Klarte ikke å åpne oversettelsen. ${err.message}`);
  }
}

// ---------- Tegning ----------

function render() {
  renderInn();
  renderPress();
  renderUt();
  renderHistory();
}

function fileMeta(file) {
  if (file.status === "failed") return file.error || file.message || "Kunne ikke leses.";
  const parts = [];
  if (file.segments != null) parts.push(plural(file.segments, "tekstbit", "tekstbiter"));
  if (file.chars != null) parts.push(`${formatNumber(file.chars)} tegn`);
  if (file.estimateSeconds != null) parts.push(formatDuration(file.estimateSeconds));
  return parts.join(" · ") || formatBytes(file.bytes);
}

function docName(path) {
  return h("span", { class: "doc-name" },
    dirName(path) ? h("span", { class: "doc-dir" }, dirName(path)) : null,
    baseName(path)
  );
}

function renderInn() {
  const p = phase();
  const draft = p === "draft";
  els.btnFiles.disabled = p === "active";
  els.btnFolder.disabled = p === "active";
  els.dropzone.classList.toggle("disabled", p === "active");
  els.dropzone.setAttribute("aria-disabled", String(p === "active"));

  const locked = Boolean(state.job) || state.uploads.length > 0;
  els.lang.disabled = locked && p !== "final";
  els.langNote.hidden = !(locked && draft);
  els.btnRestart.hidden = !(draft && (state.files.length || state.uploads.length));

  const items = [];
  const files = draft ? state.files : p === "active" ? state.files.filter((f) => IN_PROGRESS_FILE.has(f.status)) : [];
  for (const file of files) {
    const working = file.status === "working";
    const pct = Math.round((file.progress && file.progress.percent) || 0);
    const hint = draft && file.status === "failed" ? failHint(file) : "";
    items.push(h("li", { class: `doc ${file.status}` },
      docName(file.path || file.name),
      h("span", { class: "doc-meta" },
        draft ? fileMeta(file) : file.message || (working ? `Oversetter … ${pct} %` : "Venter på tur")),
      hint ? h("span", { class: "doc-hint" }, hint) : null,
      working ? h("progress", { max: 100, value: pct, "aria-label": `Fremdrift for ${file.name}` }) : null,
      draft ? h("button", {
        type: "button", class: "remove", "aria-label": `Fjern ${file.name}`, title: "Fjern", onclick: () => removeFile(file),
      }, "×") : null
    ));
  }
  if (draft) {
    for (const item of state.uploads) {
      const bar = item.status === "uploading" ? h("progress", { max: 100, value: item.pct, "aria-label": `Opplasting av ${baseName(item.path)}` }) : null;
      item.bar = bar;
      items.push(h("li", { class: `doc upload ${item.status}` },
        docName(item.path),
        h("span", { class: "doc-meta" },
          item.status === "error" ? item.error
            : item.status === "uploading" ? "Laster opp og leser dokumentet …"
              : "Venter på opplasting"),
        bar,
        item.status === "error" ? h("button", { type: "button", class: "retry", onclick: () => retryUpload(item) }, "Prøv igjen") : null,
        h("button", {
          type: "button", class: "remove", "aria-label": `Fjern ${baseName(item.path)}`, title: "Fjern", onclick: () => removeUpload(item),
        }, "×")
      ));
    }
  }
  if (!items.length) {
    items.push(h("li", { class: "empty" },
      p === "draft" ? "Ingen filer ennå. Slipp filer i feltet over, eller trykk «Velg filer»."
        : p === "active" ? "Alle filene er ferdig behandlet."
          : "Alt er sendt til ut-kurven. Legg inn nye filer for å starte en ny runde."));
  }
  els.inList.replaceChildren(...items);
}

function renderPress() {
  const p = phase();
  const job = state.job;
  const ready = state.files.filter((f) => f.status === "ready");
  const uploading = state.uploads.some((u) => u.status !== "error");

  els.overall.hidden = p !== "active";
  els.cancel.hidden = p !== "active";
  els.btnNew.hidden = p !== "final";
  els.start.hidden = p === "final";
  els.start.classList.toggle("busy", p === "active");
  els.slipNote.textContent = "";

  if (p === "draft") {
    const seconds = job && job.estimateSeconds != null
      ? job.estimateSeconds
      : ready.reduce((n, f) => n + (f.estimateSeconds || 0), 0);
    const chars = ready.reduce((n, f) => n + (f.chars || 0), 0);
    els.slipLabel.textContent = "Estimert tid";
    els.slipValue.textContent = ready.length ? formatDuration(seconds) : "–";
    els.slipLine.textContent = ready.length
      ? `${plural(ready.length, "fil", "filer")} · ${formatNumber(chars)} tegn`
      : "Legg inn filer, så ser du her hvor lang tid det tar.";
    if (ready.length && job && job.queueWaitSeconds > 0) {
      els.slipNote.textContent = `Andre oversettelser er i gang. Din starter om ${formatDuration(job.queueWaitSeconds)}.`;
    }
    els.start.disabled = !ready.length || uploading;
    els.stampSub.textContent = uploading ? "Laster opp …" : ready.length ? "Trykk for å starte" : "Legg inn filer først";
    return;
  }

  els.start.disabled = true;
  const progress = job.progress || {};
  if (job.status === "queued") {
    els.slipLabel.textContent = "I kø";
    els.slipValue.textContent = job.queuePosition > 1 ? `Nr. ${job.queuePosition} i køen` : "Starter snart";
    els.slipLine.textContent = job.queueWaitSeconds > 0
      ? `I kø – starter om ${formatDuration(job.queueWaitSeconds)}`
      : "I kø – starter straks";
    els.overall.value = 0;
    els.stampSub.textContent = "Venter i kø";
    return;
  }
  if (job.status === "running") {
    const pct = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
    els.slipLabel.textContent = "Oversetter …";
    els.slipValue.textContent = `${pct} %`;
    els.overall.value = pct;
    const eta = job.eta;
    els.slipLine.textContent = eta && eta.secondsRemaining != null
      ? `${formatDuration(eta.secondsRemaining)} igjen · ferdig ca.\u00a0kl.\u00a0${formatClock(eta.finishAt)}`
      : "Beregner tid …";
    if (eta && eta.confidence === "lav") els.slipNote.textContent = "(første anslag — blir mer presist underveis)";
    els.stampSub.textContent = "Stempler …";
    return;
  }

  const done = state.files.filter((f) => f.status === "done").length;
  const total = state.files.length;
  els.slipLabel.textContent = statusLabel(job.status);
  els.slipValue.textContent = `${done} av ${total}`;
  const took = job.startedAt && job.finishedAt
    ? (new Date(job.finishedAt) - new Date(job.startedAt)) / 1000
    : null;
  els.slipLine.textContent = {
    done: done === 1 ? "Filen er oversatt." : "Alle filene er oversatt.",
    partial: `${plural(total - done, "fil", "filer")} kunne ikke oversettes. Se ut-kurven.`,
    failed: job.error || "Ingen filer ble oversatt.",
    cancelled: "Du avbrøt oversettelsen.",
  }[job.status] || "";
  if (took != null) els.slipNote.textContent = `Tok ${formatDuration(took).replace(/^ca\. /, "")}`;
}

function failHint(file) {
  const text = `${file.error || ""} ${file.message || ""}`.toLowerCase();
  if (/skann|ocr|ingen tekst/.test(text)) {
    return "PDF-en ser ut til å være et bilde av tekst. Den må gjøres om til tekst (OCR) før den kan oversettes.";
  }
  if (/api-nøkkel|administrator/.test(text)) return "Dette må ordnes av den som har satt opp InnNorsk. Si fra, så kan du prøve igjen etterpå.";
  if (phase() === "draft") return "Denne filen blir ikke med i oversettelsen. Du kan fjerne den.";
  if (file.status === "cancelled") return "";
  return "Prøv igjen med «Ny oversettelse». Hvis det fortsatt feiler, si fra til den som har satt opp InnNorsk for deg.";
}

function warningList(file) {
  const warnings = (file.warnings || []).map((w) => (typeof w === "string" ? w : w.message)).filter(Boolean);
  if (!warnings.length) return null;
  if (warnings.length === 1) return h("span", { class: "doc-warn" }, `Merk: ${warnings[0]}`);
  return h("details", { class: "doc-warn" },
    h("summary", null, `Merk: ${warnings.length} små merknader`),
    h("ul", null, warnings.map((w) => h("li", null, w)))
  );
}

function renderUt() {
  const p = phase();
  const job = state.job;
  const results = p === "draft" ? [] : state.files.filter((f) => !IN_PROGRESS_FILE.has(f.status));
  const done = results.filter((f) => f.status === "done");
  const expired = Boolean(job && job.filesDeleted);

  els.utTitle.textContent = done.length
    ? `${plural(done.length, "fil klar", "filer klare")} til nedlasting`
    : p === "active" ? "Kommer straks …"
      : results.length ? "Ingen filer å laste ned" : "Ingenting her ennå";
  els.zip.hidden = !(p === "final" && done.length > 1 && !expired);
  if (!els.zip.hidden) els.zip.href = zipUrl(job.id);

  els.utNote.textContent = expired
    ? "Filene er slettet fra serveren. Kjør oversettelsen på nytt hvis du trenger dem."
    : job && job.expiresAt && done.length
      ? `Filene kan lastes ned frem til ${new Date(job.expiresAt).toLocaleDateString("nb-NO", { day: "numeric", month: "long" })}.`
      : p === "draft" ? "De norske filene havner her. Originalene dine endres ikke." : "";

  const items = results.map((file) => {
    if (file.status === "done") {
      return h("li", { class: "doc done" },
        docName(file.outputName || file.path || file.name),
        h("span", { class: "doc-meta" }, `Ferdig${file.outputBytes ? ` · ${formatBytes(file.outputBytes)}` : ""}`),
        warningList(file),
        expired ? null : h("a", {
          class: "paper dl", href: `${fileUrl(file)}/download`, download: "", "aria-label": `Last ned ${baseName(file.outputName || file.name)}`,
        }, "Last ned")
      );
    }
    const hint = failHint(file);
    return h("li", { class: `doc ${file.status}` },
      docName(file.path || file.name),
      h("span", { class: "doc-meta" },
        file.status === "cancelled" ? "Avbrutt – ikke oversatt."
          : `Kunne ikke oversettes: ${file.error || file.message || "ukjent feil"}`),
      hint ? h("span", { class: "doc-hint" }, hint) : null
    );
  });
  if (!items.length) {
    items.push(h("li", { class: "empty" },
      p === "active" ? "Filene dukker opp her etter hvert som de blir ferdige." : "Tomt. Oversatte filer kommer hit."));
  }
  els.outList.replaceChildren(...items);
}

async function loadHistory() {
  try {
    const { jobs } = await api("/api/jobs?limit=20");
    state.history = jobs || [];
    renderHistory();
  } catch (err) {
    els.history.replaceChildren(h("li", { class: "empty" }, `Klarte ikke å hente tidligere oversettelser. ${err.message}`));
  }
}

function renderHistory() {
  const jobs = state.history.filter((j) => j.status !== "draft" || (state.job && j.id === state.job.id));
  if (!jobs.length) {
    els.history.replaceChildren(h("li", { class: "empty" }, "Ingen tidligere oversettelser ennå."));
    return;
  }
  els.history.replaceChildren(...jobs.map((listed) => {
    const current = Boolean(state.job && state.job.id === listed.id);
    const job = current ? { ...listed, ...state.job } : listed;
    const canZip = (job.status === "done" || job.status === "partial") && !job.filesDeleted;
    return h("li", { class: `history-item${current ? " current" : ""}` },
      h("button", { type: "button", class: "history-open", onclick: () => openJob(job.id), "aria-current": current ? "true" : null },
        h("span", { class: "history-date" }, formatDateTime(job.createdAt)),
        h("span", { class: "history-meta" },
          `${plural(job.fileCount || 0, "fil", "filer")} · ${LANGUAGE_LABELS[job.targetLanguage] || job.targetLanguage || ""}`),
        h("span", { class: `badge status-${job.status}` }, statusLabel(job.status))
      ),
      canZip ? h("a", { class: "paper quiet zip-small", href: zipUrl(job.id), download: "" }, "Last ned (.zip)")
        : job.filesDeleted ? h("span", { class: "small-note" }, "Filene er slettet") : null
    );
  }));
}

// ---------- Bytt passord ----------

function setupPasswordDialog() {
  const dialog = $("pw-dialog");
  const form = $("pw-form");
  const error = $("pw-error");
  const ok = $("pw-ok");
  $("btn-password").addEventListener("click", () => {
    form.reset();
    error.hidden = true;
    ok.hidden = true;
    dialog.showModal();
  });
  $("pw-cancel").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.hidden = true;
    ok.hidden = true;
    const current = $("pw-current").value;
    const next = $("pw-new").value;
    let message = "";
    if (!current) message = "Skriv inn passordet du bruker nå.";
    else if (next.length < 10) message = "Det nye passordet må ha minst 10 tegn.";
    else if (next !== $("pw-repeat").value) message = "De to nye passordene er ikke like.";
    if (message) {
      error.textContent = message;
      error.hidden = false;
      return;
    }
    const save = $("pw-save");
    save.disabled = true;
    try {
      await api("/api/auth/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      form.reset();
      ok.hidden = false;
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      save.disabled = false;
    }
  });
}

// ---------- Oppstart ----------

function setupInputs() {
  els.btnFiles.addEventListener("click", () => els.inputFiles.click());
  els.btnFolder.addEventListener("click", () => els.inputFolder.click());
  for (const input of [els.inputFiles, els.inputFolder]) {
    input.addEventListener("change", () => {
      addEntries(fromFileList(input.files));
      input.value = "";
    });
  }

  const zone = els.dropzone;
  zone.addEventListener("click", () => {
    if (phase() !== "active") els.inputFiles.click();
  });
  zone.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && phase() !== "active") {
      e.preventDefault();
      els.inputFiles.click();
    }
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    try {
      addEntries(await entriesFromDrop(e.dataTransfer));
    } catch (err) {
      showAlert(`Klarte ikke å lese filene du slapp. ${err.message || ""}`, "Prøv heller knappen «Velg filer» eller «Velg mappe».");
    }
  });
  // Filer sluppet utenfor feltet skal ikke åpnes i nettleseren.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  els.start.addEventListener("click", startJob);
  els.cancel.addEventListener("click", cancelJob);
  els.btnNew.addEventListener("click", () => {
    resetRound();
    els.dropzone.focus();
  });
  els.btnRestart.addEventListener("click", () => {
    if (window.confirm("Vil du tømme inn-kurven og begynne på nytt?")) resetRound();
  });
  $("btn-logout").addEventListener("click", logout);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.job && ACTIVE.has(state.job.status)) {
      clearTimeout(state.pollTimer);
      poll();
    }
  });
}

async function init() {
  setupInputs();
  setupPasswordDialog();
  render();
  try {
    const { user } = await api("/api/auth/me");
    if (user.mustChangePassword) {
      location.href = "/login";
      return;
    }
    els.who.textContent = user.displayName || user.username;
    els.adminLink.hidden = user.role !== "admin";
  } catch (err) {
    showAlert(err.message);
    return;
  }
  await loadHistory();
  // Fortsett der brukeren slapp: en pågående eller ustartet runde åpnes igjen.
  const latest = state.history[0];
  if (latest && !state.job && (ACTIVE.has(latest.status) || latest.status === "draft")) {
    await openJob(latest.id, { scroll: false });
  }
}

init();
