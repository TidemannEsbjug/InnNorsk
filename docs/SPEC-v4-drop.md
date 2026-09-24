# InnNorsk Drop — spec v4 (binding contract for all build agents)

Repo: /home/user/InnNorsk, branch claude/cloud-solution-login-logging-1n7k24. Owner writes to us in Norwegian/English; **all product UI is Norwegian bokmål** (correct æøå).

## What the owner wants (final)
- Svetlana (the only end user) logs in on a **warm, pleasant website** and **drops files** to the owner. The owner gets a **push notification on his iPhone** (his own native iOS app; he has Xcode + Apple Developer Program).
- The **owner's Mac mini M2** (mostly always on) runs a **headless agent** — no UI to click — that automatically picks up her files, translates them with the existing InnNorsk translation engine (`src/core.js`, keeps formatting) using **Grok Build CLI** in headless mode (cheaper than the API), and sends the result back. If the Mac is off, files wait safely in the cloud and are processed when it comes back.
- Svetlana sees the status and downloads the finished translation **on the site** (no email). Clear, kind statuses; she can close the page and come back.
- **Cost: $0.** The website runs on **Cloudflare Workers FREE plan** + D1 (free) + R2 (free 10 GB). No xAI API calls from the cloud at all (no API key in the cloud).
- The owner still wants **visible logs** (logins, uploads, downloads, agent activity, errors) and **estimates** (agent reports progress % and ETA).
- Never commit passwords, tokens or keys. Tests never call real xAI or real Grok or real APNs.

## Components
1. **Worker** (`worker/`, Cloudflare Workers Free): website (static `web/`), JSON API, agent API, APNs push, cron cleanup.
2. **Web UI** (`web/`): login, Svetlana's drop page + "Mine filer", owner admin.
3. **Mac agent** (`mac/`): Node ≥ 20 headless daemon under launchd + CLI (`setup`, `doctor`, `run`, `once`, `translate`).
4. **iOS app** (`ios/`): SwiftUI app for the owner: login, registers APNs token, shows sendings + agent status, receives pushes.
5. **Core** (`src/` — owned by orchestrator, DONE): `src/core.js`, `src/grok.js` (now with pluggable `ctx.transport`), formats. Electron/Windows app stays as-is (legacy; do not delete).

## FREE-PLAN CONSTRAINT (critical): ≤ 10 ms CPU per Worker request
- No server-side password hashing, no zip building, no document parsing in the Worker. Stream uploads/downloads between request and R2.
- **Password auth = client-side key stretching + server-side SHA-256** (proven pattern; DB theft still requires PBKDF2 per guess):
  - `POST /api/auth/salt {username}` → `{ salt, iterations }` — real salt for existing users; for unknown users a deterministic fake salt = base64url(HMAC-SHA256(env.SALT_PEPPER || "innnorsk", lower(username))) so usernames can't be enumerated. `iterations = 310000`, algorithm PBKDF2-HMAC-SHA256, 32-byte output.
  - Client computes `proof = base64url(PBKDF2(password, base64url-decoded salt, iterations, SHA-256, 256 bits))` (WebCrypto in browser, CommonCrypto in iOS, node:crypto in scripts).
  - `POST /api/auth/login {username, proof}` → server compares `sha256hex(proof)` with `users.verifier` (timing-safe). Store per user: `salt`, `iterations`, `verifier`.
  - Password change / admin-created users / resets: the CLIENT generates a random 16-byte salt, computes the proof, and sends `{ salt, iterations, proof }`; server stores `sha256hex(proof)`. Admin "reset password" generates a random 14-char password in the browser, shows it once.
  - Initial users (owner admin + Svetlana): created with `scripts/make-user.js` locally (`node scripts/make-user.js <username> --role admin|user --display-name "…"` prompts for the password twice, hidden input) which prints and optionally runs `npx wrangler d1 execute innnorsk --remote|--local --command "INSERT … ON CONFLICT(username) DO UPDATE …"`. The password never leaves the machine; no password secrets in Cloudflare.
