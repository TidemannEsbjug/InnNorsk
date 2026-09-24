# InnNorsk

Dokumentoversetter til norsk med Grok (xAI). Resultatet skal se ut som originalen: avsnitt, linjeskift, skrift, skriftstørrelse, fet og kursiv.

Versjon **1.2.0**. To utgaver med samme oversettelseskjerne:

| | Hva | Hvor |
|---|---|---|
| **InnNorsk Sky** (anbefalt) | Nettside med innlogging. Last opp filer eller en mappe, last ned norsk resultat. Eieren ser logger og feil. | Egen server på Render. Oppsett: [docs/DEPLOY.md](docs/DEPLOY.md) |
| **Windows-appen** (lokal, eldre) | Electron-app. Velg en mappe på PC-en. | [Nedlastingsside](https://tidemannesbjug.github.io/InnNorsk/) · [InnNorsk-Windows.zip](https://github.com/TidemannEsbjug/InnNorsk/releases/latest/download/InnNorsk-Windows.zip) |

GitHub Pages (`docs/index.html`) er bare nedlastingssiden for Windows-appen, ikke selve skyappen.

## Slik brukes skyappen

1. Logg inn med kontoen du har fått fra eieren.
2. Dra filer eller en hel mappe inn i **Inn-kurven**. Du ser estimert tid før du starter.
3. Velg bokmål eller nynorsk og trykk **Oversett til norsk**.
4. Last ned fra **Ut-kurven**, fil for fil eller alt som zip. Originalene endres ikke.

Filene slettes fra serveren etter 14 dager.

Støtte: `.docx` `.pdf` `.pptx` `.xlsx` `.txt` `.md` `.csv` `.html` `.rtf`. PDF og RTF blir Word. Skannet PDF uten tekstlag går ikke.

## Windows-appen

1. Last ned og pakk ut zip-en, kjør `InnNorsk.exe` (SmartScreen: «Mer info» → «Kjør likevel»).
2. Lim inn xAI-nøkkel under Innstillinger. Nøkkelen må ha chat/model-tilgang i [console.x.ai](https://console.x.ai) (`api-key:endpoint:*`, ikke bare voice).
3. Velg inn-mappe og trykk **Oversett til norsk**. Ferdige filer havner i `oversatt/`.

## For utviklere og Claude

Les først:

- [CLAUDE.md](CLAUDE.md): hvordan jobbe i repoet, kodekart, kjente feller
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): server, jobbflyt, estimat, logging, sikkerhet
- [docs/PRODUCT.md](docs/PRODUCT.md): krav
- [docs/DEPLOY.md](docs/DEPLOY.md): drift på Render

Krever Node 22.13 eller nyere.

### Skyappen lokalt, uten ekte xAI (gratis)

```bash
npm install
node test/helpers/mock-xai-server.js 18080 &
XAI_BASE_URL=http://127.0.0.1:18080 XAI_API_KEY=mock \
  ADMIN_USERNAME=admin ADMIN_PASSWORD=lokalt-passord-123 npm run server
```

Åpne http://localhost:8080 og logg inn som `admin`. Den falske xAI-serveren «oversetter» til store bokstaver, så du kan teste hele flyten uten kostnad. Data havner i `./data/` (slett mappen for å starte på nytt). Admin-brukeren lages bare når databasen er tom.

### Med ekte xAI (koster penger)

```bash
XAI_API_KEY=xai-... ADMIN_USERNAME=admin ADMIN_PASSWORD=... npm run server
```

Alle innstillinger står i [.env.example](.env.example). Brukere kan også administreres fra kommandolinjen: `node server/cli.js` (`create-user`, `reset-password`, `list-users`, `disable-user`).

### Tester

```bash
npm test
```

Testene kaller **aldri** det ekte xAI-API-et. De bruker `test/helpers/mock-grok.js` (falsk `fetch`) eller den falske xAI-serveren.

### Windows-appen

```bash
npm start                 # Electron lokalt
node scripts/pack-win.js  # Windows-zip → dist/InnNorsk-Windows.zip
```

Ikke commit `node_modules/`, `dist/`, `data/`, `.env` eller API-nøkler.

## Lisens

MIT. Se [LICENSE](LICENSE).
