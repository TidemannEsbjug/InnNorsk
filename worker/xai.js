// xAI i Workeren: innstillinger til src/grok.js (nøkkelen finnes bare i serverens miljø), ett D1-spor per
// HTTP-kall (grok_calls + tellere på filen), kostnad fra tokens, og tidsmodellen tilpasset fra de siste kallene.
import { config } from "./config.js";
import { all, batch, nowIso } from "./db.js";
import { fitParams } from "./estimate.js";

const FIT_ROWS = 300;
const FIT_CACHE_MS = 60000;
let fitCache = null; // { model, at, params }

export function grokOptions(env, extra = {}) {
  return { apiKey: env.XAI_API_KEY, model: config(env).model, baseUrl: env.XAI_BASE_URL || undefined, ...extra };
}

// Estimatparametre for gjeldende modell fra de siste vellykkede oversettelseskallene (ikke «Test xAI»), bufret 60 s.
export async function estimatorParams(env) {
  const { model } = config(env);
  if (fitCache && fitCache.model === model && Date.now() - fitCache.at < FIT_CACHE_MS) return fitCache.params;
  const rows = await all(
    env,
    "SELECT input_chars, ms FROM grok_calls WHERE ok = 1 AND model = ? AND file_id IS NOT NULL ORDER BY id DESC LIMIT ?",
    model, FIT_ROWS
  );
  fitCache = { model, at: Date.now(), params: fitParams(rows) };
  return fitCache.params;
}

// USD, eller null når prisene ikke er satt.
export function costUsd(env, inputTokens, outputTokens) {
  const { priceInputPerM: input, priceOutputPerM: output } = config(env);
  if (input == null || output == null) return null;
  return Number((((inputTokens || 0) * input + (outputTokens || 0) * output) / 1e6).toFixed(6));
}

// SQL for files.cost_usd ut fra filens tokens (uendret når prisene ikke er satt): [uttrykk, argumenter].
export function costSql(env) {
  const { priceInputPerM: input, priceOutputPerM: output } = config(env);
  if (input == null || output == null) return ["cost_usd", []];
  return ["ROUND((COALESCE(input_tokens, 0) * ? + COALESCE(output_tokens, 0) * ?) / 1000000.0, 6)", [input, output]];
}

// info kommer fra onCall i src/grok.js. usage følger Responses-API-et (input_tokens/output_tokens).
export function recordCall(env, { sendingId = null, fileId = null }, info) {
  const usage = info.usage || {};
  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const reasoning = (usage.output_tokens_details || usage.completion_tokens_details || {}).reasoning_tokens ?? null;
  const statements = [[
    `INSERT INTO grok_calls (ts, sending_id, file_id, model, status, ok, attempt, items, input_chars, output_chars, ms,
       input_tokens, output_tokens, reasoning_tokens, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    nowIso(), sendingId, fileId, config(env).model, info.status || 0, info.ok ? 1 : 0, info.attempt, info.items, info.inputChars,
    info.outputChars || 0, info.ms, input, output, reasoning, info.error ? String(info.error).slice(0, 1000) : null,
  ]];
  if (fileId) {
    statements.push(["UPDATE files SET calls = calls + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?",
      input, output, fileId]);
  }
  return batch(env, statements);
}
