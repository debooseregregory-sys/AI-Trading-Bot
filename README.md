# AI Crypto Trading Assistant — Fase 8

Dit Windows-project toont openbare marktgegevens, technische signalen, een historische backtest en paper trading met uitsluitend virtueel geld. Fase 8 voegt een optionele Binance Spot-accountkoppeling toe die uitsluitend leesgegevens kan ophalen. Fase 9 heeft daarnaast een handmatig bevestigde Binance Spot Testnet-orderstroom; die gebruikt alleen fictieve Testnet-tegoeden. Er is geen LIVE-order-, opname-, stortings- of transferfunctie.

## Starten

1. Open de projectmap in Verkenner.
2. Dubbelklik op **`run_local.bat`**.
3. Er opent een browserpagina met het dashboard. Laat het zwarte venster open zolang je de app gebruikt.
4. Sluit het zwarte venster om de lokale verbinding te stoppen.

Python 3 moet op de computer zijn geïnstalleerd. De app verbindt lokaal op deze computer en gebruikt voor markt- en koershistorie alleen openbare leesverzoeken naar Binance Vision. Je kunt ook `index.html` dubbelklikken, maar voor de lokale AI-status gebruik je `run_local.bat`.

## Een backtest uitvoeren

1. Open **Backtesting** in het linkermenu.
2. Kies maximaal 20 munten (de lijst komt uit de beschikbare openbare markten; standaard zijn BTC en ETH geselecteerd). Zoek een munt, gebruik je watchlist of neem je huidige markselectie over.
3. Kies de periode, het tijdsframe, virtuele startkapitaal en de aannames voor kosten, slippage, positiegrootte, stop-loss, koersdoel en het maximumaantal posities.
4. Klik **Start backtest**. Met **Stop backtest** breek je een lopende gegevensophaling of simulatie af.
5. Bekijk het fictieve vermogen, de statistieken, transacties en uitleg. Voer nog een test uit met andere instellingen om twee resultaten naast elkaar te zetten. Maximaal vijf resultaten blijven beschikbaar zolang de pagina open is.

De gekozen einddatum is inbegrepen. Er kunnen tot 210 extra candles vóór de startdatum worden opgehaald om technische gemiddelden op te warmen; die tellen niet mee als testperiode. Minstens drie van de vier perioden (15 minuten, 1 uur, 4 uur, 1 dag) moeten bruikbaar zijn voor een signaal. Munten met missende geselecteerde koershistorie worden overgeslagen en gemeld. Ook is voor een resultaat in euro de historische EUR/USDT-koers nodig; ontbreekt die, dan stopt de test in plaats van een omrekening te verzinnen.

De Fase 3-regels beoordelen alleen afgesloten candles. Een virtuele actie wordt uitgevoerd bij de opening van de volgende candle. Stop-loss en koersdoel worden tussentijds gecontroleerd. Als beide binnen dezelfde candle geraakt worden, rekent de test voorzichtig met de stop-loss. Een nog open positie wordt aan het eind virtueel gesloten. De simulatie gebruikt geen hefboom of short-posities. Ingestelde kosten en slippage zijn aannames, geen actuele exchange-tarieven. Een veranderde selectie of periode is geen garantie voor toekomstige resultaten.

Er is nog geen AI-dienst ingesteld. De backtest maakt daarom geen AI-resultaten en gebruikt alleen de bestaande technische signalen uit Fase 3.

## Bestaande functies

- Zoek en bekijk meerdere dynamisch beschikbare USDT-markten en bewaar een lokale watchlist.
- Bekijk actuele openbare prijzen en historische candles.
- Bereken technische indicatoren en scan meerdere munten op Fase 3-signalen.
- Gebruik de voorbereide Fase 4-status zonder provider of API-sleutel. Er wordt geen AI-analyse verzonnen.
- Oefen met paper trading: virtueel startbedrag, meerdere munten, risicoregels, kosten/slippage, stop-loss/koersdoel, posities, resultaten en lokale handelsgeschiedenis.

## Fase 7 risicobeheer gebruiken

