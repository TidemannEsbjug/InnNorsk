// InnNorsk — Cloudflare Worker (Workers Paid): nettside og API (Hono), oversettelse i Workflowen TranslateSending (xAI),
// push og cron hvert 15. minutt.
import app from "./app.js";
import { runCron } from "./cron.js";

export { TranslateSending } from "./translate.js";

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    await runCron(env);
  },
};
