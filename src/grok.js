const LANGUAGE_LABEL = {
  bokmal: "norsk bokmål",
  nynorsk: "norsk nynorsk",
};

const MAX_BATCH_CHARS = 7000;
const MAX_BATCH_ITEMS = 28;
const MAX_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 240000;

// code: auth | forbidden | rate_limit | server | network | timeout | bad_response | cancelled | no_key
class GrokError extends Error {
  constructor(code, message, { status, retryAfterMs, cause } = {}) {
    super(message);
    this.name = "GrokError";
    this.code = code;
    this.status = status || 0;
    this.retryAfterMs = retryAfterMs || 0;
    this.retryable = ["rate_limit", "server", "network", "timeout"].includes(code);
    if (cause) this.cause = cause;
  }
}

function extractOutputText(data) {
  if (!data) return "";
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }
  if (Array.isArray(data.output)) {
    const parts = [];
    for (const item of data.output) {
      if (!item) continue;
      if (typeof item.text === "string") parts.push(item.text);
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (!c) continue;
          if (typeof c.text === "string") parts.push(c.text);
          else if (typeof c === "string") parts.push(c);
        }
      }
    }
    if (parts.length) return parts.join("\n");
  }
  const choice = data.choices && data.choices[0];
  if (choice && choice.message && typeof choice.message.content === "string") {
    return choice.message.content;
  }
  return "";
}

function sanitizeKey(apiKey) {
  return String(apiKey || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function apiErrorMessage(data, status) {
  if (!data) return `xAI-feil ${status}`;
  if (typeof data.error === "string" && data.error.trim()) return data.error;
  if (data.error && typeof data.error.message === "string") return data.error.message;
  if (typeof data.message === "string" && data.message.trim()) return data.message;
  return `xAI-feil ${status}`;
}

function baseUrlOf(baseUrl) {
  const env = typeof process !== "undefined" && process.env ? process.env.XAI_BASE_URL : "";
  return String(baseUrl || env || "https://api.x.ai").replace(/\/+$/, "");
}

function httpError(status, data, headers) {
  const detail = apiErrorMessage(data, status);
  if (status === 401) {
    return new GrokError("auth", "xAI avviste API-nøkkelen (401). Sjekk at nøkkelen er riktig.", { status });
  }
  if (status === 403) {
    return new GrokError(
      "forbidden",
      `xAI nektet tilgang (403): ${detail}. Nøkkelen må ha chat-/modelltilgang (api-key:endpoint:* og api-key:model:*), ikke bare voice.`,
      { status }
    );
  }
  if (status === 429) {
    const ra = Number(headers && headers.get && headers.get("retry-after"));
    return new GrokError("rate_limit", "xAI melder for mange forespørsler (429).", {
      status,
      retryAfterMs: Number.isFinite(ra) && ra >= 0 ? Math.min(ra, 60) * 1000 : 0,
    });
  }
  if (status >= 500) {
    return new GrokError("server", `xAI har en midlertidig feil (${status}).`, { status });
  }
  return new GrokError("bad_response", `xAI-feil ${status}: ${detail}`, { status });
}

// Slår sammen jobbens avbrudd med en tidsgrense per forespørsel.
function requestSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new GrokError("timeout", "xAI svarte ikke i tide.")),
    timeoutMs
  );
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

function cancelledError() {
  return new GrokError("cancelled", "Oversettelsen ble avbrutt.");
}

