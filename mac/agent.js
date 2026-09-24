// Mottaket: henter filene Svetlana har sendt, oversetter dem her på Mac-en med Grok CLI
// (samme formatkjerne som ellers, src/core.js) og sender resultatet tilbake. Én fil om gangen.
//
// Feilhåndtering:
//   Grok CLI ikke logget inn / mangler  -> fila legges tilbake i køen, agentstatus «error», pause, nytt forsøk
//   Grok CLI feiler på annen måte        -> som over, men etter 3 forsøk på samme fil regnes den som dokumentfeil
//   Dokumentfeil (skadet, skannet, …)    -> fila markeres som feilet med melding og detaljer
//   Nettverksfeil mot nettstedet         -> prøv igjen med økende pause, behold fila
const os = require("node:os");
const path = require("node:path");
const core = require("../src/core");
const { GrokError } = require("../src/grok");
const { createApi, ApiError } = require("./api");
const { createTransport } = require("./grok-cli");
const estimate = require("./estimate");
const { localDate, safeSegment, safeRelPath, norskName, saveCopy } = require("./local-files");
const { notify } = require("./system");
const { version } = require("../package.json");

const FORWARDED_INFO = new Set(["agent.started", "file.processing", "file.translated"]);
const AGENT_PROBLEMS = new Set(["auth", "no_key", "forbidden"]);
const GONE = new Set([404, 409, 410]);
const MAX_GROK_FAILURES = 3;
const IDLE = "Venter på filer";

// JSON-linjer til stdout (launchd skriver dem til loggfilen); advarsler, feil og nøkkelhendelser også til nettstedet.
function createLogger(write, forward) {
  const at = (level) => (type, message, data) => {
    write(JSON.stringify({ ts: new Date().toISOString(), level, type, message, ...(data && { data }) }));
    if (level !== "info" || FORWARDED_INFO.has(type)) {
      forward({ level, type, message, data, fileId: data && data.fileId, sendingId: data && data.sendingId });
    }
  };
  return { info: at("info"), warn: at("warn"), error: at("error") };
}

// Venter, men våkner med en gang ved stopp. Gir false hvis stoppet.
function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const done = (completed) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorDetails(err) {
  return [err.code ? `Kode: ${err.code}` : "", Array.isArray(err.details) ? err.details.join("\n") : "", err.stack || String(err)]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 8000);
}

