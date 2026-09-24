import { api } from "./api.js";

const $ = (id) => document.getElementById(id);
const loginForm = $("login-form");
const changeForm = $("change-form");

// Passordet brukeren nettopp logget inn med, så hun slipper å skrive det igjen.
let currentPassword = "";

function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

function toggleVisible(checkbox, inputs) {
  checkbox.addEventListener("change", () => {
    for (const input of inputs) input.type = checkbox.checked ? "text" : "password";
  });
}

function showChangeForm() {
  loginForm.hidden = true;
  changeForm.hidden = false;
  $("current-field").hidden = Boolean(currentPassword);
  (currentPassword ? $("new-password") : $("current-password")).focus();
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("username").value.trim();
  const password = $("password").value;
  const error = $("login-error");
  if (!username || !password) {
    showError(error, "Skriv inn både brukernavn og passord.");
    return;
  }
  showError(error, "");
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
    }
  } catch (err) {
    showError(error, err.message);
    $("password").select();
  } finally {
    button.disabled = false;
    button.textContent = "Logg inn";
  }
});

changeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const error = $("change-error");
  const current = currentPassword || $("current-password").value;
  const next = $("new-password").value;
  if (!current) return showError(error, "Skriv inn passordet du fikk.");
  if (next.length < 10) return showError(error, "Det nye passordet må ha minst 10 tegn.");
  if (next !== $("repeat-password").value) return showError(error, "De to passordene er ikke like. Prøv igjen.");
  if (next === current) return showError(error, "Det nye passordet må være forskjellig fra det du fikk.");
  showError(error, "");
  const button = $("change-submit");
  button.disabled = true;
  try {
    await api("/api/auth/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
    location.replace("/");
  } catch (err) {
    showError(error, err.message);
    button.disabled = false;
  }
});

toggleVisible($("show-password"), [$("password")]);
toggleVisible($("show-new"), [$("current-password"), $("new-password"), $("repeat-password")]);

// Allerede innlogget? Send videre, eller be om nytt passord først.
api("/api/auth/me")
  .then(({ user }) => {
    if (user.mustChangePassword) showChangeForm();
    else location.replace("/");
  })
  .catch(() => $("username").focus());
