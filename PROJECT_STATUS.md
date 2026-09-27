# Projectstatus — AI Crypto Trading Assistant

**Bijgewerkt:** 27 september 2026  
**Projectmap:** `C:\Users\andyb\Documents\Codex\2026-09-26\we-gaan-samen-een-ai-crypto`  
**Doelplatform:** Windows 10/11, Python 3 en Node.js voor controles

## Huidige fase

**Fase 9 — Testnet-orderstroom: gedeeltelijk gebouwd, niet gereed voor gebruik.**

De huidige wijziging voegde een losse Binance Spot Testnet-provider, lokale serverroutes, een voorbereidings- en bevestigingsscherm en gesimuleerde tests toe. Er is geen volledige Testnet-portefeuilleadministratie. Gebruik de Testnet-orderfunctie niet voordat de openstaande punten onder **Bekende problemen** zijn opgelost.

## Faseoverzicht

Dit overzicht combineert de fase-afrondingen die de gebruiker eerder heeft gemeld met wat de huidige broncode laat zien.

| Fase | Status | Toelichting |
|---|---|---|
| 0 — basisproject | Volledig klaar volgens projectgeschiedenis | Dashboard en projectbasis. |
| 1 — marktgegevens | Volledig klaar volgens projectgeschiedenis | Openbare Binance Vision-marktprijzen en historische candles. |
| 2 — technische analyse | Volledig klaar volgens projectgeschiedenis | Indicatoren, meerdere munten en tijdsframes. |
| 3 — technische signalen | Volledig klaar volgens projectgeschiedenis | Uitlegbare technische signalen. |
| 4 — AI-analyse | Gedeeltelijk klaar | Veilige lokale AI-grens bestaat, maar er is bewust geen AI-provider/API-sleutel ingesteld. Er worden geen AI-resultaten verzonnen. |
| 5 — historiek | Volledig klaar volgens projectgeschiedenis | Historische registraties en projectonderdelen aanwezig. |
| 6 — paper trading | Volledig klaar volgens projectgeschiedenis | Virtuele rekening, posities, risicoregels en lokale opslag. |
| 7 — risicobeheer | Volledig klaar voor paper trading | Risicoprofielen en controles bestaan in de paper-tradinglaag; Testnet gebruikt deze instellingen nog niet volledig. |
| 8 — exchangegegevens | Volledig klaar als alleen-lezen functie | Binance Spot-accountverbinding met vaste leesverzoeken. De aparte Testnet-code van Fase 9 kan orders versturen. |
| 9 — handmatig bevestigde Testnet-orders | Gedeeltelijk klaar | Ordervoorbereiding, bevestiging, dubbelcheck en statusbewaking zijn gebouwd; volledige rekening- en filladministratie ontbreekt. |
| 10 en verder | Nog niet gepland | Er is nog geen volgende fase opgedragen. LIVE-uitvoering mag niet worden toegevoegd zonder afzonderlijke expliciete opdracht. |

## Huidige functionaliteiten

- Lokaal Windows-dashboard met marktgegevens, grafieken, technische indicatoren en technische signalen.
- Dynamische USDT-markten en lokale watchlist.
- Backtests met historische gegevens en virtueel geld.
- Paper trading met virtueel saldo, transactiekosten/slippage, posities, stop-loss/take-profit en de Fase 7-risicoregels.
- Lokale AI-statusgrens. Zonder ingestelde provider meldt de app dat AI niet beschikbaar is en maakt zij geen AI-uitkomst.
- Binance Spot alleen-lezen accountprovider in `exchange_layer.py`.
- Experimentele Testnet-orderstroom in `testnet_trading.py`. Deze gebruikt uitsluitend Binance Spot Testnet en vereist een aparte gebruikersbevestiging.
- Lokale Testnet-orderhistorie in SQLite onder `outputs/testnet_ledger.sqlite3` zodra de Testnetservice wordt gestart. De SQLite-bestanden zijn uitgesloten van Git.

## Veiligheidsregels en modi

| Modus | Huidige status |
|---|---|
| **PAPER** | Virtueel geld in de browser/lokale paper-administratie. Geen exchange-orders. |
| **TESTNET** | Aparte provider met vast `https://testnet.binance.vision`-adres. Orders zijn alleen mogelijk in een expliciete Testnet-sessie, na ordervoorbereiding, risicocontroles en de knop **BEVESTIG TESTNET ORDER**. De huidige implementatie is onvolledig; niet gebruiken tot de bekende problemen zijn opgelost. |
| **LIVE** | Accountgegevens kunnen via de bestaande read-only provider worden gelezen. De Testnet-provider weigert wanneer sandbox niet expliciet aan staat en heeft geen live-host. Er is geen werkende LIVE-orderroute, live orderprovider, opname- of transferfunctie. |

**LIVE-orders zijn met de huidige code technisch niet mogelijk.** De live-accountprovider heeft alleen vaste GET-aanroepen; de aparte schrijfprovider heeft een vaste Testnet-host en `create_testnet_service()` vereist `EXCHANGE_SANDBOX=1`. Voeg geen LIVE-ordercode toe zonder een nieuwe, expliciete opdracht van de gebruiker.

AI en technische signalen zijn niet gekoppeld aan een orderverzendroute. API-geheimen worden niet in de browser getoond, in de database opgeslagen of door de server gelogd. De launchers houden de ingevoerde waarden alleen tijdelijk in het serverproces.

## AI- en exchangestatus

