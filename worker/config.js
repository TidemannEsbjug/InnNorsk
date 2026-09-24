// Miljøvariabler (strenger fra wrangler.jsonc / secrets) → tall og strenger med standardverdier.
// Hemmeligheter (XAI_API_KEY, APNS_KEY_P8, SALT_PEPPER) leses direkte fra env der de trengs.
function num(env, key, fallback) {
  const raw = env[key];
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// USD per million tokens; tom verdi betyr ukjent pris (da vises bare tokens).
function price(env, key) {
  const raw = String(env[key] ?? "").trim();
  const n = raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function config(env) {
  return {
    maxFileMb: num(env, "MAX_FILE_MB", 25),
    maxFilesPerSending: Math.floor(num(env, "MAX_FILES_PER_SENDING", 50)),
    model: env.XAI_MODEL || "grok-4.6",
    concurrency: Math.floor(num(env, "GROK_CONCURRENCY", 2)),
    priceInputPerM: price(env, "XAI_PRICE_INPUT_PER_M"),
    priceOutputPerM: price(env, "XAI_PRICE_OUTPUT_PER_M"),
    apnsBundleId: env.APNS_BUNDLE_ID || "no.innnorsk.varsel",
    apnsEnv: env.APNS_ENV === "production" ? "production" : "sandbox",
  };
}
