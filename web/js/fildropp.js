// Fildropp nederst på forsiden: Svetlana slipper hvilke som helst filer (et dokument som ble rart, et skjermbilde …)
// og sender dem rett til eieren med en valgfri melding. Ingen oversettelse; eieren ser dem under Admin → Fildropp.
import { api, upload, h, fill, icon, extBadge, plural, formatBytes, formatWhen, relativeTime, track } from "./api.js";

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;

const state = { items: [], busy: false, to: "oversetteren", maxBytes: 100 * 1024 * 1024, maxFiles: 50 };

// Ingen filer valgt, ingen melding skrevet og ingenting som sendes (trygt å laste siden inn på nytt).
export const fildroppIdle = () => !state.busy && !state.items.length && !$("fildropp-note").value.trim();

// Slipp inne i fildroppet: hovedslippsonen (web/js/app.js) skal ikke ta filene.
export const inFildropp = (e) => e.target instanceof Element && Boolean(e.target.closest("#fildropp"));

function bar(percent, label) {
  const fillEl = h("span", { class: "bar-fill" });
  fillEl.style.width = `${percent}%`;
  return h("div", { class: "bar", role: "progressbar", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) }, fillEl);
}

function showError(message) {
  fill($("fildropp-error"), message ? h("p", null, message) : null);
  $("fildropp-error").hidden = !message;
}

function itemMeta(item) {
  if (item.status === "uploading") return `Sender … ${item.pct || 0} %`;
  if (item.status === "done") return `${formatBytes(item.file.size)} · sendt`;
  if (item.status === "error") return item.error;
  return formatBytes(item.file.size);
}

function row(item) {
  const name = item.file.name;
  return h("li", { class: `q q-${item.status === "error" ? "error" : item.status === "done" ? "ready" : "waiting"}` },
    extBadge(name),
    h("div", { class: "q-main" },
      h("p", { class: "q-name" }, name),
      h("p", { class: "q-meta" }, itemMeta(item)),
      item.status === "uploading" ? bar(item.pct || 0, `Sender ${name}`) : null),
    state.busy ? null : h("button", {
      type: "button", class: "icon-btn", "aria-label": `Fjern ${name}`,
      onclick: () => {
        state.items = state.items.filter((x) => x !== item);
        render();
      },
    }, icon("close")));
}

function render() {
  fill($("fildropp-queue"), state.items.map(row));
  const any = state.items.length > 0;
  $("fildropp-more").hidden = !any;
  const button = $("fildropp-send");
  button.disabled = state.busy || !any;
  button.textContent = state.busy ? "Sender …" : `Send ${plural(state.items.length, "fil", "filer")} til ${state.to}`;
  $("fildropp-drop").classList.toggle("is-disabled", state.busy);
}

function addFiles(files, folders = 0) {
  if (state.busy) return;
  showError("");
  $("fildropp-done").hidden = true;
  const problems = [];
  if (folders) problems.push("Mapper kan ikke slippes her. Åpne mappen og velg filene inni den.");
  for (const file of files) {
    if (!file.size) problems.push(`${file.name} er tom.`);
    else if (file.size > state.maxBytes) problems.push(`${file.name} er for stor (maks ${formatBytes(state.maxBytes)}).`);
    else if (state.items.length >= state.maxFiles) problems.push(`Du kan sende maks ${state.maxFiles} filer om gangen.`);
    else if (!state.items.some((x) => x.file.name === file.name && x.file.size === file.size)) state.items.push({ file, status: "waiting" });
  }
  if (problems.length) showError([...new Set(problems)].join(" "));
  render();
}

async function send() {
  if (state.busy || !state.items.length) return;
  state.busy = true;
  showError("");
  render();
  try {
    const { drop } = await api("/api/dropbox", { method: "POST", body: {} });
    for (const item of state.items) {
      item.status = "uploading";
      item.pct = 0;
      render();
      try {
        await upload(`/api/dropbox/${enc(drop.id)}/files?path=${enc(item.file.name)}`, item.file, {
          onProgress: (pct) => {
            item.pct = pct;
            render();
          },
        });
        item.status = "done";
      } catch (err) {
        item.status = "error";
        item.error = err.message;
        track("client.upload_failed", `Fildropp: ${item.file.name} kunne ikke sendes: ${err.message}`, { name: item.file.name, bytes: item.file.size, status: err.status, where: "fildropp" });
      }
      render();
    }
    const sent = state.items.filter((x) => x.status === "done");
    if (!sent.length) throw new Error("Ingen av filene kom fram. Prøv igjen om litt.");
    await api(`/api/dropbox/${enc(drop.id)}/send`, { method: "POST", body: { note: $("fildropp-note").value } });
    const failed = state.items.filter((x) => x.status === "error");
    state.items = failed.map((x) => ({ file: x.file, status: "waiting" }));
    if (!failed.length) $("fildropp-note").value = "";
    fill($("fildropp-done"), icon("check"), h("span", null,
      `Takk! ${state.to} har fått ${plural(sent.length, "fil", "filer")}.`,
      failed.length ? ` ${plural(failed.length, "fil", "filer")} kom ikke fram – de ligger igjen under, trykk Send for å prøve igjen.` : ""));
    $("fildropp-done").hidden = false;
    loadHistory();
  } catch (err) {
    showError(err.message);
    for (const item of state.items) if (item.status !== "error") item.status = "waiting";
  } finally {
    state.busy = false;
    render();
  }
}

function renderHistory(drops) {
  const box = $("fildropp-history");
  if (!drops.length) return fill(box);
  fill(box,
    h("h3", { class: "fildropp-history-title" }, "Sendt tidligere"),
    h("ul", { class: "fildropp-history" }, drops.map((d) => h("li", null,
      h("span", { class: "muted small", title: formatWhen(d.sentAt) }, relativeTime(d.sentAt)),
      " ",
      d.files.map((f) => f.name).join(", ")))));
}

async function loadHistory() {
  try {
    const data = await api("/api/dropbox");
    state.to = data.to || state.to;
    state.maxBytes = (data.maxFileMb || 100) * 1024 * 1024;
    state.maxFiles = data.maxFiles || state.maxFiles;
    $("fildropp-to").textContent = state.to;
    renderHistory(data.drops || []);
    render();
  } catch {
    // Listen er bare til hjelp; selve sendingen gir sin egen feilmelding.
  }
}

$("fildropp-pick").addEventListener("click", () => $("fildropp-input").click());
$("fildropp-input").addEventListener("change", (e) => {
  addFiles([...e.target.files]);
  e.target.value = "";
});
$("fildropp-drop").addEventListener("click", (e) => {
  if (!e.target.closest("button") && !state.busy) $("fildropp-input").click();
});
$("fildropp-send").addEventListener("click", send);

const zone = $("fildropp");
zone.addEventListener("dragover", (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = state.busy ? "none" : "copy";
  $("fildropp-drop").classList.add("is-over");
});
zone.addEventListener("dragleave", (e) => {
  if (!zone.contains(e.relatedTarget)) $("fildropp-drop").classList.remove("is-over");
});
zone.addEventListener("drop", (e) => {
  $("fildropp-drop").classList.remove("is-over");
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  const entries = [...e.dataTransfer.items].filter((item) => item.kind === "file").map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null));
  const files = [...e.dataTransfer.files].filter((_, i) => !(entries[i] && entries[i].isDirectory));
  addFiles(files, entries.filter((x) => x && x.isDirectory).length);
});

render();
loadHistory();
