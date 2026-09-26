# InnNorsk

Dokumentoversetter til norsk med Grok (xAI). Resultatet skal se ut som originalen: avsnitt, linjeskift, skrift, skriftstørrelse, fet og kursiv.

| | Hva | Hvor |
|---|---|---|
| **InnNorsk (sky)** | Nettside med innlogging. Last opp filer eller en mappe, få dem oversatt automatisk, last ned under «Mine filer». Eieren ser logger, Grok-kall og kostnad. | Cloudflare Workers Paid. Oppsett: [docs/DEPLOY.md](docs/DEPLOY.md) |
| **Windows-appen** (lokal, eldre) | Electron-app. Velg en mappe på PC-en. | [Nedlastingsside](https://tidemannesbjug.github.io/InnNorsk/) · [InnNorsk-Windows.zip](https://github.com/TidemannEsbjug/InnNorsk/releases/latest/download/InnNorsk-Windows.zip) |

GitHub Pages (`docs/index.html`) er bare nedlastingssiden for Windows-appen.

## Slik brukes nettsiden

1. Logg inn med kontoen du har fått.
2. Legg til filer (eller en mappe). Du ser «Klar – ca. N min» per fil og beregnet tid totalt.
3. Velg bokmål eller nynorsk og trykk **Oversett til norsk**. Du kan lukke siden; oversettelsen fortsetter.
4. Last ned under **Mine filer** (`Rapport (norsk).docx`). Originalene endres ikke. Filene ligger der til du sletter dem.

Støtte: `.docx` `.pptx` `.xlsx` `.pdf` `.txt` `.md` `.csv` `.html` `.rtf` (maks 25 MB per fil). PDF blir PDF med samme oppsett (tekst byttes på stedet, grafikk beholdes); RTF blir RTF med samme skrift, tabeller, lenker og bilder. Skannet PDF uten tekstlag går ikke.

## Arkitektur

```
Nettleser ──► Cloudflare Worker (worker/) ──► D1 (brukere, økter, sendinger, logg, grok_calls)
                    │                     └──► R2 (originaler, oversettelser, mellomlager per batch)
                    └── Workflow TranslateSending ──► xAI Responses API (src/grok.js)
                                   └── formatkjernen src/core.js (docx/pptx/xlsx/pdf/rtf/tekst)
```

Mer: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/PRODUCT.md](docs/PRODUCT.md) · [CLAUDE.md](CLAUDE.md)

## Utvikling

```bash
npm install
npm test                                # alt mot falsk xAI/APNs, ingen ekte API-kall
node test/helpers/mock-xai-server.js 18080 &
cp .dev.vars.example .dev.vars          # sett XAI_BASE_URL=http://127.0.0.1:18080 og XAI_API_KEY=mock
npm run db:migrate:local && npm run dev
npm run make-user -- svetlana --role user --local --apply
npm start                               # Windows-/Electron-appen
node scripts/pack-win.js                # Windows-zip → dist/InnNorsk-Windows.zip
```

Ikke commit `node_modules/`, `dist/`, `.dev.vars`, nøkler eller passord. Repoet er offentlig.

## Lisens

MIT. Se [LICENSE](LICENSE).
