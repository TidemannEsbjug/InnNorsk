# InnNorsk — kontekst for Claude (Cloud / Code)

Dette er en **dokumentoversetter til norsk** via **xAI Grok** (`https://api.x.ai`).

Repo: https://github.com/TidemannEsbjug/InnNorsk  
To produkter, samme kjerne (`src/`):

- **InnNorsk Sky** (hovedprodukt): webapp med innlogging. Express 5 + `node:sqlite`, Docker på Render.
- **Windows-appen** (lokal, eldre): Electron.

Ikke commit API-nøkler. I skyen ligger nøkkelen bare i serverens miljø (`XAI_API_KEY`). I Windows-appen limer brukeren den inn selv.

**Tester og agenter kaller aldri det ekte xAI-API-et.** Bruk `test/helpers/mock-grok.js` (falsk `fetch`) eller `test/helpers/mock-xai-server.js` (falsk HTTP-server, pek `XAI_BASE_URL` dit).

## Hva som er hostet hvor

| Ting | Hvor |
|---|---|
| All kildekode | GitHub `main` (dette repoet) |
| Skyappen | Render webtjeneste fra `render.yaml` + `Dockerfile`, disk `/data` (SQLite + filer). Se `docs/DEPLOY.md` |
| Oversettelse i skyen | Serveren kaller `api.x.ai` med `XAI_API_KEY` fra miljøet |
| Nedlastingsside | GitHub Pages: https://tidemannesbjug.github.io/InnNorsk/ (`docs/index.html`) |
| Windows-bygg | GitHub Releases (`InnNorsk-Windows.zip`) |
| Oversettelse i Windows-appen | Lokalt i Electron, kaller `api.x.ai` |

Pages er **ikke** appen. Det er en statisk landingsside med nedlastingsknapp.

## Produktkrav (må holdes)

1. Bruker laster opp dokumenter (filer eller hel mappe) i skyen, eller velger en mappe i Windows-appen.
2. Trykk oversett → dokumentene kommer ut på **bokmål** (valg: nynorsk).
3. Resultatet skal **se ut som originalen**: avsnitt, linjeskift, skrift, skriftstørrelse, fet/kursiv.
4. Originaler endres ikke. Output i egen mappe / eget resultat.
5. xAI-nøkkel: sky = server-env, aldri i nettleseren eller loggen. Windows = Innstillinger. Må ha chat/model-ACL, ikke bare voice (`api-key:endpoint:voice` gir 403).
6. Modell: `grok-4.6` mot `https://api.x.ai/v1/responses`.
7. Sky: innlogging, eieren ser logger/feil/Grok-kall, ærlige tidsestimat. Norsk UI.

## Støttede formater

| Inn | Ut | Hvordan |
|---|---|---|
| `.docx` | `.docx` | Tekst byttes på stedet i OOXML. Stiler/tema beholdes. |
| `.pptx` | `.pptx` | Samme, i slide XML. |
| `.xlsx` | `.xlsx` | Oversetter tekstceller, hopper over tall/formler. |
| `.pdf` | `.docx` | pdf.js henter tekst + font/størrelse, bygger Word. |
| `.txt` `.md` `.csv` `.html` | samme / `.html` | Tekst/HTML. |
| `.rtf` | `.docx` | RTF strippes, skrives som Word. |

Skannet PDF uten tekstlag kan ikke oversettes. All utdata sjekkes av `src/validate.js` før levering.

## Kodekart

```
src/                 Delt kjerne (sky + Electron)
  grok.js            xAI Responses API: batcher som JSON-array, retry, split, dryRun, telemetri-hooks
  pipeline.js        translateBuffer/analyzeBuffer, HANDLERS/SUPPORTED, utdatanavn; scanFolder/translateFile (Electron)
  validate.js        validateOutput: OOXML-zip + XML-gyldighet, UTF-8
  xml-util.js        XML-escaping/hjelpere
  formats/docx.js    Word: bytt tekst i lengste run, behold rPr
  formats/pptx.js    PowerPoint: behold a:rPr
  formats/pdf.js     PDF-layout → styled Word
  formats/xlsx.js    Excel-celler
  formats/text.js    txt/md/csv/html/rtf
  formats/simple-docx.js  Bygg Word når vi ikke har original OOXML
  main.js preload.js settings.js renderer/   Electron (nøkkel kryptert via safeStorage)
server/              Skyserver
  index.js           oppstart, admin-bootstrap, worker, ryddig nedstenging
  app.js             createApp() → Express-app (testbar uten listen)
  config.js db.js    env → config; node:sqlite + migreringer
  auth.js            scrypt, økter, CSRF, innloggingssperre
  log.js             hendelser → events-tabell + stdout-JSON
  storage.js         filstier under DATA_DIR, opprydding
  estimate.js        tidsestimat + kalibrering fra grok_calls
  worker.js          jobbkø (én jobb om gangen), fremdrift, ETA, avbryt
  routes/            auth, jobs, admin, client-log
  cli.js             create-user | reset-password | list-users | disable-user
web/                 Statisk UI (login/index/admin), vanilla JS, ingen byggesteg
test/                node:test; helpers/mock-grok.js, helpers/mock-xai-server.js
Dockerfile render.yaml .env.example   Drift (docs/DEPLOY.md)
scripts/pack-win.js  Bygg Windows-zip fra macOS (uten Wine)
docs/                Pages (index.html) + ARCHITECTURE, PRODUCT, DEPLOY
```

