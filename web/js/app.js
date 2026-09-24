import {
  api, upload, h, fill, icon, extBadge, baseName, dirName, extOf, plural, formatBytes, formatClock, formatDuration,
  dayLabel, LANGUAGE_LABELS, remember, recall, confirmDialog, toast, logout, reportErrors, initMenu,
  changePassword, passwordProblem,
} from "./api.js";

reportErrors();
initMenu();

// Samme liste som SUPPORTED i src/core.js. Serveren sjekker uansett; dette er for å kunne forklare med én gang.
const SUPPORTED = new Set([".docx", ".pptx", ".xlsx", ".pdf", ".txt", ".md", ".csv", ".html", ".htm", ".rtf"]);
const OLD_OFFICE = new Set([".doc", ".ppt", ".xls"]);
const MAX_FILE_MB = 50; // MAX_FILE_MB i wrangler.jsonc
const MAX_FILES = 50; // MAX_FILES_PER_SENDING i wrangler.jsonc
const PERMANENT = new Set([400, 413, 415]); // gjelder bare den ene filen; resten kan sendes
const ACTIVE = new Set(["sent", "working"]);
const LANG_KEY = "innnorsk.language";
const SEEN_KEY = "innnorsk.seenDone";

const SKIP_TEXT = {
  lock: "Midlertidige filer som Word og Office lager mens et dokument er åpent (navnet starter med ~$). Selve dokumentet er med.",
  hidden: "Skjulte systemfiler, som .DS_Store og Thumbs.db. Det er ikke dokumenter.",
  type: "Filtyper som ikke kan oversettes, for eksempel bilder.",
  empty: "Tomme filer.",
  big: `Filer som er større enn ${MAX_FILE_MB} MB.`,
  duplicate: "Filer som allerede ligger i listen.",
  many: `Mer enn ${MAX_FILES} filer på en gang. Send gjerne resten etterpå.`,
};
const HARMLESS = new Set(["lock", "hidden", "duplicate", "empty"]);

const PILL = {
  draft: "Ikke sendt ennå",
  sent: "Mottatt",
  working: "Oversettes nå",
  done: "Ferdig",
  failed: "Oversetteren ser på denne filen",
};

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;

const state = {
  me: null,
  translator: "oversetteren",
  queue: [], // { file, path, status: "ready" | "uploading" | "done" | "error", pct, error, fileId, el }
  draft: null, // sendingen på serveren mens filene lastes opp
  sending: false,
  sendings: [],
  statuses: new Map(), // fil-ID → status sist vi tegnet, for å merke overganger
  seen: null, // ferdige fil-ID-er hun har sett (localStorage)
  fresh: new Set(), // ferdige siden forrige besøk; fremheves så lenge siden er åpen
  pollTimer: 0,
  failures: 0,
};

function say(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

function bar(percent, label) {
  const fillEl = h("span", { class: "bar-fill" });
  fillEl.style.width = `${percent}%`;
  return h("div", { class: "bar", role: "progressbar", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(percent)) }, fillEl);
}

// ---------- Velge filer ----------

function skipReason(path, file, known) {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  if (name.startsWith("~$") || name.startsWith(".~lock")) return "lock";
  if (parts.some((p) => p.startsWith(".")) || /^(thumbs\.db|desktop\.ini)$/i.test(name)) return "hidden";
  if (!SUPPORTED.has(extOf(name))) return "type";
  if (file.size === 0) return "empty";
  if (file.size > MAX_FILE_MB * 1024 * 1024) return "big";
  if (known.has(path.toLowerCase())) return "duplicate";
  if (known.size >= MAX_FILES) return "many";
  return null;
}

function addFiles(entries) {
  if (state.sending) return;
  showCompose();
  const known = new Set(state.queue.map((item) => item.path.toLowerCase()));
  const skipped = {};
  for (const { file, path } of entries) {
    const reason = skipReason(path, file, known);
    if (reason) {
      (skipped[reason] ||= []).push(path);
      continue;
    }
    known.add(path.toLowerCase());
    state.queue.push({ file, path, status: "ready", pct: 0, error: "", fileId: null, el: null });
  }
  renderSkipped(skipped);
  renderQueue();
}

