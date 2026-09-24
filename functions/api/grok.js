import { requireUser, json } from "../lib/auth.js";

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
          if (c && typeof c.text === "string") parts.push(c.text);
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

function apiErrorMessage(data, status) {
  if (!data) return `xAI-feil ${status}`;
  if (typeof data.error === "string" && data.error.trim()) return data.error;
  if (data.error && typeof data.error.message === "string") return data.error.message;
  if (typeof data.message === "string" && data.message.trim()) return data.message;
  return `xAI-feil ${status}`;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const gate = await requireUser(request, env);
  if (gate.error) return gate.error;
  if (!env.XAI_API_KEY) {
    return json({ error: "Serveren mangler XAI_API_KEY." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ugyldig forespørsel." }, 400);
  }
  const input = body.input;
  const model = body.model || "grok-4.6";
  if (typeof input !== "string" || !input.trim()) {
    return json({ error: "Mangler tekst å oversette." }, 400);
  }
  if (input.length > 80_000) {
    return json({ error: "Tekstbiten er for stor." }, 413);
  }

  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.XAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
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
    return json({ error: `Ugyldig svar fra xAI (${res.status})` }, 502);
  }
  if (!res.ok) {
    return json({ error: apiErrorMessage(data, res.status) }, res.status === 403 ? 403 : 502);
  }
  const text = extractOutputText(data).trim();
  if (!text) return json({ error: "Tomt svar fra Grok." }, 502);
  return json({ text });
}
