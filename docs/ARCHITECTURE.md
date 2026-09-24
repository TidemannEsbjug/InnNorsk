# Arkitektur

InnNorsk finnes i to utgaver som deler samme oversettelseskjerne (`src/`):

- **InnNorsk Sky**: webapp. Nettleser → Express-server i Docker (Render) → xAI.
- **Windows-appen**: Electron, kjører lokalt og kaller xAI direkte.

## Sky: oversikt

```
[Nettleser]  web/  login.html · index.html · admin.html  (vanilla JS, ingen byggesteg)
    │  HTTPS · cookie innnorsk_sid · header X-InnNorsk: 1 på alle endringer
    ▼
[Render webtjeneste · Docker node:22-slim · én instans]
  server/index.js     config → db → admin-bootstrap → worker → listen · ryddig nedstenging
  server/app.js       Express 5: sikkerhetsheadere, statiske filer, ruter
    ├─ routes/auth.js         innlogging, utlogging, passordbytte
    ├─ routes/jobs.js         jobber, opplasting (rå PUT), start/avbryt, nedlasting, zip
    ├─ routes/admin.js        oversikt, logg, økter, brukere, jobbdetaljer, test-API
    ├─ routes/client-log.js   JavaScript-feil fra nettleseren
    ├─ auth.js                scrypt, økter, CSRF, innloggingssperre
    ├─ worker.js ─ jobbkø ─► src/pipeline.js ─► src/formats/* ─► src/grok.js ─► api.x.ai/v1/responses
    │                                  └─► src/validate.js (sjekker filen før levering)
    ├─ estimate.js            tidsestimat og kalibrering
    ├─ log.js                 ─► events-tabellen + stdout (JSON-linjer → Render Logs)
    └─ storage.js             filstier, opprydding
[/data  (Render-disk, 1 GB)]
  innnorsk.db    SQLite (WAL): users, sessions, jobs, files, events, grok_calls
  files/         originaler og oversatte filer per jobb
```

Alt kjører i én Node-prosess. Jobbkøen ligger i minnet og tilstanden i SQLite (`node:sqlite`, innebygd i Node 22). Derfor skal det alltid være **nøyaktig én instans**.

## Sky: flyt for en oversettelse

1. `POST /api/auth/login` → cookie `innnorsk_sid`.
2. `POST /api/jobs { targetLanguage }` → jobb med status `draft`.
3. Én forespørsel per fil: `PUT /api/jobs/:id/files?path=<relativ sti>` med filen som rå body (ingen multipart). Serveren
   - renser stien (ingen `..`, absolutte stier eller stasjonsbokstaver),
   - avviser filtyper som ikke støttes (415) og Office-låsefiler (`~$…`, `.~lock…`),
   - lagrer originalen og SHA-256,
   - kjører `analyzeBuffer`: formatet trekkes ut og deles i batcher **uten** nettverkskall (`dryRun`),
   - setter filen til `ready` (med tekstbiter, tegn, batcher og estimat) eller `failed` med norsk melding.
4. `GET /api/jobs/:id` gir estimatet før start (`estimateSeconds`, og `queueWaitSeconds` hvis en annen jobb kjører).
5. `POST /api/jobs/:id/start` → `queued`. Svarer 503 hvis serveren mangler `XAI_API_KEY`.
6. Workeren tar jobbene én om gangen (FIFO): `running` → hver fil går gjennom `translateBuffer` → `validateOutput` → lagres.
7. Nettleseren spør `GET /api/jobs/:id` hvert 1,5 sekund (5 sekunder når fanen er skjult) og viser fremdrift og gjenstående tid.
8. Nedlasting: `/api/jobs/:id/files/:fileId/download` per fil, eller `/api/jobs/:id/download.zip` med mappestrukturen bevart.

Hvis to filer får samme utdatanavn (`x.pdf` og `x.docx` → `x.docx`), får den andre navnet `x (pdf).docx`.

## Jobbens livsløp

```
draft ──start──► queued ──worker──► running ──► done | partial | failed | cancelled
                   │                   │
                   └──── avbryt ───────┴──► cancelled
```

