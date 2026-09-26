# Drift: InnNorsk på Cloudflare (Workers Paid)

Alt kjører hos Cloudflare: nettside og API (Worker), database (D1), filer (R2) og oversettelse (Workflow som kaller xAI). Ingenting trenger å stå på hjemme.

## Kostnad

- **Cloudflare Workers Paid: $5/mnd** (kreves for CPU-tid og Workflows). R2 (10 GB) og D1 er godt innenfor inkluderte kvoter for én bruker. Sjekk gjeldende priser på cloudflare.com.
- **xAI:** betaling per token. Admin viser tokens per fil, og kostnad når du fyller inn `XAI_PRICE_INPUT_PER_M` / `XAI_PRICE_OUTPUT_PER_M` (USD per million tokens) i `wrangler.jsonc`.

## Tak mot uventet regning

Cloudflare har **ingen hard utgiftsgrense** på Workers Paid; alt over det inkluderte faktureres. For én bruker er det inkluderte (10 mill. forespørsler, 30 mill. CPU-ms, 10 GB R2) svært romslig. Det som faktisk koster, er mye tekst til xAI og mye lagring, så appen har egne tak (i `wrangler.jsonc`, endres med ny `npm run deploy`):

| Variabel | Standard | Betyr |
|---|---|---|
| `MAX_CHARS_PER_DAY` | 300000 | tegn som kan sendes til oversettelse siste 24 t (ca. 120 sider) |
| `MAX_CHARS_PER_MONTH` | 2000000 | tegn siste 30 dager (ca. 800 sider) |
| `MAX_STORAGE_GB` | 5 | samlet lagring (originaler + oversettelser, også slettede som ikke er slettet for godt ennå), godt under R2-gratiskvoten på 10 GB |
| `RETAIN_DELETED_DAYS` | 30 | hvor lenge du kan laste ned filer Svetlana har slettet, før cron sletter dem for godt |

Også «Sett i kø igjen» teller, og sletting gir ikke kvoten tilbake. Plass i lagringen kommer først tilbake når slettede filer er slettet for godt (etter `RETAIN_DELETED_DAYS`, eller med «Slett for godt nå» i Admin → Sendinger). Når et tak nås, får Svetlana en vennlig melding, og hendelsen `quota.*` havner i Admin → Logg. Forbruket mot takene vises i Admin → Oversikt.

I tillegg (gjøres i nettleseren):
- **Cloudflare:** Manage Account → Notifications → Add → **Usage Based Billing** → e-post når bruken av Workers/R2/D1 passerer en terskel.
- **xAI:** bruk forhåndsbetalte kreditter **uten automatisk påfyll** (console.x.ai → Billing). Da kan xAI aldri koste mer enn det du har fylt på.

## Første gang (på din Mac, i repo-mappen)

1. Kjøp **Workers Paid** i Cloudflare-dashbordet (Workers & Pages → Plans).
2. Kjør:

```bash
git clone https://github.com/TidemannEsbjug/InnNorsk.git && cd InnNorsk
npm install
npx wrangler login                                  # åpner nettleseren
npx wrangler d1 create innnorsk                     # lim database_id inn i wrangler.jsonc
npx wrangler r2 bucket create innnorsk-files
npm run deploy                                      # kjører D1-migrasjoner og deployer → skriver ut https://oversetter.<konto>.workers.dev
npx wrangler secret put XAI_API_KEY                 # NY nøkkel fra console.x.ai (chat-/modelltilgang)
openssl rand -base64 32 | npx wrangler secret put SALT_PEPPER
npm run make-user -- <ditt-brukernavn> --role admin --display-name "<navnet Svetlana ser>" --apply
npm run make-user -- Svetlana --role user --display-name Svetlana --apply
```

`make-user` spør etter passordet i terminalen (to ganger, skjult). Det lagres ikke noe sted utenom en hash i D1. Svetlana tvinges ikke til å bytte passord. Brukernavn skiller ikke på store/små bokstaver.

`database_id` er ikke hemmelig; det er greit å committe `wrangler.jsonc` med den.

3. Test:
   - Logg inn som deg selv → **Admin → Oversikt → Test API-tilkobling** (ett lite kall).
   - Logg inn som Svetlana (gjerne på telefonen) → legg til en liten .docx → **Oversett til norsk** → vent → **Last ned**.

Valgfritt: eget domene under Workers → oversetter → Settings → Domains & Routes.

