# InnNorsk Varsel – iPhone-appen

En liten iPhone-app for deg som oversetter. Den gir deg **push-varsel** når Svetlana sender filer på nettsiden, og viser:

- **Mac mini**: om Mac-en er på (har meldt seg de siste 3 minuttene), når den sist ble sett, hva den holder på med, og om Grok CLI er klar.
- **Sendinger**: hvem som sendte, når, meldingen hennes og hver fil med status, fremdrift i prosent og omtrent hvor lenge det er igjen («ca. 3 min igjen – ferdig rundt kl. 14:32»). Feil vises med melding.
- **Send testvarsel** og **Logg ut**.

Appen oppdaterer seg når du åpner den, når et varsel kommer, og av seg selv (hvert 10. sekund mens noe oversettes, ellers hvert minutt). Dra ned i listen for å oppdatere med en gang.

Slik henger det sammen: Svetlana sender filer → Workeren på Cloudflare lagrer dem og sender push via Apple (APNs) → iPhonen din varsler → Mac-en henter filene, oversetter og sender resultatet tilbake.

## Dette trenger du

- En Mac med **Xcode 15 eller nyere**.
- **Apple Developer Program** (betalt medlemskap) – kreves for push.
- En **iPhone med iOS 17** eller nyere, og en kabel første gang.
- InnNorsk-nettsiden kjører på Cloudflare (se `README.md` i roten av repoet), og du har en **admin-bruker** laget med `node scripts/make-user.js <brukernavn> --role admin`.

## 1. Lag Xcode-prosjektet

### A: Med XcodeGen (anbefalt)

```bash
brew install xcodegen
cd ios
xcodegen generate
open InnNorskVarsel.xcodeproj
```

Prosjektfilen lages fra `project.yml` og sjekkes ikke inn (se `.gitignore`). Kjør `xcodegen generate` igjen når du har hentet nye endringer.

### B: Manuelt i Xcode

1. **File → New → Project… → iOS → App**. Product Name `InnNorskVarsel`, Interface **SwiftUI**, Language **Swift**, ingen tester. Lagre prosjektet utenfor repoet, f.eks. i `~/Utvikling`.
2. Slett malens `ContentView.swift`, `InnNorskVarselApp.swift` og `Assets.xcassets` (Move to Trash).
3. Dra alle `.swift`-filene og `Assets.xcassets` fra `ios/InnNorskVarsel/` inn i prosjektet, med target **InnNorskVarsel** avkrysset.
4. Target → **General** → Minimum Deployments: **iOS 17.0**.
5. Target → **Build Settings**: Swift Language Version **Swift 5**. Bruker du Xcode 26: sett også **Default Actor Isolation** til **nonisolated** (koden er skrevet for vanlig Swift 5-modus).
6. Target → **Signing & Capabilities** → **+ Capability** → **Push Notifications**. Xcode lager da entitlements-filen selv.

## 2. Team og bundle-ID

1. Velg prosjektet i Xcode → target **InnNorskVarsel** → **Signing & Capabilities**.
2. Slå på **Automatically manage signing** og velg ditt **Team**.
3. **Bundle Identifier** skal være `no.innnorsk.varsel`. Sier Xcode at den er opptatt, velg en egen, f.eks. `no.dittnavn.innnorsk` – og bruk nøyaktig samme verdi i `APNS_BUNDLE_ID` (steg 5). Med XcodeGen endrer du `PRODUCT_BUNDLE_IDENTIFIER` i `project.yml`, så den overlever neste `xcodegen generate`.

Med XcodeGen må Team velges på nytt etter hver `xcodegen generate`. Vil du slippe det, legg `DEVELOPMENT_TEAM: ABCDE12345` (ditt Team ID) under `settings.base` i `project.yml` lokalt.

## 3. Push Notifications i appen

Under **Signing & Capabilities** skal **Push Notifications** stå oppført. Med XcodeGen kommer den fra `InnNorskVarsel/InnNorskVarsel.entitlements` (`aps-environment = development`). Xcode registrerer App ID-en med push automatisk når du bygger.

Du trenger ikke «Background Modes» – appen bruker vanlige varsler.

## 4. APNs-nøkkel (.p8) i Apple Developer

