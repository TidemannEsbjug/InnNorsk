# InnNorsk mottak – på Mac-en

Mottaket er et lite program uten vindu som går i bakgrunnen på Mac-en (f.eks. Mac mini). Det:

1. spør nettstedet hvert 20. sekund om Svetlana har sendt noe,
2. henter filen, legger en kopi i `~/InnNorsk/<dato> <navn>/`,
3. oversetter den med **Grok Build CLI** (samme formatkjerne som ellers, så avsnitt, skrift og fet/kursiv beholdes),
4. melder fremdrift og estimat underveis, så Svetlana ser «Oversettes nå – 45 % – ca. 3 min igjen»,
5. sender den norske filen tilbake til nettstedet og legger en kopi `… (norsk).docx` ved siden av originalen.

Er Mac-en av eller sover, venter filene trygt på nettstedet og tas når den er tilbake.

## Dette trenger du

- **Node.js 22 eller nyere** via Homebrew:
  ```bash
  brew install node
  ```
- **Grok Build CLI**, installert og logget inn én gang:
  ```bash
  grok login
  ```
  Sjekk at `which grok` viser en sti.
- **Agent-tokenet** (`AGENT_TOKEN`) som nettstedet er satt opp med. Har du ikke laget det ennå:
  ```bash
  openssl rand -hex 32                 # lag et token og kopier det
  npx wrangler secret put AGENT_TOKEN  # lim det inn her (i prosjektmappen)
  ```

## Installer

```bash
git clone https://github.com/TidemannEsbjug/InnNorsk.git ~/InnNorsk-kode
cd ~/InnNorsk-kode
npm install --omit=dev
node mac/innnorsk-mottak.js setup
```

`--omit=dev` sparer deg for å laste ned Electron og Wrangler, som mottaket ikke trenger.

`setup` spør om:

| Spørsmål | Svar |
|---|---|
| Adressen til nettstedet | f.eks. `https://innnorsk.dittnavn.workers.dev` |
| Agent-token | `AGENT_TOKEN` fra over (vises ikke mens du skriver) |
| Mappe for kopier | Enter for `~/InnNorsk` |

Tokenet lagres i nøkkelringen (Keychain). Oppsettet havner i `~/.innnorsk/config.json`, og mottaket
legges inn i launchd (`~/Library/LaunchAgents/no.innnorsk.mottak.plist`), så det starter av seg selv
når du logger inn, og startes på nytt hvis det skulle stoppe.

Spør macOS om «security vil bruke nøkkelringen», velg **Tillat alltid**.

## Hold Mac-en våken

- **Systeminnstillinger → Energi**: slå på at Mac-en ikke skal gå i dvale av seg selv når skjermen er av
  (på engelsk: *Prevent automatic sleeping when the display is off*), og gjerne at den starter igjen
  etter strømbrudd (*Start up automatically after a power failure*).
- Mottaket kjører når du er logget inn. Starter Mac-en på nytt av seg selv, må noen logge inn – eller slå på
  automatisk innlogging under **Systeminnstillinger → Brukere og grupper** (*Automatically log in as*;
  ikke mulig med FileVault på).

## Sjekk at alt virker

```bash
node mac/innnorsk-mottak.js doctor
```

Du får en sjekkliste med ✓ og ✗, og hva du skal gjøre med hver ✗:

```
✓ Oppsett: /Users/deg/.innnorsk/config.json
✓ Agent-tokenet er lagret i nøkkelringen (Keychain)
✓ Nettstedet svarer: https://innnorsk.dittnavn.workers.dev
✓ Tokenet er godtatt – ingen filer venter
    Kommando: /opt/homebrew/bin/grok --no-auto-update --output-format json … --prompt-file /tmp/…/prompt.txt
✓ Grok CLI oversatte en prøvetekst på 3,1 s («God morgen») – kostnad $0.0007
✓ Kan skrive til /Users/deg/InnNorsk
✓ Mottaket kjører i bakgrunnen (launchd, pid 812)
```

`doctor` oversetter én liten tekst med Grok for å vite at innloggingen virker (koster en brøkdel av en cent),
og viser nøyaktig hvilken kommando den kjørte.

## Logger

Alt mottaket gjør, skrives som én JSON-linje per hendelse til

```
~/Library/Logs/InnNorsk/mottak.log
```

```bash
tail -f ~/Library/Logs/InnNorsk/mottak.log
# penere, med jq (brew install jq):
tail -f ~/Library/Logs/InnNorsk/mottak.log | jq -r '"\(.ts)  \(.level)  \(.message)"'
```

Advarsler, feil og de viktigste hendelsene (mottaket startet, fil hentet, fil oversatt) sendes også til
nettstedet og vises under **Admin → Logg**, sammen med kostnaden per fil.