function createAgent({ config, token, paths, write = (line) => process.stdout.write(line + "\n") }) {
  const api = createApi({ siteUrl: config.siteUrl, token });
  const log = createLogger(write, (entry) => api.log(entry).catch(() => {}));
  const transport = createTransport(config.grok);
  const stopping = new AbortController();
  const status = { state: "idle", stateMessage: IDLE, grokOk: null };
  const grokFailures = new Map();
  const pollMs = config.pollSeconds * 1000;
  // 20 s normalt, 5 s rett etter arbeid, opptil 60 s ved nettverksfeil (skalerer med pollSeconds).
  const timing = { poll: pollMs, fast: pollMs / 4, max: pollMs * 3 };
  let lastNotice = "";

  const heartbeat = () => api.poll({ host: os.hostname(), version, ...status });
  const setStatus = (state, stateMessage) => Object.assign(status, { state, stateMessage });

  async function retrying(what, fn) {
    for (let delay = timing.fast; ; delay = Math.min(delay * 2, timing.max)) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof ApiError) || !err.retry || stopping.signal.aborted) throw err;
        log.warn("worker.retry", `${what}: ${err.message} Prøver igjen om ${Math.ceil(delay / 1000)} s.`);
        if (!(await wait(delay, stopping.signal))) throw err;
      }
    }
  }

  function keepLocal(target, buffer, ids) {
    try {
      return saveCopy(target, buffer);
    } catch (err) {
      log.warn("local.copy.failed", `Kunne ikke lagre lokal kopi ${target}: ${err.message}`, ids);
      return null;
    }
  }

  // Fremdrift per batch; bare én forespørsel om gangen, og alltid den nyeste. Forlenger leien hver gang.
  function progressReporter(file, est, onGone) {
    let latest = null;
    let flushing = null;
    let stopped = false;
    async function flush() {
      while (latest && !stopped) {
        const body = latest;
        latest = null;
        try {
          await api.progress(file.id, body);
        } catch (err) {
          if (GONE.has(err.status)) return onGone();
          log.warn("progress.failed", `Fremdrift for ${file.name}: ${err.message}`, { fileId: file.id });
        }
      }
    }
    return {
      send(message) {
        if (stopped) return;
        const s = est.snapshot();
        latest = {
          percent: s.percent,
          etaSeconds: s.etaSeconds,
          message: message || `${s.done} av ${s.total} deler ferdig`,
          leaseSeconds: config.leaseSeconds,
        };
        setStatus("working", `Oversetter ${file.name} – ${Math.round(s.percent)} %`);
        if (!flushing) flushing = flush().finally(() => (flushing = null));
      },
      async stop() {
        stopped = true;
        latest = null;
        await flushing;
      },
    };
  }

  async function processFile(file) {
    const ids = { fileId: file.id, sendingId: file.sendingId };
    const relPath = file.relPath || file.name;
    const ext = file.ext || core.extOf(file.name);
    const job = new AbortController();
    const stop = () => job.abort();
    stopping.signal.addEventListener("abort", stop, { once: true });
    const samples = [];
    let costUsd = 0;
    let gone = false;
    let beat = null;
    let reporter = null;
    try {
      if (!(await retrying("Reservering", () => api.claim(file.id, config.leaseSeconds)))) {
        log.info("file.skipped", `${file.name} er allerede tatt eller borte.`, ids);
        return "skipped";
      }
      const started = Date.now();
      const sender = file.displayName || file.username || "Ukjent";
      setStatus("working", `Oversetter ${file.name}`);
      log.info("file.processing", `Oversetter ${file.name} fra ${sender}.`, { ...ids, bytes: file.bytes, targetLanguage: file.targetLanguage });

      const original = await retrying("Nedlasting", () => api.original(file.id));
      const folder = path.join(config.outputDir, `${localDate()} ${safeSegment(sender)}`);
      const copy = keepLocal(path.join(folder, ...safeRelPath(relPath)), original, ids);
      const plan = await core.analyzeBuffer(original, ext);
      const model = estimate.fitModel(estimate.loadSamples(paths.statsFile));
      const est = estimate.createEstimator({ plan, model, concurrency: config.concurrency });
      reporter = progressReporter(file, est, () => {
        gone = true;
        job.abort();
      });
      reporter.send("Starter oversettelsen");
      beat = setInterval(() => {
        heartbeat().catch(() => {});
        reporter.send();
      }, Math.min(timing.max, (config.leaseSeconds * 1000) / 3));

      const result = await core.translateBuffer(original, ext, {
        transport,
        targetLanguage: file.targetLanguage === "nynorsk" ? "nynorsk" : "bokmal",
        concurrency: config.concurrency,
        timeoutMs: config.grok.timeoutSeconds * 1000,
        retryDelayMs: config.retryDelayMs,
        signal: job.signal,
        onBatch: (b) => {
          samples.push({ chars: b.chars, ms: b.ms });
          est.batchDone(b.chars);
          reporter.send();
        },
        onCall: (c) => {
          if (Number.isFinite(c.costUsd)) costUsd += c.costUsd;
        },
        onWarning: (w) => log.warn("file.warning", `${file.name}: ${w.message}`, { ...ids, code: w.code }),
      });
      clearInterval(beat);
      await reporter.stop();
      status.grokOk = true;

      if (copy) keepLocal(norskName(copy, result.outExt), result.buffer, ids);
      const outputName = path.posix.basename(core.outputNameFor(relPath.replace(/\\/g, "/")));
      await retrying("Opplasting", () => api.result(file.id, { name: outputName, costUsd, buffer: result.buffer }));

      grokFailures.delete(file.id);
      lastNotice = "";
      const seconds = Math.round((Date.now() - started) / 1000);
      log.info("file.translated", `${file.name} er oversatt (${seconds} s, $${costUsd.toFixed(4)}).`, {
        ...ids,
        seconds,
        chars: plan.chars,
        batches: plan.batches,
        costUsd,
        warnings: result.warnings.length,
        outputName,
      });
      notify(paths.bins.osascript, "InnNorsk", `Ferdig oversatt: ${file.name} (fra ${sender})`);
      return "done";
    } catch (err) {
      return await handleFailure(file, err, { gone, costUsd });
    } finally {
      clearInterval(beat);
      if (reporter) await reporter.stop();
      stopping.signal.removeEventListener("abort", stop);
      if (status.state === "working") setStatus("idle", IDLE);
      if (samples.length) {
        try {
          estimate.saveSamples(paths.statsFile, [...estimate.loadSamples(paths.statsFile), ...samples]);
        } catch {
          // statistikken er bare til estimater
        }
      }
    }
  }

  async function handleFailure(file, err, { gone, costUsd }) {
    const ids = { fileId: file.id, sendingId: file.sendingId };
    if (gone || GONE.has(err.status)) {
      log.info("file.gone", `${file.name} ble slettet eller endret på nettstedet underveis. Hopper over.`, ids);
      return "gone";
    }
    if (stopping.signal.aborted) {
      await api.release(file.id, "Mottaket på Mac-en ble stoppet.").catch((e) => log.warn("file.release.failed", e.message, ids));
      log.info("file.released", `${file.name} er lagt tilbake i køen fordi mottaket stoppet.`, ids);
      return "stopped";
    }
    if (err instanceof ApiError && err.status === 401) {
      log.error("worker.unauthorized", err.message, ids);
      return "error";
    }
    if (err instanceof GrokError) {
      const agentProblem = AGENT_PROBLEMS.has(err.code);
      const strikes = (grokFailures.get(file.id) || 0) + 1;
      if (agentProblem || strikes < MAX_GROK_FAILURES) {
        if (agentProblem) status.grokOk = false;
        else grokFailures.set(file.id, strikes);
        setStatus("error", err.message);
        await retrying("Frigjøring", () => api.release(file.id, err.message)).catch((e) =>
          log.warn("file.release.failed", e.message, ids)
        );
        log.error("agent.error", `${err.message} ${file.name} er lagt tilbake i køen.`, { ...ids, code: err.code });
        if (lastNotice !== err.message) {
          lastNotice = err.message;
          notify(paths.bins.osascript, "InnNorsk trenger hjelp", err.message);
        }
        return "paused";
      }
    }
    grokFailures.delete(file.id);
    await retrying("Feilmelding", () => api.fail(file.id, { message: err.message, details: errorDetails(err), costUsd }));
    log.error("file.failed", `Kunne ikke oversette ${file.name}: ${err.message}`, { ...ids, code: err.code });
    return "failed";
  }

  // Etter et Grok-problem: vent (5 min), men fortsett å melde fra, så eieren ser feilmeldingen.
  async function pause() {
    const until = Date.now() + config.pauseSeconds * 1000;
    log.info("agent.paused", `Prøver igjen om ${estimate.formatDuration(config.pauseSeconds)}.`);
    while (Date.now() < until && (await wait(Math.min(timing.max, until - Date.now()), stopping.signal))) {
      await heartbeat().catch(() => {});
    }
  }

  // once: behandle det som venter nå, og avslutt. Gir avslutningskode.
  async function run({ once = false } = {}) {
    const { signal } = stopping;
    log.info("agent.started", `Mottaket startet på ${os.hostname()} (versjon ${version}).`, { once, siteUrl: config.siteUrl });
    const tried = new Set();
    let delay = timing.poll;
    while (!signal.aborted) {
      let files;
      try {
        files = await heartbeat();
        delay = timing.poll;
      } catch (err) {
        if (err.status === 401) log.error("worker.unauthorized", `${err.message} Kjør «setup» på nytt med riktig AGENT_TOKEN.`);
        else log.warn("worker.unreachable", err.message);
        if (once) return 1;
        delay = err.status === 401 ? timing.max : Math.min(delay * 2, timing.max);
        await wait(delay, signal);
        continue;
      }
      const todo = files.filter((f) => !tried.has(f.id));
      if (!todo.length) {
        if (once) break;
        await wait(timing.poll, signal);
        continue;
      }
      for (const file of todo) {
        if (signal.aborted) break;
        if (once) tried.add(file.id);
        let outcome;
        try {
          outcome = await processFile(file);
        } catch (err) {
          log.error("agent.error", `Uventet feil med ${file.name}: ${err.message}`, { fileId: file.id, stack: err.stack });
        }
        if (outcome === "paused") {
          await heartbeat().catch(() => {});
          if (once) return 1;
          await pause();
          break;
        }
      }
      if (!once) await wait(timing.fast, signal);
    }
    log.info("agent.stopped", "Mottaket stoppet.");
    return 0;
  }

  return { run, processFile, stop: () => stopping.abort(), status };
}

module.exports = { createAgent };
