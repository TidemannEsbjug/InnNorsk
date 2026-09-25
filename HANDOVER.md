# Overlevering — status

**Beslutning:** Alt på Cloudflare **Workers Paid ($5/mnd)**. Svetlana laster opp på nettsiden, oversettelsen skjer automatisk i Cloudflare (Workflow → xAI API), resultatet ligger under «Mine filer». Eieren ser logger og alle filer i admin.

## Ferdig og testet (`npm test`: 75/75, bare mot falsk xAI/APNs; integrasjonstestene trenger `pip install python-docx`)
- Kjerne (`src/`): robust Grok-klient, formatbevarende uttrekk/innsetting, PDF med ekte fontnavn.
- Worker (`worker/`): innlogging, sendinger, Workflow-oversettelse med R2-cache per batch, estimat ved opplasting og live ETA, `grok_calls` med tokens/kostnad, admin, cron.
- Web (`web/`): varmt design, «Oversett til norsk», «Mine filer», admin med xAI-kort og Grok-kall per fil.
- Tak mot uventet forbruk (`worker/quota.js`): tegn til xAI per døgn / 30 dager og samlet lagring; se [docs/DEPLOY.md](docs/DEPLOY.md#tak-mot-uventet-regning).
- **Deployet** 2026-09-25 til **https://innnorsk.viciapp.workers.dev**: D1 `innnorsk`, R2 `innnorsk-files`, migrasjon 0001–0003.
- Dokumentasjon: [CLAUDE.md](CLAUDE.md), [README.md](README.md), [docs/DEPLOY.md](docs/DEPLOY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Gjenstår
1. **Secrets og brukere** (eieren kjører selv, se [docs/DEPLOY.md](docs/DEPLOY.md)): `XAI_API_KEY`, `SALT_PEPPER`, `make-user` for eier og Svetlana.
2. **Roter xAI-nøkkelen** — den gamle ble limt inn i en chat. Bruk en ny i `wrangler secret put XAI_API_KEY`.
3. **Kostnadsvarsler:** Cloudflare «Usage Based Billing»-varsel og xAI forhåndsbetalte kreditter uten automatisk påfyll.
4. Første ekte test: Admin → Test API-tilkobling, deretter én liten .docx som Svetlana.
5. Valgfritt: `ios/` (push-app, ikke kompilert her) og priser i `XAI_PRICE_*` for kostnadsvisning.

Ikke verifisert mot ekte Cloudflare/xAI (miljøet der dette ble bygget hadde ikke nettilgang dit): feilmeldingsformatet fra Workflows i produksjon og faktisk ytelse.
