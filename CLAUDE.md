# InnNorsk — kontekst for Claude (og andre kodeagenter)

Dokumentoversetter til norsk (bokmål/nynorsk) med **xAI Grok**. Resultatet skal **se ut som originalen**.

Repo: https://github.com/TidemannEsbjug/InnNorsk — **offentlig**. Aldri API-nøkler, passord eller tokens i koden.

## Produkter

| | Hva | Hvor |
|---|---|---|
| **InnNorsk (sky)** — hovedprodukt | Nettside med innlogging. Svetlana laster opp filer, oversettelsen skjer automatisk, ferdige filer ligger under «Mine filer». Eieren ser logger, Grok-kall, tokens/kostnad og alle filer i admin. | **Cloudflare Workers Paid** ($5/mnd): Worker + D1 + R2 + Workflows |
| Windows-appen (eldre, lokal) | Electron. Velg mappe, oversett lokalt med egen xAI-nøkkel. | GitHub Releases + Pages-nedlastingsside (`docs/index.html`) |

Begge bruker samme kjerne i `src/`.

## Produktkrav (må holdes)

1. Bruker laster opp dokumenter (filer eller mappe) → bokmål (valg: nynorsk).
2. Resultatet beholder avsnitt, linjeskift, skrift, størrelse, fet/kursiv, tabeller. Originaler endres aldri.
3. xAI-nøkkel kun som Worker-secret `XAI_API_KEY` (aldri i nettleser/logg). Må ha chat/model-ACL (`api-key:endpoint:voice` gir 403).
4. Norsk UI overalt. Varmt, vennlig design.
5. Eieren ser logger, feil, Grok-kall og estimat vs faktisk tid.

## Kodekart

```
src/                      Delt kjerne (CommonJS; bundles inn i Workeren, brukes av Electron)
  core.js                 HANDLERS/SUPPORTED, collectStrings, analyzeBuffer, applyTranslations, translateBuffer, utfilnavn
  grok.js                 xAI Responses API: planBatches, translateBatch (retry, split ved feil antall, GrokError), transport-hook
  validate.js             sjekker at .docx/.pptx/.xlsx er gyldig XML før levering
  formats/*.js            docx, pptx, xlsx, pdf (PDF → PDF: unpdf leser, pdf-lib skriver), text (txt/md/csv/html/rtf), simple-docx
  pipeline.js main.js preload.js settings.js renderer/   Electron (Windows-appen)
worker/                   Cloudflare Worker (ESM, Hono)
  index.js app.js         inngang, sikkerhetsheadere, sider, ruter; eksporterer Workflow TranslateSending
  translate.js            Workflow: prepare → batch-trinn (4 batcher, R2-cache per batch) → assemble → finish
  estimate.js xai.js      estimator (t = a + b·tegn, kalibrert fra grok_calls); xAI-oppsett, grok_calls, kostnad
  sendings.js files.js    sendinger/filer, statustekster, stier, opplasting/nedlasting
  auth.js                 PBKDF2-bevis fra klienten + SHA-256 på server, økter, sperre, CSRF
  log.js cron.js apns.js  hendelser (D1 + konsoll-JSON), opprydding/avstemming, valgfri iPhone-push
  quota.js                tak mot uventet forbruk: tegn til xAI per døgn/30 dager (quota_usage), samlet lagring
  routes/                 auth, sendings, admin, clientlog
migrations/               D1: 0001_init.sql, 0002_cloud_translate.sql, 0003_quota.sql (endre aldri en migrasjon som er kjørt)
web/                      Statisk UI (login, index, admin), vanilla JS, ingen byggesteg
scripts/make-user.js      oppretter/endrer brukere lokalt → wrangler d1 execute (passordet forlater aldri maskinen)
ios/                      valgfri SwiftUI-app for eierens push-varsler (ikke kompilert i CI)
test/                     node:test; helpers/mock-grok.js, mock-xai-server.js, mock-apns.js, worker-dev.js
docs/                     DEPLOY.md, ARCHITECTURE.md, PRODUCT.md, SPEC-v5-cloudflare.md; index.html = Pages
```

## Utvikling

```bash
npm install
npm test                  # alt mot falsk xAI og falsk APNs (starter wrangler dev lokalt)
cp .dev.vars.example .dev.vars   # fyll inn, eller pek XAI_BASE_URL mot mocken:
node test/helpers/mock-xai-server.js 18080 &
npm run db:migrate:local && npm run dev
npm run make-user -- svetlana --role user --local --apply
```

Deploy: se [docs/DEPLOY.md](docs/DEPLOY.md).

## Harde regler

- **Tester, skript og agenter kaller aldri ekte xAI eller APNs.** Bruk mockene. Let aldri etter ekte nøkler.
- Aldri hemmeligheter i repoet. `wrangler secret put` og `scripts/make-user.js`.
- Norsk UI. CSP: ingen inline-skript, `on*`-attributter eller `style=""` i `web/`.

## Kjente feller

- Voice-nøkkel → 403 på chat. xAI 403-body er `{ error: "string" }`.
- Word: linjeskift er `<w:br/>`; skriv oversettelsen i **lengste run**; ikke slå sammen avsnitt før Grok-kall.
- collect/apply krever at handleren er deterministisk: samme fil → samme kallrekkefølge og strenger.
- PDF → PDF: all tekst fjernes fra innholdsstrømmene (Tj/TJ/'/", også i Form XObjects) og tegnes på nytt med standardskriftene (Helvetica/Times/Courier, WinAnsi: æøå ok, kyrillisk blir «?»). Låst/ødelagt PDF → ny PDF uten grafikk. OCR-lag (usynlig tekst) dekkes med hvitt.
- Workflow: hvert batchsvar ligger i R2 (`work/<fil>/b-<idx>.json`) og hoppes over ved nye forsøk — ikke fjern det (ellers betales det dobbelt). Trinn-navn må være faste og unike.
- Auth: klienten sender `proof = base64url(PBKDF2-SHA256(passord, salt, 310000, 32 B))`; serveren lagrer bare `sha256(proof)`. Ingen Unicode-normalisering.
- Alle ikke-GET `/api/*` krever headeren `X-InnNorsk: 1`.
- Opplasting er rå `PUT /api/sendings/:id/files?path=<encodeURIComponent>` med Content-Length. Maks 25 MB (Worker-minne 128 MB; filen analyseres i minnet).
- Lokal `wrangler dev` kan ikke HTTP/2 til APNs → tester bruker `mock-apns.js`. Sandbox- vs produksjons-token må matche `APNS_ENV`/enhetens env.
- `database_id` i `wrangler.jsonc` må fylles inn etter `wrangler d1 create innnorsk`.
- Windows-appen er usignert → SmartScreen «Mer info → Kjør likevel».
