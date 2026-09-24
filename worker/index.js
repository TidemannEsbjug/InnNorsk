// InnNorsk Drop — Cloudflare Worker (Free-plan): nettside og API (Hono), agent-API for Mac-en, push og cron hvert 15. minutt.
import app from "./app.js";
import { runCron } from "./cron.js";

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    await runCron(env);
  },
};
