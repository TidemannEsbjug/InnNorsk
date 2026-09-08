const api = window.innnorsk;

const $ = (id) => document.getElementById(id);

const els = {
  keyPill: $("key-pill"),
  inPath: $("in-path"),
  outPath: $("out-path"),
  statCount: $("stat-count"),
  statDone: $("stat-done"),
  jobList: $("job-list"),
  stamp: $("btn-translate"),
  stampSub: $("stamp-sub"),
  cancel: $("btn-cancel"),
  pressNote: $("press-note"),
  drawer: $("drawer"),
  fieldKey: $("field-key"),
  fieldModel: $("field-model"),
  fieldLang: $("field-lang"),
  fieldSkip: $("field-skip"),
  settingsStatus: $("settings-status"),
};

let files = [];
let busy = false;

function shortPath(p) {
  if (!p) return "Ingen mappe valgt";
  const parts = p.replace(/\\/g, "/").split("/");
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-3).join("/")}`;
}

function setPill(hasKey) {
  els.keyPill.textContent = hasKey ? "API-nøkkel lagret" : "Mangler API-nøkkel";
  els.keyPill.className = hasKey ? "pill ok" : "pill warn";
}

function renderJobs() {
  if (!files.length) {
    els.jobList.innerHTML = `<li class="empty">Tomt. Velg en inn-mappe for å se dokumentene.</li>`;
    return;
  }
  els.jobList.innerHTML = files
    .map((f, i) => {
      const state = f.uiStatus || (f.alreadyTranslated ? "skipped" : "");
      const msg =
        f.uiMessage ||
        (f.alreadyTranslated ? "Finnes i ut-kurven" : f.ext.replace(".", "").toUpperCase());
      return `<li class="${state}" data-i="${i}">
        <div class="name">${escapeHtml(f.name)}</div>
        <div class="meta"><span>${msg}</span><span>${formatBytes(f.bytes)}</span></div>
      </li>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function refresh(settings) {
  const s = settings || (await api.getSettings());
  setPill(s.hasApiKey);
  els.inPath.textContent = shortPath(s.inputFolder);
  els.outPath.textContent = shortPath(s.outputFolder) || "oversatt/";
  els.fieldKey.value = s.apiKey || "";
  els.fieldModel.value = s.model || "grok-4.6";
  els.fieldLang.value = s.targetLanguage || "bokmal";
  els.fieldSkip.checked = s.skipExisting !== false;

  if (!s.inputFolder) {
    files = [];
    els.statCount.textContent = "0";
    els.statDone.textContent = "0";
    renderJobs();
    return s;
  }

  const scan = await api.scanFolder();
  files = scan.files || [];
  els.statCount.textContent = String(files.length);
  els.statDone.textContent = String(files.filter((f) => f.alreadyTranslated).length);
  renderJobs();
  if (scan.error) els.pressNote.textContent = scan.error;
  return s;
}

function openDrawer() {
  els.drawer.hidden = false;
}
function closeDrawer() {
  els.drawer.hidden = true;
}

$("btn-settings").addEventListener("click", openDrawer);
$("drawer-scrim").addEventListener("click", closeDrawer);

$("btn-pick-in").addEventListener("click", async () => {
  const s = await api.pickFolder("input");
  if (s) await refresh(s);
});
$("btn-pick-out").addEventListener("click", async () => {
  const s = await api.pickFolder("output");
  if (s) await refresh(s);
});
$("btn-open-in").addEventListener("click", () => api.openFolder("input"));
$("btn-open-out").addEventListener("click", () => api.openFolder("output"));

$("link-console").addEventListener("click", (e) => {
  e.preventDefault();
  api.openExternal("https://console.x.ai");
});

$("btn-save").addEventListener("click", async () => {
  const s = await api.saveSettings({
    apiKey: els.fieldKey.value.trim(),
    model: els.fieldModel.value,
    targetLanguage: els.fieldLang.value,
    skipExisting: els.fieldSkip.checked,
  });
  els.settingsStatus.textContent = "Lagret på denne maskinen.";
  await refresh(s);
});

$("btn-test").addEventListener("click", async () => {
  await api.saveSettings({
    apiKey: els.fieldKey.value.trim(),
    model: els.fieldModel.value,
  });
  els.settingsStatus.textContent = "Kobler til xAI…";
  try {
    const r = await api.testApi();
    els.settingsStatus.textContent = r.ok
      ? "Tilkobling OK. Grok svarte."
      : "Fikk ikke kontakt.";
  } catch (err) {
    els.settingsStatus.textContent = err.message || String(err);
  }
});

api.onProgress((p) => {
  const file = files[p.index];
  if (file) {
    file.uiStatus = p.status;
    file.uiMessage = p.message;
    renderJobs();
  }
  els.stampSub.textContent = `${p.index + 1} / ${p.total}`;
});

$("btn-cancel").addEventListener("click", () => api.cancel());

els.stamp.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  els.stamp.classList.add("busy");
  els.stamp.disabled = true;
  els.cancel.classList.remove("hidden");
  els.pressNote.textContent = "Oversetter. Originalene røres ikke.";
  try {
    await api.saveSettings({
      apiKey: els.fieldKey.value.trim(),
      model: els.fieldModel.value,
      targetLanguage: els.fieldLang.value,
      skipExisting: els.fieldSkip.checked,
    });
    const result = await api.translate();
    const ok = result.results.filter((r) => r.ok && !r.skipped).length;
    const skip = result.results.filter((r) => r.skipped).length;
    const fail = result.results.filter((r) => !r.ok).length;
    els.pressNote.textContent = result.cancelled
      ? `Avbrutt. ${ok} ferdig, ${fail} feilet.`
      : `${ok} oversatt, ${skip} hoppet over, ${fail} feilet.`;
    await refresh();
  } catch (err) {
    els.pressNote.textContent = err.message || String(err);
    if (/API-nøkkel/i.test(err.message || "")) openDrawer();
  } finally {
    busy = false;
    els.stamp.classList.remove("busy");
    els.stamp.disabled = false;
    els.cancel.classList.add("hidden");
    els.stampSub.textContent = "Stempler ut-kurven";
  }
});

refresh();
