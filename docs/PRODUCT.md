# Produkt: InnNorsk

## Problem

Svetlana har dokumenter (Word, PDF, PowerPoint, Excel, tekst) som må bli norske uten at oppsettet går i stykker.

## Løsning

En varm, enkel nettside på Cloudflare:

1. Svetlana logger inn.
2. Legger til filer eller en mappe, ser «Beregnet tid», velger bokmål eller nynorsk og trykker **Oversett til norsk**.
3. Kan lukke siden; oversettelsen fortsetter i skyen.
4. Laster ned under **Mine filer**. Filene ligger der til hun sletter dem.

Eieren ser alt i admin: logger, økter, alle filer, feil, Grok-kall, tokens og kostnad, estimat vs faktisk tid. Valgfritt push-varsel på iPhone.

Windows-appen (Electron) finnes fortsatt for lokal bruk.

## Krav som ikke kan ofres

- Direkte oversettelse, ikke omskriving.
- Ser lik ut: skrift, størrelse, avsnitt, linjeskift, fet/kursiv, tabeller.
- Originalene urørt.
- Norsk UI (bokmål), valg for nynorsk-oversettelse.
- Ingen nøkler eller passord i koden (repoet er offentlig).
