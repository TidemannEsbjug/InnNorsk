// Tynne D1-hjelpere. All SQL er parameterisert; undefined blir NULL.
const clean = (args) => args.map((a) => (a === undefined ? null : a));

export const prepare = (env, sql, ...args) => env.DB.prepare(sql).bind(...clean(args));

export const one = (env, sql, ...args) => prepare(env, sql, ...args).first();

export async function all(env, sql, ...args) {
  return (await prepare(env, sql, ...args).all()).results;
}

export const run = (env, sql, ...args) => prepare(env, sql, ...args).run();

// statements: [[sql, ...args], ...] i én transaksjon.
export function batch(env, statements) {
  return env.DB.batch(statements.map(([sql, ...args]) => prepare(env, sql, ...args)));
}

export const nowIso = () => new Date().toISOString();

export const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

export const DAY_MS = 86400000;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function newId(len = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let id = "";
  for (const b of bytes) id += BASE32[b & 31];
  return id;
}

export function parseJson(text, fallback) {
  if (text == null || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
