// Starter Workeren lokalt (wrangler dev, med Workflowen) med egen D1/R2 i en midlertidig mappe, testbrukere laget med
// scripts/make-user.js, en falsk xAI (test/helpers/mock-xai-server.js) og en falsk APNs (test/helpers/mock-apns.js).
// Kaller aldri Apple eller xAI; XAI_API_KEY er en dummyverdi.
//   const dev = await require("./worker-dev").start({ vars: { GROK_CONCURRENCY: "1" }, xai: { mode: "slow", delayMs: 800 } });
//   dev.url · dev.users.svetlana.password · dev.xai.state.requests · dev.xai.setMode("fail401") · dev.apns.pushes
//   const svetlana = await dev.login("svetlana");    // Client med økt (test/worker/client.js)
//   await dev.sql("SELECT ..."); await dev.r2Keys("work/"); await dev.cron(); dev.logs(); await dev.stop();
// .dev.vars og .env i repoet leses aldri (egen --env-file), så ekte nøkler kan ikke lekke inn i tester.
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { makeUserSql } = require("../../scripts/make-user");
const mockApns = require("./mock-apns");
const mockXai = require("./mock-xai-server");
const { Client } = require("../worker/client");

const ROOT = path.resolve(__dirname, "../..");
const WRANGLER = path.join(ROOT, "node_modules/.bin/wrangler");
const READY_TIMEOUT_MS = 90000;
const CRON = "*/15 * * * *";

// Bare dummyverdier.
const DEFAULT_USERS = {
  eier: { username: "eier", displayName: "Jonas", role: "admin", password: "eier-testpassord-123" },
  svetlana: { username: "svetlana", displayName: "Svetlana", role: "user", password: "testpassord-123" },
};
const XAI_API_KEY = "test-xai-nokkel-bare-for-tester-0123456789";
// Testpriser (USD per million tokens), så kostnad regnes ut. Sett dem til "" for «ukjent pris».
const PRICES = { XAI_PRICE_INPUT_PER_M: "2", XAI_PRICE_OUTPUT_PER_M: "10" };

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const QUIET = { WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" };

// n ulike ledige porter (alle holdes åpne samtidig, så samme port ikke kan komme to ganger).
async function freePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  })));
  const ports = servers.map((srv) => srv.address().port);
  await Promise.all(servers.map((srv) => new Promise((resolve) => srv.close(resolve))));
  return ports;
}

function wrangler(args) {
  return new Promise((resolve, reject) => {
    execFile(WRANGLER, args, { cwd: ROOT, env: { ...process.env, ...QUIET }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`wrangler ${args.slice(0, 3).join(" ")} feilet:\n${stripAnsi(stdout + stderr)}`));
      else resolve(stripAnsi(stdout));
    });
  });
}

// Samme vei som eieren oppretter brukere: SQL fra make-user.js kjørt med wrangler d1 execute.
function createUsers(persistDir, users) {
  const sql = Object.values(users).map((u) => makeUserSql(u)).join("; ");
  return wrangler(["d1", "execute", "innnorsk", "--local", "--persist-to", persistDir, "--command", sql]);
}

// Dummy APNs-nøkkel laget på stedet; den offentlige halvdelen gis til den falske APNs-serveren.
function apnsKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }), publicKey };
}

