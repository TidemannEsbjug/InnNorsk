# Brief til Grok Bot — InnNorsk

Gi denne filen til Grok Bot når den skal jobbe med InnNorsk.

## Hva den andre Grok-en (Grok Build / desktop-agenten) har gjort

Den bygde **InnNorsk**: en dokumentoversetter til norsk med Grok-API.

Først en **Windows Electron-app** (mappe inn → oversett → norske filer ut). Så en **web-portal** slik at Svetlana kan logge inn i nettleseren, laste opp filer og laste ned oversatt resultat.

Repo: https://github.com/TidemannEsbjug/InnNorsk  
Branch: `main`

Les også `CLAUDE.md`, `docs/ARCHITECTURE.md` og `docs/PRODUCT.md`.

## Hva du (Grok Bot) er

Du er backend-hjelper i skyen. Du skal **ikke** kreve Cloudflare Workers Paid ($5/mnd).

Web-portalen bruker **Cloudflare Pages + Functions på gratisplan** som tynn proxy:

- Nettleseren parser DOCX/PDF/PPTX/XLSX (samme kode som desktop: `src/formats/*`).
- Hver Grok-bit går som `POST /api/grok` til Pages Function.
- Function sjekker innloggingscookie og kaller `https://api.x.ai/v1/responses` med `XAI_API_KEY` fra **server-secret**.
- Passord og API-nøkkel skal **aldri** ligge i HTML, JS-bundle, GitHub eller denne filen.

Hvis du skal erstatte Cloudflare-funksjonen: du må ta imot autentiserte kall, holde xAI-nøkkelen skjult, og returnere Grok-tekst. Ikke ta imot hele PDF-en på et 10 ms CPU-budsjett — la klienten parse, og oversett bare tekstbiter.

## Produktet Svetlana skal se

1. Login (brukernavn/passord sjekkes på serveren).
2. Last opp filer.
3. Tydelig status mens Grok jobber («avsnitt 12 av 40, fil 1 av 3, ikke lukk fanen»).
4. Last ned oversatte filer.
5. Layout skal ligne originalen (skrift, størrelse, linjeskift).

## Tekniske ankre

- Modell: `grok-4.6`
- API: `POST https://api.x.ai/v1/responses` (nøkkel kun på server)
- Oversettelse: `src/grok.js` — JSON-array av strenger, behold linjeskift
- Web UI: `web/`
- Auth + proxy: `functions/api/*`
- Secrets: Cloudflare `AUTH_USERNAME`, `AUTH_PASSWORD`, `XAI_API_KEY`, `SESSION_SECRET`

## Ikke gjør

- Ikke commit passord eller `xai-`-nøkler.
- Ikke vis hemmeligheter i frontend.
- Ikke krev Workers Paid for denne bruken.
- Ikke ødelegg format-pipeline som bevarer skrift og avsnitt.
