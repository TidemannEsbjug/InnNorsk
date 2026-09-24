# Overlevering — status

**Beslutning:** Alt på Cloudflare **Workers Paid ($5/mnd)**. Svetlana laster opp på nettsiden, oversettelsen skjer automatisk i Cloudflare (Workflow → xAI API), resultatet ligger under «Mine filer». Eieren ser logger og alle filer i admin.

## Ferdig og testet (`npm test`: 69/69, bare mot falsk xAI/APNs)
- Kjerne (`src/`): robust Grok-klient, formatbevarende uttrekk/innsetting, PDF med ekte fontnavn.
- Worker (`worker/`): innlogging, sendinger, Workflow-oversettelse med R2-cache per batch, estimat ved opplasting og live ETA, `grok_calls` med tokens/kostnad, admin, cron.
- Web (`web/`): varmt design, «Oversett til norsk», «Mine filer», admin med xAI-kort og Grok-kall per fil.
- Dokumentasjon: [CLAUDE.md](CLAUDE.md), [README.md](README.md), [docs/DEPLOY.md](docs/DEPLOY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Gjenstår
1. **Deploy** — følg [docs/DEPLOY.md](docs/DEPLOY.md) (Workers Paid, `wrangler login`, D1/R2, `npm run deploy`, secrets, `make-user`).
2. **Roter xAI-nøkkelen** — den gamle ble limt inn i en chat. Bruk en ny i `wrangler secret put XAI_API_KEY`.
3. Første ekte test: Admin → Test API-tilkobling, deretter én liten .docx som Svetlana.
4. Valgfritt: `ios/` (push-app, ikke kompilert her) og priser i `XAI_PRICE_*` for kostnadsvisning.

Ikke verifisert mot ekte Cloudflare/xAI (miljøet der dette ble bygget hadde ikke nettilgang dit): feilmeldingsformatet fra Workflows i produksjon og faktisk ytelse.