function renderSkipped(skipped) {
  const box = $("skipped");
  const reasons = Object.keys(skipped);
  if (!reasons.length) {
    box.hidden = true;
    return;
  }
  const total = reasons.reduce((n, r) => n + skipped[r].length, 0);
  const names = (paths) => {
    const list = paths.map(baseName);
    return list.slice(0, 3).join(", ") + (list.length > 3 ? ` og ${list.length - 3} til` : "");
  };
  const oldOffice = (skipped.type || []).some((p) => OLD_OFFICE.has(extOf(p)));
  const harmless = reasons.every((r) => HARMLESS.has(r));
  fill(box,
    h("button", { type: "button", class: "icon-btn notice-close", "aria-label": "Lukk meldingen", onclick: () => { box.hidden = true; } }, icon("close")),
    h("p", null, h("strong", null, harmless
      ? `Vi hoppet over ${plural(total, "fil", "filer")} – det er helt i orden:`
      : `${total === 1 ? "Én fil" : `${total} filer`} ble ikke tatt med:`)),
    h("ul", null, reasons.map((r) => h("li", null, SKIP_TEXT[r], " ", h("span", { class: "muted" }, `(${names(skipped[r])})`)))),
    skipped.type ? h("p", null, "Dette kan sendes: Word (.docx), PowerPoint (.pptx), Excel (.xlsx), PDF, tekst (.txt, .md, .csv), nettsider (.html) og RTF.") : null,
    oldOffice ? h("p", null, "Har du en eldre Office-fil (.doc, .ppt eller .xls)? Åpne den, velg «Lagre som» og lagre den i det nye formatet (.docx, .pptx eller .xlsx).") : null
  );
  box.hidden = false;
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

function removeItem(item) {
  state.queue = state.queue.filter((other) => other !== item);
  if (item.fileId && state.draft) {
    api(`/api/sendings/${enc(state.draft.id)}/files/${enc(item.fileId)}`, { method: "DELETE" }).catch(() => {});
  }
  say($("send-error"), "");
  renderQueue();
  $(state.queue.length ? "btn-send" : "btn-files").focus();
}

function queueStatus(item) {
  if (item.status === "uploading") return `Laster opp … ${item.pct} %`;
  if (item.status === "done") return [icon("check"), "Lastet opp"];
  if (item.status === "error") return item.error;
  return formatBytes(item.file.size);
}

function renderQueue() {
  fill($("queue"), state.queue.map((item) => {
    const name = baseName(item.path);
    item.el = h("li", { class: `q q-${item.status}` },
      extBadge(name),
      h("div", { class: "q-main" },
        h("p", { class: "q-name" }, dirName(item.path) ? h("span", { class: "q-dir" }, dirName(item.path)) : null, name),
        h("p", { class: "q-meta" }, queueStatus(item)),
        item.status === "uploading" ? bar(item.pct, `Opplasting av ${name}`) : null
      ),
      h("button", { type: "button", class: "icon-btn", "aria-label": `Fjern ${name}`, disabled: state.sending, onclick: () => removeItem(item) }, icon("close"))
    );
    return item.el;
  }));
  const count = state.queue.length;
  const bytes = state.queue.reduce((n, item) => n + item.file.size, 0);
  $("summary").textContent = count ? `${plural(count, "fil", "filer")} · ${formatBytes(bytes)}` : "";
  $("compose-more").hidden = !count;
  $("btn-send").disabled = !count || state.sending;
}

function progressItem(item, pct) {
  item.pct = pct;
  if (!item.el) return;
  item.el.querySelector(".q-meta").textContent = queueStatus(item);
  const barEl = item.el.querySelector(".bar");
  barEl.setAttribute("aria-valuenow", String(pct));
  barEl.firstChild.style.width = `${pct}%`;
}

// ---------- Sende ----------

function setSending(on) {
  state.sending = on;
  const button = $("btn-send");
  button.textContent = on ? "Sender …" : `Send til ${state.translator}`;
  button.classList.toggle("is-busy", on);
  for (const id of ["btn-files", "btn-folder", "note"]) $(id).disabled = on;
  for (const radio of document.querySelectorAll('input[name="lang"]')) radio.disabled = on;
  $("drop").classList.toggle("is-disabled", on);
  renderQueue();
}

function forgetDraft() {
  state.draft = null;
  for (const item of state.queue) Object.assign(item, { fileId: null, status: "ready", error: "" });
}

async function uploadItem(item) {
  Object.assign(item, { status: "uploading", pct: 0, error: "" });
  renderQueue();
  try {
    const url = `/api/sendings/${enc(state.draft.id)}/files?path=${enc(item.path)}`;
    const { file } = await upload(url, item.file, { onProgress: (pct) => progressItem(item, pct) });
    Object.assign(item, { status: "done", fileId: file.id });
  } catch (err) {
    Object.assign(item, { status: "error", error: err.message });
    if (!PERMANENT.has(err.status)) throw err;
  } finally {
    renderQueue();
  }
}

async function send() {
  if (state.sending || !state.queue.length) return;
  const targetLanguage = document.querySelector('input[name="lang"]:checked').value;
  const note = $("note").value.trim();
  const error = $("send-error");
  say(error, "");
  setSending(true);
  try {
    if (state.draft && state.draft.targetLanguage !== targetLanguage) {
      await api(`/api/sendings/${enc(state.draft.id)}`, { method: "DELETE" }).catch(() => {});
      forgetDraft();
    }
    if (!state.draft) {
      state.draft = (await api("/api/sendings", { method: "POST", body: { targetLanguage, note: note || undefined } })).sending;
    } else if ((state.draft.note || "") !== note) {
      await api(`/api/sendings/${enc(state.draft.id)}/note`, { method: "POST", body: { note } });
      state.draft.note = note;
    }
    for (const item of state.queue) {
      if (item.status !== "done") await uploadItem(item);
    }
    const failed = state.queue.filter((item) => item.status === "error").length;
    if (failed) {
      say(error, `${failed === 1 ? "Én fil" : `${failed} filer`} kunne ikke sendes (se listen over). Fjern ${failed === 1 ? "den" : "dem"}, og trykk «Send» igjen.`);
      return;
    }
    const { sending } = await api(`/api/sendings/${enc(state.draft.id)}/send`, { method: "POST" });
    showThanks(sending);
  } catch (err) {
    if (err.status === 404) forgetDraft();
    say(error, `${err.message} Trykk «Send» for å prøve igjen – det som allerede er lastet opp, sendes ikke på nytt.`);
  } finally {
    setSending(false);
  }
}

function showThanks(sending) {
  const count = sending.files ? sending.files.length : state.queue.length;
  const t = state.translator;
  state.queue = [];
  state.draft = null;
  $("note").value = "";
  $("skipped").hidden = true;
  renderQueue();
  $("thanks-title").textContent = count === 1 ? "Takk! Filen er sendt." : "Takk! Filene er sendt.";
  $("thanks-lead").textContent = sending.agentOnline === false
    ? `${t} har fått beskjed. Oversettelsen starter når ${t} er klar – filene venter trygt her så lenge.`
    : `${t} har fått beskjed.`;
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

function etaText(progress) {
  if (!progress || progress.etaSeconds == null) return "Beregner hvor lang tid det tar …";
  const finish = (Date.parse(progress.at) || Date.now()) + progress.etaSeconds * 1000;
  const left = (finish - Date.now()) / 1000;
  if (left < 20) return "Straks ferdig …";
  return `${formatDuration(left)} igjen – ferdig rundt kl. ${formatClock(finish)}`;
}

function fileRow(file) {
  const fresh = state.fresh.has(file.id);
  const known = state.statuses.has(file.id);
  const percent = file.progress ? Math.max(0, Math.min(100, Math.round(file.progress.percent))) : 0;
  const pill = file.status === "working"
    ? `${PILL.working}${file.progress ? ` · ${percent} %` : ""}`
    : file.status === "done" ? PILL.done : file.statusText || PILL[file.status] || file.status;
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
          ? h("span", { class: "row-detail" }, `kl. ${formatClock(file.finishedAt)}${file.outputBytes ? ` · ${formatBytes(file.outputBytes)}` : ""}`)
          : null
      ),
      file.status === "working" ? [bar(percent, `Fremdrift for ${file.name}`), h("p", { class: "row-eta" }, etaText(file.progress))] : null
    ),
    file.status === "done"
      ? h("div", { class: "row-actions" },
        h("a", { class: "btn btn-primary btn-download", href: `/api/files/${enc(file.id)}/result`, download: "", "data-key": `dl-${file.id}`, "aria-label": `Last ned ${outName}` }, icon("download"), "Last ned"),
        h("a", { class: "link-small", href: `/api/files/${enc(file.id)}/original`, download: "", "data-key": `og-${file.id}`, "aria-label": `Original: ${file.name}` }, "Original"))
      : null
  );
}

