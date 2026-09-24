# InnNorsk — spec v5: Workers Paid, translation in Cloudflare (delta on top of the CURRENT code = spec v4 "Drop")

Owner decision (final): he buys **Cloudflare Workers Paid ($5/mo)**. Everything runs on Cloudflare: Svetlana uploads on the warm site, **translation happens automatically in Cloudflare via the xAI API**, results appear in "Mine filer". The owner gets **logs and all files** in admin. **No Mac agent, no Grok CLI, nothing at home.** Keep everything else from v4 (login with client-side PBKDF2, sessions, CSRF, CSP, sendings/files, R2, admin tabs, events, optional APNs push, cron, make-user.js, warm web design).

Previous spec (still valid where not overridden): /tmp/claude-0/-home-user-InnNorsk/78815035-992e-5a1d-81f9-12213c0203a0/scratchpad/SPEC.md (v4).

## Remove
- `mac/` (whole dir), `test/mac/`, `test/helpers/fake-grok.js`, `test/helpers/fake-agent-api.js`, `test/integration/mac-agent.js` and any test relying on the Mac agent.
- Worker agent API (`worker/routes/agent.js`, `/api/agent/*`), `AGENT_TOKEN`, `agent` table usage, agent-offline cron alert, `isAgentOnline`/`agentOnline` logic. package.json script `mottak`.
- Keep `ios/` untouched (optional owner push app; it tolerates missing fields).

## wrangler.jsonc
Add: `"limits": { "cpu_ms": 300000 }`, `"workflows": [{ "name": "innnorsk-translate", "binding": "TRANSLATE", "class_name": "TranslateSending" }]`. Vars: `XAI_MODEL: "grok-4.6"`, `GROK_CONCURRENCY: "2"`, `XAI_PRICE_INPUT_PER_M: ""`, `XAI_PRICE_OUTPUT_PER_M: ""` (USD per 1M tokens; empty = cost unknown, show tokens only), keep MAX_FILE_MB/MAX_FILES_PER_SENDING/APNS_*. Remove AGENT_OFFLINE_ALERT_MINUTES. Secrets: **`XAI_API_KEY` (required)**, `SALT_PEPPER`, optional `APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID`. Optional var `XAI_BASE_URL` (tests → mock). Update the header comment (first-time setup) accordingly, incl. `npx wrangler secret put XAI_API_KEY`. Update `.dev.vars.example`.

## D1: migrations/0002_cloud_translate.sql (do NOT edit 0001)
- `files` add: `segments INTEGER, chars INTEGER, batches INTEGER, plan_json TEXT /* number[][] batch chars per internal call */, estimate_seconds REAL, calls INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0`.
- `sendings` add: `workflow_id TEXT, estimate_seconds REAL, started_at TEXT`.
- New `grok_calls(id INTEGER PK, ts TEXT NOT NULL, sending_id TEXT, file_id TEXT, model TEXT, status INTEGER, ok INTEGER, attempt INTEGER, items INTEGER, input_chars INTEGER, output_chars INTEGER, ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, error TEXT)` + indexes (ts, file_id, model).
- New `batches(file_id TEXT NOT NULL, idx INTEGER NOT NULL, chars INTEGER NOT NULL, ms INTEGER, done_at TEXT, PRIMARY KEY (file_id, idx))` — idempotent progress.
- `DROP TABLE IF EXISTS agent;`

## Upload = analysis + estimate (paid plan allows CPU)
`PUT /api/sendings/:id/files` (draft): read body (≤ MAX_FILE_MB via Content-Length, else 413), store in R2 as now, then `core.analyzeBuffer(Buffer.from(bytes), ext)` → store segments/chars/batches/plan_json/estimate_seconds (estimator below) → file status `draft` with `message` "Klar"; on analysis error (scanned PDF without text, corrupt file) keep the file with status `failed` and a kind Norwegian message (e.g. "Denne PDF-en er et bilde uten tekst og kan ikke oversettes."; "Filen ser ut til å være skadet eller er ikke et gyldig Word-dokument.") — she can remove it; such files are skipped at send. Sending view includes `estimateSeconds` = predicted total for draft/sent files that are not failed.
Import core in the Worker: `import core from "../src/core.js"` (CJS interop, proven in spike) — note core pulls format code; fine on paid plan.

## Send → Workflow
`POST /api/sendings/:id/send`: requires ≥1 non-failed file and `XAI_API_KEY` (else 503 "Oversettelsen er ikke satt opp ennå. Si fra til <translatorName>."), files draft → `sent`, `sent_at`, `estimate_seconds`, create instance `env.TRANSLATE.create({ id: \`${sendingId}-${n}\`, params: { sendingId } })` (n = attempt counter so re-queues get unique ids), store `workflow_id`, events `sending.sent`, optional push to admin devices (keep existing APNs code; no-op without secrets).
Admin "Sett i kø igjen" (`POST /api/admin/files/:id/status {status:"sent"}`) → file back to `sent` (clear error/progress) and start a new instance for its sending (only `sent` files are processed).
Deleting a sending while running → `terminate()` the instance (ignore errors), then delete as now.

