# Overlevering — status (les denne først)

**Beslutning:** Alt på Cloudflare **Workers Paid ($5/mnd)**. Svetlana laster opp på nettsiden, oversettelsen skjer automatisk i Cloudflare (Workflow → xAI API), resultatet ligger under «Mine filer». Eieren ser logger og alle filer i admin. Ingen Mac-agent.

**Bindende spesifikasjon:** [docs/SPEC-v5-cloudflare.md](docs/SPEC-v5-cloudflare.md) (endringer oppå [docs/SPEC-v4-drop.md](docs/SPEC-v4-drop.md), som beskriver dagens kode).

## Ferdig og testet (commit 2f125f3, 100/100 tester)
- `src/` kjerne: robust Grok-klient (retry, split ved feil antall, norske feil), `core.js` (collectStrings/applyTranslations/analyzeBuffer), PDF via unpdf med ekte fontnavn.
- `worker/` + `web/`: fildropp med innlogging (PBKDF2 i nettleser, SHA-256 på server), varmt design, «Mine filer», admin (logg, økter, brukere), valgfri iPhone-push (APNs), cron.
- `scripts/make-user.js`: oppretter brukere; passordet forlater aldri maskinen.

## Under arbeid da dette ble pushet (kan være halvferdig — kjør `npm test`)
- Backend etter spec v5: `worker/translate.js` (Workflow `TranslateSending`), `migrations/0002_cloud_translate.sql`, estimat ved opplasting, `grok_calls` med tokens/kostnad, admin-endringer, fjerne `mac/` og agent-API.
- Web etter spec v5: «Oversett til norsk»-flyt, «Beregnet tid», xAI-kort i admin, Grok-kall per fil.

## Gjenstår
1. Fullføre/verifisere punktene over (`npm test` grønt).
2. Oppdatere `CLAUDE.md`, `README.md`, `docs/DEPLOY.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCT.md` — **de beskriver fortsatt et gammelt Render/Express-oppsett og er feil.**
3. Deploy (på Mac-en, `wrangler`):
   ```bash
   npm install && npx wrangler login
   npx wrangler d1 create innnorsk          # lim database_id inn i wrangler.jsonc
   npx wrangler r2 bucket create innnorsk-files
   npm run deploy                           # migrasjoner + deploy
   npx wrangler secret put XAI_API_KEY      # NY nøkkel (den gamle ble limt inn i chat — roter den)
   openssl rand -base64 32 | npx wrangler secret put SALT_PEPPER
   npm run make-user -- <deg> --role admin --display-name "<navn>" --apply
   npm run make-user -- Svetlana --role user --display-name Svetlana --apply
   ```
4. `ios/` (valgfri push-app) er ikke kompilert.

**Regler:** repoet er offentlig — aldri nøkler/passord i koden. Tester kaller aldri ekte xAI (bruk `test/helpers/mock-grok.js` / mock-xai-server).
