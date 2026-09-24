# Arkitektur

## I dag

```
[Windows-PC]
  InnNorsk.exe (Electron)
    → velg inn-mappe
    → pipeline skanner .docx/.pdf/...
    → formats/* trekker ut tekst med layout
    → grok.js POST https://api.x.ai/v1/responses  (modell grok-4.6)
    → formats/* skriver tekst tilbake med samme stiler
    → filer i ut-mappe (standard: inn/oversatt)
```

API-nøkkel lagres lokalt (`safeStorage` / userData). Ingen backend. Ingen database.

## Hosting i dag

- **GitHub repo** `TidemannEsbjug/InnNorsk` = kildekode.
- **GitHub Pages** (`docs/index.html`) = nedlastingsside.
- **GitHub Releases** = `InnNorsk-Windows.zip` (Electron-runtime + `app.asar`).

## Oversettelse

`src/grok.js` sender lister av strenger som JSON-array. Modellen skal returnere like mange strenger, med samme linjeskift. Batch ~28 elementer / ~7000 tegn.

Word/PPTX: originalfilen er en zip med XML. Vi endrer bare tekstnoder. Bilder, tema, sidemal, tabeller blir liggende.

PDF: `pdfjs-dist` leser glyph-posisjon, fontnavn og størrelse. Vi bygger en ny `.docx` som etterligner det.

## Sky (planlagt)

Bytt Electron-skallet med:

```
[Nettleser] opplasting
    → [server] samme pipeline (formats + grok)
    → XAI_API_KEY kun på server
    → [Nettleser] last ned oversatt fil
```

Gjenbruk `src/grok.js` og `src/formats/*`. Ikke port UI-en som «mappe på disk»; bruk filopplasting.
