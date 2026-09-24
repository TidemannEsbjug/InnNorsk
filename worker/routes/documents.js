// «Mine dokumenter»: alle ferdige oversettelser brukeren ikke har slettet.
import { Hono } from "hono";
import { all } from "../db.js";
import { requireUser } from "../auth.js";

const documents = new Hono();
documents.use("*", requireUser);

documents.get("/", async (c) => {
  const rows = await all(
    c.env,
    `SELECT f.id, f.job_id, f.name, f.rel_path, f.output_name, f.finished_at, f.output_bytes, j.target_language
     FROM files f JOIN jobs j ON j.id = f.job_id
     WHERE j.user_id = ? AND f.status = 'done' AND f.deleted_at IS NULL AND j.deleted_at IS NULL
     ORDER BY f.finished_at DESC, f.output_name LIMIT 1000`,
    c.get("user").id
  );
  return c.json({
    documents: rows.map((r) => ({
      fileId: r.id,
      jobId: r.job_id,
      name: r.output_name.split("/").pop(),
      originalName: r.name,
      path: r.output_name,
      targetLanguage: r.target_language,
      finishedAt: r.finished_at,
      outputBytes: r.output_bytes,
    })),
  });
});

export default documents;
