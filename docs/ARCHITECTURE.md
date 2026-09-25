# Arkitektur

## Komponenter

| Del | Teknologi | Ansvar |
|---|---|---|
| Worker (`worker/`) | Cloudflare Workers Paid, Hono, ESM | sider, API, innlogging, opplasting/nedlasting, admin, cron |
| Workflow `TranslateSending` (`worker/translate.js`) | Cloudflare Workflows | oversetter én sending, fil for fil, med varige trinn |
| D1 (`migrations/`) | SQLite | brukere, økter, sendinger, filer, batcher, `grok_calls`, `quota_usage`, hendelser, enheter |
| R2 (`innnorsk-files`) | objektlager | `s/<sending>/<fil>/original`, `…/result`, `work/<fil>/…` (mellomlager) |
| Kjerne (`src/`) | CommonJS, bundlet inn | uttrekk og innsetting av tekst med formatering, Grok-klient, validering |
| UI (`web/`) | statisk HTML/CSS/JS | Svetlanas side og admin |

## Flyt

1. **Opplasting:** `POST /api/sendings` (utkast) → én rå `PUT /api/sendings/:id/files?path=` per fil → lagres i R2 → `core.analyzeBuffer` gir tekstbiter, tegn, batcher og estimat. Skannet/skadet fil markeres `failed` med vennlig tekst og hoppes over.
2. **Start:** `POST /api/sendings/:id/send` → filer `sent` → ny Workflow-instans `<sendingId>-<n>`.
3. **Workflow:** for hver fil: `prepare` (collectStrings → `strings.json` i R2) → `chunk`-trinn med 4 batcher (parallelt `GROK_CONCURRENCY`; hvert svar lagres som `b-<idx>.json` og hoppes over ved nye forsøk) → `assemble` (applyTranslations, validering, `… (norsk).<ext>`) → `finish`. Feil nøkkel (401/403) stopper resten.
4. **Visning:** nettleseren poller `GET /api/sendings`; status og ETA kommer fra D1.

Statuser for fil: `draft → sent → working → done | failed`.

## Estimat

Per batch `t = a + b·tegn` (standard 8 s + 0,006 s/tegn), tilpasset med minste kvadraters metode fra de siste vellykkede `grok_calls` (≥ 8 målinger, blandet med standard). Filestimat = sum av trinn (LPT over `GROK_CONCURRENCY`) + 3 s. Under kjøring korrigeres gjenstående tid mot faktisk tid for filens ferdige batcher.

## Logging

- Hendelser i D1 (`events`) + én JSON-linje i konsollen (Workers Logs). Typer bl.a. `auth.*`, `sending.*`, `file.*`, `download.*`, `admin.*`, `client.error`, `server.error`. Hemmeligheter fjernes.
- Hvert xAI-forsøk → `grok_calls` (ms, status, forsøk, tokens, kostnad, feil).

## Sikkerhet

- Passord: klienten regner `PBKDF2-SHA256(passord, salt, 310000)`; serveren lagrer bare `sha256(bevis)`. Ukjente brukernavn får et stabilt falskt salt. Sperre etter 5 feil på 15 min.
- Økter: tilfeldig token i `HttpOnly`/`SameSite=Lax`-cookie, bare hash i D1.
- CSRF: `X-InnNorsk: 1` på alle ikke-GET API-kall. Streng CSP og sikkerhetsheadere på alle svar.
- Svetlana ser bare egne sendinger. xAI-nøkkel og APNs-nøkkel er Worker-secrets.
- Tak mot uventet forbruk (`worker/quota.js`): hver sending og hvert «Sett i kø igjen» reserverer filenes tegn i `quota_usage` (sjekk og reservasjon i én SQL-setning). Over `MAX_CHARS_PER_DAY` (24 t) eller `MAX_CHARS_PER_MONTH` (30 dager) → 429 og `quota.translation` i loggen. Sletting frigjør ikke kvote. Opplasting som ville gi mer enn `MAX_STORAGE_GB` lagret → 507 og `quota.storage`. Forbruket vises i Admin → Oversikt.

## Opprydding (cron hvert 15. min)

Oversettelser som har hengt i over 30 min markeres som feilet. Gamle utkast, innloggingsforsøk, utløpte økter, gamle hendelser og `quota_usage` eldre enn 31 dager slettes. Ferdige filer beholdes til brukeren sletter dem.
