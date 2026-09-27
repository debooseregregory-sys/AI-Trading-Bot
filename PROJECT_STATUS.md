# Projectstatus — AI Crypto Trading Assistant

**Bijgewerkt:** 27 september 2026  
**Projectmap:** `C:\Users\andyb\Documents\Codex\2026-09-26\we-gaan-samen-een-ai-crypto`  
**Doelplatform:** Windows 10/11, Python 3 en Node.js voor controles

## Huidige fase

**Fase 10 — code-audit en mock/regressiechecks lopen; niet end-to-end afgesloten.**

De Fase 9-implementatie gebruikt uitsluitend de afgescheiden Binance Spot Testnet-adapter. De bestaande Fase 7-risk engine wordt via een dunne Node-procesgrens aangeroepen; bij ontbrekende engine, ongeldige input of onbekende rekeningstaat wordt fail-closed geblokkeerd. Orders vereisen voorbereiding, expliciete bevestiging en een tweede actuele controle. De read-only Testnet-verbinding is op 27 september 2026 bevestigd met uitsluitend GET-verzoeken. Er is geen Testnet- of live-order verstuurd. Sleutels zijn niet in code of repository opgeslagen.

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
| 7 — risicobeheer | Volledig klaar voor paper trading | Dezelfde profielen en `PaperTradingEngine.checkRisk` worden server-side hergebruikt door Fase 9. |
| 8 — exchangegegevens | Volledig klaar als alleen-lezen functie | Binance Spot-accountverbinding met vaste leesverzoeken. De aparte Testnet-code van Fase 9 kan orders versturen. |
| 9 — handmatig bevestigde Testnet-orders | Code/mock-verificatie afgerond; read-only Testnet-verbinding geslaagd | Echte time-, exchangeInfo- en account-read zijn geslaagd. Orderuitvoering/lifecycle blijft uitsluitend mock-getest; er is geen order verstuurd. |
| 10 — technische, veiligheids- en regressieaudit | Code-audit en mocks; afsluiting beperkt door onbeschermde partial fills en niet-uitgevoerde echte Testnet-writevalidatie | Geen nieuwe tradingfunctie toegevoegd. Zie “Fase 10-audit” hieronder. LIVE-uitvoering blijft buiten scope. |

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
| **TESTNET** | Aparte provider met vast `https://testnet.binance.vision`-adres. Orderflow vereist expliciete Testnet-sessie, voorbereiding, Fase 7-risicocontroles en knop **BEVESTIG TESTNET ORDER**. De read-only endpoints zijn echt getest; orderuitvoering blijft mock-getest. |
| **LIVE** | Accountgegevens kunnen via de bestaande read-only provider worden gelezen. De Testnet-provider weigert wanneer sandbox niet expliciet aan staat en heeft geen live-host. Er is geen werkende LIVE-orderroute, live orderprovider, opname- of transferfunctie. |

**LIVE-orders zijn met de huidige code technisch niet mogelijk.** De live-accountprovider heeft alleen vaste GET-aanroepen; de aparte schrijfprovider heeft een vaste Testnet-host en `create_testnet_service()` vereist `EXCHANGE_SANDBOX=1`. Voeg geen LIVE-ordercode toe zonder een nieuwe, expliciete opdracht van de gebruiker.

Automatische trading is niet actief. AI en technische signalen zijn niet gekoppeld aan een orderverzendroute. API-geheimen worden niet in de browser getoond, in de database opgeslagen of door de server gelogd. De launchers houden de ingevoerde waarden alleen tijdelijk in het serverproces.

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

`run_testnet.bat` start een aparte Testnet-sessie en vraagt om bevestiging en Testnet-sleutels. Alleen eigen Binance Spot Testnet-sleutels zijn geschikt. De read-only controle is geslaagd; tijdens die controle is uitsluitend GET gebruikt. Er is geen Testnet-order verstuurd. De write/orderflow blijft niet echt op Testnet gevalideerd.

Als al een oudere server op poort 8765 draait, stop die met `Ctrl+C` in het servervenster en start daarna de gewenste `.bat` opnieuw zodat de bijgewerkte code wordt geladen.

