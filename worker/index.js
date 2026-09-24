// InnNorsk Sky — Cloudflare Worker: sider og API (Hono), oversettelsesjobber (Workflows) og daglig opprydding (cron).
import app from "./app.js";
import { sweep } from "./sweep.js";

export { TranslationJob } from "./workflow.js";

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    await sweep(env);
  },
};
