# Produkt: InnNorsk

## Problem

Noen har en bunke dokumenter (Word, PDF, PowerPoint, Excel, tekst) og trenger dem på norsk, uten at layouten kollapser.

## Løsning i dag

Lokal Windows-app. Bruker:

1. Laster ned zip fra GitHub Pages / Releases.
2. Kjører `InnNorsk.exe`.
3. Lim inn xAI-nøkkel under Innstillinger.
4. Velger inn-mappe, trykker det røde stemplet **Oversett til norsk**.
5. Henter filene i ut-kurven.

## Krav som ikke kan ofres

- Direkte oversettelse, ikke omskriving.
- Ser lik ut: skrift, størrelse, avsnitt, linjeskift.
- Originalene urørt.
- Norsk UI (bokmål). Valg for nynorsk.
- Nøkkelen skal ikke hardkodes.

## Neste steg eieren vil ha

Skybasert versjon, utviklet med Claude Cloud mot dette GitHub-repoet. Samme oversetter, annen flate: last opp i nettleser, få norsk fil tilbake.