// users: { navn: { username, displayName, role, password, mustChangePassword } } (standard: eier + svetlana).
// xai: { mode, delayMs } for den falske xAI-serveren (standard upper).
async function start({ vars = {}, users = DEFAULT_USERS, xai: xaiOptions = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "innnorsk-dev-"));
  let apns = null;
  let xai = null;
  let child = null;
  let exited = true;
  let exitPromise = Promise.resolve();
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // allerede borte
    }
  };
  // Dør testprosessen uten stop() (krasj, process.exit), skal ikke wrangler bli hengende igjen.
  const killOnExit = () => killGroup("SIGKILL");

  async function stop() {
    process.off("exit", killOnExit);
    if (child && !exited) {
      killGroup("SIGTERM");
      const timer = setTimeout(() => killGroup("SIGKILL"), 5000);
      await exitPromise;
      clearTimeout(timer);
    }
    if (apns) await apns.close();
    if (xai) await xai.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  let output = "";
  try {
    await wrangler(["d1", "migrations", "apply", "innnorsk", "--local", "--persist-to", dir]);
    if (Object.keys(users).length) await createUsers(dir, users);
    const key = apnsKeyPair();
    if (!vars.APNS_BASE_URL) apns = await mockApns.start({ publicKey: key.publicKey });
    if (!vars.XAI_BASE_URL) xai = await mockXai.start(xaiOptions);
    const all = {
      XAI_API_KEY,
      ...(xai ? { XAI_BASE_URL: xai.url } : {}),
      ...PRICES,
      APNS_KEY_P8: key.pem,
      APNS_KEY_ID: "TESTKEY123",
      APNS_TEAM_ID: "TESTTEAM12",
      SALT_PEPPER: "test-pepper",
      ...(apns ? { APNS_BASE_URL: apns.url } : {}),
      ...vars,
    };
    const envFile = path.join(dir, "test.env");
    fs.writeFileSync(envFile, Object.entries(all).map(([k, v]) => `${k}=${JSON.stringify(String(v))}\n`).join(""));

    const [port, inspectorPort] = await freePorts(2);
    child = spawn(WRANGLER, [
      "dev",
      "--ip", "127.0.0.1",
      "--port", String(port),
      "--inspector-port", String(inspectorPort),
      "--persist-to", dir,
      "--env-file", envFile,
      "--test-scheduled",
      "--show-interactive-dev-session=false",
      "--log-level", "log",
    ], { cwd: ROOT, env: { ...process.env, ...QUIET }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    exited = false;
    process.once("exit", killOnExit);
    exitPromise = new Promise((resolve) => child.once("exit", () => {
      exited = true;
      resolve();
    }));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`wrangler dev startet ikke:\n${output.slice(-4000)}`)), READY_TIMEOUT_MS);
      const collect = (chunk) => {
        output += stripAnsi(chunk.toString());
        if (/Ready on http/.test(output)) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      exitPromise.then(() => {
        clearTimeout(timer);
        reject(new Error(`wrangler dev avsluttet:\n${output.slice(-4000)}`));
      });
    });

    const url = `http://127.0.0.1:${port}`;
    const explorer = `${url}/cdn-cgi/local/explorer/api`;

    const databases = await (await fetch(`${explorer}/d1/database`)).json();
    const dbId = encodeURIComponent(databases.result.find((d) => d.name === "DB").uuid);

    // SQL direkte mot den lokale D1-databasen (wranglers Local Explorer). Parametre sendes som strenger.
    async function sql(query, ...params) {
      const res = await fetch(`${explorer}/d1/database/${dbId}/raw`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: query, params: params.map(String) }),
      });
      const body = await res.json();
      if (!body.success) throw new Error(`SQL feilet: ${JSON.stringify(body.errors)}`);
      const { columns, rows } = body.result[0].results;
      return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
    }

    async function r2Keys(prefix = "") {
      const res = await fetch(`${explorer}/r2/buckets/innnorsk-files/objects?prefix=${encodeURIComponent(prefix)}`);
      const body = await res.json();
      if (!body.success) throw new Error(`R2-listing feilet: ${JSON.stringify(body.errors)}`);
      return body.result.map((o) => o.key);
    }

    async function login(name, { password, ip } = {}) {
      const u = users[name] || { username: name };
      const client = new Client(url, { ip });
      const res = await client.login(u.username, password || u.password);
      if (res.status !== 200) throw new Error(`Innlogging for ${u.username} ga ${res.status} ${JSON.stringify(res.data)}`);
      return client;
    }

    // Kjører scheduled() slik cron gjør hvert 15. minutt.
    async function cron() {
      const res = await fetch(`${url}/__scheduled?cron=${encodeURIComponent(CRON)}`);
      if (res.status !== 200) throw new Error(`/__scheduled ga ${res.status}`);
    }

    return {
      url,
      port,
      persistDir: dir,
      vars: all,
      users,
      apns,
      xai,
      logs: () => output,
      sql,
      r2Keys,
      login,
      cron,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

module.exports = { start, DEFAULT_USERS };
