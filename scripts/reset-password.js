// Nødverktøy: nytt passord for en bruker rett i D1, når Admin → Brukere ikke kan brukes (f.eks. mistet admin-passord).
// Lager scrypt-hashen med worker/auth.js og skriver ut en wrangler-kommando du kjører selv. Passordet skrives aldri ut.
//   node scripts/reset-password.js [--local] [brukernavn]
// Passordet skrives inn skjult to ganger. Uten terminal (rør) leses det fra første linje på stdin.
const path = require("node:path");
const readline = require("node:readline");
const { pathToFileURL } = require("node:url");

const DB = "innnorsk";
const USERNAME = /^[\p{L}\p{N}._@-]{1,64}$/u; // samme regel som Admin → Brukere

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

async function firstStdinLine() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/)[0];
}

function die(message) {
  console.error(message);
  process.exit(1);
}

// `$` i hashen ville blitt tolket av skallet (zsh, bash, PowerShell). Hashen skrives derfor med `:`
// (finnes ikke i base64) og byttes tilbake til `$` (char(36)) i SQL.
function buildSql(username, hash) {
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const where = `username = ${q(username)} COLLATE NOCASE`;
  return [
    `UPDATE users SET password_hash = replace(${q(hash.replace(/\$/g, ":"))}, ':', char(36)), must_change_password = 0 WHERE ${where}`,
    `UPDATE sessions SET revoked_at = ${q(new Date().toISOString())}, revoked_reason = 'password_reset' WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE ${where})`,
    `SELECT username, role, disabled FROM users WHERE ${where}`,
  ].join("; ");
}

async function main() {
  const args = process.argv.slice(2);
  const local = args.includes("--local");
  const interactive = Boolean(process.stdin.isTTY);
  let username = args.find((a) => !a.startsWith("--"));
  if (!username) {
    if (!interactive) die("Oppgi brukernavnet: node scripts/reset-password.js <brukernavn>");
    username = await ask("Brukernavn: ");
  }
  username = username.trim();
  if (!USERNAME.test(username)) die("Brukernavnet kan bare ha bokstaver, tall og . _ - @ (1–64 tegn).");

  const { hashPassword, MIN_PASSWORD } = await import(pathToFileURL(path.join(__dirname, "../worker/auth.js")).href);

  let password;
  if (interactive) {
    password = await ask("Nytt passord (vises ikke): ", { hidden: true });
    if ((await ask("Skriv det en gang til: ", { hidden: true })) !== password) die("Passordene er ikke like. Ingenting er endret.");
  } else {
    password = await firstStdinLine();
  }
  if ([...password].length < MIN_PASSWORD) die(`Passordet må ha minst ${MIN_PASSWORD} tegn. Ingenting er endret.`);

  const sql = buildSql(username, hashPassword(password));
  console.log(`
Kjør denne kommandoen i InnNorsk-mappen (der wrangler.jsonc ligger):

npx wrangler d1 execute ${DB} ${local ? "--local" : "--remote"} --command "${sql}"

Til slutt viser Wrangler brukeren som ble endret. Vises ingen bruker, finnes ikke brukernavnet, og ingenting er endret.
Brukeren logges ut overalt og logger inn med det nye passordet (uten å måtte bytte det).
Passordet står ikke i kommandoen, bare en scrypt-hash av det.`);
}

main().catch((err) => die(err.message));