## Utvikling

```bash
npm install                          # ELECTRON_SKIP_BINARY_DOWNLOAD=1 hvis du bare jobber med serveren
npm test                             # alle tester, alltid mot mock
node test/helpers/mock-xai-server.js 18080 &
XAI_BASE_URL=http://127.0.0.1:18080 XAI_API_KEY=mock ADMIN_USERNAME=admin ADMIN_PASSWORD=lokalt-passord-123 npm run server
# → http://localhost:8080, data i ./data/
npm start                            # Electron
```

Regel: nye tester skal bruke mocken. Ingen test, skript eller agent skal treffe ekte `api.x.ai` eller lete etter en ekte nøkkel.

Windows-zip (fra Mac):

```bash
node scripts/pack-win.js
```

Output: `dist/InnNorsk-Windows.zip`. Last opp som GitHub Release. Pages peker på `/releases/latest/download/InnNorsk-Windows.zip`. Skriptet pakker bare `src/`, `assets/` og prod-avhengigheter (uten `express`) i `app.asar`, ikke `server/`, `web/`, `test/` eller `data/`.

Electron-packager `--win` på Mac krever Wine for ikon/metadata. `scripts/pack-win.js` laster ned win32 Electron og pakker `app.asar` i stedet.

## Sky (implementert)

Detaljer i `docs/ARCHITECTURE.md`. Kort:

- **Flyt:** `POST /api/jobs` (utkast) → én rå `PUT` per fil → analyse uten nettverk (`dryRun`) gir tekstmengde og estimat → `start` → worker oversetter én jobb om gangen → nettleseren poller `GET /api/jobs/:id` → nedlasting per fil eller zip.
- **Status:** jobb `draft → queued → running → done | partial | failed | cancelled`. Omstart under kjøring → jobben `failed`, køen fortsetter.
- **Logging:** `log.<nivå>(type, melding, data, ctx)` → `events` + én JSON-linje på stdout. Hvert xAI-forsøk → `grok_calls`. Faste hendelsestyper (`auth.*`, `job.*`, `file.*`, `grok.*`, `download.*`, `client.error`, `server.error` …). Hemmeligheter fjernes fra `data`.
- **Estimat:** `t = a + b·tegn` per batch (standard 8 s + 0,006 s/tegn), kalibrert fra de siste 300 kallene, LPT over `GROK_CONCURRENCY`, live ETA som korrigerer seg mot faktisk tid, sikkerhet lav/middels/høy.
- **Sletting:** filer etter `RETENTION_DAYS` (14), utkast etter 2 døgn, hendelser etter 90 dager. Jobbrader og `grok_calls` beholdes.
- **Sikkerhet:** scrypt, token-hash i DB, `HttpOnly`/`SameSite=Lax`-cookie, CSRF-header, streng CSP, bruker ser bare egne jobber.

## Kjente feller

- Voice-nøkkel (`acls: ["api-key:endpoint:voice"]`) → 403 på chat. Bruk nøkkel med `api-key:endpoint:*` og `api-key:model:*`.
- xAI 403-body er `{ error: "string" }`, ikke `{ error: { message } }`.
- Linjeskift i Word må være `<w:br/>`, ikke `\n` inne i `<w:t>`.
- I DOCX: skriv oversettelsen inn i **lengste run**, ikke nødvendigvis første (første kan være 8pt/tom).
- Ikke slå sammen avsnitt før Grok-kall; det ødelegger layout.
- Windows-appen er usignert → SmartScreen «Mer info → Kjør likevel».
- `node:sqlite` krever Node ≥ 22.13 og gir `ExperimentalWarning`. Start med `--disable-warning=ExperimentalWarning` (npm-skriptene og Dockerfile gjør det).
- Opplasting er rå `PUT /api/jobs/:id/files?path=<encodeURIComponent(relPath)>`, én fil per kall. Ingen multipart/multer.
- Alle `/api/*`-kall som ikke er GET/HEAD, må ha headeren `X-InnNorsk: 1`, ellers 403. Husk den i curl og tester.
- CSP tillater ikke inline-skript eller `on*`-attributter i `web/`. Bruk egne `.js`-filer og `addEventListener`.
- Nøyaktig én instans: SQLite + jobbkø i minnet. Ikke skaler horisontalt.
- `Secure`-cookie i produksjon krever HTTPS (localhost går).
- `ADMIN_USERNAME`/`ADMIN_PASSWORD` brukes bare når `users` er tom.
- pdfjs-dist sin valgfrie `canvas` installeres ikke (Docker og pack-win bruker `--omit=optional`). Advarslene «Cannot polyfill DOMMatrix/Path2D» ved oppstart er ufarlige; tekstuttrekk trenger ikke canvas.
- Claude Code i skyen: miljøets nettverkspolicy blokkerer `api.x.ai` (proxyen svarer 403 på CONNECT) og `render.com`. Det er med vilje for tester. Skal en økt nå xAI, må eieren legge `api.x.ai` til under **Network access** i miljøets innstillinger (miljømenyen i øktens tittellinje → Edit), eller velge et bredere tilgangsnivå.
