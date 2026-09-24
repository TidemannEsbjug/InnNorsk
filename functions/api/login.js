import { safeEqual, signPayload, cookieHeader, json } from "../lib/auth.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ugyldig forespørsel." }, 400);
  }
  const username = String(body.username || "");
  const password = String(body.password || "");
  const expectedUser = env.AUTH_USERNAME || "";
  const expectedPass = env.AUTH_PASSWORD || "";
  const secret = env.SESSION_SECRET || "";
  if (!expectedUser || !expectedPass || !secret) {
    return json({ error: "Serveren er ikke konfigurert med innlogging." }, 500);
  }
  const userOk = safeEqual(username, expectedUser);
  const passOk = safeEqual(password, expectedPass);
  if (!userOk || !passOk) {
    return json({ error: "Feil brukernavn eller passord." }, 401);
  }
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const token = await signPayload(secret, `v1|${expectedUser}|${exp}`);
  return json(
    { ok: true, user: expectedUser },
    200,
    { "Set-Cookie": cookieHeader(token, request, 30 * 24 * 60 * 60) }
  );
}
