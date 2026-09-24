# Drift: InnNorsk Sky på Render

Denne guiden er for eieren. Den tar deg fra GitHub-repoet til en fungerende nettadresse der brukeren logger inn og oversetter dokumenter. Du trenger ikke å kunne programmere.

Oppsettet ligger ferdig i repoet:

| Fil | Hva den gjør |
|---|---|
| [`render.yaml`](../render.yaml) | Forteller Render hva som skal lages: én webtjeneste (Docker), region Frankfurt, plan Starter, 1 GB disk på `/data`. |
| [`Dockerfile`](../Dockerfile) | Bygger serveren (Node 22). |
| [`.env.example`](../.env.example) | Liste over alle innstillinger med forklaring. |

Alt som skal bevares (brukere, innlogginger, jobber, logg, filer) lagres på disken `/data`: databasen `innnorsk.db` og mappen `files/`.

## Før du starter

- **GitHub:** Koden må ligge på `main` i `TidemannEsbjug/InnNorsk`. Render bygger fra `main` og bygger på nytt ved hver endring der.
- **Render-konto:** Opprett på [render.com](https://render.com) (logg gjerne inn med GitHub). Du må legge inn betalingskort; gratisplanen kan ikke ha disk.
- **xAI-nøkkel:** Lag en nøkkel i [console.x.ai](https://console.x.ai) med chat/model-tilgang (`api-key:endpoint:*` og `api-key:model:*`). En ren voice-nøkkel gir feil 403.
- **Admin-bruker:** Bestem et brukernavn til deg selv (f.eks. `admin`) og et langt passord (minst 10 tegn). Lagre det i passordbehandleren din.

## Første gangs oppsett (ca. 15 minutter)

1. Gå til [dashboard.render.com](https://dashboard.render.com).
2. Trykk **New** → **Blueprint**.
3. Koble til GitHub og velg repoet **TidemannEsbjug/InnNorsk**. Ser du det ikke i listen, trykk **Configure account** / **Configure GitHub App** og gi Render tilgang til repoet.
4. Render leser `render.yaml` og viser det som skal lages: webtjenesten **innnorsk** og disken **innnorsk-data**. Gi blueprinten et navn, f.eks. `InnNorsk`.
5. Fyll inn de tre hemmelige verdiene Render spør om:
   - `XAI_API_KEY`: xAI-nøkkelen
   - `ADMIN_USERNAME`: brukernavnet ditt
   - `ADMIN_PASSWORD`: passordet ditt
6. Trykk **Deploy Blueprint** (eller **Apply**). Første bygg tar noen minutter. Følg med under tjenesten → **Logs**. Tjenesten er klar når statusen er **Live**.
7. Åpne adressen øverst på tjenestesiden, f.eks. `https://innnorsk.onrender.com` (Render kan legge til et suffiks i navnet). Du får innloggingssiden.
8. Logg inn med admin-brukeren. Trykk **Admin**.
9. Under **Oversikt**: sjekk at det **ikke** står en rød advarsel om manglende API-nøkkel. Vil du være helt sikker, trykk **Test API**. Det koster ett lite Grok-kall.
10. Under **Brukere** → **Opprett bruker**, for den som skal oversette:
    - Brukernavn: f.eks. fornavnet hennes, små bokstaver
    - Visningsnavn: fullt navn
    - Rolle: vanlig bruker (ikke admin)
    - La passordfeltet stå tomt. Da lager systemet et passord på 14 tegn.
11. Passordet vises **bare én gang**. Trykk kopier og send det til henne, sammen med adressen og brukernavnet. Du kan bruke denne meldingen:

    > Hei! Her er oversetteren: <https://innnorsk.onrender.com>\
    > Brukernavn: kari\
    > Midlertidig passord: (lim inn)
    >
    > Første gang du logger inn, velger du et nytt passord. Dra filene (eller en hel mappe) inn i Inn-kurven, velg bokmål eller nynorsk og trykk «Oversett til norsk». Du ser hvor lang tid det vil ta. Ferdige filer lastes ned fra Ut-kurven, én og én eller alle som zip. Filene slettes automatisk etter 14 dager.

    Send gjerne passordet i en annen kanal (f.eks. SMS) enn adressen og brukernavnet.

`ADMIN_USERNAME` og `ADMIN_PASSWORD` brukes bare ved første oppstart, når databasen er tom. Å endre dem senere gjør ingenting. Bytt passord inne i appen.

## Kostnader

- **Render:** Starter-instans (fast månedspris) + disk (betales per GB per måned, her 1 GB). Priser endres; sjekk [render.com/pricing](https://render.com/pricing). Til sammenligning kostet Starter rundt 7 USD/mnd og disk rundt 0,25 USD per GB/mnd i 2025.
- **xAI:** Betales separat per token i console.x.ai. Forbruket siste døgn står under Admin → **Oversikt**, og hvert kall står under Admin → **Jobber** → en jobb.

Gratisplanen passer ikke. Den har ikke disk, så brukere og filer ville forsvunnet ved hver omstart.

## Oppdatere appen

Når ny kode kommer på `main`, bygger og starter Render tjenesten på nytt av seg selv. Tjenester med disk har ikke «zero-downtime»: siden er borte i noen sekunder til et par minutter. En jobb som kjører akkurat da, blir markert som feilet med «Serveren ble startet på nytt under jobben.», og brukeren må starte den på nytt. Sjekk derfor Admin → **Jobber** før du slår sammen endringer, og vent til ingen jobb kjører.

Skru aldri opp antall instanser. Appen bruker én SQLite-database og én jobbkø i samme prosess, og Render tillater uansett bare én instans med disk.

## Eget domene (valgfritt)

1. Render → tjenesten → **Settings** → **Custom Domains** → **Add Custom Domain**, f.eks. `oversett.dittdomene.no`.
2. Render viser en DNS-post (vanligvis CNAME). Legg den inn hos domeneleverandøren.
3. Render lager HTTPS-sertifikat automatisk når DNS er på plass. `onrender.com`-adressen virker fortsatt.

## Sikkerhetskopi

Render tar automatisk øyeblikksbilder (snapshots) av disken, minst én gang i døgnet. Sjekk hvor lenge de beholdes i Render-dokumentasjonen for disker. Du gjenoppretter under tjenesten → **Disks**.

En gjenoppretting setter **hele** disken tilbake til det tidspunktet: brukere, passord, logg, jobber og filer. Oversatte filer slettes uansett etter 14 dager, så det viktigste å ta vare på er databasen (brukere og logg).

## Bytte xAI-nøkkel

Bytt nøkkel hvis den kan ha lekket, eller hvis loggen viser 401/403 fra xAI.

1. Lag en ny nøkkel i console.x.ai (chat/model-tilgang, ikke voice).
2. Vent til ingen jobb kjører (Admin → **Jobber**).
3. Render → tjenesten → **Environment** → rediger `XAI_API_KEY` → lim inn den nye → **Save Changes**. Render starter tjenesten på nytt.
4. Når tjenesten er **Live**: Admin → **Oversikt** → **Test API**.
5. Slett den gamle nøkkelen i console.x.ai.

Nøkkelen finnes bare i Render sine miljøvariabler. Den sendes aldri til nettleseren og skrives aldri i loggen.

## Logger: hvor ser jeg hva som skjedde?

| Hvor | Hva du ser |
|---|---|
| Admin → **Logg** | Alle hendelser: innlogginger og mislykkede forsøk, opplastinger, jobber, feil fra Grok, JavaScript-feil i nettleseren hennes, nedlastinger. Filtrer på nivå, type, bruker og tekst. Radene er fargekodet etter nivå, og detaljene (data) kan foldes ut. |
| Admin → **Jobber** | Alle jobber. Trykk på en jobb for filer, feilmeldinger (med teknisk stack), tidslinje, hvert Grok-kall (varighet, tokens, status) og estimert mot faktisk tid. |
| Admin → **Økter** | Hvem som er innlogget, fra hvilken IP og enhet, og når de sist var aktive. Du kan logge ut en økt. |
| Render → tjenesten → **Logs** | Serverens rå utskrift: én JSON-linje per hendelse (`ts`, `level`, `type`, `msg` …). Her ser du også feil fra oppstart og krasj, før appen kan skrive til databasen. Søk f.eks. på `job.failed` eller `"level":"error"`. |

Hendelser i loggen beholdes i 90 dager (`EVENT_RETENTION_DAYS`). Jobboversikten beholdes. Filene slettes etter 14 dager (`RETENTION_DAYS`).

## Når hun sier «det virker ikke»

Gå gjennom denne listen:

1. **Spør kort:** Omtrent når? Hvilken fil? Hva sto det på skjermen (gjerne skjermbilde)?
2. **Admin → Oversikt:** Rød advarsel om API-nøkkel? Mange feilede filer siste døgn?
3. **Admin → Jobber:** Finn jobben hennes (bruker og tidspunkt) og åpne den.
   - Se status på jobben og hver fil. Feilmeldingen står på fila.
   - Se tidslinjen (`file.failed`, `grok.retry`, `grok.error`, `job.failed`).
   - Se Grok-kallene. Statuskoden sier mye:

     | Status | Betyr | Gjør |
     |---|---|---|
     | 401 | xAI avviste nøkkelen | Bytt nøkkel (over). |
     | 403 | Nøkkelen mangler chat/model-tilgang (f.eks. voice-nøkkel) | Lag ny nøkkel med riktig tilgang. |
     | 429 | For mange forespørsler eller kvote/kreditt brukt opp | Sjekk kreditt i console.x.ai. Prøv igjen senere. |
     | 5xx / tidsavbrudd | Problemer hos xAI | Appen prøver selv flere ganger. Be henne prøve igjen senere. |
4. **Finner du ingen jobb:** Admin → **Logg**, filtrer på brukeren hennes.
   - `auth.login_failed` / `auth.locked`: feil passord. Etter 5 feil på 15 minutter stenges innloggingen i 15 minutter.
   - `file.rejected`: fila ble avvist, f.eks. fordi filtypen ikke støttes. Filer over 50 MB avvises også.
   - `client.error`: noe krasjet i nettleseren hennes. Meldingen sier hva.
5. **Kommer hun ikke inn:** Admin → **Brukere** → sjekk at kontoen ikke er deaktivert → nullstill passordet hennes og send henne det nye. Hun logges da ut overalt.
6. **Kjente meldinger:**
   - «Fant ingen tekst i PDF-en (kan være skannet uten OCR).»: PDF-en er et bilde. Den må kjøres gjennom OCR (tekstgjenkjenning) først.
   - «Serveren ble startet på nytt under jobben.»: Det kom en oppdatering eller omstart. Start jobben på nytt.
   - «Filene er slettet etter 14 dager.»: Last opp og oversett på nytt.
7. **Ser resultatet feil ut** (layout eller tekst): noter jobb-ID og filnavn fra Admin → Jobber og gi det til utvikleren (eller Claude) sammen med originalen. Feilmelding og stack i jobbdetaljene er det utvikleren trenger.
8. **Er hele siden nede:** Render → tjenesten → **Events** og **Logs**. Adressen `/healthz` skal svare `{"ok":true}`.

Har du mistet admin-passordet, åpne Render → tjenesten → **Shell** og kjør `node --disable-warning=ExperimentalWarning server/cli.js` for å se kommandoene (`create-user`, `reset-password`, `list-users`, `disable-user`).

## Andre verter

Appen er et vanlig Docker-image. Den kan kjøre hos enhver vert som har:

- Docker-bygg fra repoet (bruker `Dockerfile`)
- **et varig volum montert på `/data`** (ellers forsvinner alt ved omstart)
- HTTPS foran appen (innloggingscookien krever det i produksjon)
- **nøyaktig én instans**, som ikke stoppes automatisk mens en jobb kjører

Sett minst `XAI_API_KEY`, `ADMIN_USERNAME` og `ADMIN_PASSWORD`. Appen lytter på `PORT` (8080). `NODE_ENV=production` og `DATA_DIR=/data` er satt i imaget. Alle innstillinger står i [`.env.example`](../.env.example).

- **Fly.io:** `fly launch` finner Dockerfile. Lag et volum (`fly volumes create innnorsk_data --size 1`), monter det på `/data` under `[mounts]` i `fly.toml`, bruk `internal_port = 8080`, og sett nøklene med `fly secrets set`. Slå av automatisk stopp av maskinen, ellers kan en jobb bli avbrutt.
- **Railway:** Nytt prosjekt fra GitHub-repoet (Dockerfile oppdages). Legg til et volum på `/data` og sett variablene.

Imaget kjører som brukeren `node`, ikke root. Viser loggen `EACCES` eller `permission denied` på `/data`, er volumet montert slik at bare root kan skrive. På Railway løses det med variabelen `RAILWAY_RUN_UID=0`. Andre steder: gi uid 1000 skrivetilgang til volumet.

Lokalt med Docker (bak HTTPS, eller på `localhost`):

```bash
docker build -t innnorsk .
docker run -d -p 8080:8080 -v innnorsk-data:/data \
  -e XAI_API_KEY=... -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD=... innnorsk
```
