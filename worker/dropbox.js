// Fildropp: Svetlana sender hvilke som helst filer rett til eieren (ingen oversettelse), f.eks. et dokument som ble
// rart, så han kan se på det. Filene ligger i R2 under drop/<dropId>/<fileId> til eieren sletter dem.
import { all, batch, nowIso } from "./db.js";

export const DROP_MAX_MB = 100;
export const MAX_DROP_FILES = 50;
export const MAX_DROP_NOTE = 2000;

export const dropKey = (dropId, fileId) => `drop/${dropId}/${fileId}`;

export function serializeDropFile(f) {
  return { id: f.id, name: f.name, path: f.rel_path, bytes: f.bytes, createdAt: f.created_at };
}

// Fildropp med filene, nyeste først. userId: bare én brukers (hennes egen liste); ellers alle (admin, også de hun
// lastet opp filer til, men aldri trykket Send på). sentOnly: bare de som er sendt.
export async function listDrops(env, { userId = null, sentOnly = false, limit = 50 } = {}) {
  const drops = await all(
    env,
    `SELECT d.*, COALESCE(u.display_name, u.username) AS display_name, u.username FROM drops d JOIN users u ON u.id = d.user_id
     WHERE d.deleted_at IS NULL AND (? IS NULL OR d.user_id = ?) AND (? = 0 OR d.sent_at IS NOT NULL)
       AND EXISTS (SELECT 1 FROM drop_files f WHERE f.drop_id = d.id AND f.deleted_at IS NULL)
     ORDER BY d.created_at DESC LIMIT ?`,
    userId, userId, sentOnly ? 1 : 0, limit
  );
  if (!drops.length) return [];
  const files = await all(
    env,
    `SELECT * FROM drop_files WHERE deleted_at IS NULL AND drop_id IN (SELECT value FROM json_each(?)) ORDER BY rel_path`,
    JSON.stringify(drops.map((d) => d.id))
  );
  return drops.map((d) => ({
    id: d.id,
    userId: d.user_id,
    displayName: d.display_name,
    username: d.username,
    note: d.note,
    createdAt: d.created_at,
    sentAt: d.sent_at,
    files: files.filter((f) => f.drop_id === d.id).map(serializeDropFile),
  }));
}

// Sletter filene for godt i R2 og merker radene (som blir stående som historikk).
export async function deleteDrop(env, dropId) {
  const files = await all(env, "SELECT id FROM drop_files WHERE drop_id = ? AND deleted_at IS NULL", dropId);
  if (files.length) await env.FILES.delete(files.map((f) => dropKey(dropId, f.id)));
  const now = nowIso();
  await batch(env, [
    ["UPDATE drops SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", now, dropId],
    ["UPDATE drop_files SET deleted_at = ? WHERE drop_id = ? AND deleted_at IS NULL", now, dropId],
  ]);
  return files.length;
}
