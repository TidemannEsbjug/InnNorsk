// Oppretter en bruker i D1, eller gir en eksisterende bruker nytt passord, uten at passordet forlater maskinen.
//   node scripts/make-user.js <brukernavn> [--role admin|user] [--display-name "Navn"] [--must-change]
//                             [--remote | --local [--persist-to <mappe>]] [--apply]
// Passordet skrives inn skjult to ganger (uten terminal: første og eventuelt andre linje på stdin).
// Som nettleseren og iPhone-appen regner skriptet ut proof = PBKDF2-SHA256(passord, tilfeldig salt, 310000, 32 byte),
// og SQL-en lagrer bare salt og sha256(proof). Skriptet skriver ut wrangler-kommandoen, og kjører den med --apply.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");

const DB = "innnorsk";
const ITERATIONS = 310000;
const MIN_PASSWORD = 8;
const USERNAME = /^[\p{L}\p{N}._@-]{1,64}$/u; // samme regel som Workeren (worker/auth.js)
const ROOT = path.resolve(__dirname, "..");

const pbkdf2Proof = (password, salt, iterations = ITERATIONS) =>
  crypto.pbkdf2Sync(String(password), Buffer.from(salt, "base64url"), iterations, 32, "sha256").toString("base64url");

const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

function makeUserSql({ username, displayName, role = "user", password, mustChangePassword = false }) {
  const name = String(username || "").normalize("NFC").trim();
  if (!USERNAME.test(name)) throw new Error("Brukernavnet kan bare ha bokstaver, tall og . _ - @ (1–64 tegn).");
  if (!["admin", "user"].includes(role)) throw new Error("Rollen må være admin eller user.");
  if ([...String(password || "")].length < MIN_PASSWORD) throw new Error(`Passordet må ha minst ${MIN_PASSWORD} tegn.`);
  const salt = crypto.randomBytes(16).toString("base64url");
  const verifier = crypto.createHash("sha256").update(pbkdf2Proof(password, salt)).digest("hex");
  const now = new Date().toISOString();
  const values = [name, String(displayName || name).trim() || name, role, salt].map(sqlString);
  return [
    `INSERT INTO users (username, display_name, role, salt, iterations, verifier, must_change_password, created_at)` +
      ` VALUES (${values.join(", ")}, ${ITERATIONS}, ${sqlString(verifier)}, ${mustChangePassword ? 1 : 0}, ${sqlString(now)})` +
      " ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, role = excluded.role, salt = excluded.salt," +
      " iterations = excluded.iterations, verifier = excluded.verifier, must_change_password = excluded.must_change_password, disabled = 0",
    `UPDATE sessions SET revoked_at = ${sqlString(now)}, revoked_reason = 'password_reset'` +
      ` WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE username = ${sqlString(name)})`,
    `SELECT username, display_name, role, must_change_password FROM users WHERE username = ${sqlString(name)}`,
  ].join("; ");
}

// ---- Kommandolinje ----

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => {
      if (!muted) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
    muted = hidden;
  });
}

async function stdinLines() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/);
}

// POSIX-skall (zsh/bash): enkeltfnutter rundt alt som ikke er helt trygt.
const shellQuote = (s) => (/^[\w@%+=:,./-]+$/u.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

function parseArgs(argv) {
  const opts = { role: "user", mustChangePassword: false, local: false, apply: false };
  const rest = [...argv];
  while (rest.length) {
    const arg = rest.shift();
    if (arg === "--role") opts.role = rest.shift();
    else if (arg === "--display-name") opts.displayName = rest.shift();
    else if (arg === "--persist-to") opts.persistTo = rest.shift();
    else if (arg === "--must-change") opts.mustChangePassword = true;
    else if (arg === "--local") opts.local = true;
    else if (arg === "--remote") opts.local = false;
    else if (arg === "--apply") opts.apply = true;
    else if (arg.startsWith("--")) throw new Error(`Ukjent valg: ${arg}`);
    else opts.username = arg;
  }
  if (opts.persistTo) opts.local = true;
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const interactive = Boolean(process.stdin.isTTY);
  if (!opts.username) {
    if (!interactive) throw new Error("Oppgi brukernavnet: node scripts/make-user.js <brukernavn> --role admin|user");
    opts.username = await ask("Brukernavn: ");
  }
  let password;
  if (interactive) {
    password = await ask("Passord (vises ikke): ", { hidden: true });
    if ((await ask("Skriv det en gang til: ", { hidden: true })) !== password) throw new Error("Passordene er ikke like. Ingenting er endret.");
  } else {
    const [first, second] = await stdinLines();
    if (second && second !== first) throw new Error("Passordene er ikke like. Ingenting er endret.");
    password = first;
  }
  const sql = makeUserSql({ ...opts, password });
  const args = ["d1", "execute", DB, opts.local ? "--local" : "--remote", ...(opts.persistTo ? ["--persist-to", opts.persistTo] : []), "--command", sql];
  console.log(`
Kommandoen under lagrer brukeren ${opts.username} (bare salt og sha256 av PBKDF2-beviset, aldri passordet):

npx wrangler ${args.map(shellQuote).join(" ")}
`);
  if (!opts.apply) {
    console.log("Kjør den i InnNorsk-mappen (der wrangler.jsonc ligger), eller kjør skriptet på nytt med --apply.");
    return;
  }
  const local = path.join(ROOT, "node_modules/.bin/wrangler");
  const [cmd, cmdArgs] = fs.existsSync(local) ? [local, args] : ["npx", ["wrangler", ...args]];
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit" });
  if (res.status !== 0) throw new Error("wrangler d1 execute feilet. Ingenting er endret.");
  console.log(`Ferdig. ${opts.username} kan logge inn nå; eventuelle gamle innlogginger er avsluttet.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { makeUserSql, pbkdf2Proof, ITERATIONS };