- JWT for APNs (ES256 via WebCrypto) signed at most every 50 min, cached in module scope.
- Sessions: random 32-byte token (base64url) cookie `innnorsk_sid` (HttpOnly, SameSite=Lax, Path=/, Secure on https, Max-Age 30 days); D1 stores sha256 hex; sliding expiry ≤ once/min. iOS app uses the same cookie via URLSession cookie storage.
- Login throttle in D1 (`login_attempts`): ≥ 5 failures / 15 min per `ip:` or `user:` key → 429 "For mange mislykkede forsøk. Vent 15 minutter og prøv igjen."
- CSRF: every non-GET/HEAD `/api/*` except `/api/agent/*` requires header `X-InnNorsk: 1` → else 403.
- Security headers on ALL responses (CSP `default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, nosniff, Referrer-Policy same-origin, X-Frame-Options DENY, HSTS on https).

## Cloudflare config (wrangler.jsonc)
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "innnorsk",
  "main": "worker/index.js",
  "compatibility_date": "2025-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "./web", "binding": "ASSETS", "run_worker_first": true },
  "d1_databases": [{ "binding": "DB", "database_name": "innnorsk", "database_id": "<SETT INN ETTER wrangler d1 create>", "migrations_dir": "migrations" }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "innnorsk-files" }],
  "triggers": { "crons": ["*/15 * * * *"] },
  "observability": { "enabled": true },
  "vars": { "MAX_FILE_MB": "50", "MAX_FILES_PER_SENDING": "50", "APNS_BUNDLE_ID": "no.innnorsk.varsel", "APNS_ENV": "sandbox", "AGENT_OFFLINE_ALERT_MINUTES": "120" }
}
```
No `limits.cpu_ms` (free plan). Secrets (never in repo): `AGENT_TOKEN` (long random; agent auth), `APNS_KEY_P8` (full PEM text of the .p8), `APNS_KEY_ID`, `APNS_TEAM_ID`, optional `SALT_PEPPER`. Optional vars for tests: `APNS_BASE_URL` (default by APNS_ENV: sandbox `https://api.sandbox.push.apple.com`, production `https://api.push.apple.com`). Local dev: `.dev.vars` (gitignored) + `.dev.vars.example` (placeholders only).

## D1 schema (migrations/0001_init.sql — replace the old Cloudflare-build migration)
```sql
users(id INTEGER PK, username TEXT UNIQUE NOT NULL COLLATE NOCASE, display_name TEXT, role TEXT CHECK(role IN('admin','user')) NOT NULL, salt TEXT NOT NULL, iterations INTEGER NOT NULL, verifier TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT)
sessions(id TEXT PK, user_id INTEGER NOT NULL, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at, revoked_reason)
login_attempts(key TEXT NOT NULL, ts TEXT NOT NULL)
sendings(id TEXT PK, user_id INTEGER NOT NULL, status TEXT NOT NULL /* draft|sent|done|deleted — derived summary kept in sync */, target_language TEXT NOT NULL /* bokmal|nynorsk */, note TEXT /* from her */, reply TEXT /* from owner */, created_at, sent_at, finished_at, deleted_at)
files(id TEXT PK, sending_id TEXT NOT NULL, rel_path TEXT NOT NULL, name TEXT NOT NULL, ext TEXT NOT NULL, bytes INTEGER, status TEXT NOT NULL /* draft|sent|working|done|failed */, message TEXT, progress_percent REAL, eta_seconds REAL, progress_at TEXT, lease_until TEXT, attempts INTEGER DEFAULT 0, output_name TEXT, output_bytes INTEGER, output_source TEXT /* agent|manual */, cost_usd REAL, error TEXT, error_details TEXT, created_at, started_at, finished_at, deleted_at)
agent(id INTEGER PK CHECK(id=1), last_seen_at TEXT, host TEXT, version TEXT, state TEXT /* idle|working|error */, state_message TEXT, grok_ok INTEGER, offline_alert_sent_at TEXT)
devices(token TEXT PK, user_id INTEGER NOT NULL, env TEXT NOT NULL /* sandbox|production */, name TEXT, created_at, last_ok_at, disabled_at, last_error TEXT)
events(id INTEGER PK, ts TEXT NOT NULL, level TEXT NOT NULL, type TEXT NOT NULL, message TEXT, user_id INTEGER, session_id TEXT, sending_id TEXT, file_id TEXT, ip TEXT, source TEXT /* web|agent|ios|system */, data_json TEXT)
-- indexes: sessions(user_id), login_attempts(key, ts), sendings(user_id, created_at), files(sending_id), files(status), events(ts), events(type), events(sending_id)
```
IDs random 16-char base32. All SQL parameterized.

## R2 keys
`s/<sendingId>/<fileId>/original`, `s/<sendingId>/<fileId>/result`. Download names always from D1 (UTF-8 RFC 5987 Content-Disposition).

## Worker API (JSON; errors `{ error: "norsk melding" }`)
Pages: `/login` public (logged in → `/`); `/` requires session (admin → still fine; admin link visible); `/admin` requires admin. Static via `env.ASSETS.fetch`. `GET /healthz` → `{ ok: true }`.
Auth: `POST /api/auth/salt`, `POST /api/auth/login {username, proof}` → `{ user }` + cookie | 401 "Brukernavnet eller passordet stemmer ikke." | 403 disabled | 429 · `POST /api/auth/logout` → 204 · `GET /api/auth/me` → `{ user: { id, username, displayName, role, mustChangePassword }, translatorName /* display name of the first admin */ }` · `POST /api/auth/password {currentProof, salt, iterations, proof}` → 204 (verifies current; stores new; revokes other sessions).
Svetlana (role user; admins may also use these for their own sendings):
- `POST /api/sendings {targetLanguage, note?}` → 201 `{ sending }` (draft)
- `PUT /api/sendings/:id/files?path=<encodeURIComponent(rel)>` raw body streamed to R2 (Content-Length required; ≤ MAX_FILE_MB → else 413 "Filen er for stor (maks N MB)."; ≤ MAX_FILES_PER_SENDING; path sanitized: `\`→`/`, drop ``..``/`.`/empty segments, strip control chars/leading `/`/drive letters, max 240; ext must be in core SUPPORTED list (.docx .pptx .xlsx .pdf .txt .md .csv .html .htm .rtf) → else 415 "Filtypen .xyz støttes ikke."; `~$`/`.~lock`/Thumbs.db/desktop.ini/.DS_Store → 400 "Dette er en midlertidig låsefil, ikke et dokument."; 0 bytes → 400 "Filen er tom.") → 201 `{ file }`. Import the supported-extension list and isIgnoredName from `src/core.js`? NO — core pulls in heavy format code; duplicate the tiny list in `worker/files.js` with a comment pointing at src/core.js.
- `DELETE /api/sendings/:id/files/:fileId` → 204 (draft only)
- `POST /api/sendings/:id/note {note}` (draft) · `POST /api/sendings/:id/send` → `{ sending }`: files → sent; sent_at; event sending.sent; **push to all admin devices**: title "Nye filer fra <displayName>", body "<n> fil(er): <first name>…", sound default, custom data `{ sendingId }`.
- `GET /api/sendings` → `{ sendings: [...] }` own, newest first, non-deleted, drafts only if < 1 day old; each with files + `agentOnline` flag and friendly per-file `statusText`.
- `GET /api/sendings/:id` → `{ sending }`
- `GET /api/files/:fileId/result` → download translated file (event download.result) · `GET /api/files/:fileId/original` → original (event download.original)
- `DELETE /api/sendings/:id` → 204 (deleted_at; R2 objects removed; event sending.deleted)
Admin (role admin):
- `GET /api/admin/overview` → `{ agent: { online /* last_seen < 3 min */, lastSeenAt, host, version, state, stateMessage, grokOk }, counts: { waiting, working, doneToday, failed }, storage: { files, bytes }, devices, users }`
- `GET /api/admin/sendings?limit=50` → all users' sendings with username + files (+ error, errorDetails, costUsd, attempts)
- `PUT /api/admin/files/:fileId/result?name=<encoded output name>` raw body → manual result upload (output_source manual; status done) · `POST /api/admin/files/:fileId/status {status: "sent"|"failed"|"done", message?}` (e.g. re-queue) · `POST /api/admin/sendings/:id/reply {reply}` (message shown to her)
- `GET /api/admin/events?level=&type=&source=&q=&beforeId=&limit=100` · `GET /api/admin/sessions?all=0|1` · `POST /api/admin/sessions/:idPrefix/revoke`
- `GET /api/admin/users` · `POST /api/admin/users {username, displayName, role, salt, iterations, proof, mustChangePassword}` · `PATCH /api/admin/users/:id {displayName?, role?, disabled?}` (not self-demote/disable) · `POST /api/admin/users/:id/password {salt, iterations, proof, mustChangePassword}` (revokes their sessions)
- `GET /api/admin/devices` · `POST /api/admin/devices {token, env, name}` (upsert for current admin; env sandbox|production) · `DELETE /api/admin/devices/:token` · `POST /api/admin/test-push` → sends "Testvarsel fra InnNorsk" to the caller's devices → `{ sent, failed, errors }`
Client log: `POST /api/client-log {level, message, stack?, url?}` (logged in; ≤ 30/min/session) → event client.error (source web|ios by header `X-InnNorsk-Client: ios`).
**Agent API** (header `Authorization: Bearer <AGENT_TOKEN>`; compare sha256 digests timing-safe; no CSRF header; 401 otherwise):
- `POST /api/agent/poll {host, version, state, stateMessage, grokOk}` → heartbeat (agent row) + `{ files: [{ id, sendingId, name, relPath, ext, bytes, targetLanguage, note, username, displayName }] }` = files with status `sent`, plus `working` files whose `lease_until` < now (re-queue), oldest first, max 20.
- `POST /api/agent/files/:id/claim {leaseSeconds}` → `{ ok: true }` if status sent (or working with expired lease) → status working, started_at, lease_until, attempts+1, event file.claimed; else 409.
- `GET /api/agent/files/:id/original` → stream.
- `POST /api/agent/files/:id/progress {percent, etaSeconds, message?, leaseSeconds?}` → updates progress + extends lease.
- `PUT /api/agent/files/:id/result?name=<encoded output name>&costUsd=<n>` raw body → R2 result; status done; output_*; finished_at; cost_usd; event file.done; if all files of the sending are final → sending finished_at + event sending.done.
- `POST /api/agent/files/:id/fail {message, details?, costUsd?}` → status failed (her text: "Oversetteren ser på denne filen."; admin sees message + details); event file.failed; **push to admin**: "Kunne ikke oversette <name>".
- `POST /api/agent/files/:id/release {reason}` → back to `sent` (agent-side problem, e.g. Grok CLI not logged in); event file.released.
- `POST /api/agent/log {level, type, message, data?}` → event (source agent). Rate-limit 120/min.
Cron (every 15 min): expired leases → sent; if files waiting (status sent) and agent last_seen older than AGENT_OFFLINE_ALERT_MINUTES and no alert sent since → push admin "Svetlana venter: Mac-en har ikke svart siden HH:MM" (once per offline period; reset when agent comes back); purge drafts > 2 days (R2 + rows), login_attempts > 1 day, sessions expired > 30 days, events > 365 days. Event retention.sweep (only if something happened).

### Object shapes
sending: `{ id, userId, username?, displayName?, status, targetLanguage, note, reply, createdAt, sentAt, finishedAt, files: [file], counts: { total, waiting, working, done, failed } }`
file: `{ id, sendingId, path, name, ext, bytes, status, statusText, progress: { percent, etaSeconds, at } | null, outputName, outputBytes, createdAt, startedAt, finishedAt }` (+ admin: `error, errorDetails, attempts, costUsd, outputSource, leaseUntil`)
statusText for her (examples): sent + agent online → "Mottatt – oversettes snart"; sent + agent offline → "Mottatt – oversettelsen starter når oversetteren er klar"; working → "Oversettes nå – 45 % – ca. 3 min igjen"; done → "Ferdig"; failed → "Oversetteren ser på denne filen".

### APNs (worker/apns.js)
ES256 JWT: header `{ alg: "ES256", kid: APNS_KEY_ID }`, claims `{ iss: APNS_TEAM_ID, iat }`; import PEM PKCS#8 via `crypto.subtle.importKey("pkcs8", …, { name: "ECDSA", namedCurve: "P-256" })`; sign `{ name: "ECDSA", hash: "SHA-256" }` (WebCrypto returns raw r||s = JOSE format). Cache token 50 min. `POST {base}/3/device/<token>` headers `authorization: bearer <jwt>`, `apns-topic: APNS_BUNDLE_ID`, `apns-push-type: alert`, `apns-priority: 10`, body `{ aps: { alert: { title, body }, sound: "default", "thread-id": "innnorsk" }, sendingId }`. Device env decides base URL (sandbox vs production) unless APNS_BASE_URL set. 410 or 400 BadDeviceToken → disable device. Log event push.sent / push.failed. Note: HTTP/2 is required by APNs; Workers production fetch supports it; local wrangler dev may not → tests use a mock APNs HTTP server via APNS_BASE_URL.

## Mac agent (mac/)
- `mac/innnorsk-mottak.js` (CommonJS, Node ≥ 20, no extra deps beyond repo deps). Commands:
  - `setup` — interactive: site URL, agent token (stored in macOS Keychain via `security add-generic-password -U -s no.innnorsk.mottak -a agent-token -w <token>`; fallback file `~/.innnorsk/agent.json` chmod 600 if `security` missing), output folder (default `~/InnNorsk`), Grok command check; writes `~/.innnorsk/config.json`; installs launchd plist `~/Library/LaunchAgents/no.innnorsk.mottak.plist` (RunAtLoad, KeepAlive, ProgramArguments [absolute node path, absolute script path, "run"], EnvironmentVariables PATH incl. /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin and HOME, StandardOutPath/StandardErrorPath `~/Library/Logs/InnNorsk/mottak.log`) and loads it with `launchctl bootstrap gui/<uid>` (bootout first if loaded). `setup --uninstall` removes it.
  - `doctor` — checks config, site reachable, token accepted (poll), Grok CLI found + logged in by translating one tiny string (prints ms + cost), write access to output folder. Prints a clear Norwegian checklist with ✓/✗ and fixes.
  - `run` — daemon loop: poll every 20 s (adaptive: 5 s right after work, back off to 60 s on network errors); process files one at a time (translation concurrency inside a file = config `concurrency`, default 2); graceful SIGTERM (release current claim).
  - `once` — process current queue then exit.
  - `translate <files...> [--nynorsk] [--out <dir>]` — local manual translation without the website (same engine + CLI), writes `<name> (norsk).<ext>` next to the file or into --out.
- Processing a file: claim (lease 15 min) → download original → save a local copy `~/InnNorsk/<yyyy-mm-dd> <displayName>/<relPath>` → `core.analyzeBuffer` for plan → `core.translateBuffer(buf, ext, { transport: grokCli, targetLanguage, concurrency, onBatch, onCall, onWarning })` → progress every batch: percent by chars + ETA from local timing model (reuse the estimator idea: t = a + b·chars per batch, fitted from `~/.innnorsk/stats.json` history of CLI calls, defaults a=6 s, b=0.004 s/char; blend observed rate) → PUT result (output name from `core.outputNameFor(relPath)` basename; collisions are per-file so fine) with costUsd summed from onCall → save local translated copy next to the original copy → macOS notification via `osascript -e 'display notification "…" with title "InnNorsk"'` (best effort).
- Errors: GrokError code auth/no_key or CLI missing → `release` the file, set agent state `error` with Norwegian stateMessage (e.g. "Grok CLI er ikke logget inn – kjør `grok login`"), pause 5 min, retry. Document/format errors (invalid_output, scanned PDF, parse errors) → `fail` with message + details (stack). Network errors talking to the Worker → retry with backoff, keep claim.
- Logging: JSON lines to stdout (captured by launchd log file) + forward warn/error and key info events (file.processing, file.translated, agent.started, agent.error) to `/api/agent/log`.
- `mac/grok-cli.js`: transport for `src/grok.js` (`ctx.transport`). Config `grok.command` (default `grok`), `grok.args` (default `["--no-auto-update", "--output-format", "json", "--max-turns", "1", "--disable-web-search", "--no-subagents", "--permission-mode", "defaultMode"]`), `grok.model` (optional → `-m <model>`), `grok.effort` (default "low" → `--effort low`), prompt passed via `--prompt-file <tmpfile>` (Grok Build does NOT read stdin), cwd = an empty temp dir. Parse stdout as JSON `{ text, usage, total_cost_usd }` → `{ text, usage, costUsd }`; if stdout isn't JSON, use it as plain text. Exit code != 0: stderr matching /login|auth|unauthori[sz]ed|not logged/i → GrokError("auth", "Grok CLI er ikke logget inn. Kjør «grok login» i Terminal."); ENOENT → GrokError("no_key", "Fant ikke Grok CLI («grok»). Installer den eller sett riktig sti i ~/.innnorsk/config.json."); else GrokError("server", "Grok CLI feilet: <first stderr line>"). Honour AbortSignal (kill process group). Clean temp files.
- `mac/README.md` (Norwegian): install (Node via Homebrew, repo clone, `npm install`, `node mac/innnorsk-mottak.js setup`), `grok login` once, keep Mac awake (System Settings → Energy → "Prevent automatic sleeping…"), logs, doctor, uninstall.
- Tests: `test/mac/*.test.js` using a fake grok CLI `test/helpers/fake-grok.js` (executable Node script; reads `--prompt-file`, extracts the JSON array like mock-grok, prints `{"text": "...", "usage": {...}, "total_cost_usd": 0.001}`; env FAKE_GROK_MODE=ok|auth|crash|plain|slow) against a real local Worker (test/helpers/worker-dev.js) → file goes sent → working → done with progress events and cost; auth error → release + agent state error; doc error → fail; lease expiry re-queue.

## iOS app (ios/InnNorskVarsel/)
SwiftUI, iOS 17+, bundle id `no.innnorsk.varsel` (configurable). Files: `InnNorskVarselApp.swift` (App + `@UIApplicationDelegateAdaptor` AppDelegate: register for remote notifications, `didRegisterForRemoteNotificationsWithDeviceToken` → hex → post to server; UNUserNotificationCenter delegate shows banners in foreground), `API.swift` (base URL from Settings (stored in UserDefaults), login = salt → PBKDF2 via CommonCrypto `CCKeyDerivationPBKDF(kCCPBKDF2, …, kCCPRFHmacAlgSHA256, …)` → proof base64url → /api/auth/login; cookies via `HTTPCookieStorage.shared`; header `X-InnNorsk: 1` and `X-InnNorsk-Client: ios`; register device `POST /api/admin/devices {token, env: DEBUG ? "sandbox" : "production", name: UIDevice.current.name}`), `ContentView.swift` (login form; then list: agent status card (online/offline, last seen), sendings with per-file status + progress, pull to refresh, "Send testvarsel" button, log out), `Models.swift` (Codable structs matching the API shapes). `ios/README.md` (Norwegian): create Xcode project (App, SwiftUI) named InnNorskVarsel, add files, set bundle id + team, add Push Notifications capability, create APNs Auth Key (.p8) in developer portal → set Worker secrets APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID + var APNS_BUNDLE_ID/APNS_ENV, run on iPhone, allow notifications, log in as owner, "Send testvarsel". Also `ios/project.yml` for XcodeGen as an optional shortcut. Code must be conservative, compile-clean Swift 5.9 (no exotic APIs) since it cannot be compiled here.

## Web UI (web/) — warm & pleasant
- Design: **warm and cosy** ("varm og hyggelig"): warm cream/linen background, terracotta/apricot + soft sage accents, deep warm brown text, rounded cards with soft shadows, generous spacing, a friendly serif for headings (e.g. Fraunces or Literata) + a humanist sans for body (Google Fonts allowed), body ≥ 17px, gentle micro-animations (respect prefers-reduced-motion), a small friendly inline-SVG illustration (e.g. envelope/paper plane) as separate .svg file in web/img. One centered column (max ~720px). Works at 375px and desktop. Light theme only.
- `login.html`: "Velkommen" + one warm sentence ("Her sender du dokumenter til <translatorName> for oversettelse til norsk." — translatorName isn't known before login → generic: "Her sender du dokumenter som skal oversettes til norsk."), Brukernavn, Passord, "Logg inn". Uses client-side PBKDF2 (WebCrypto) per the auth flow; shows a gentle "Logger inn …" while hashing. Must-change-password flow if `mustChangePassword`.
- `index.html` (Svetlana): header "Hei, <displayName>!" + small menu (Bytt passord, Logg ut; Admin for admins). Card 1 "Send dokumenter til <translatorName>": big drop zone ("Slipp filene her, eller velg dem"), "Velg filer" + "Velg mappe"; client-side filter (unsupported/lock/hidden) with kind explanations; language choice Bokmål/Nynorsk (two big toggles); optional message field ("Melding til <translatorName> (valgfritt)"); sequential XHR PUT uploads with per-file progress; big button "Send til <translatorName>". After sending: warm confirmation ("Takk! Filene er sendt. <translatorName> har fått beskjed.") + reassurance ("Du kan trygt lukke siden. Når oversettelsen er klar, finner du den her under «Mine filer».").
  Card 2 "Mine filer": sendings newest first, grouped by day ("I dag", "I går", date), each file row with status pill + statusText (progress bar + "ca. 3 min igjen – ferdig rundt kl. 14:32" when working), big "Last ned" for done files (and "Original" small link), owner's reply shown as a friendly note; "Slett" per sending with confirm. Poll `/api/sendings` every 5 s while anything is sent/working (30 s otherwise; pause when hidden). Tab title "(1 klar) InnNorsk" when new results since last view. Welcome-back banner if files finished since last visit (localStorage).
  window.onerror/unhandledrejection → `/api/client-log` (≤ 5/min).
- `admin.html` (owner, same warm style, denser): tabs **Oversikt** (agent card: online/offline, last seen, host, state message, Grok OK; counts; storage; "Send testvarsel"; devices list), **Sendinger** (all sendings with files, statuses, errors + details in <details>, cost, attempts, download original/result, manual "Last opp oversettelse" per file, "Sett i kø igjen", reply to Svetlana), **Logg** (filters level/type/source/text, newest first, "Last flere", auto-refresh 5 s, level colours, expandable escaped JSON), **Økter** (sessions + revoke), **Brukere** (list; create user / reset password with browser-generated password shown once + copy + Norwegian message template; activate/deactivate; role).
- api.js: fetch wrapper (`X-InnNorsk: 1` on non-GET; 401 → /login; JSON; Error(server error)), `pbkdf2Proof(password, salt, iterations)`, `newSaltedProof(password)`, helpers escapeHtml, formatDuration ("under 1 min", "ca. 3 min", "ca. 1 t 5 min"), formatClock (nb-NO 24h), formatBytes, relativeTime ("akkurat nå", "for 3 min siden"), dayLabel.
- CSP: no inline scripts/handlers/style attributes. Escape untrusted strings. Accessible (labels, focus, aria-live, keyboard drop zone, contrast ≥ 4.5:1).

## Testing (never real xAI / Grok / APNs)
- `npm test` = node --test over `test/**/*.test.js`: core (exists), worker integration via `test/helpers/worker-dev.js` (wrangler dev + temp persist + migrations; vars incl. AGENT_TOKEN dummy, APNS_* dummy key generated at test time with node:crypto `generateKeyPairSync("ec", { namedCurve: "P-256" })` exported as PKCS#8 PEM, APNS_BASE_URL → `test/helpers/mock-apns.js` HTTP server that records requests and verifies the ES256 JWT with the public key), mac agent tests with fake grok CLI.
- Test users are created through the same path as `scripts/make-user.js` (export a function that returns the SQL; tests run it with `wrangler d1 execute --local --persist-to`).
- `npm run e2e` = Playwright E2E (global playwright; chromium preinstalled; never `playwright install`).
- Remove obsolete tests from the previous Cloudflare build (test/worker/*, test/estimate.test.js) or rewrite them for this spec.
