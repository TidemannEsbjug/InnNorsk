import "./styles.css";
import { Buffer } from "buffer";
import { SUPPORTED, translateUpload } from "./pipeline-web.js";

globalThis.Buffer = Buffer;
globalThis.__INNNORSK_GROK_PROXY = "/api/grok";

const app = document.getElementById("app");

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Feil ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function renderLogin(error = "") {
  app.innerHTML = `
    <div class="wrap">
      <p class="eyebrow">InnNorsk på nett</p>
      <h1>Dokumenter inn.<br>Norsk ut.</h1>
      <p class="lede">Logg inn for å laste opp filer. Oversettelsen skjer med Grok. Passord og API-nøkkel ligger ikke i siden.</p>
      <form class="card" id="login-form">
        <div class="lip">Inngang</div>
        <div class="card-body">
          <label>
            <span>Brukernavn</span>
            <input name="username" type="text" autocomplete="username" required />
          </label>
          <label>
            <span>Passord</span>
            <input name="password" type="password" autocomplete="current-password" required />
          </label>
          <button class="paper" type="submit">Logg inn</button>
          <p class="status" id="login-status">${error}</p>
        </div>
      </form>
    </div>`;
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const status = document.getElementById("login-status");
    status.textContent = "Sjekker…";
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: String(fd.get("username") || ""),
          password: String(fd.get("password") || ""),
        }),
      });
      await showApp();
    } catch (err) {
      status.textContent = err.message || String(err);
    }
  });
}

function fileRow(id, file) {
  return `<li id="${id}">
    <div class="name">${file.name}</div>
    <div class="meta" data-meta>Klar · ${formatBytes(file.size)}</div>
  </li>`;
}

async function showApp(user = "Svetlana") {
  app.innerHTML = `
    <div class="wrap">
      <div class="top">
        <div>
          <p class="eyebrow">Innlogget som ${user}</p>
          <h1>InnNorsk</h1>
          <p class="lede">Last opp Word, PDF, PowerPoint, Excel eller tekst. Du får norske filer tilbake, med samme layout.</p>
        </div>
        <button class="ghost" id="logout" type="button">Logg ut</button>
      </div>
      <section class="card">
        <div class="lip">Inn-kurv</div>
        <div class="card-body">
          <div class="drop" id="drop" tabindex="0">
            Slipp filer her, eller klikk for å velge<br>
            <span class="hint">${SUPPORTED.join(" ")}</span>
          </div>
          <input id="picker" type="file" multiple class="hide" accept="${SUPPORTED.join(",")}" />
          <ul class="jobs" id="jobs"></ul>
          <div class="row" style="margin-top:16px">
            <button class="stamp" id="go" type="button">Oversett til norsk</button>
          </div>
          <div class="bar" id="barwrap"><span id="bar"></span></div>
          <div class="banner" id="banner">
            <strong>Ingenting er sendt ennå.</strong>
            Når du trykker stemplet, jobber Grok med én bit av gangen. Det kan ta flere minutter. Statusen under oppdateres hele tiden — lukk ikke fanen.
          </div>
        </div>
      </section>
    </div>`;

  const files = [];
  const drop = document.getElementById("drop");
  const picker = document.getElementById("picker");
  const jobs = document.getElementById("jobs");
  const banner = document.getElementById("banner");
  const bar = document.getElementById("bar");
  const go = document.getElementById("go");

  function addFiles(list) {
    for (const file of list) {
      files.push(file);
      const id = `f-${files.length - 1}`;
      jobs.insertAdjacentHTML("beforeend", fileRow(id, file));
    }
  }

  drop.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => addFiles(picker.files));
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    addFiles(e.dataTransfer.files);
  });

  document.getElementById("logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    renderLogin();
  });

  go.addEventListener("click", async () => {
    if (!files.length) {
      banner.innerHTML = "<strong>Velg filer først.</strong> Slipp dem i inn-kurven.";
      return;
    }
    go.disabled = true;
    const results = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const li = document.getElementById(`f-${i}`);
      const meta = li.querySelector("[data-meta]");
      li.className = "working";
      banner.innerHTML = `<strong>Oversetter fil ${i + 1} av ${files.length}: ${file.name}</strong><br>Grok leser teksten i biter. Dette kan ta et par minutter per dokument. Ikke lukk fanen.`;
      bar.style.width = `${Math.round((i / files.length) * 100)}%`;
      try {
        const out = await translateUpload(file, {
          targetLanguage: "bokmal",
          onProgress: ({ done, total }) => {
            meta.textContent = `Oversetter avsnitt ${done} av ${total}…`;
            const inner = total ? done / total : 0;
            bar.style.width = `${Math.round(((i + inner) / files.length) * 100)}%`;
            banner.innerHTML = `<strong>Jobber med ${file.name}</strong><br>Avsnitt ${done} av ${total} er sendt til Grok. Fil ${i + 1} av ${files.length}. Vent til du ser «Ferdig» og en last-ned-lenke.`;
          },
        });
        const url = URL.createObjectURL(out.blob);
        results.push({ ...out, url });
        li.className = "done";
        meta.innerHTML = `Ferdig · <a class="dl" href="${url}" download="${out.name}">Last ned ${out.name}</a>`;
      } catch (err) {
        li.className = "error";
        meta.textContent = err.message || String(err);
        banner.innerHTML = `<strong>Noe stoppet.</strong> ${err.message || err}`;
      }
    }
    go.disabled = false;
    bar.style.width = "100%";
    const ok = results.length;
    if (ok) {
      banner.innerHTML = `<strong>Ferdig. ${ok} fil${ok === 1 ? "" : "er"} oversatt.</strong> Last ned med de grønne radene under. Originalene på maskinen din er uendret.`;
    }
  });
}

async function boot() {
  try {
    const me = await api("/api/me");
    await showApp(me.user);
  } catch {
    renderLogin();
  }
}

boot();
