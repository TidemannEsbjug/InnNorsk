# InnNorsk

Dokumentoversetter til norsk med Grok (xAI).

**Kildekode og dokumentasjon ligger i dette repoet.**  
**GitHub Pages er bare nedlastingssiden** for Windows-bygget, ikke selve appen.

| | |
|---|---|
| Repo | https://github.com/TidemannEsbjug/InnNorsk |
| Nedlasting (Windows) | https://tidemannesbjug.github.io/InnNorsk/ |
| Siste `.exe`-zip | [InnNorsk-Windows.zip](https://github.com/TidemannEsbjug/InnNorsk/releases/latest/download/InnNorsk-Windows.zip) |

Versjon: **1.2.0** (lokal Electron-app). Retning: skyapp, se [docs/PRODUCT.md](docs/PRODUCT.md).

## Hva appen gjør

1. Legg dokumenter i en mappe.
2. Velg mappen som inn-kurv, lim inn xAI-nøkkel under Innstillinger.
3. Trykk **Oversett til norsk**.
4. Ferdige filer lander i ut-kurven (`oversatt/`). Originalene endres ikke.

Oversettelsen skal se ut som originalen: avsnitt, linjeskift, skrift og skriftstørrelse.

Støtte: `.docx` `.pdf` `.pptx` `.xlsx` `.txt` `.md` `.csv` `.html` `.rtf`.  
PDF skrives som Word. Skannet PDF uten tekstlag går ikke.

Nøkkelen må ha chat/model-tilgang i [console.x.ai](https://console.x.ai) (`api-key:endpoint:*`, ikke bare voice).

## For utviklere og Claude Cloud

Les først:

- [CLAUDE.md](CLAUDE.md) — hvordan jobbe i repoet
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — hva som kjører hvor
- [docs/PRODUCT.md](docs/PRODUCT.md) — krav og sky-retning

```bash
npm install
npm start                 # Electron lokalt
node scripts/pack-win.js  # Windows-zip → dist/InnNorsk-Windows.zip
```

Ikke commit `node_modules/`, `dist/` eller API-nøkler.

## Lisens

MIT. See [LICENSE](LICENSE).
