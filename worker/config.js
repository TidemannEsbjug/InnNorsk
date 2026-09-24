// Miljøvariabler (strenger fra wrangler.jsonc / secrets) → tall og strenger med standardverdier.
// Hemmeligheter (XAI_API_KEY, passord) leses direkte fra env der de trengs, aldri herfra.
function num(env, key, fallback) {
  const raw = env[key];
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function config(env) {
  return {
    model: env.XAI_MODEL || "grok-4.6",
    baseUrl: env.XAI_BASE_URL || undefined,
    concurrency: Math.min(8, Math.max(1, Math.floor(num(env, "GROK_CONCURRENCY", 2)))),
    retentionDays: num(env, "RETENTION_DAYS", 0),
    sessionDays: num(env, "SESSION_DAYS", 30) || 30,
    maxFileMb: num(env, "MAX_FILE_MB", 30) || 30,
    maxFilesPerJob: Math.floor(num(env, "MAX_FILES_PER_JOB", 100)) || 100,
    eventRetentionDays: num(env, "EVENT_RETENTION_DAYS", 180) || 180,
    adminUsername: String(env.ADMIN_USERNAME || "admin").trim(),
    seedUsername: String(env.SEED_USER_USERNAME || "").trim(),
    seedDisplayName: String(env.SEED_USER_DISPLAY_NAME || env.SEED_USER_USERNAME || "").trim(),
  };
}