## Oversette for hånd (uten nettstedet)

```bash
node mac/innnorsk-mottak.js translate ~/Desktop/Rapport.pdf
node mac/innnorsk-mottak.js translate ~/Desktop/Mappe --nynorsk --out ~/Desktop/Ferdig
```

Resultatet heter `Rapport (norsk).docx` og legges ved siden av originalen, eller i `--out`.
Mapper gås gjennom, og låsefiler (`~$…`) og tidligere `(norsk)`-filer hoppes over.

`once` behandler det som venter på nettstedet nå, og avslutter (nyttig for å prøve uten launchd):

```bash
node mac/innnorsk-mottak.js once
```

## Innstillinger

`~/.innnorsk/config.json` (lages av `setup`):

| Nøkkel | Standard | Betyr |
|---|---|---|
| `siteUrl` | – | Adressen til nettstedet |
| `outputDir` | `~/InnNorsk` | Hvor kopiene legges |
| `concurrency` | `2` | Hvor mange Grok-kall som går samtidig i én fil |
| `pollSeconds` | `20` | Hvor ofte nettstedet spørres (5 s rett etter arbeid, opptil 60 s ved nettverksfeil) |
| `leaseSeconds` | `900` | Hvor lenge en fil er «reservert» uten livstegn før nettstedet gir den ut igjen |
| `pauseSeconds` | `300` | Pause før nytt forsøk når Grok CLI ikke virker |
| `tokenStore` | `keychain` | `keychain` eller `file` (`~/.innnorsk/agent.json`, bare lesbar for deg) |
| `grok.command` | `grok` | Full sti til Grok CLI (settes av `setup`) |
| `grok.args` | se under | Flaggene som sendes til Grok |
| `grok.model` | `null` | Egen modell (`-m <modell>`), ellers CLI-ens standard |
| `grok.effort` | `"low"` | `--effort low`; `null` for å sløyfe flagget |
| `grok.timeoutSeconds` | `240` | Maks tid per Grok-kall |

Standardflaggene er
`--no-auto-update --output-format json --max-turns 1 --disable-web-search --no-subagents --permission-mode defaultMode`.
Prompten sendes alltid med `--prompt-file`, og Grok kjører i en tom midlertidig mappe.
Kjenner ikke din Grok-versjon alle flaggene, sier `doctor` fra og viser hvilken variant som virker.

Etter endringer: start mottaket på nytt med

```bash
launchctl kickstart -k gui/$(id -u)/no.innnorsk.mottak
```

## Oppdatere

```bash
cd ~/InnNorsk-kode
git pull
npm install --omit=dev
launchctl kickstart -k gui/$(id -u)/no.innnorsk.mottak
```

## Avinstallere

```bash
node mac/innnorsk-mottak.js setup --uninstall
```

Stopper mottaket, fjerner det fra oppstart og sletter tokenet. Oppsettet i `~/.innnorsk` og
dokumentkopiene dine beholdes.

## Feilsøking

| Du ser | Gjør dette |
|---|---|
| «Grok CLI er ikke logget inn» | Kjør `grok login` i Terminal. Mottaket prøver igjen av seg selv hvert 5. minutt. Filen ligger trygt i køen så lenge. |
| «Fant ikke Grok CLI» | Finn stien med `which grok`, og kjør `setup` på nytt (eller sett `grok.command` til full sti). |
| `doctor`: «virker bare uten de ekstra flaggene» | Sett `"args": []` og `"effort": null` under `grok` i config.json, og legg tilbake flaggene `grok --help` viser. |
| «Nettstedet avviste agent-tokenet (401)» | Tokenet på Mac-en og `AGENT_TOKEN` i Cloudflare er ulike. Kjør `setup` på nytt med riktig token. |
| «Får ikke kontakt med nettstedet» | Sjekk nettet. Mottaket prøver igjen (opptil hvert minutt) og beholder filen det holder på med. |
| En fil er «feilet» | Admin-siden viser feilmeldingen og detaljer. Er filen skadet eller en skannet PDF uten tekst, kan den ikke oversettes automatisk. Du kan oversette den selv og laste opp med «Last opp oversettelse», eller trykke «Sett i kø igjen». |
| Grok feiler på samme fil tre ganger | Filen markeres som feilet (så den ikke går i ring). Se loggen, og sett den i kø igjen når Grok virker. |
| Kjører mottaket? | `launchctl print gui/$(id -u)/no.innnorsk.mottak \| grep -E "state\|pid"` eller `doctor`. |

Mottaket stoppes pent (`launchctl bootout …`, avslutning av Mac-en): filen det holder på med, legges
tilbake i køen, og Grok-prosessen stoppes.