| Jobbstatus | Betyr |
|---|---|
| `draft` | Filer lastes opp og analyseres. Ikke startet. |
| `queued` | Venter på workeren. |
| `running` | Oversettes nå. |
| `done` | Alle filer ferdige. |
| `partial` | Minst én fil ferdig og minst én feilet. |
| `failed` | Ingen filer ble ferdige, eller jobben ble stoppet (f.eks. av en omstart). |
| `cancelled` | Avbrutt av brukeren. |

| Filstatus | Betyr |
|---|---|
| `ready` | Analysert, klar til oversettelse. |
| `failed` | Analyse eller oversettelse feilet. Norsk melding til brukeren; stack bare for admin. |
| `queued` / `working` | Venter / oversettes. |
| `done` | Oversatt og validert. Kan lastes ned. |
| `skipped` | Hoppet over. |
| `cancelled` | Jobben ble avbrutt før filen var ferdig. |

Regler:

- Feil med nøkkelen (401, 403, manglende nøkkel) stopper resten av jobben. De gjenstående filene får samme melding.
- Avbryt bruker en `AbortController` per jobb. Pågående kall avbrytes, gjenstående filer blir `cancelled`.
- Ved oppstart: jobber som sto som `running`, blir `failed` («Serveren ble startet på nytt under jobben.»). Jobber i `queued` fortsetter.
- Utkast eldre enn ett døgn vises ikke i historikken, og slettes etter to døgn.

## Oversettelseskjernen (`src/`)

`src/grok.js` sender lister av strenger som JSON-array til `POST /v1/responses` (modell `grok-4.6`) og krever like mange strenger tilbake, med samme linjeskift.

- **Batcher:** ny batch når neste streng ville gitt over ca. 7000 tegn, eller ved 28 strenger. Tomme strenger sendes aldri.
- **Parallellitet:** batchene i ett kall kjøres med `GROK_CONCURRENCY` (2) samtidige forespørsler. Rekkefølgen bevares.
- **Nye forsøk:** 429, 500, 502, 503, 504, nettverksfeil og tidsavbrudd (`GROK_TIMEOUT_MS`, 4 min) gir opptil 4 forsøk med ventetid 2, 4 og 8 s (+ litt tilfeldighet). `Retry-After` respekteres, maks 60 s. 400, 401, 403 og 404 prøves ikke igjen.
- **Feil antall strenger tilbake:** ett nytt forsøk med strengere instruks → batchen deles i to, rekursivt → én og én streng som ren tekst. Én dårlig batch skal aldri velte en hel fil.
- **Tom oversettelse** av ikke-tom tekst: originalteksten beholdes, og det logges en advarsel.

Formatene (`src/formats/*`) endrer bare tekstnoder:

- Word og PowerPoint er zip-filer med XML. Tekst byttes på stedet. Bilder, tema, sidemal og tabeller blir liggende.
- PDF: `pdfjs-dist` leser posisjon, fontnavn og størrelse. Det bygges en ny `.docx` som etterligner originalen.
- Excel: tekstceller oversettes. Tall og formler røres ikke.

`src/validate.js` sjekker hver utdatafil før den leveres. For `.docx`, `.pptx` og `.xlsx`: zip-en åpnes, `[Content_Types].xml` må finnes, og hver XML-del må være gyldig og uten ulovlige kontrolltegn. En ugyldig fil gir `failed` (`invalid_output`) i stedet for en fil Word ikke kan åpne.

## Tidsestimat (`server/estimate.js`)

### Modell

Hvert Grok-kall (én batch) antas å ta

```
t = a + b × tegn   (sekunder)
```

Standard er `a = 8` s og `b = 0,006` s/tegn, altså ca. 50 s for en full batch på 7000 tegn. Kan overstyres med `EST_A` og `EST_B`.

### Kalibrering

`fitParams` henter de siste 300 vellykkede kallene for modellen fra `grok_calls` og finner `a` og `b` med minste kvadraters metode. Det krever minst 8 kall med ulik lengde. Verdiene holdes innenfor `a ∈ [0,5; 120]` og `b ∈ [0,0002; 0,2]`. Deretter blandes de med standardverdiene med vekt `n / (n + 20)`: etter 20 kall teller historikken halvparten, etter 180 kall 90 %. Resultatet mellomlagres i 60 s. Admin → Oversikt viser `a`, `b`, antall kall og om verdiene er `default` eller `fitted`.

