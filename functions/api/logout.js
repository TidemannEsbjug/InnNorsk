import { cookieHeader, json } from "../lib/auth.js";

export async function onRequestPost(context) {
  return json({ ok: true }, 200, {
    "Set-Cookie": cookieHeader("deleted", context.request, 0),
  });
}
