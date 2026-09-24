import { api, reportErrors } from "./api.js";

reportErrors();

const $ = (id) => document.getElementById(id);
const loginForm = $("login-form");
const changeForm = $("change-form");

// Passordet hun nettopp logget inn med, så hun slipper å skrive det igjen.
let currentPassword = "";

function say(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

function showChangeForm() {
  loginForm.hidden = true;
  changeForm.hidden = false;
  $("current-field").hidden = Boolean(currentPassword);
  (currentPassword ? $("new-password") : $("current-password")).focus();
}

// Vennligere tekst når serveren ikke svarer som forventet.
function loginMessage(err) {
  if (err.status === 401) return `${err.message} Sjekk skrivemåten og prøv igjen.`;
  if (err.status >= 500) return "Det er et problem hos oss akkurat nå. Prøv igjen om et par minutter.";
  return err.message;
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("username").value.trim();
  const password = $("password").value;
  const error = $("login-error");
  if (!username || !password) {
    say(error, !username ? "Skriv inn brukernavnet ditt først." : "Skriv inn passordet ditt også.");
    (!username ? $("username") : $("password")).focus();
    return;
  }
  say(error, "");
  const button = $("login-submit");
  button.disabled = true;
  button.textContent = "Logger inn …";
  try {
    const { user } = await api("/api/auth/login", { method: "POST", body: { username, password } });
    if (user.mustChangePassword) {
      currentPassword = password;
      showChangeForm();
    } else {
      location.replace("/");
      return;
    }
  } catch (err) {
    say(error, loginMessage(err));
    $("password").select();
  }
  button.disabled = false;
  button.textContent = "Logg inn";
});

changeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const error = $("change-error");
  const current = currentPassword || $("current-password").value;
  const next = $("new-password").value;
  if (!current) return say(error, "Skriv inn passordet du fikk.");
  if (next.length < 8) return say(error, "Det nye passordet må ha minst 8 tegn.");
  if (next !== $("repeat-password").value) return say(error, "De to passordene er ikke like. Prøv en gang til.");
  if (next === current) return say(error, "Velg et annet passord enn det du fikk.");
  say(error, "");
  const button = $("change-submit");
  button.disabled = true;
  try {
    await api("/api/auth/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
    location.replace("/");
  } catch (err) {
    say(error, err.message);
    button.disabled = false;
  }
});

for (const toggle of document.querySelectorAll(".pw-toggle")) {
  toggle.addEventListener("click", () => {
    const input = $(toggle.dataset.for);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    toggle.textContent = show ? "Skjul" : "Vis";
    toggle.setAttribute("aria-pressed", String(show));
    toggle.setAttribute("aria-label", show ? "Skjul passordet" : "Vis passordet");
  });
}

$("password").addEventListener("keyup", (e) => {
  if (e.getModifierState) $("caps").hidden = !e.getModifierState("CapsLock");
});

// Serveren sender innloggede brukere rett videre til forsiden.
$("username").focus();