## Belangrijke configuratie en bestanden

- `run_local.bat` — gewone lokale app, standaard zonder accountgeheimen.
- `run_local.py` — lokale HTTP-server en toegestane API-routes.
- `exchange_layer.py` — Binance Spot read-only provider; vaste account-GET-routes.
- `run_exchange_readonly.py` — optionele tijdelijke accountverbinding. LIVE is alleen-lezen; kies alleen Testnet voor de sandbox.
- `testnet_trading.py` — Testnet-only API-adapter, risico- en orderworkflow, SQLite-administratie.
- `testnet_readonly_check.py` — optionele, vaste-host Testnet-connectiecontrole met alleen GET time/market/account; doet zonder beide lokale credential-env-vars niets.
- `run_testnet.py` en `run_testnet.bat` — aparte Testnet-start.
- `src/paper-trading.js` — paper-account, opslag en Fase 7-risicoregels.
- `src/ai-bridge.js` — veilige status- en aanvraaggrens voor AI.
- `tests/` — Python- en JavaScript-controles.
- `.gitignore` — sluit Python-cache en Testnet-SQLite-bestanden uit.

Testnetconfiguratie wordt tijdens de startsessie alleen via procesomgevingsvariabelen gelezen: `EXCHANGE_PROVIDER=binance_spot`, `EXCHANGE_SANDBOX=1`, `EXCHANGE_API_KEY` en `EXCHANGE_API_SECRET`. Zet geen sleutels in broncode, `.env`-bestanden of Git.

## Afronding Fase 9 en resterende verificatie

De implementatie registreert orders en exchangebevestigde fills idempotent in SQLite. Open posities, gemiddelde kostprijs, SELL-afsluiting, realized/unrealized P/L en fees worden uit fills afgeleid. Fee-assets buiten basis/quote worden historisch naar USDT gewaardeerd; ontbrekende omrekening zet reconciliatie aan en blokkeert nieuwe orders. Dag-P/L vergelijkt de USDT-waardering bij eerste sync van de lokale dag met de actuele USDT-balans en fill-afgeleide posities. Dit is een Testnet-rekeningwaardering, geen exchange-provided daily-P&L endpoint; niet-geregistreerde stortingen/handmatige trades blokkeren via reconciliatie in plaats van als betrouwbare P/L te worden geboekt.

Portfolio-peak, dagelijkse basis en risicoblokkades blijven persistent. Na restart worden lokale orders/fills opnieuw verwerkt en exchange-open-orders, accountbalans en bekende orderstatussen gesynchroniseerd. Unknown orders/assets of afwijkende balans blokkeren entries. BUY gebruikt de bestaande Fase 7-engine, zowel bij voorbereiding als direct voor verzending. SELL kan alleen een fill-bevestigde positie sluiten. Exchange filters, prijsversheid, orderlimieten, commissiepercentage en actuele balans worden server-side gecontroleerd. OTOCO-bescherming wordt alleen als bevestigd getoond na exchangebevestiging op de werkelijk gevulde hoeveelheid.

**Beperking:** De beurs levert via de gebruikte endpoints geen historische accountbalanssnapshot voor de start van de dag. Als de lokale service pas later op de dag start, kan zij de dagstart niet exchange-bevestigen; het lokale dagresultaat begint dan bij de eerste succesvolle sync. Dit wordt niet voorgesteld als bewezen volledige daghistorie. Onbekende assets/orders, onwaardeerbare fees of balansverschillen blijven `reconciliationRequired` en blokkeren nieuwe entries.

De read-only Testnet-controle is geslaagd. De orderflow is niet end-to-end exchange-gevalideerd: write/order lifecycle-responses zijn uitsluitend mock-getest en er is geen echte Testnet-write-order of live-order uitgevoerd. LIVE blijft standaard uitgeschakeld en buiten scope.

## Testnet-compatibiliteitscontrole

