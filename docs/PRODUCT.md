# Produkt: InnNorsk

## Problem

Noen har en bunke dokumenter (Word, PDF, PowerPoint, Excel, tekst) og trenger dem på norsk, uten at layouten kollapser.

## Løsning i dag

### InnNorsk Sky (anbefalt)

En nettside med innlogging. Eieren setter den opp på Render ([DEPLOY.md](DEPLOY.md)) og lager en konto til brukeren.

Brukeren:

1. Logger inn (velger eget passord første gang).
2. Drar filer, eller en hel mappe, inn i **Inn-kurven**, eller bruker «Velg filer» / «Velg mappe».
3. Ser for hver fil hvor mye tekst den har og hvor lang tid den vil ta, og et samlet estimat.
4. Velger bokmål eller nynorsk og trykker det røde stemplet **Oversett til norsk**.
5. Følger fremdriften med «ca. X min igjen · ferdig ca. kl. HH:MM». Estimatet justerer seg underveis.
6. Laster ned fra **Ut-kurven**: én og én fil, eller alt som zip med samme mappestruktur.

Filene slettes fra serveren etter 14 dager. Tidligere jobber vises i historikken.

Eieren (admin) ser innlogginger, økter, jobber, feil per fil, hvert kall til Grok (tid, tokens, nye forsøk) og JavaScript-feil fra brukerens nettleser. Når noe ikke virker, finner eieren årsaken der ([DEPLOY.md](DEPLOY.md#når-hun-sier-det-virker-ikke)).

### Windows-appen (lokal)

Eldre variant som kjører på egen PC:

1. Last ned zip fra GitHub Pages / Releases.
2. Kjør `InnNorsk.exe`.
3. Lim inn xAI-nøkkel under Innstillinger.
4. Velg inn-mappe og trykk det røde stemplet **Oversett til norsk**.
5. Hent filene i ut-kurven.

Begge bruker samme oversettelseskjerne, så forbedringer i formatene gjelder begge.

## Krav som ikke kan ofres

- Direkte oversettelse, ikke omskriving.
- Ser lik ut: skrift, størrelse, avsnitt, linjeskift, fet/kursiv.
- Originalene urørt.
- Norsk UI (bokmål). Valg for nynorsk.
- Nøkkelen skal ikke hardkodes. I skyen ligger den bare på serveren, aldri i nettleseren.
- Bare innloggede brukere kommer inn, og hver bruker ser bare sine egne filer.
- Eieren skal kunne se hvorfor noe feilet, uten å spørre en utvikler først.
- Tidsestimatet skal være ærlig: vises før start, oppdateres underveis og sier fra når det er usikkert.

## Kjente begrensninger

- Skannet PDF uten tekstlag kan ikke oversettes (trenger OCR først).
- PDF kommer ut som Word (`.docx`), ikke som PDF.
- Skyen oversetter én jobb om gangen. Neste jobb står i kø og ser forventet ventetid.
- Oversatte filer i skyen slettes etter 14 dager.