function sendingBlock(s) {
  const lang = LANGUAGE_LABELS[s.targetLanguage] || "";
  const when = s.status === "draft" ? "Ikke sendt" : `Sendt kl. ${formatClock(s.sentAt || s.createdAt)}`;
  return h("article", { class: "sending" },
    h("div", { class: "sending-head" },
      h("p", { class: "sending-meta" }, [when, lang, plural(s.files.length, "fil", "filer")].filter(Boolean).join(" · ")),
      h("button", { type: "button", class: "btn-quiet", "data-key": `del-${s.id}`, onclick: () => removeSending(s) }, icon("trash"), "Slett")
    ),
    s.note ? h("p", { class: "my-note" }, h("span", { class: "muted" }, "Din melding: "), `«${s.note}»`) : null,
    s.status === "draft"
      ? h("div", { class: "draft-box" },
        h("p", null, "Disse filene ble ikke sendt – kanskje ble siden lukket underveis."),
        h("button", { type: "button", class: "btn btn-primary btn-small", "data-key": `send-${s.id}`, onclick: () => sendDraft(s) }, `Send til ${state.translator} nå`))
      : null,
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
      h("p", { class: "muted" }, "Når du har sendt noe, kan du følge med her og laste ned når det er ferdig.")));
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
  document.title = ready ? `(${ready} ${ready === 1 ? "klar" : "klare"}) InnNorsk` : "InnNorsk";
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
    state.sendings = sendings || [];
    state.failures = 0;
    $("mine-error").hidden = true;
    trackDone();
    renderMine();
    state.statuses = new Map(state.sendings.flatMap((s) => s.files).map((f) => [f.id, f.status]));
  } catch (err) {
    state.failures++;
    if (err.status !== 401) {
      fill($("mine-error"), h("p", null, "Fikk ikke hentet filene dine akkurat nå. Vi prøver igjen av oss selv."));
      $("mine-error").hidden = false;
    }
  }
  schedule();
}