### Estimat før start

`analyzeBuffer` gir for hver fil en liste med kall, og for hvert kall en liste med batchstørrelser. Batchene i ett kall fordeles på `GROK_CONCURRENCY` arbeidere (LPT: lengste først, til den som blir ledig først). Kallets tid er den som blir sist ferdig. Filens tid er summen over kallene + 0,3 s. Jobbens tid er summen over filene, pluss ventetid i køen hvis en annen jobb kjører.

Eksempel med standardverdier og 2 arbeidere: batcher på 7000, 7000 og 3000 tegn tar 50, 50 og 26 s. De to store kjører samtidig (50 s), deretter den lille (26 s): 76 s + 0,3 s ≈ 1 min 16 s.

### Gjenstående tid under kjøring

Workeren følger med på:

- `predictedWallTotal`: estimert total tid for jobben
- `workTotal = Σ (a + b × tegn)` over alle batcher, og `wallPerWork = predictedWallTotal / workTotal`
- `predictedWallDone = wallPerWork × Σ (a + b × tegn)` over ferdige batcher
- `actualElapsed`: faktisk tid siden jobben startet

Forholdet `r = actualElapsed / predictedWallDone` sier om det går fortere eller tregere enn antatt. Det dempes mot 1 til vi har nok data: `r' = (r × w + 3) / (w + 3)`, der `w` er antall ferdige batcher. Da er

```
ETA = max(0, predictedWallTotal − predictedWallDone) × r'
```

Sikkerhet: `lav` under 3 ferdige batcher, `middels` under 10, ellers `høy`. Brukeren ser «usikkert estimat» når den er lav. ETA lagres i databasen høyst hvert 2. sekund. Fremdriften holdes i minnet og flettes inn i svaret på `GET /api/jobs/:id`.

### Treffsikkerhet

Når en jobb er ferdig, lagres estimert og faktisk tid i hendelsen `job.finished` (`{ estimateSeconds, actualSeconds }`). Admin → Oversikt viser median absolutt avvik i prosent over disse.

## Logging (`server/log.js`)

`log.info(type, melding, data?, ctx?)` (og `debug`, `warn`, `error`) skriver

- én rad i `events` (nivå info og over; debug bare når `LOG_LEVEL=debug`), og
- én JSON-linje til stdout: `{ ts, level, type, msg, userId, sessionId, jobId, fileId, ip, data }`. Det er dette som vises under Logs i Render.

`ctx` knytter hendelsen til bruker, økt (bare de 8 første tegnene av ID-en), jobb, fil og IP. Nøkler som ligner `pass`, `token`, `secret`, `key`, `authorization` eller `cookie` fjernes fra `data`, uansett hvor dypt de ligger.

Hendelsestyper:

| Område | Typer |
|---|---|
| System | `system.start`, `system.stop`, `server.error` (5xx med stack), `retention.sweep` |
| Innlogging | `auth.login`, `auth.login_failed`, `auth.locked`, `auth.logout`, `auth.password_changed`, `session.revoked` |
| Brukere | `user.created`, `user.updated`, `user.password_reset` |
| Jobber | `job.created`, `job.queued`, `job.started`, `job.finished`, `job.cancelled`, `job.failed` |
| Filer | `file.uploaded`, `file.rejected`, `file.analyzed`, `file.analysis_failed`, `file.started`, `file.done`, `file.failed`, `file.warning` |
| Grok | `grok.retry` (advarsel), `grok.error` (feil), `admin.test_api` |
| Nedlasting | `download.file`, `download.original`, `download.zip` |
| Nettleser | `client.error` |

I tillegg får **hvert** HTTP-forsøk mot xAI en rad i `grok_calls`: status, forsøk nr., antall strenger, tegn inn/ut, millisekunder og tokens (inn, ut, resonnering). Det er grunnlaget for kalibreringen og for Admin → Jobber.

