import { requireUser, json } from "../lib/auth.js";

export async function onRequestGet(context) {
  const { error, user } = await requireUser(context.request, context.env);
  if (error) return error;
  return json({ ok: true, user });
}
