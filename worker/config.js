// Miljøvariabler (strenger fra wrangler.jsonc / secrets) → tall og strenger med standardverdier.
// Hemmeligheter (AGENT_TOKEN, APNS_KEY_P8, SALT_PEPPER) leses direkte fra env der de trengs.
function num(env, key, fallback) {
  const raw = env[key];
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function config(env) {
  return {
    maxFileMb: num(env, "MAX_FILE_MB", 50),
    maxFilesPerSending: Math.floor(num(env, "MAX_FILES_PER_SENDING", 50)),
    agentOfflineAlertMinutes: num(env, "AGENT_OFFLINE_ALERT_MINUTES", 120),
    apnsBundleId: env.APNS_BUNDLE_ID || "no.innnorsk.varsel",
    apnsEnv: env.APNS_ENV === "production" ? "production" : "sandbox",
  };
}