- **AI:** geen provider gekozen en geen API-sleutel ingesteld. De bestaande AI-aanvraagroute retourneert een duidelijke melding dat AI niet is ingesteld; geen verzonnen AI-analyses.
- **Openbare marktgegevens:** beschikbaar via de bestaande openbare Binance Vision-verzoeken, onafhankelijk van accountinstellingen.
- **Account/exchange:** Binance Spot is de bestaande accountprovider. `run_exchange_readonly.py` start de optionele accountverbinding; kies LIVE daar uitsluitend voor lezen. De aparte `run_testnet.bat` is bedoeld voor Testnet.
- **Sleutels:** niet aanwezig in de code of configuratiebestanden. Voor een Testnet-sessie vraagt `run_testnet.py` verborgen invoer en zet de waarden tijdelijk in procesomgevingsvariabelen.

## Starten op Windows

### Dashboard, marktgegevens en paper trading

1. Open deze projectmap in Verkenner.
2. Dubbelklik op `run_local.bat`.
3. Houd het servervenster open zolang de app actief is.
4. Sluit het venster om de server te stoppen.

### Testnet

`run_testnet.bat` start een aparte Testnet-sessie en vraagt om bevestiging en Testnet-sleutels. **Gebruik deze starter momenteel niet voor orderuitvoering:** Fase 9 is niet compleet. Er zijn tijdens de bouw geen Testnet-sleutels ingevoerd en geen Testnet-order verstuurd.

Als al een oudere server op poort 8765 draait, stop die met `Ctrl+C` in het servervenster en start daarna de gewenste `.bat` opnieuw zodat de bijgewerkte code wordt geladen.

## Belangrijke configuratie en bestanden

- `run_local.bat` — gewone lokale app, standaard zonder accountgeheimen.
- `run_local.py` — lokale HTTP-server en toegestane API-routes.
- `exchange_layer.py` — Binance Spot read-only provider; vaste account-GET-routes.
- `run_exchange_readonly.py` — optionele tijdelijke accountverbinding. LIVE is alleen-lezen; kies alleen Testnet voor de sandbox.
- `testnet_trading.py` — Testnet-only API-adapter, risico- en orderworkflow, SQLite-administratie.
- `run_testnet.py` en `run_testnet.bat` — aparte Testnet-start.
- `src/paper-trading.js` — paper-account, opslag en Fase 7-risicoregels.
- `src/ai-bridge.js` — veilige status- en aanvraaggrens voor AI.
- `tests/` — Python- en JavaScript-controles.
- `.gitignore` — sluit Python-cache en Testnet-SQLite-bestanden uit.

Testnetconfiguratie wordt tijdens de startsessie alleen via procesomgevingsvariabelen gelezen: `EXCHANGE_PROVIDER=binance_spot`, `EXCHANGE_SANDBOX=1`, `EXCHANGE_API_KEY` en `EXCHANGE_API_SECRET`. Zet geen sleutels in broncode, `.env`-bestanden of Git.

## Bekende problemen / open werk in Fase 9

1. Testnet gebruikt nog een vaste, ingebouwde risicobasis. De door de gebruiker ingestelde Fase 7-profielen en hun risicostatus worden niet als volledige server-side Testnet-risicostaat gebruikt.
2. De SQLite-administratie is nog geen volledige handelsadministratie. Fill-by-fill gegevens, werkelijk gemiddelde instap, fees, gerealiseerde en ongerealiseerde P/L, open posities, open risico, dagresultaat en drawdown worden niet volledig en duurzaam bijgehouden.
3. Dagverlies- en drawdowncontroles hebben daardoor nog niet de benodigde betrouwbare volledige Testnet-rekeninghistorie als basis.
4. SELL/positie-afsluiting is geblokkeerd. Alleen BUY-ordervoorbereiding is aanwezig.
5. Exchange-marktfilters zoals stapgrootte, prijstick en minimumorderwaarde worden niet volledig lokaal gevalideerd. De exchange kan een order daarom nog afwijzen.
6. OTOCO-beschermorders worden pas actief nadat de instaporder volledig is gevuld. Bij gedeeltelijke fills blijft bescherming terecht onbevestigd; herstel- en noodafhandeling voor zo’n positie is nog niet compleet.
7. Kosten zijn een schatting, geen opgehaald Testnet-commissietarief. De orderhistorieweergave is beperkt tot recente orders.
8. Er is geen live/Testnet-integratietest uitgevoerd. De tests gebruiken uitsluitend nagebootste antwoorden.

**Veilige vervolgstap:** maak de Testnet-administratie en alle Fase 7-risicocontroles volledig en server-side, valideer Binance-marktfilters, handel partial fills en beschermorders af, bouw veilige positieafsluiting en voeg daarna uitsluitend mocktests toe. Test geen Testnet-order voordat deze punten aantoonbaar opgelost zijn. LIVE blijft buiten scope.

## Laatst uitgevoerde controles

Bij de laatste codecontrole zijn geslaagd:

- Python compilecontrole voor server-, Testnet- en exchangebestanden.
- 28 Python-tests in `tests/`, inclusief de nagebootste Testnet-scenario’s en bestaande exchange-/AI-controles.
- JavaScript-syntaxcontrole voor `src/app.js` en `src/paper-trading.js`.
- Paper risk, paper trading, lokale paper-opslag, backtest en AI-contract smoke-tests.

Alle orderreacties in de tests waren nagebootst. Er zijn geen externe orderverzoeken gedaan.
