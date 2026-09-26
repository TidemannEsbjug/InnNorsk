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
  validate.js             sjekker før levering: .docx/.pptx/.xlsx gyldig XML, .pdf hode/slutt, .rtf {\rtf + balanserte { }
  formats/*.js            docx, pptx, xlsx, pdf (PDF → PDF: unpdf leser, pdf-lib skriver), rtf (RTF → RTF, egen tokenizer),
                          text (txt/md/csv/html), simple-docx (brukes ikke lenger)
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
migrations/               D1: 0001_init.sql, 0002_cloud_translate.sql, 0003_quota.sql, 0004_retention_activity.sql (endre aldri en migrasjon som er kjørt)
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
- RTF → RTF (`formats/rtf.js`): enhet = avsnitt (til `\par`, `\cell`, `\row`, `\sect`, `\page` eller slutten av topptekst/fotnote/tekstboks); `\line` og Cocoas U+2028 = "\n" (skrives som `\line`), `\tab` = "\t"; `\softline`/`\softpage`/`\softcol` (skift som ikke vises) står urørt og blir et mellomrom for Grok. Et avsnitt over ca. 1000 tegn deles ved et linjeskift etter setningsslutt (ikke etter forkortelser som «Mr.», «e.g.», «f.eks.») eller ved to linjeskift, over 5000 tegn ved hvilket som helst linjeskift (så én merkefeil ikke tar formateringen fra et helt TextEdit-dokument, og setninger ikke deles). Grunnformat = tegnformatet med flest bokstaver (usynlige ord som `\insrsid`/`\strokec`/`\cf0` teller ikke; Cocoa-farger med ulik gjennomsiktighet i `\expandedcolortbl` er ulike); ord i annet format sendes som `⟦1⟧…⟦/1⟧` (høyst 6) og skrives tilbake i run-en med samme merke, i samme rekkefølge (en run med bare mellomrom får tekst bare når ingen annen passer, så teksten etter et anker ikke havner foran det). Merkevarianter fra modellen (`⟦ 1 ⟧`, `⟦１⟧`, `〚1〛`, `[1]…[/1]`; har originalen `[`, bare i par, og aldri når den har `[/`) rettes; har originalen `⟦ ⟧` eller `〚 〛` som tekst, får avsnittet ingen merker; ugyldige merker → alt i grunnformatet, rester av merker fjernes (siden med tab/linjeskift blir stående, og tab/linjeskift først og sist) og én advarsel `markers_lost` per fil; bare merker/mellomrom → avsnittet står urørt. Ankre (fotnote `\chftn` + `{\footnote}`/`{\*\footnote}`, `\pict`, RTFD-vedlegg `{{\NeXTGraphic …}¬}`, symbolskrift og `\u` U+F000–F0FF, `\chpgn`/`\chdate`, kommentarmerker, bokmerker rundt tekst (ikke tomme som `_GoBack`), `\deleted`, `\v`, tekst mellom `\*` og kontrollordet i en skadet fil, hevet/senket uten bokstaver, tegnsetting med mellomrom i et format uten ord (`•\t`, ` - `), understreket/uthevet blankt felt, tab/linjeskift/mellomrom alene inntil et anker) står urørt; teksten etter et anker merkes så den havner etter det (disse merkene regnes ut etter 6-grensen, får plass før format nr. 6 og videre og deler plassene som er igjen, så fotnotemerker aldri flytter seg), og mellomrom ved et anker settes tilbake på samme side som i originalen. Symbolskrift gjenkjennes på `\fcharset2` eller familienavnet, også Cocoas PostScript-navn (`Wingdings-Regular`, `SymbolMT`, `ZapfDingbatsITC`). Et felt med bokstaver i resultatet deler avsnittet; sidetall o.l. er ankre. Aldri tekst i `\fonttbl`, `\stylesheet`, `\info`, `\pict`, `\fldinst`, `\listtext` o.l. eller ukjente `\*`-grupper (unntak: `\*\footnote`, `\*\shpinst`). `\'hh` leses med skriftens `\fcharset` (egne tabeller 1250–1258/874/Mac, ikke TextDecoder); flerbyte uten `\uN` → avsnittet står uoversatt + én advarsel. Alt som ikke er ASCII skrives som `\uN` + reservetegn etter `\ucN`. Innhold etter rotgruppen fjernes og manglende `}` legges til før noe betales; umulig struktur → «RTF-filen er skadet og kan ikke leses.» ved opplasting. Minne (heapUsed + arrayBuffers, Worker-grensen 128 MB; i Node går ca. 20 MB til selve kjøringen): vakten i `parseRtf` regner ut det som lever samtidig ved innsamling/analyse (innfil, run-er 11 B, avsnitt 9 B, kildestrenger, listene i translateStrings og planBatches ca. 64 B per streng, kladd per tekstnivå, tabellene over formater/skrifter/farger ca. 150 B per format med flate nøkler) og ved innlegging (oversettelser inntil 1,3 × originalen à 2 B/tegn, utfil der `\'hh` blir `\uN?`, justering), og slipper bare gjennom filer som holder seg under 100 og 110 MB (test i `test/rtf.test.js`: Word-RTF, mange korte avsnitt/tabellceller/formater fylt opp til 25 MB, felt i felt og en enorm skrifttabell; 25 MB tett Word-tekst er for mye). `core.applyTranslations` kopierer bare den ytre listen. For mye → «RTF-filen er for stor til å oversettes på én gang (…)» eller over 12 MB tekst → «RTF-filen har for mye tekst … (maks 12 MB tekst) …» ved opplasting. Tester: skriv `\u` som `§` i RTF-kilden (verktøy kan tolke `\u` + fire sifre).
- PDF → PDF: all tekst fjernes fra innholdsstrømmene (Tj/TJ/'/", også i Form XObjects) og tegnes på nytt med standardskriftene (Helvetica/Times/Courier, WinAnsi: æøå ok, kyrillisk blir «?»). Låst/ødelagt PDF → ny PDF uten grafikk. OCR-lag (usynlig tekst) dekkes med hvitt.
- Workflow: hvert batchsvar ligger i R2 (`work/<fil>/b-<idx>.json`) og hoppes over ved nye forsøk — ikke fjern det (ellers betales det dobbelt). Trinn-navn må være faste og unike.
- Auth: klienten sender `proof = base64url(PBKDF2-SHA256(passord, salt, 310000, 32 B))`; serveren lagrer bare `sha256(proof)`. Ingen Unicode-normalisering.
- Alle ikke-GET `/api/*` krever headeren `X-InnNorsk: 1`.
- Sletting fra Svetlana er myk: filene blir liggende i R2 i `RETAIN_DELETED_DAYS` (30) så eieren kan se/laste ned dem (Admin → Sendinger, `?all=1`); cron renser etterpå (`purged_at`). Lagringstaket teller alt som ikke er renset. Nettleserens hendelser (`client.page`, `client.file_rejected`, `client.upload_failed`, `client.error_shown`) går via `/api/client-log` (60/min per økt, 120/min per bruker).
- Opplasting er rå `PUT /api/sendings/:id/files?path=<encodeURIComponent>` med Content-Length. Maks 25 MB (Worker-minne 128 MB; filen analyseres i minnet).
- Lokal `wrangler dev` kan ikke HTTP/2 til APNs → tester bruker `mock-apns.js`. Sandbox- vs produksjons-token må matche `APNS_ENV`/enhetens env.
- `database_id` i `wrangler.jsonc` må fylles inn etter `wrangler d1 create innnorsk`.
- Windows-appen er usignert → SmartScreen «Mer info → Kjør likevel».
