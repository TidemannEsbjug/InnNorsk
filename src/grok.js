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

async function grokRequest({ apiKey, model, input }) {
  const key = sanitizeKey(apiKey);
  const res = await fetch("https://api.x.ai/v1/responses", {
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
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Ugyldig svar fra xAI (${res.status}): ${raw.slice(0, 240)}`);
  }

  if (!res.ok) {
    throw new Error(apiErrorMessage(data, res.status));
  }

  const text = extractOutputText(data).trim();
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

async function translateStrings({ apiKey, model, targetLanguage, strings, onProgress }) {
  const label = LANGUAGE_LABEL[targetLanguage] || LANGUAGE_LABEL.bokmal;
  const result = new Array(strings.length).fill("");
  const work = [];

  strings.forEach((s, i) => {
    const t = String(s ?? "");
    if (!t.trim()) {
      result[i] = t;
    } else {
      work.push({ i, t });
    }
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

  let done = 0;
  for (const batch of batches) {
    const payload = batch.map((b) => b.t);
    const prompt = [
      `Du er en profesjonell oversetter til ${label}.`,
      "Oversett hvert element i JSON-arrayen til naturlig, idiomatisk norsk.",
      "Behold layouten: samme antall linjeskift, tomme linjer, tabulatorer og innrykk som i kilden.",
      "Ikke slå sammen avsnitt eller linjer. Ikke legg til markdown, punktlister eller overskrifter som ikke finnes i kilden.",
      "Behold tall, egennavn, e-postadresser, URL-er, koder og markup uendret når de ikke er vanlig språk.",
      "Ikke legg til forklaringer. Ikke hopp over elementer.",
      `Returner KUN et JSON-array med nøyaktig ${payload.length} strenger, i samme rekkefølge.`,
      "",
      JSON.stringify(payload, null, 2),
    ].join("\n");

    let translated;
    try {
      const text = await grokRequest({ apiKey, model, input: prompt });
      translated = parseJsonArray(text, payload.length);
    } catch (firstErr) {
      const retryPrompt = `${prompt}\n\nSvar kun med gyldig JSON-array. Ingen annen tekst.`;
      try {
        const text = await grokRequest({ apiKey, model, input: retryPrompt });
        translated = parseJsonArray(text, payload.length);
      } catch {
        throw firstErr;
      }
    }

    translated.forEach((t, n) => {
      result[batch[n].i] = t;
    });
    done += batch.length;
    if (onProgress) {
      onProgress({ done, total: work.length });
    }
  }

  return result;
}

async function translateDocumentText({ apiKey, model, targetLanguage, text, onProgress }) {
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
  const translated = await translateStrings({
    apiKey,
    model,
    targetLanguage,
    strings,
    onProgress,
  });

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

async function testConnection({ apiKey, model }) {
  const text = await grokRequest({
    apiKey,
    model,
    input:
      "Svar med nøyaktig ett ord: OK. Ingen annen tekst.",
  });
  return { ok: true, sample: text.slice(0, 80) };
}

module.exports = {
  grokRequest,
  translateStrings,
  translateDocumentText,
  testConnection,
};