Hver HTTP-forespørsel til serveren gir én `http`-linje på debug-nivå (bare stdout, synlig med `LOG_LEVEL=debug`). JavaScript-feil i nettleseren til innloggede brukere sendes til `POST /api/client-log` (maks 30 per minutt per økt, forkortet) og lagres som `client.error`.

## Lagring og sletting

En opprydding kjører hver time og logger `retention.sweep`.

| Data | Hvor | Slettes |
|---|---|---|
| Opplastede originaler og oversatte filer | `/data/files` | Etter `RETENTION_DAYS` (14). Jobben blir stående, nedlasting gir 410 «Filene er slettet etter 14 dager.» |
| Utkast som aldri ble startet | database | Etter 2 døgn |
| Hendelser (`events`) | database | Etter `EVENT_RETENTION_DAYS` (90) |
| Utløpte økter | database | 30 dager etter utløp |
| Jobber, filrader, `grok_calls`, brukere | database | Beholdes (historikk og kalibrering) |

## Sikkerhet

- **Passord:** scrypt (N = 16384, r = 8, p = 1, 16 byte salt, 64 byte nøkkel), lagret som `scrypt$N$r$p$salt$hash`. Sammenligning med `timingSafeEqual`. Minst 10 tegn ved passordbytte. Genererte passord (14 tegn) må byttes ved første innlogging.
- **Økter:** tilfeldig 32-byte token i cookien `innnorsk_sid` (`HttpOnly`, `SameSite=Lax`, `Secure` i produksjon). Databasen lagrer bare SHA-256 av tokenet. Utløper etter `SESSION_DAYS` (14) uten aktivitet. Passordbytte logger ut andre økter; nullstilling av passord logger ut alle. Admin kan logge ut enkeltøkter.
- **Innloggingssperre:** 5 mislykkede forsøk på 15 minutter, per IP og per brukernavn, gir 429 i 15 minutter. Ukjente brukernavn tar omtrent like lang tid som kjente.
- **CSRF:** alle `/api/*`-kall som ikke er GET/HEAD, må ha headeren `X-InnNorsk: 1` (ellers 403). Sammen med `SameSite=Lax` stopper det forespørsler fra andre nettsteder.
- **Headere:** `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`. Ingen inline-skript i `web/`.
- **Tilgang:** en bruker ser bare sine egne jobber. Admin ser alt. `/api/admin/*` og `/admin` krever admin-rolle.
- **xAI-nøkkelen** finnes bare i serverens miljø (`XAI_API_KEY`). Den sendes aldri til nettleseren og fjernes fra logger. «Test API» kan brukes høyst én gang i minuttet.
- **Opplasting:** stier renses, filtype og størrelse (`MAX_FILE_MB`, `MAX_FILES_PER_JOB`) sjekkes, og filene lagres bare under `DATA_DIR`.
- **Containeren** kjører som brukeren `node`, ikke root.

## Windows-appen (lokal)

```
[Windows-PC]
  InnNorsk.exe (Electron)
    → velg inn-mappe
    → src/pipeline.js skanner .docx/.pdf/...
    → src/formats/* trekker ut tekst med layout
    → src/grok.js POST https://api.x.ai/v1/responses  (modell grok-4.6)
    → src/formats/* skriver tekst tilbake med samme stiler, src/validate.js sjekker
    → filer i ut-mappe (standard: inn/oversatt)
```

Nøkkelen lagres lokalt (`safeStorage` / userData). Ingen server, ingen database. `scripts/pack-win.js` pakker bare `src/`, `assets/` og produksjonsavhengigheter (uten `express`) i `app.asar`. `server/`, `web/`, `test/` og `data/` blir ikke med.

## Hosting

| Ting | Hvor |
|---|---|
| Kildekode | GitHub `TidemannEsbjug/InnNorsk`, gren `main` |
| Skyappen | Render webtjeneste fra `render.yaml` + `Dockerfile`, disk på `/data` ([DEPLOY.md](DEPLOY.md)) |
| Nedlastingsside for Windows | GitHub Pages (`docs/index.html`) |
| Windows-bygg | GitHub Releases (`InnNorsk-Windows.zip`) |