## Workflow `TranslateSending` (worker/translate.js), import { WorkflowEntrypoint } from "cloudflare:workers", NonRetryableError from "cloudflare:workflows"
run(event, step):
1. `step.do("start")`: sending.started_at if null; return ordered ids of files with status `sent` (by rel_path).
2. For each file sequentially:
   - `step.do("prepare:<fid>")`: file → `working`, started_at, message "Oversettes nå"; read original from R2; `core.collectStrings`; flatten batches across calls with `planBatches` → `[{ idx, c, k, chars }]`; put `work/<fid>/strings.json` in R2; return `{ batches }` (no text). Event file.started.
   - Chunks of 4 batches: `step.do("chunk:<fid>:<n>", { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "15 minutes" }, …)`: load strings.json; process the chunk's batches with concurrency GROK_CONCURRENCY; **skip a batch if `work/<fid>/b-<idx>.json` exists (never pay twice)**; else `grok.translateBatch(items, { apiKey, model, baseUrl: env.XAI_BASE_URL, targetLanguage, timeoutMs: 240000, onCall, onWarning })`; onCall → insert grok_calls row + increment files.calls/input_tokens/output_tokens (collect promises; await all before the step returns); put `b-<idx>.json`; `INSERT OR IGNORE INTO batches`; then update files.progress_percent (done chars / total chars), eta_seconds (estimator live ETA), progress_at. Auth-type GrokError (auth/forbidden/no_key) → `throw new NonRetryableError("[" + code + "] " + message)`.
   - `step.do("assemble:<fid>")`: rebuild translatedCalls from strings.json + all b-*.json; `core.applyTranslations`; output name = `<stem> (norsk)<outExt>` (basename of rel_path; keep folder part in rel path for display only); put result to R2 via the existing saveResult path (source "cloud"); cost_usd from tokens × price vars when set; event file.done (+ file.warning for warnings). Delete `work/<fid>/` objects.
   - A step that throws after retries → catch in run(): `step.do("fail:<fid>")` marks the file failed: her text "Kunne ikke oversettes. <translatorName> har fått beskjed." (statusText), admin sees error + details (stack / validation details); event file.failed; optional push to admin. If the error is auth-type (message starts with "[auth]", "[forbidden]" or "[no_key]") → `step.do("abort")` marks all remaining `sent` files failed with the same admin error and stops.
3. `step.do("finish")`: sending finished_at when all files final; event sending.done `{ estimateSeconds, actualSeconds, files, done, failed, calls, inputTokens, outputTokens, costUsd }`.
Step names deterministic + unique. Workflow limits: files ≤ MAX_FILES_PER_SENDING (50).

## Estimator (worker/estimate.js, pure)
Batch model `t = a + b·chars` seconds, defaults a = 8, b = 0.006; `fitParams(rows)` from recent ok grok_calls (input_chars, ms) of the current model: least squares, ≥ 8 rows, clamps a∈[0.5,120], b∈[0.0002,0.2], blend with defaults by n/(n+20); cache 60 s. `predictFile(plan, params, n)` = Σ over chunks of 4 batches (flattened in order) of LPT makespan(n workers) + 3 s overhead. `predictSending(files)` = Σ predictFile. Live ETA per file: remaining = Σ predicted remaining chunks × r' where r' = blended ratio actual/predicted for this file's done batches ((r·w + 3)/(w + 3)). Store eta_seconds + progress_at; the existing serializeFile keeps computing "seconds remaining at response time" from them. For `sent` files not yet started, statusText "I kø – starter straks" and the sending view has `estimateSeconds` (remaining total).

## statusText (Norwegian, for her)
draft (ok): "Klar – ca. N min"; draft (failed analysis): kind reason; sent: "I kø – starter straks"; working: "Oversettes nå – 45 % – ca. 3 min igjen"; done: "Ferdig"; failed: "Kunne ikke oversettes. <translatorName> har fått beskjed.".

## Admin API changes
- `GET /api/admin/overview` → `{ translator: { apiKeyConfigured, model, calls24h, failedCalls24h, tokens24h: { input, output }, cost24h /* null if prices unset */, lastCallAt, lastError }, counts: { waiting, working, doneToday, failed }, storage, devices, users, estimator: { a, b, samples, source } }` (no `agent`).
- Sendings admin view: per file add `calls, inputTokens, outputTokens, costUsd, estimateSeconds, durationSeconds` and `outputSource` ("cloud"|"manual").
- `GET /api/admin/files/:id/calls` → `{ calls: [...] }` newest first (max 200).
- `POST /api/admin/test-api` → one tiny call via `grok.testConnection` → `{ ok, ms, sample?, error? }`, max 1/min, event admin.test_api.
- Keep manual result upload, status change, reply, events, sessions, users, devices, test-push.

## Cron (every 15 min)
Keep cleanup. Add reconcile: files `working` whose progress_at (or started_at) is older than 30 min and whose sending's workflow instance status is errored/terminated/unknown → failed "Oversettelsen stoppet uventet." (admin can re-queue). Remove agent-offline alert.

## Tests (never real xAI/APNs)
- Recreate `test/helpers/mock-xai-server.js`: HTTP mock of `POST /v1/responses` using `transform`/`extractArray` logic from `test/helpers/mock-grok.js` (add exports there if needed without changing behaviour); modes upper|mismatch|flaky429|fail401|fail403|slow; runtime switch `POST /__mode {mode, delayMs}`; returns usage tokens; start({port,mode,delayMs}) → { url, close, setMode, state }.
- worker-dev passes `XAI_BASE_URL` (mock url), `XAI_API_KEY` (dummy), price vars; drop AGENT_TOKEN.
- Cover: upload analysis numbers + estimate; scanned/corrupt file → failed at draft and skipped at send; send → workflow → done with progress seen in between (mock slow) → download "<stem> (norsk).docx" valid docx containing "NB:" with formatting/table intact; nynorsk prompt label; mismatch mode still completes; 401 → file failed with kind text + admin error, remaining files failed; cost computed when price vars set; grok_calls rows + admin calls endpoint; delete sending mid-run; re-queue failed file → done after switching mock back; overview translator stats; test-api; cron reconcile. Keep auth/admin/sendings tests green (adapt agent bits away).
- `npm test` must pass (run twice). Keep suite reasonably fast.