async function removeSending(s) {
  const ok = await confirmDialog({
    title: "Slette denne sendingen?",
    text: `${plural(s.files.length, "fil", "filer")} og oversettelsene blir slettet for godt. Det kan ikke angres.`,
    confirm: "Ja, slett",
    cancel: "Nei, behold",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/sendings/${enc(s.id)}`, { method: "DELETE" });
    state.sendings = state.sendings.filter((other) => other.id !== s.id);
    renderMine();
    toast("Sendingen er slettet.");
    $("mine").focus();
  } catch (err) {
    toast(err.message);
  }
}

async function sendDraft(s) {
  try {
    await api(`/api/sendings/${enc(s.id)}/send`, { method: "POST" });
    toast(`Sendt! ${state.translator} har fått beskjed.`);
    refresh();
  } catch (err) {
    toast(err.message);
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
  }
  button.disabled = false;
  button.textContent = "Lagre nytt passord";
});

// ---------- Oppstart og hendelser ----------

function personalize({ user, translatorName }) {
  state.me = user;
  const t = translatorName || "oversetteren";
  state.translator = t;
  $("hello").textContent = `Hei, ${user.displayName || user.username}!`;
  $("hello-lead").textContent = `Her sender du dokumenter til ${t}, som oversetter dem til norsk. Ferdige oversettelser finner du under «Mine filer».`;
  $("send-title").textContent = `Send dokumenter til ${t}`;
  $("note-label").textContent = `Melding til ${t} (valgfritt)`;
  $("btn-send").textContent = `Send til ${t}`;
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
  if (state.sending) return;
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
  radio.addEventListener("change", () => remember(LANG_KEY, radio.value));
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
  if (state.sending) e.preventDefault();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) schedule();
  else refresh();
});

api("/api/auth/me").then((me) => {
  personalize(me);
  renderQueue();
  if (me.user.mustChangePassword) openPassword(true);
  refresh();
}).catch((err) => {
  if (err.status === 401) return;
  fill($("mine-error"), h("p", null, err.message));
  $("mine-error").hidden = false;
});
