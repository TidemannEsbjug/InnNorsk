# Overlevering — status

**I drift:** https://oversetter.tidemann.workers.dev (Cloudflare Workers Paid, Worker `oversetter`, Workflow `oversetter-translate`, D1 `innnorsk`, R2 `innnorsk-files`, migrasjon 0001–0004). Brukere: Svetlana (user) og Achilles (admin). Secrets `XAI_API_KEY` og `SALT_PEPPER` er satt. Modell: `grok-4.20-0309-non-reasoning` (uten resonnering, med priser, så admin viser kostnad).

## Ferdig og testet (`npm test`: 192/192 mot falsk xAI/APNs; integrasjonstestene trenger `pip install python-docx`)
- **Samme filtype og oppsett ut som inn:** Word, PowerPoint, Excel, tekst — og nå **PDF → PDF** (`src/formats/pdf.js`: teksten byttes på stedet, grafikk/bilder/tabeller/farger beholdes; uendret tekst beholder originale glyfer) og **RTF → RTF** (`src/formats/rtf.js`). Herdet i åtte runder mot et testsett av PDF-er fra Word/LibreOffice, Chrome, pdf-lib, spalter, brev/skjema, lysbilder, kyrillisk, skannet med OCR, låst og rotert, med uavhengig kontroll hver runde.
- **Eieren ser alt:** slettede sendinger beholdes i 30 dager for admin (`RETAIN_DELETED_DAYS`), nettleserens hendelser (side åpnet, filer avvist, feilmeldinger hun så), aktivitetskort, loggfilter per bruker og tidslinje per sending.
- **Tak mot uventet regning** (`worker/quota.js`): tegn til xAI per døgn / 30 dager og samlet lagring; se [docs/DEPLOY.md](docs/DEPLOY.md#tak-mot-uventet-regning).
- **Robust Workflow:** batchplanen lagres i R2 (`work/<fil>/plan.json`), så en deploy midt i en oversettelse ikke velter den.
- Nettsiden heter «Oversetter», lyst blått design, norsk UI.

## Kjente begrensninger (PDF)
- Standardskrifter (Helvetica/Times/Courier) i stedet for originalens skrift der teksten er oversatt; tegn utenfor WinAnsi (kyrillisk i oversatt tekst) translittereres.
- Låste (krypterte) PDF-er får en ny PDF med teksten på plass, men uten grafikk.
- Sjeldent: i to spalter kan en enkelt linje som vokser mye legge seg inntil nabospalten når den er tom i samme høyde (en spaltegrense ble prøvd i runde 8, men ga forverringer på vanlige lysbilder og ble tatt ut).

## Gjenstår (valgfritt)
1. **Kostnadsvarsler:** Cloudflare «Usage Based Billing»-varsel og xAI forhåndsbetalte kreditter uten automatisk påfyll.
2. `ios/` (push-app, ikke kompilert her).
