# InnNorsk

Windows-app som oversetter dokumenter til norsk med Grok (xAI). Filene leses lokalt. API-nøkkelen limer du inn under **Innstillinger**.

## Last ned

[Last ned for Windows](https://github.com/TidemannEsbjug/InnNorsk/releases/latest/download/InnNorsk-Windows.zip)

Nettside: https://tidemannesbjug.github.io/InnNorsk/

## Slik bruker du den

1. Pakk ut zip-filen og kjør `InnNorsk.exe`.
2. Åpne **Innstillinger** og lim inn en nøkkel fra [console.x.ai](https://console.x.ai).
3. Velg inn-mappe, trykk **Oversett til norsk**.
4. Finn resultatet i ut-mappen (`oversatt` som standard).

Støttede filer: `.docx` `.pdf` `.pptx` `.xlsx` `.txt` `.md` `.csv` `.html` `.rtf`.

PDF skrives ut som Word-dokument. Skannede PDF-er uten tekstlag kan ikke oversettes.

## Utvikling

```bash
npm install
npm start
```