## iPhone-varsler (valgfritt)

Se [ios/README.md](../ios/README.md). Kort: lag en APNs-nøkkel (.p8) i Apple Developer, og kjør
`npx wrangler secret put APNS_KEY_P8 < AuthKey_XXXX.p8`, `npx wrangler secret put APNS_KEY_ID`, `npx wrangler secret put APNS_TEAM_ID`. Sett `APNS_ENV` til `sandbox` (Xcode-bygg) eller `production` (TestFlight/App Store) i `wrangler.jsonc`.

## Daglig drift

- **Admin → Oversikt:** et aktivitetskort per bruker som sender filer: om siden er åpen nå / sist innom, sist innlogget, sist lastet opp, sendt og lastet ned, siste 7 dager, og problemer siste døgn (filer som feilet, feilmeldinger hun fikk se, opplastinger som ikke gikk). «Vis loggen» / «Vis problemer» åpner Logg filtrert på henne.
- **Admin → Sendinger:** alle filer (original og oversettelse), status, det hun ser ved filen, feil med tekniske detaljer, Grok-kall, tokens, kostnad, estimat vs faktisk tid, og «Historikk» per sending (opprettet, filer lastet opp eller avvist, sendt, oversatt, lastet ned, slettet – med hvem). «Sett i kø igjen» oversetter på nytt. «Last opp oversettelse» lar deg legge inn en fil manuelt. «Hilsen til Svetlana» vises for henne.
- **Når Svetlana sletter:** sendingen (eller en fil hun fjerner fra utkastet, eller laster opp på nytt med samme navn) forsvinner for henne med én gang, og en oversettelse som pågår, stoppes. Filene blir liggende i R2: med «Vis også slettede» (på som standard) ser du dem merket «Slettet av Svetlana <dato>» og kan laste ned original og oversettelse i `RETAIN_DELETED_DAYS` dager. Deretter sletter cron dem for godt (`sending.purged` i loggen); kortet blir stående som historikk. «Slett for godt nå» gjør det med én gang. Utkast som aldri ble sendt, ryddes på samme måte etter to døgn. Slettede sendinger kan ikke settes i kø igjen eller få manuell oversettelse.
- **Admin → Logg:** alle hendelser (innlogging, opplasting, oversettelse, nedlasting, sletting, feil). Filter på bruker (det hun gjorde + det systemet gjorde med sendingene hennes) og «Advarsler og feil». Fra nettsiden hennes kommer også `client.page` (siden åpnet, med nettleser og skjermstørrelse), `client.file_rejected` (filer nettleseren ikke tok med, med grunnen hun så), `client.upload_failed` og `client.error_shown` (feilmeldingen ordrett) – aldri filinnhold eller passord.
- **Admin → Økter / Brukere:** se og logg ut økter; «Sist aktiv» og «Vis aktivitet» per bruker; nytt passord til Svetlana (vises én gang), eller kjør `make-user` på nytt.
- **Cloudflare-dashbordet:** Workers → oversetter → Logs, og Workflows → oversetter-translate for hver oversettelse. `npx wrangler tail` gir live-logg.
- **Oppdatering:** `git pull && npm install && npm run deploy`.

## Feilsøking

| Symptom | Årsak / løsning |
|---|---|
| «Oversettelsen er ikke satt opp ennå» | `XAI_API_KEY` mangler: `npx wrangler secret put XAI_API_KEY` |
| Filer feiler med «[forbidden] … 403» | Nøkkelen har bare voice-tilgang. Lag ny med `api-key:endpoint:*` og `api-key:model:*`. |
| «[auth] … 401» | Feil eller slettet nøkkel. Sett ny secret. |
| Fil «stoppet uventet» | Cron har ryddet en oversettelse som hang. Admin → «Sett i kø igjen». |
| Skannet PDF | Har ikke tekstlag og kan ikke oversettes. Svetlana ser en forklaring. |
| Fil over 25 MB | Avvises. Grensen er `MAX_FILE_MB` (Worker-minnet er 128 MB). |

## Sikkerhetskopi

- D1 har Time Travel (gjenoppretting 30 dager bakover): `npx wrangler d1 time-travel info innnorsk`.
- Filene ligger i R2-bøtta `innnorsk-files`. Det Svetlana sletter, slettes for godt `RETAIN_DELETED_DAYS` dager senere (eller når du trykker «Slett for godt nå»).