- **Testnet-compatibiliteit gecontroleerd:** ja voor broncode/mock-responsecontracten en read-only verbinding. De door de gebruiker uitgevoerde echte controle slaagde op 27 september 2026; `serverTime=1790526837827`, `BTCUSDT` status `TRADING`, 502 balansregels.
- **Echt getest:** `GET /api/v3/time`: geslaagd; `GET /api/v3/exchangeInfo`: geslaagd; `GET /api/v3/account`: geslaagd. De controle meldde uitsluitend GET-verzoeken.
- **Gecontroleerde read endpoints:** `GET /api/v3/time`, `/api/v3/account`, `/api/v3/exchangeInfo`, `/api/v3/ticker/24hr`, `/api/v3/account/commission`, `/api/v3/openOrders`, `/api/v3/openOrderList`, `/api/v3/order` (client-ID en order-ID lookup), `/api/v3/orderList`, `/api/v3/myTrades`, `/api/v3/aggTrades`.
- **Gecontroleerde write-contracten zonder uitvoeren:** `POST /api/v3/order` voor SELL en `POST /api/v3/orderList/otoco` voor BUY met beschermingsorders. Orderresponse, statussen, fillvelden en idempotente fill-ID-opslag zijn alleen met mocks getest.
- **Alleen mock-getest:** commissie, open orders, orderstatussen, myTrades, beschermorderstatus, order-write-responsecontracten, HTTP/rate-limit/auth fouten, malformed responses, klokoffset/signature, timeout en productiescheiding. De account-read zelf is echt geslaagd; orderplaatsing en order lifecycle zijn niet echt getest.
- **Read-only checker gecontroleerd:** `testnet_readonly_check.py` gebruikt vaste Testnet-host en staat alleen `/api/v3/time`, `/api/v3/exchangeInfo` en `/api/v3/account` toe. De HTTP-methode is GET; andere paden zoals `/api/v3/order` worden geweigerd. Geen order-, cancel-, transfer- of withdrawal-aanroep.
- **Credentials:** API-sleutels en secrets zijn niet in code of repository opgeslagen. Het controlescript leest ze alleen uit lokale proces-omgevingsvariabelen.
- **Orders verstuurd:** nee; nul Testnet-orders en nul live-orders.
- **Fase 9 volledig Testnet-gevalideerd:** nee voor write/orderflow. **Klaar voor de volgende auditfase:** ja; de read-only Testnet-verificatie is geslaagd. Dit zegt niet dat echte orderuitvoering is gevalideerd.