1. Open **Paper trading**. De sectie **Oefenrekening en risicoregels** bevat drie profielen: Voorzichtig, Gemiddeld en Agressief. De concrete waarden staan direct onder de instellingen.
2. Kies een profiel als startpunt en pas daarna alle bedragen en percentages aan. Een profielkeuze vult de invoervelden; het verandert niets tot je **Instellingen bewaren** kiest.
3. Stel risico per transactie, open totaalrisico, positiegrootte, dagelijkse verlieslimiet, maximale drawdown, stop-loss en take-profit in. Een stop-loss en voldoende risico/rendement zijn verplicht voor elke nieuwe positie.
4. Het programma berekent de hoeveelheid op basis van verlies tot stop-loss, kosten en slippage. Het controleert ook de beschikbare cash, positie- en blootstellingslimieten, aantal posities, dagverlies en drawdown. Een afgewezen poging en de controles verschijnen onder **Risicogeschiedenis**.
5. Het dashboard toont open risico, toegestane risicoruimte, dagresultaat, drawdown en blootstelling van de portefeuille. Correlatie wordt niet verzonnen; dit wordt als niet beschikbaar getoond.
6. Een bereikte dagelijkse verlieslimiet blokkeert nieuwe posities tot de volgende lokale dag en laat bestaande posities staan. Een drawdownblokkade vraagt om de knop **Risicoblokkade handmatig hervatten** en bevestiging. Daarmee wordt de drawdownreferentie opnieuw ingesteld; een actieve dagverliesblokkade blijft gelden.

De profielen zijn slechts vooraf ingevulde paperinstellingen en geen advies. Limieten kunnen verlies beperken, maar sluiten verlies niet uit. De controle kijkt naar de laatst beschikbare verse prijs; een snelle prijsbeweging tussen controles kan dus verder gaan dan het geplande stopverlies. De risicolaag heeft geen verbinding met echte exchange-orders. Alle waarden en controles zijn uitsluitend voor paper trading.

## Paper trading gebruiken

1. Start de toepassing met `run_local.bat` en open het lokale dashboard.
2. Kies bij **Paper trading** een virtueel startbedrag en maximaal 20 munten. BTC en ETH zijn alvast geselecteerd.
3. Controleer de virtuele kosten en risicoregels. Klik **Instellingen bewaren** om de oefenrekening op deze computer aan te maken.
4. Klik **Start paper trading**. Het programma haalt verse openbare koersen en Fase 3-signalen op. Alleen een nieuw technisch koopsignaal kan een virtuele positie openen.
5. Bekijk cash, portefeuillewaarde, resultaat, open posities en alle koop/verkoopregels op dezelfde pagina. De volledige historie blijft lokaal bewaard.
6. **Pauze** bevriest virtuele openingen en sluitingen maar werkt koersen bij. **Stop** stopt het automatisch volgen; de rekening blijft bewaard. **Reset paper trading** wist de volledige virtuele rekening na een bevestigingsvraag.

Kosten en slippage zijn instelbare aannames, niet de actuele kosten van een handelsplatform. Een stop-loss of koersdoel wordt uitgevoerd wanneer de volgende gecontroleerde verse prijs het niveau bereikt of passeert; bij een internetstoring blijft een positie bestaan tot een nieuwe verse prijs beschikbaar is.

## Fase 8-techniek controleren

```powershell
node --check src/app.js
node --check src/paper-trading.js
node tests/paper-trading-engine-smoke.cjs
node tests/paper-risk-engine-smoke.cjs
node tests/paper-trading-store-smoke.cjs
node tests/backtest-engine-smoke.cjs
node tests/ai-contract-smoke.cjs
py -3 -m unittest discover -s tests -v
```

## Fase 8: exchangegegevens alleen lezen

De marktkoersen blijven zonder accountverbinding werken via de openbare marktgegevens. De exchangepagina staat standaard op **niet verbonden**. Een accountkoppeling is optioneel en staat los van paper trading.

Er is één accountprovider voorbereid: **Binance Spot**. De module ondersteunt alleen vaste `GET`-verzoeken voor accountbalansen, openstaande orders, markten en de verbindingstest. Testnet en live account zijn apart herkenbaar. Ook in de live-accountstand is de software uitsluitend read-only; er bestaat geen order-, stortings-, transfer- of opnamefunctie. Openstaande orders worden alleen getoond, nooit aangemaakt of aangepast. Een geldwaarde van het hele account wordt niet verzonnen en blijft als niet beschikbaar gemarkeerd.

Er was nog geen veilige uitwisselingsopslag. De optionele sleutel wordt daarom alleen tijdens een afzonderlijke sessie in het geheugen van het lokale serverproces gehouden. Er wordt niets naar schijf opgeslagen. API-sleutels komen niet in de browser, broncode, projectbestanden, README of serverlogs. Het dashboard bevat geen sleutelvelden. Er is in deze fase geen sleutel ingevuld of van de gebruiker gevraagd.

