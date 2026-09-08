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

async function grokRequest({ apiKey, model, input }) {
  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || "grok-4.6",
      input,
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
    const msg =
      (data && (data.error?.message || data.message)) ||
      `xAI-feil ${res.status}`;
    throw new Error(msg);
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
      "Behold tall, egennavn, e-postadresser, URL-er, koder og markdown/XML-tegn uendret når de ikke er vanlig språk.",
      "Ikke legg til forklaringer. Ikke slå sammen eller hopp over elementer.",
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
  const blocks = splitBlocks(text);
  const translated = await translateStrings({
    apiKey,
    model,
    targetLanguage,
    strings: blocks,
    onProgress,
  });
  return translated.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function splitBlocks(text) {
  const parts = String(text)
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trimEnd());
  const out = [];
  let buf = "";
  for (const p of parts) {
    if (!p.trim()) continue;
    if (buf && buf.length + p.length > 3500) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : [text];
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
