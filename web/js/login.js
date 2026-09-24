import { api, proofFor, changePassword, passwordProblem, bindPasswordToggles, reportErrors } from "./api.js";

reportErrors();
bindPasswordToggles();

const $ = (id) => document.getElementById(id);
const loginForm = $("login-form");
const changeForm = $("change-form");

// Etter innlogging med midlertidig passord: brukes som «nåværende passord» ved byttet.
let session = null;

function say(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

function busy(button, text) {
  button.dataset.label ||= button.textContent;
  button.disabled = Boolean(text);
  button.classList.toggle("is-busy", Boolean(text));
  button.textContent = text || button.dataset.label;
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
    say(error, username ? "Skriv inn passordet ditt også." : "Skriv inn brukernavnet ditt først.");
    $(username ? "password" : "username").focus();
    return;
  }
  say(error, "");
  const button = $("login-submit");
  busy(button, "Logger inn …");
  try {
    const proof = await proofFor(username, password);
    const { user } = await api("/api/auth/login", { method: "POST", body: { username, proof } });
    if (!user.mustChangePassword) {
      location.replace("/");
      return;
    }
    session = { username: user.username, password, proof };
    loginForm.hidden = true;
    changeForm.hidden = false;
    $("change-title").focus();
  } catch (err) {
    say(error, loginMessage(err));
    $("password").select();
  }
  busy(button, "");
});

changeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const error = $("change-error");
  const next = $("new-password").value;
  const problem = passwordProblem(next, $("repeat-password").value, session.password);
  say(error, problem);
  if (problem) return;
  const button = $("change-submit");
  busy(button, "Lagrer …");
  try {
    await changePassword({ username: session.username, currentProof: session.proof, next });
    location.replace("/");
  } catch (err) {
    say(error, err.message);
    busy(button, "");
  }
});

$("password").addEventListener("keyup", (e) => {
  $("caps").hidden = !e.getModifierState("CapsLock");
});

$("username").focus();