Als je later zelf kiest de koppeling in te stellen: maak een aparte API-sleutel met alleen leesrechten. Zet trading, margin, transfers, stortingen en withdrawals/opnames uit; sta zo mogelijk alleen jouw eigen IP-adres toe. Opnames zijn voor deze app nooit nodig. Start in een testnet als je een accountkoppeling gaat uitproberen. Je kunt de aparte sessiestarter starten met `py -3 run_exchange_readonly.py`; hij vraagt pas dan om de gegevens, verbergt de invoer en houdt ze alleen tijdelijk in het geheugen. Sluit het servervenster om die tijdelijke gegevens te wissen. Gebruik dit niet met een sleutel waaraan trading- of geldverplaatsingsrechten zijn gegeven.

Het bestaande accountpaneel blijft alleen-lezen. Fase 9 voegt daarnaast een aparte Binance Spot Testnet-stroom toe. De live-accountkeuze blijft alleen-lezen.

De Binance REST-aanroepen volgen de officiële documentatie voor [Spot REST API](https://developers.binance.com/en/docs/products/spot/rest-api) en [API-sleutelrechten](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/account). Controleer de actuele rechten in Binance zelf voordat je ooit een sleutel instelt.

## Fase 9: Testnet-orderstroom

De aparte Windowsstarter is `run_testnet.bat`. De app vraagt eerst om `TESTNET` en daarna om Testnet API-sleutelgegevens, verborgen tijdens het typen. Gebruik hier nooit een echte/live sleutel. Sleutels leven alleen tijdelijk in het serverproces. Ze worden niet in de browser, SQLite-administratie, Git, bestanden of serverlogs opgeslagen. De Testnet-sleutel heeft Testnet trading-rechten nodig; zet geldverplaatsing en opnames uit.

De gebruiker vult een USDT-paar, BUY- of SELL-hoeveelheid en voor een BUY stop-loss en take-profit in. De server haalt actuele prijs, balans, Fase 7-instellingen, accountcommissie en marktfilters op. De bestaande `PaperTradingEngine.checkRisk` wordt via een kleine Node-procesgrens aangeroepen; zonder die engine wordt fail-closed geblokkeerd. Een bevestigingskaart toont de order. Pas na **BEVESTIG TESTNET ORDER** voert de server direct opnieuw de prijs-, balans-, markt-, positie- en risicocontroles uit en verstuurt één order met unieke client-id. SELL sluit alleen fill-bevestigde inventaris. Bij een prijsbeweging groter dan 0,1%, mislukte controle, onduidelijke status of time-out wordt niets automatisch opnieuw verstuurd.

De status wordt bijgehouden als NEW, PARTIALLY_FILLED, FILLED, CANCELED, REJECTED, EXPIRED of UNKNOWN. Een gedeeltelijke fill telt alleen voor de werkelijk uitgevoerde hoeveelheid; de resterende hoeveelheid blijft een afzonderlijke open-orderreservering. Die fill is onbeschermd: OTOCO-beschermingslegs worden niet als actief beschouwd voordat de exchange beide juiste SELL-orders (type, client-id, status, hoeveelheid en trigger-/limietprijs) voor de werkelijke fill bevestigt. Ontbrekende of tegenstrijdige beschermingsinformatie vereist reconciliatie en blokkeert nieuwe instaporders. Afzonderlijke exchangefills en commissies worden idempotent opgeslagen in `outputs/testnet_ledger.sqlite3`. De portfolio toont posities, fees, realized/unrealized P/L, open risico, daily loss en drawdown. Fees in een derde asset worden naar USDT omgerekend op basis van een nabije historische trade; ontbreekt die koers, dan wordt reconciliatie vereist en nieuwe instaporders geblokkeerd.

**Verificatiestatus:** de echte read-only Testnet-controle is succesvol uitgevoerd: `GET /api/v3/time`, `GET /api/v3/exchangeInfo` en `GET /api/v3/account` slaagden; BTCUSDT had status `TRADING`. De controle gebruikte uitsluitend GET en heeft geen order verstuurd. Er is geen echte Testnet-write-order end-to-end uitgevoerd en er is nooit een live-order uitgevoerd. Orderflow en schrijfresponses zijn uitsluitend met mocks getest. Automatische trading is niet actief; AI en signalen kunnen geen order uitvoeren. De dagelijkse verliesmeting begint bij de eerste lokale sync van de dag en is geen exacte historische dag-P/L. Een onverklaarde USDT-balanswijziging maakt daily P/L niet beschikbaar, vereist reconciliatie en blokkeert nieuwe entries. Zie `PROJECT_STATUS.md` voor de auditbevindingen en verificatiegrenzen.

`testnet_readonly_check.py` is de afzonderlijke uitsluitend-lezen connectiecontrole. Het script is echt succesvol uitgevoerd met lokaal ingestelde Testnet-credentials. Het gebruikt uitsluitend GET naar `/api/v3/time`, `/api/v3/exchangeInfo` en `/api/v3/account`; de vaste Testnet-host en allowlist weigeren andere routes. Het script bevat geen functie of endpoint waarmee een order kan worden geplaatst, geannuleerd, overgemaakt of opgenomen. De credentials zijn niet in code of repository opgeslagen. Er is met deze controle geen Testnet-order verstuurd.

Tests zonder exchangeverbinding:

```powershell
py -3 -m unittest tests.test_testnet_trading -v
```

De bouw- en testcontrole heeft geen API-sleutel gebruikt en geen Testnet- of LIVE-verzoek gedaan. Als je later Testnet wilt proberen: start `run_testnet.bat`, typ `TESTNET`, gebruik uitsluitend Testnet-sleutels, controleer de bevestigingskaart en klik alleen bewust op de knop. Dit verstuurt echte Testnet-orders maar gebruikt geen echt geld.

## Veiligheidsgrens

De marktgegevens komen via openbare `GET`-verzoeken van Binance Vision. De Fase 8 accountprovider heeft vaste alleen-lezen routes; de afzonderlijke Testnetprovider heeft een vaste Testnet-host en beperkte Testnet-order- en statusroutes. Geen van beide heeft een live schrijfhost of een opname-/transfermethode. Sleutels blijven in het serverproces en worden niet aan de browser teruggegeven. AI en technische signalen zijn niet gekoppeld aan orderuitvoering. Backtest en paper trading blijven gescheiden van Testnet.

## Projectbestanden

- `index.html` — dashboard, Fase 5-scherm en browserbeveiliging.
- `run_local.bat` — start de lokale Windows-server.
- `run_local.py` — lokale dashboardserver, AI-statusgrens en allowlist met exchange-leesroutes.
- `exchange_layer.py` — uitbreidbare, read-only Binance Spot-provider; vaste GET-aanroepen zonder orderfunctie.
- `run_exchange_readonly.py` — optionele verborgen invoer voor een tijdelijke read-only sessie; sleutels worden niet bewaard.
- `testnet_trading.py` — Testnet-only orderprovider, ordervoorbereiding, bevestiging en statuscontrole.
- `testnet_readonly_check.py` — apart beperkt read-only Testnet-connectiescript.
- `run_testnet.py`, `run_testnet.bat` — afzonderlijke Windowsstarter voor TESTNET.
- `tests/test_testnet_trading.py` — Testnet-controles met nagebootste reacties.
- `src/exchange.css` — weergave van de status en alleen-lezen accountgegevens.
- `tests/test_exchange_layer.py` — tests met nagebootste exchange-antwoorden; geen echte sleutels of transacties.
- `src/app.js` — marktgegevens, dashboard, historische gegevensophaling, resultaatweergave.
- `src/indicators.js` — berekening van technische indicatoren.
- `src/signals.js` — bestaande uitlegbare Fase 3-signaalregels.
- `src/backtest.js` — historische simulatie met virtueel saldo, zonder netwerk- of orderfunctie.
- `src/paper-trading.js` — aparte virtuele handelsrekenmodule en lokale opslag; geen netwerk- of orderfunctie.
- `tests/paper-risk-engine-smoke.cjs` — tests voor positieomvang, risico/rendement, verlieslimieten, handmatige hervatting en scheiding van echte orders.
- `src/ai-bridge.js` — controle van de bestaande lokale AI-status.
- `src/styles.css` — vormgeving.
- `tests/backtest-engine-smoke.cjs` — controles van de simulatie en het gebruik van historische gegevens.
- `tests/paper-trading-engine-smoke.cjs` — virtuele transacties, kosten, slippage, risico, stop/koersdoel, pauze en verouderde data.
- `tests/paper-trading-store-smoke.cjs` — herladen en wissen van de lokale oefenrekening.
- `tests/ai-contract-smoke.cjs`, `tests/test_local_ai_bridge.py` — controles van de bestaande AI-veiligheidsgrens.

## Technische controles uitvoeren

Voor deze technische controles heb je Node.js en Python 3 nodig. Open PowerShell in de projectmap en voer uit:

```powershell
node --check src/app.js
node --check src/backtest.js
node tests/backtest-engine-smoke.cjs
node tests/ai-contract-smoke.cjs
py -3 -m unittest discover -s tests -v
```
