# InnNorsk — kontekst for Claude (Cloud / Code)

Dette er en **dokumentoversetter til norsk** via **xAI Grok** (`https://api.x.ai`).

Repo: https://github.com/TidemannEsbjug/InnNorsk  
Nåværende produkt: **lokal Windows Electron-app**.  
Ønsket retning: **skybasert løsning**, med dette repoet som kilde for Claude Cloud.

Ikke commit API-nøkler. Nøkkelen limer brukeren inn selv (xAI Console).

## Hva som er hostet hvor

| Ting | Hvor |
|---|---|
| All kildekode | GitHub `main` (dette repoet) |
| Nedlastingsside | GitHub Pages: https://tidemannesbjug.github.io/InnNorsk/ (`docs/`) |
| Windows-bygg | GitHub Releases (`InnNorsk-Windows.zip`) |
| Selve oversettelsen | Kjører **lokalt i Electron** og kaller `api.x.ai` |

Pages er **ikke** appen. Det er en statisk landingsside med nedlastingsknapp.

## Produktkrav (må holdes)

1. Bruker legger dokumenter i en mappe (eller tilsvarende opplasting i sky).
2. Trykk oversett → dokumentene kommer ut på **bokmål** (valg: nynorsk).
3. Resultatet skal **se ut som originalen**: avsnitt, linjeskift, skrift, skriftstørrelse, fet/kursiv.
4. Originaler endres ikke. Output i egen mappe / eget resultat.
5. xAI-nøkkel under innstillinger. Må ha chat/model-ACL, ikke bare voice (`api-key:endpoint:voice` gir 403).
6. Modell: `grok-4.6` mot `https://api.x.ai/v1/responses`.

## Støttede formater

| Inn | Ut | Hvordan |
|---|---|---|
| `.docx` | `.docx` | Tekst byttes på stedet i OOXML. Stiler/tema beholdes. |
| `.pptx` | `.pptx` | Samme, i slide XML. |
| `.xlsx` | `.xlsx` | Oversetter tekstceller, hopper over tall/formler. |
| `.pdf` | `.docx` | pdf.js henter tekst + font/størrelse, bygger Word. |
| `.txt` `.md` `.csv` `.html` | samme / `.html` | Tekst/HTML. |
| `.rtf` | `.docx` | RTF strippes, skrives som Word. |

Skannet PDF uten tekstlag kan ikke oversettes.

## Kodekart

```
src/main.js          Electron main, IPC, mappevalg, jobb
src/preload.js       contextBridge
src/renderer/        UI (norsk)
src/settings.js      Nøkkel lagres kryptert via safeStorage når mulig
src/grok.js          xAI Responses API, batch-oversettelse som JSON-array
src/pipeline.js      Skanner mappe, ruter til format-handler
src/formats/docx.js  Word: bytt tekst i lengste run, behold rPr
src/formats/pptx.js  PowerPoint: behold a:rPr
src/formats/pdf.js   PDF-layout → styled Word
src/formats/xlsx.js  Excel-celler
src/formats/text.js  txt/md/csv/html/rtf
src/formats/simple-docx.js  Bygg Word når vi ikke har original OOXML
scripts/pack-win.js  Bygg Windows zip fra macOS (uten Wine)
docs/                GitHub Pages
```

## Utvikling

```bash
npm install
npm start
```

Windows-zip (fra Mac):

```bash
node scripts/pack-win.js
```

Output: `dist/InnNorsk-Windows.zip`. Last opp som GitHub Release. Pages peker på `/releases/latest/download/InnNorsk-Windows.zip`.

Electron-packager `--win` på Mac krever Wine for ikon/metadata. `scripts/pack-win.js` laster ned win32 Electron og pakker `app.asar` i stedet.

## Sky-retning

Eieren vil flytte dette fra lokal `.exe` til en **skyapp** (opplasting i nettleser, oversettelse på server, nedlasting av norsk fil). Behold:

- Samme format-pipeline (`src/formats/*`, `src/grok.js`)
- Samme visuell-fidelity-krav
- xAI-nøkkel **server-side**, aldri i nettleserbunt
- Norsk UI

Electron-skallet (`main.js` / mappevelger) erstattes av web-opplasting + lagring. Ikke kast oversettelseslogikken.

## Kjente feller

- Voice-nøkkel (`acls: ["api-key:endpoint:voice"]`) → 403 på chat. Bruk nøkkel med `api-key:endpoint:*` og `api-key:model:*`.
- xAI 403-body er `{ error: "string" }`, ikke `{ error: { message } }`.
- Linjeskift i Word må være `<w:br/>`, ikke `\n` inne i `<w:t>`.
- I DOCX: skriv oversettelsen inn i **lengste run**, ikke nødvendigvis første (første kan være 8pt/tom).
- Ikke slå sammen avsnitt før Grok-kall; det ødelegger layout.
- Windows-appen er usignert → SmartScreen «Mer info → Kjør likevel».