1. Gå til [developer.apple.com/account](https://developer.apple.com/account) → **Certificates, IDs & Profiles** → **Keys** → **+**.
2. Gi nøkkelen et navn, f.eks. «InnNorsk push», og kryss av for **Apple Push Notifications service (APNs)**. Får du spørsmål om miljø, velg **Sandbox & Production**; om begrensning, velg **Team Scoped (All Topics)**.
3. **Continue → Register → Download**. Du får filen `AuthKey_XXXXXXXXXX.p8`. **Den kan bare lastes ned én gang** – ta vare på den utenfor repoet.
4. Noter **Key ID** (10 tegn, vises på nøkkelen) og **Team ID** (under **Membership details**, eller øverst til høyre i portalen).

## 5. Hemmeligheter og variabler i Cloudflare

Fra roten av repoet:

```bash
npx wrangler secret put APNS_KEY_P8 < ~/Downloads/AuthKey_XXXXXXXXXX.p8
npx wrangler secret put APNS_KEY_ID      # lim inn Key ID
npx wrangler secret put APNS_TEAM_ID     # lim inn Team ID
```

`APNS_KEY_P8` skal være hele innholdet i filen, med linjene `-----BEGIN PRIVATE KEY-----` og `-----END PRIVATE KEY-----`.

I `wrangler.jsonc` under `"vars"`:

```jsonc
"APNS_BUNDLE_ID": "no.innnorsk.varsel",
"APNS_ENV": "sandbox"
```

- `APNS_BUNDLE_ID` må være nøyaktig samme bundle-ID som i Xcode.
- `APNS_ENV` er **`sandbox`** så lenge du kjører appen fra Xcode (utviklerbygg), og **`production`** når du går over til TestFlight eller App Store.

Appen forteller dessuten serveren hvilket miljø den selv hører til når den registrerer telefonen (`sandbox` for bygg fra Xcode, `production` for TestFlight/App Store). Du ser det på admin-siden under **Oversikt → enheter**, og i appen under **Varsler**.

Publiser etterpå med `npx wrangler deploy`. Legg aldri `.p8`-filen eller nøklene i repoet eller i `wrangler.jsonc`.

## 6. Kjør appen på iPhonen

1. Koble iPhonen til Mac-en med kabel og trykk **Stol på** på telefonen.
2. Slå på utviklermodus på iPhonen: **Innstillinger → Personvern og sikkerhet → Utviklermodus** (telefonen starter på nytt).
3. Velg iPhonen som mål øverst i Xcode og trykk **▶** (⌘R).
4. Når appen spør om å sende varslinger: trykk **Tillat**.

## 7. Logg inn

- **Serveradresse**: adressen til nettsiden, f.eks. `https://oversetter.dittnavn.workers.dev` (eller ditt eget domene). `https://` legges til hvis du utelater det.
- **Brukernavn** og **passord**: admin-brukeren din.

Passordet forlater aldri telefonen: appen regner ut det samme passordbeviset som nettsiden (PBKDF2-SHA256) og sender bare det. Innloggingen huskes i 30 dager. Appen er bare for admin – Svetlana bruker nettsiden.

## 8. Send testvarsel

1. Under **Varsler** skal det stå «Varsler er på for denne telefonen – utviklerbygg (sandbox).»
2. Trykk **Send testvarsel**. Etter noen sekunder kommer «Testvarsel fra InnNorsk» – også når appen er åpen.
3. Vil du teste hele veien: lås telefonen og send en fil fra nettsiden som Svetlana. Da kommer «Nye filer fra Svetlana».

**Logg ut** fjerner telefonen fra varsellisten og logger deg ut.

## TestFlight og App Store

**Product → Archive → Distribute App**. Xcode bytter selv til produksjonsmiljøet for push når appen eksporteres. Sett `APNS_ENV` til `production`, publiser med `npx wrangler deploy`, og installer appen fra TestFlight. Når den åpnes, registrerer den telefonen med det nye produksjonstokenet.

## Feilsøking

Feilene fra Apple står i loggen på admin-siden: **Logg**, filtrer på type `push` (`push.sent`, `push.failed` med årsak). «Send testvarsel» viser dem også i appen.

- **«Ingen telefoner er registrert ennå»** – tillat varsler (**Innstillinger → Varslinger → InnNorsk**), åpne appen på nytt og vent til **Varsler** viser «Varsler er på». Appen sender telefonens ID til serveren etter innlogging og hver gang Apple gir en ny.
- **«Apple ga ingen varsel-ID»** – Push Notifications mangler under Signing & Capabilities, feil Team, eller appen kjører i simulatoren. Bruk en ekte iPhone.
- **Feil miljø / `BadDeviceToken`** – et token fra et Xcode-bygg er et *sandbox*-token og virker bare mot Apples sandbox-server, og omvendt for TestFlight/App Store. Sjekk `APNS_ENV` og miljøet enheten står med på admin-siden. Serveren slår av enheten ved `BadDeviceToken`; logg ut og inn igjen i appen, så registreres den på nytt.
- **Token ikke registrert (`Unregistered`, HTTP 410)** – appen er slettet og installert på nytt, eller varsler er nullstilt, så det gamle tokenet er dødt. Serveren slår det av automatisk; åpne appen og logg inn, så registreres det nye.
- **`InvalidProviderToken` eller `403`** – feil `APNS_KEY_ID` eller `APNS_TEAM_ID`, `APNS_KEY_P8` mangler BEGIN/END-linjene, eller nøkkelen er trukket tilbake. Legg inn hemmelighetene på nytt.
- **`DeviceTokenNotForTopic` eller `TopicDisallowed`** – `APNS_BUNDLE_ID` er ikke lik bundle-ID-en i Xcode.
- **«Push er ikke satt opp på serveren ennå.»** – en eller flere av `APNS_KEY_P8`, `APNS_KEY_ID` og `APNS_TEAM_ID` mangler.
- **Innlogging**: «Brukernavnet eller passordet stemmer ikke.» – sjekk begge; etter 5 feil må du vente 15 minutter. «Denne appen er for oversetteren» – brukeren er ikke admin. «Fant ikke serveren» eller «Kunne ikke lage en sikker forbindelse» – sjekk adressen; den må bruke `https://`.
- **Mac mini svarer ikke** – Mac-en har ikke meldt seg på over 3 minutter. Kjør `node mac/innnorsk-mottak.js doctor` på Mac-en (se `mac/README.md`).