De endpointcontracten zijn vergeleken met de [officiële Binance Spot REST-documentatie](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md) en de [Spot Testnet changelog](https://github.com/binance/binance-spot-api-docs/blob/master/testnet/CHANGELOG.md). Onder meer `/api/v3/time` geeft `serverTime` in milliseconden; signed calls compenseren lokale klokdrift met een vers server-time-offset en `recvWindow=5000`. Binance documenteert OTOCO op Spot Testnet. Werkelijke beschikbaarheid per markt wordt alsnog uit `exchangeInfo` gecontroleerd en ontbrekende capability blokkeert de BUY-order.

## Laatst uitgevoerde controles

Bij de laatste codecontrole zijn geslaagd:

- Python compilecontrole voor server-, Testnet- en exchangebestanden.
- 63 Python-tests in `tests/` geslaagd, inclusief nagebootste Testnet-scenario’s en bestaande exchange-/AI-regressies.
- JavaScript-syntaxcontrole en smoke-tests voor Phase 7 paper risk/trading/storage, backtest en AI-contract.
- `git diff --check`.

Orderresponses in de tests zijn nagebootst. Er is tijdens deze wijziging geen Testnet- of live-order verstuurd.

## Fase 10-audit

**Status:** de eerdere auditbevindingen zijn aangepakt en deze aanvullende eind-audit is op code en mocks gecontroleerd. De Fase 10-audit kan niet volledig worden afgesloten: er is geen echte Testnet-write-order end-to-end uitgevoerd en een gedeeltelijk gevulde BUY-OTOCO-positie blijft zonder door de exchange geactiveerde beschermingslegs totdat de working order volledig gevuld is. Automatische trading en LIVE zijn niet actief.

- **Open BUY-risico:** lokale PREPARED/CONFIRMING orders en exchange-openstaande BUY-orderresten worden als afzonderlijke reserveringen aan de bestaande `PaperTradingEngine.checkRisk` aangeboden. Dezelfde Fase 7-engine rekent ze mee in positiegrootte per symbool, portefeuilleblootstelling, aggregate risk, beschikbare cash en positieaantal. Een gedeeltelijke fill blijft een fill-afgeleide positie plus alleen de resterende orderreservering. Ontbrekende of afwijkende orderinformatie vereist reconciliatie en blokkeert nieuwe entries. Reserveringen herstellen vanuit SQLite na restart.
- **USDT-kasreconciliatie:** een persistente USDT-basis plus idempotente, fill-afgeleide kasstromen detecteert latere onverklaarde afwijkingen. Afwijkingen maken reconciliatie sticky, blokkeren orders, laten dagbasis en portfolio peak ongemoeid en verbergen daily P/L als niet beschikbaar. De oorzaak wordt niet ingevuld.
- **Dag-P/L-beperking:** de beurs geeft via de gebruikte endpoints geen historische dagopeningsbalans. Daily P/L is daarom alleen “indicatief sinds eerste lokale sync” en wordt niet als exacte volledige daghistorie gepresenteerd; bij reconciliatie is de waarde niet beschikbaar.
- **Modusweergave:** de globale badge begint met moduscontrole en schakelt naar PAPER, TESTNET of LIVE alleen op basis van serverstatus. Bij onbereikbare status toont de UI “modus onbekend/fail-closed”. De Paper-rekening is expliciet als aparte module aangeduid.
- **README:** vermeldt nu de geslaagde read-only Testnet-controle, de drie GET-routes, de beperking dat dit script geen orders kan plaatsen, en dat write/orderflow alleen mock-getest is.
- **Partial fills en bescherming:** de werkelijke fillhoeveelheid vormt de positie; alleen de resterende exchange-open hoeveelheid is een risk-reservering. Een gedeeltelijke fill wordt expliciet als onbeschermd/pending getoond. De Fase 7-engine rekent een positie zonder bevestigde bescherming conservatief als volledig risicovol. Alleen twee exchange-bevestigde SELL-legs met verwachte client-id's, types, open status, volle fillhoeveelheid en passende prijzen kunnen `ACTIVE_CONFIRMED` opleveren. Ontbrekende/tegenstrijdige informatie zet reconciliatie aan en blokkeert nieuwe entries. Dit is mock-getest, niet live op Testnet.
- **Orderflow-architectuur:** AI en signalen hebben geen order-executieroute. Server-side voorbereiding vereist de bestaande Fase 7-controle; verzending vereist expliciete bevestiging, herhaalde actuele risk-/prijs-/balans-/marktchecks en statusopvraging. Een onzekere write wordt niet opnieuw verzonden; UNKNOWN/contradictoire statussen blokkeren vervolgorders. De Testnet-adapter heeft een vaste sandbox-host; de LIVE-laag is alleen-lezen en er is geen automatische trading.
- **Documentatie/security:** README en dit bestand melden dat echte Testnet-write-orders niet end-to-end zijn uitgevoerd, LIVE-orders nooit zijn uitgevoerd, dagelijkse historische openingsbalans ontbreekt, credentials lokaal blijven en de aparte read-only checker uitsluitend GET gebruikt.

LIVE, automatische trading, transfers en withdrawals zijn niet toegevoegd. Tijdens de remediatie is geen order verstuurd.

**Verificatie huidige audit:** 63/63 Python-tests geslaagd; Python compilecontrole geslaagd; JavaScript-syntaxcontroles geslaagd; alle 5 JavaScript-smoke suites geslaagd; lokale dashboardstartcontrole geslaagd; `git diff --check` geslaagd. `.gitignore` sluit `.env`, `.env.*` (behalve `.env.example`), credentials, lokale configuratie, logs en SQLite-bestanden uit. Gewijzigde diff is gecontroleerd op API-key/secret-inhoud; er zijn geen waarden van echte sleutels opgenomen. Alle write-scenario's gebruikten mocks; geen Testnet- of live-order is verstuurd.