async function grokRequest({ apiKey, model, input, baseUrl, signal, timeoutMs, onCall, items, attempt }) {
  const key = sanitizeKey(apiKey);
  if (!key) throw new GrokError("no_key", "Mangler xAI API-nøkkel.");
  if (signal && signal.aborted) throw cancelledError();
  const t0 = Date.now();
  const report = (extra) => {
    if (onCall) {
      onCall({ attempt: attempt || 1, items: items || 0, inputChars: input.length, ms: Date.now() - t0, ...extra });
    }
  };
  const req = requestSignal(signal, timeoutMs || DEFAULT_TIMEOUT_MS);
  let res;
  let raw;
  try {
    res = await fetch(`${baseUrlOf(baseUrl)}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || "grok-4.6",
        input,
        store: false,
        temperature: 0.15,
      }),
      signal: req.signal,
    });
    raw = await res.text();
  } catch (err) {
    const reason = req.signal.reason;
    let error;
    if (signal && signal.aborted) error = cancelledError();
    else if (reason instanceof GrokError) error = reason;
    else error = new GrokError("network", `Fikk ikke kontakt med xAI (${err.message}).`, { cause: err });
    report({ ok: false, status: 0, outputChars: 0, error: error.message, code: error.code });
    throw error;
  } finally {
    req.done();
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const error = res.ok
      ? new GrokError("bad_response", `Ugyldig svar fra xAI (${res.status}): ${raw.slice(0, 240)}`, { status: res.status })
      : httpError(res.status, null, res.headers);
    report({ ok: false, status: res.status, outputChars: 0, error: error.message, code: error.code });
    throw error;
  }

  if (!res.ok) {
    const error = httpError(res.status, data, res.headers);
    report({ ok: false, status: res.status, outputChars: 0, error: error.message, code: error.code });
    throw error;
  }

  const text = extractOutputText(data).trim();
  report({ ok: Boolean(text), status: res.status, outputChars: text.length, usage: data.usage || null });
  if (!text) throw new GrokError("bad_response", "Tomt svar fra Grok.", { status: res.status });
  return text;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(cancelledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Prøver igjen ved 429, 5xx, nettverksfeil og tidsavbrudd: 2 s, 4 s, 8 s (+ litt tilfeldighet).
async function requestWithRetry(ctx, input, items) {
  const base = ctx.retryDelayMs != null ? ctx.retryDelayMs : 2000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await grokRequest({ ...ctx, input, items, attempt });
    } catch (err) {
      if (!(err instanceof GrokError) || !err.retryable || attempt >= MAX_ATTEMPTS) throw err;
      const backoff = base * 2 ** (attempt - 1) + Math.floor(Math.random() * (base / 4));
      await sleep(Math.max(err.retryAfterMs, backoff), ctx.signal);
    }
  }
}

function parseJsonArray(text, expected) {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new GrokError("bad_response", "Kunne ikke lese oversettelsen som JSON.");
  }
  let parsed;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    throw new GrokError("bad_response", "Kunne ikke lese oversettelsen som JSON.");
  }
  if (!Array.isArray(parsed)) throw new GrokError("bad_response", "Oversettelsen var ikke en liste.");
  if (typeof expected === "number" && parsed.length !== expected) {
    throw new GrokError("bad_response", `Forventet ${expected} oversettelser, fikk ${parsed.length}.`);
  }
  if (parsed.some((item) => item != null && typeof item === "object")) {
    throw new GrokError("bad_response", "Oversettelsen inneholdt objekter i stedet for tekst.");
  }
  return parsed.map((item) => (item == null ? "" : String(item)));
}

function batchPrompt(label, payload) {
  return [
    `Du er en profesjonell oversetter til ${label}.`,
    "Oversett hvert element i JSON-arrayen til naturlig, idiomatisk norsk.",
    "Behold layouten: samme antall linjeskift, tomme linjer, tabulatorer og innrykk som i kilden.",
    "Direkte oversettelse. Ikke omskriv, ikke forkort, ikke utvid, og ikke endre typografi.",
    "Ikke slå sammen avsnitt eller linjer. Ikke legg til markdown, punktlister eller overskrifter som ikke finnes i kilden.",
    "Behold tall, egennavn, e-postadresser, URL-er, koder og markup uendret når de ikke er vanlig språk.",
    "Ikke legg til forklaringer. Ikke hopp over elementer.",
    `Returner KUN et JSON-array med nøyaktig ${payload.length} strenger, i samme rekkefølge.`,
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function singlePrompt(label, text) {
  return [
    `Du er en profesjonell oversetter til ${label}.`,
    "Oversett teksten under til naturlig, idiomatisk norsk. Direkte oversettelse.",
    "Behold linjeskift, tabulatorer og innrykk nøyaktig. Behold tall, egennavn, URL-er og koder.",
    "Returner KUN den oversatte teksten, uten anførselstegn, forklaringer eller markdown.",
    "",
    text,
  ].join("\n");
}

async function requestArray(ctx, label, texts) {
  const prompt = batchPrompt(label, texts);
  try {
    return parseJsonArray(await requestWithRetry(ctx, prompt, texts.length), texts.length);
  } catch (err) {
    if (!(err instanceof GrokError) || err.code !== "bad_response") throw err;
    const strict = `${prompt}\n\nSvar kun med gyldig JSON-array med nøyaktig ${texts.length} strenger. Ingen annen tekst.`;
    return parseJsonArray(await requestWithRetry(ctx, strict, texts.length), texts.length);
  }
}

// Ugyldig svar (feil antall, ikke JSON) deles i to til hvert element går gjennom.
// Én dårlig batch skal aldri velte en hel fil.
async function translateTexts(ctx, label, texts) {
  try {
    return await requestArray(ctx, label, texts);
  } catch (err) {
    if (!(err instanceof GrokError) || err.code !== "bad_response") throw err;
    if (texts.length === 1) {
      const text = await requestWithRetry(ctx, singlePrompt(label, texts[0]), 1);
      return [text.replace(/^```\w*\s*|\s*```$/g, "")];
    }
    const mid = Math.ceil(texts.length / 2);
    const left = await translateTexts(ctx, label, texts.slice(0, mid));
    const right = await translateTexts(ctx, label, texts.slice(mid));
    return left.concat(right);
  }
}

// items: [{ i, t }] fra planBatches. Returnerer oversettelser i samme rekkefølge.
async function translateBatch(items, ctx) {
  const label = LANGUAGE_LABEL[ctx.targetLanguage] || LANGUAGE_LABEL.bokmal;
  const texts = items.map((it) => it.t);
  const translated = await translateTexts(ctx, label, texts);
  return translated.map((t, n) => {
    if (!String(t).trim() && texts[n].trim()) {
      if (ctx.onWarning) {
        ctx.onWarning({
          code: "empty_translation",
          message: "Grok returnerte tom tekst; originalen er beholdt.",
          index: items[n].i,
        });
      }
      return texts[n];
    }
    return t;
  });
}

function planBatches(strings) {
  const batches = [];
  let current = [];
  let chars = 0;
  strings.forEach((s, i) => {
    const t = String(s ?? "");
    if (!t.trim()) return;
    const extra = t.length + 8;
    if (current.length && (chars + extra > MAX_BATCH_CHARS || current.length >= MAX_BATCH_ITEMS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push({ i, t });
    chars += extra;
  });
  if (current.length) batches.push(current);
  return batches.map((items) => ({
    items,
    chars: items.reduce((n, it) => n + it.t.length, 0),
  }));
}

// Moduser (ctx):
//   dryRun + onPlan  bare tell opp (estimat), ingen nettverk
//   collect: []      samle strengene per kall, ingen nettverk (skyjobbens første steg)
//   apply: [[...]]   bruk ferdige oversettelser i samme kallrekkefølge (skyjobbens siste steg)
//   ellers           oversett via xAI, `concurrency` batcher parallelt
async function translateStrings(ctx) {
  const { strings, onProgress, onPlan, onBatch, dryRun, collect, apply } = ctx;
  const result = strings.map((s) => String(s ?? ""));

  if (apply) {
    const next = apply.shift();
    if (!next || next.length !== result.length) {
      throw new Error("Dokumentet endret seg under oversettelsen. Prøv igjen.");
    }
    return next.map((t, i) => (t == null ? result[i] : String(t)));
  }
  if (collect) {
    collect.push({ strings: result.slice() });
    return result;
  }

  const planned = planBatches(result);
  const total = planned.reduce((n, b) => n + b.items.length, 0);
  if (onPlan) {
    onPlan({
      batches: planned.map((b) => b.chars),
      segments: total,
      chars: planned.reduce((n, b) => n + b.chars, 0),
    });
  }
  if (dryRun) return result;

  let done = 0;
  let next = 0;
  const workers = Math.max(1, Math.min(Number(ctx.concurrency) || 1, planned.length));
  async function worker() {
    while (next < planned.length) {
      const batch = planned[next++];
      const started = Date.now();
      const translated = await translateBatch(batch.items, ctx);
      translated.forEach((t, n) => {
        result[batch.items[n].i] = t;
      });
      done += batch.items.length;
      if (onBatch) onBatch({ chars: batch.chars, items: batch.items.length, ms: Date.now() - started, ok: true });
      if (onProgress) onProgress({ done, total });
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  return result;
}

async function translateDocumentText(ctx) {
  const { text } = ctx;
  const source = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trailing = source.match(/\n+$/);
  const core = trailing ? source.slice(0, -trailing[0].length) : source;
  const pieces = [];
  const re = /(\n{2,})/g;
  let last = 0;
  let m;
  while ((m = re.exec(core))) {
    pieces.push({ kind: "text", value: core.slice(last, m.index) });
    pieces.push({ kind: "sep", value: m[1] });
    last = m.index + m[1].length;
  }
  pieces.push({ kind: "text", value: core.slice(last) });

  const strings = pieces.filter((p) => p.kind === "text").map((p) => p.value);
  const translated = await translateStrings({ ...ctx, strings });

  let ti = 0;
  let out = "";
  for (const piece of pieces) {
    if (piece.kind === "sep") out += piece.value;
    else out += translated[ti++] ?? piece.value;
  }
  if (trailing) out += trailing[0];
  else if (source.endsWith("\n")) out += "\n";
  return out;
}

async function testConnection({ apiKey, model, baseUrl, signal, onCall }) {
  const t0 = Date.now();
  const text = await grokRequest({
    apiKey,
    model,
    baseUrl,
    signal,
    onCall,
    timeoutMs: 60000,
    input: "Svar med nøyaktig ett ord: OK. Ingen annen tekst.",
  });
  return { ok: true, sample: text.slice(0, 80), ms: Date.now() - t0 };
}

module.exports = {
  GrokError,
  planBatches,
  translateBatch,
  grokRequest,
  translateStrings,
  translateDocumentText,
  testConnection,
};
