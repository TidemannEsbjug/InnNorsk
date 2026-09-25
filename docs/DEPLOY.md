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
| `MAX_STORAGE_GB` | 5 | samlet lagring (originaler + oversettelser), godt under R2-gratiskvoten på 10 GB |

Også «Sett i kø igjen» teller, og sletting gir ikke kvoten tilbake. Når et tak nås, får Svetlana en vennlig melding, og hendelsen `quota.*` havner i Admin → Logg. Forbruket mot takene vises i Admin → Oversikt.

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
npm run deploy                                      # kjører D1-migrasjoner og deployer → skriver ut https://innnorsk.<konto>.workers.dev
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

Valgfritt: eget domene under Workers → innnorsk → Settings → Domains & Routes.

## iPhone-varsler (valgfritt)

Se [ios/README.md](../ios/README.md). Kort: lag en APNs-nøkkel (.p8) i Apple Developer, og kjør
`npx wrangler secret put APNS_KEY_P8 < AuthKey_XXXX.p8`, `npx wrangler secret put APNS_KEY_ID`, `npx wrangler secret put APNS_TEAM_ID`. Sett `APNS_ENV` til `sandbox` (Xcode-bygg) eller `production` (TestFlight/App Store) i `wrangler.jsonc`.

## Daglig drift

- **Admin → Sendinger:** alle filer (original og oversettelse), status, feil med tekniske detaljer, Grok-kall, tokens, kostnad, estimat vs faktisk tid. «Sett i kø igjen» oversetter på nytt. «Last opp oversettelse» lar deg legge inn en fil manuelt. «Hilsen til Svetlana» vises for henne.
- **Admin → Logg:** alle hendelser (innlogging, opplasting, oversettelse, nedlasting, feil i nettleseren).
- **Admin → Økter / Brukere:** se og logg ut økter; nytt passord til Svetlana (vises én gang), eller kjør `make-user` på nytt.
- **Cloudflare-dashbordet:** Workers → innnorsk → Logs, og Workflows → innnorsk-translate for hver oversettelse. `npx wrangler tail` gir live-logg.
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
- Filene ligger i R2-bøtta `innnorsk-files` og slettes bare når Svetlana sletter en sending.
