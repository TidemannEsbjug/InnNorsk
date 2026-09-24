// Den ekte Mac-agenten (node mac/innnorsk-mottak.js once|run) som egen prosess mot worker-dev, slik launchd starter den:
// midlertidig HOME med ~/.innnorsk/config.json, agent-tokenet i filreserven (~/.innnorsk/agent.json, ingen nøkkelring),
// falsk Grok CLI (test/helpers/fake-grok.js) og falske security/osascript/launchctl. Kaller aldri ekte Grok.
//   const mac = startMac(dev, { config: { concurrency: 1 }, history: [{ chars: 1000, ms: 60000 }, …] });
//   const { code, lines } = await mac.once({ FAKE_GROK_MODE: "slow", FAKE_GROK_DELAY_MS: "1200" });
//   const agent = mac.run({ FAKE_GROK_MODE: "ok" }); … await agent.stop();
//   mac.grokCalls() · mac.notifications() · mac.home · await mac.cleanup()
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_GROK_ARGS } = require("../../mac/config");
const { CLI, FAKE_GROK, machine, writeSetup } = require("../mac/helpers");

const STOP_GRACE_MS = 8000;

// history: tidligere Grok-kall på «Mac-en» ({ chars, ms }), som estimatene bygger på (~/.innnorsk/stats.json).
function startMac(dev, { config = {}, history = null } = {}) {
  const cleanups = [];
  const m = machine({ after: (fn) => cleanups.push(fn) }, { keychain: false });
  const settings = {
    siteUrl: dev.url,
    outputDir: path.join(m.home, "InnNorsk"),
    concurrency: 1,
    leaseSeconds: 120,
    pollSeconds: 1,
    pauseSeconds: 300,
    retryDelayMs: 1,
    tokenStore: "file",
    grok: { command: FAKE_GROK, args: DEFAULT_GROK_ARGS, model: null, effort: "low", timeoutSeconds: 60 },
    ...config,
  };
  writeSetup(m, settings, dev.agentToken);
  if (history) fs.writeFileSync(m.paths.statsFile, JSON.stringify({ batches: history }));

  const running = new Set();
  const killAll = () => {
    for (const child of running) child.kill("SIGKILL");
  };
  process.on("exit", killAll);

  // Starter agenten. lines = JSON-linjene den skriver (samme som launchd legger i mottak.log).
  function spawnAgent(command, env = {}) {
    const child = spawn(process.execPath, [CLI, command], {
      env: { ...m.env, FAKE_GROK_LOG: m.grokLog, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.add(child);
    const handle = { child, lines: [], stdout: "", stderr: "" };
    child.stdout.on("data", (chunk) => {
      handle.stdout += chunk;
      const parts = handle.stdout.split("\n");
      handle.stdout = parts.pop();
      for (const line of parts.filter(Boolean)) {
        try {
          handle.lines.push(JSON.parse(line));
        } catch {
          handle.lines.push({ raw: line });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      handle.stderr += chunk;
    });
    handle.exited = new Promise((resolve) => child.on("exit", (code, signal) => {
      running.delete(child);
      resolve(code ?? signal);
    }));
    handle.types = () => handle.lines.map((l) => l.type);
    // SIGTERM som launchd; henger den, SIGKILL.
    handle.stop = async () => {
      if (!running.has(child)) return handle.exited;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
      const code = await handle.exited;
      clearTimeout(timer);
      return code;
    };
    return handle;
  }

  async function once(env, { timeoutMs = 120000 } = {}) {
    const handle = spawnAgent("once", env);
    const timer = setTimeout(() => handle.child.kill("SIGKILL"), timeoutMs);
    const code = await handle.exited;
    clearTimeout(timer);
    return { code, lines: handle.lines, stderr: handle.stderr, types: handle.types() };
  }

  return {
    home: m.home,
    paths: m.paths,
    config: settings,
    grokCalls: m.grokCalls,
    notifications: () => m.binCalls("osascript").map((args) => args[1]),
    spawn: spawnAgent,
    once,
    run: (env) => spawnAgent("run", env),
    async cleanup() {
      await Promise.all([...running].map((child) => {
        child.kill("SIGTERM");
        return new Promise((resolve) => {
          const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }));
      process.off("exit", killAll);
      for (const fn of cleanups) fn();
    },
  };
}

// Kostnaden per falske Grok-kall (test/helpers/fake-grok.js, FAKE_GROK_COST).
const FAKE_COST_PER_CALL = 0.0007;

module.exports = { startMac, FAKE_GROK, FAKE_COST_PER_CALL };
