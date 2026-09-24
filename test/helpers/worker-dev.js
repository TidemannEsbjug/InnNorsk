// Starter Workeren lokalt (wrangler dev) med egen database/lagring i en midlertidig mappe.
//   const dev = await require("./worker-dev").start({ mockUrl, vars: { GROK_CONCURRENCY: "2" } });
//   await fetch(dev.url + "/healthz"); dev.logs(); await dev.stop();
// .dev.vars og .env i repoet leses aldri her (egen --env-file), så ekte nøkler kan ikke lekke inn i tester.
// Hemmelighetene (bare dummyverdier) sendes som secrets via --env-file, resten som --var.
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const ROOT = path.resolve(__dirname, "../..");
const WRANGLER = path.join(ROOT, "node_modules/.bin/wrangler");
const READY_TIMEOUT_MS = 90000;

// Bare dummyverdier. Tester som trenger dem, leser dem herfra.
const DEFAULT_VARS = {
  XAI_API_KEY: "mock-nokkel-for-test",
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "admin-testpassord-123",
  SEED_USER_USERNAME: "Svetlana",
  SEED_USER_DISPLAY_NAME: "Svetlana",
  SEED_USER_PASSWORD: "testpassord-123",
};

const SECRETS = ["XAI_API_KEY", "ADMIN_PASSWORD", "SEED_USER_PASSWORD"];

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function wrangler(args, { env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(WRANGLER, args, { cwd: ROOT, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`wrangler ${args.join(" ")} feilet:\n${stripAnsi(stdout + stderr)}`));
      else resolve(stripAnsi(stdout));
    });
  });
}

const QUIET = { WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" };

// persistDir: gjenbruk en eksisterende mappe (den slettes da ikke av stop()).
async function start({ vars = {}, mockUrl, persistDir } = {}) {
  const dir = persistDir || fs.mkdtempSync(path.join(os.tmpdir(), "innnorsk-dev-"));
  const ownsDir = !persistDir;
  await wrangler(["d1", "migrations", "apply", "innnorsk", "--local", "--persist-to", dir], { env: QUIET });

  const all = { ...DEFAULT_VARS, ...(mockUrl ? { XAI_BASE_URL: mockUrl } : {}), ...vars };
  const secretsFile = path.join(dir, "secrets.env");
  fs.writeFileSync(secretsFile, SECRETS.map((k) => `${k}=${JSON.stringify(String(all[k] ?? ""))}\n`).join(""));
  const [port, inspectorPort] = [await freePort(), await freePort()];
  const args = [
    "dev",
    "--ip", "127.0.0.1",
    "--port", String(port),
    "--inspector-port", String(inspectorPort),
    "--persist-to", dir,
    "--env-file", secretsFile,
    "--test-scheduled",
    "--show-interactive-dev-session=false",
    "--log-level", "log",
  ];
  for (const [k, v] of Object.entries(all)) if (!SECRETS.includes(k)) args.push("--var", `${k}:${v}`);

  const child = spawn(WRANGLER, args, {
    cwd: ROOT,
    env: { ...process.env, ...QUIET },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk) => {
    output += stripAnsi(chunk.toString());
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  let exited = false;
  const exitPromise = new Promise((resolve) => child.once("exit", () => {
    exited = true;
    resolve();
  }));

  // keepData: behold databasen og filene, f.eks. for å starte på nytt med samme --persist-to.
  async function stop({ keepData = false } = {}) {
    if (!exited) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // allerede borte
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // allerede borte
        }
      }, 5000);
      await exitPromise;
      clearTimeout(timer);
    }
    if (ownsDir && !keepData) fs.rmSync(dir, { recursive: true, force: true });
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev startet ikke:\n${output.slice(-4000)}`)), READY_TIMEOUT_MS);
    const check = () => {
      if (/Ready on http/.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    exitPromise.then(() => {
      clearTimeout(timer);
      reject(new Error(`wrangler dev avsluttet:\n${output.slice(-4000)}`));
    });
  }).catch(async (err) => {
    await stop();
    throw err;
  });

  const url = `http://127.0.0.1:${port}`;
  const explorer = `${url}/cdn-cgi/local/explorer/api`;

  // SQL direkte mot den lokale D1-databasen (via wranglers Local Explorer). Returnerer rader som objekter.
  // Explorer-API-et tar bare strengparametre; SQLite gjør dem om til tall der kolonnen er INTEGER.
  async function sql(query, ...params) {
    const res = await fetch(`${explorer}/d1/database/DB/raw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: query, params: params.map(String) }),
    });
    const body = await res.json();
    if (!body.success) throw new Error(`SQL feilet: ${JSON.stringify(body.errors)}`);
    const { columns, rows } = body.result[0].results;
    return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
  }

  // Nøkler i R2-bøtta med gitt prefiks.
  async function r2Keys(prefix = "") {
    const res = await fetch(`${explorer}/r2/buckets/innnorsk-files/objects?prefix=${encodeURIComponent(prefix)}`);
    const body = await res.json();
    if (!body.success) throw new Error(`R2-listing feilet: ${JSON.stringify(body.errors)}`);
    return body.result.map((o) => o.key);
  }

  async function r2Put(key, body) {
    const res = await fetch(`${explorer}/r2/buckets/innnorsk-files/objects/${encodeURIComponent(key)}`, { method: "PUT", body });
    if (!(await res.json()).success) throw new Error(`R2-opplasting av ${key} feilet`);
  }

  return { url, port, persistDir: dir, vars: all, logs: () => output, sql, r2Keys, r2Put, stop };
}

module.exports = { start, DEFAULT_VARS };
