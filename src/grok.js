const LANGUAGE_LABEL = {
  bokmal: "norsk bokmål",
  nynorsk: "norsk nynorsk",
};

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
  return String(baseUrl || process.env.XAI_BASE_URL || "https://api.x.ai").replace(/\/+$/, "");
}

async function grokRequest({ apiKey, model, input, baseUrl, signal, onCall, items }) {
  const key = sanitizeKey(apiKey);
  const t0 = Date.now();
  const report = (extra) => {
    if (onCall) onCall({ attempt: 1, items: items || 0, inputChars: input.length, ms: Date.now() - t0, ...extra });
  };
  let res;
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
      signal,
    });
  } catch (err) {
    report({ ok: false, status: 0, outputChars: 0, error: err.message });
    throw err;
  }

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    report({ ok: false, status: res.status, outputChars: 0, error: "invalid json" });
    throw new Error(`Ugyldig svar fra xAI (${res.status}): ${raw.slice(0, 240)}`);
  }

  if (!res.ok) {
    const message = apiErrorMessage(data, res.status);
    report({ ok: false, status: res.status, outputChars: 0, error: message });
    throw new Error(message);
  }

  const text = extractOutputText(data).trim();
  report({ ok: Boolean(text), status: res.status, outputChars: text.length, usage: data.usage || null });
  if (!text) throw new Error("Tomt svar fra Grok.");
  return text;
}

function parseJsonArray(text, expected) {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Kunne ikke lese oversettelsen som JSON.");
  }
  const parsed = JSON.parse(stripped.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Oversettelsen var ikke en liste.");
  if (typeof expected === "number" && parsed.length !== expected) {
    throw new Error(
      `Forventet ${expected} oversettelser, fikk ${parsed.length}.`
    );
  }
  return parsed.map((item) => (item == null ? "" : String(item)));
}

function planBatches(strings) {
  const work = [];
  strings.forEach((s, i) => {
    const t = String(s ?? "");
    if (t.trim()) work.push({ i, t });
  });

  const batches = [];
  let current = [];
  let chars = 0;
  for (const item of work) {
    const extra = item.t.length + 8;
    if (current.length && (chars + extra > 7000 || current.length >= 28)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += extra;
  }
  if (current.length) batches.push(current);
  return batches.map((items) => ({
    items,
    chars: items.reduce((n, it) => n + it.t.length, 0),
  }));
}

async function translateStrings(ctx) {
  const { apiKey, model, baseUrl, signal, targetLanguage, strings, onProgress, onPlan, onBatch, onCall, dryRun } = ctx;
  const label = LANGUAGE_LABEL[targetLanguage] || LANGUAGE_LABEL.bokmal;
  const result = strings.map((s) => String(s ?? ""));
  const planned = planBatches(strings);
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
  for (const planBatch of planned) {
    const batch = planBatch.items;
    const started = Date.now();
    const payload = batch.map((b) => b.t);
    const prompt = [
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

    let translated;
    try {
      const text = await grokRequest({ apiKey, model, baseUrl, signal, onCall, items: batch.length, input: prompt });
      translated = parseJsonArray(text, payload.length);
    } catch (firstErr) {
      const retryPrompt = `${prompt}\n\nSvar kun med gyldig JSON-array. Ingen annen tekst.`;
      try {
        const text = await grokRequest({ apiKey, model, baseUrl, signal, onCall, items: batch.length, input: retryPrompt });
        translated = parseJsonArray(text, payload.length);
      } catch {
        throw firstErr;
      }
    }

    translated.forEach((t, n) => {
      result[batch[n].i] = t;
    });
    done += batch.length;
    if (onBatch) {
      onBatch({ chars: planBatch.chars, items: batch.length, ms: Date.now() - started, ok: true });
    }
    if (onProgress) {
      onProgress({ done, total });
    }
  }

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

async function testConnection({ apiKey, model, baseUrl, signal }) {
  const text = await grokRequest({
    apiKey,
    model,
    baseUrl,
    signal,
    input:
      "Svar med nøyaktig ett ord: OK. Ingen annen tekst.",
  });
  return { ok: true, sample: text.slice(0, 80) };
}

module.exports = {
  planBatches,
  grokRequest,
  translateStrings,
  translateDocumentText,
  testConnection,
};
