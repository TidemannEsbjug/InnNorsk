// R2-nøkler og filoperasjoner. Nedlastingsnavn kommer alltid fra D1, aldri fra nøklene.
const userJobPrefix = (userId, jobId) => `u/${userId}/j/${jobId}/`;
const filePrefix = (userId, jobId, fileId) => `${userJobPrefix(userId, jobId)}f/${fileId}/`;

export const keys = {
  original: (userId, jobId, fileId) => `${filePrefix(userId, jobId, fileId)}original`,
  output: (userId, jobId, fileId) => `${filePrefix(userId, jobId, fileId)}output`,
  workPrefix: (jobId) => `work/${jobId}/`,
  strings: (jobId, fileId) => `work/${jobId}/${fileId}/strings.json`,
  batch: (jobId, fileId, idx) => `work/${jobId}/${fileId}/b-${idx}.json`,
};

export const putOriginal = (env, file, userId, body) =>
  env.FILES.put(keys.original(userId, file.job_id, file.id), body);

export const getOriginal = (env, file, userId) => env.FILES.get(keys.original(userId, file.job_id, file.id));

export const putOutput = (env, file, userId, body) => env.FILES.put(keys.output(userId, file.job_id, file.id), body);

export const getOutput = (env, file, userId) => env.FILES.get(keys.output(userId, file.job_id, file.id));

export async function getJson(env, key) {
  const obj = await env.FILES.get(key);
  return obj ? obj.json() : null;
}

export const putJson = (env, key, value) =>
  env.FILES.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });

export async function deletePrefix(env, prefix) {
  let deleted = 0;
  let cursor;
  do {
    const page = await env.FILES.list({ prefix, cursor, limit: 1000 });
    const names = page.objects.map((o) => o.key);
    if (names.length) {
      await env.FILES.delete(names);
      deleted += names.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

export const deleteWork = (env, jobId) => deletePrefix(env, keys.workPrefix(jobId));

export async function deleteJobObjects(env, userId, jobId) {
  return (await deletePrefix(env, userJobPrefix(userId, jobId))) + (await deleteWork(env, jobId));
}

export const deleteFileObjects = (env, userId, jobId, fileId) => deletePrefix(env, filePrefix(userId, jobId, fileId));

// Jobb-id-er som har arbeidsfiler liggende (for opprydding).
export async function listWorkJobIds(env) {
  const ids = [];
  let cursor;
  do {
    const page = await env.FILES.list({ prefix: "work/", delimiter: "/", cursor, limit: 1000 });
    for (const p of page.delimitedPrefixes || []) ids.push(p.slice(5, -1));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return ids;
}
