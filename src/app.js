// Fase 1 vraagt uitsluitend openbare marktgegevens op. Geen sleutels, orders
// of accountfuncties. De enige netwerkbestemming staat ook in de CSP.
"use strict";

const MARKET_DATA_ROOT = "https://data-api.binance.vision/api/v3";
const COPYRIGHT_LICENSE_TEXT = "© 2026 Andy B.\nDeveloped by Andy B.\nLicensed to\nChantal Verpoort";
const REFRESH_INTERVAL_MS = 60_000;
const HISTORY_LIMIT = 500;
const INTERVALS = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);
const ANALYSIS_INTERVALS = new Set(["15m", "1h", "4h", "1d"]);
const SYMBOLS = new Map();
const byId = (id) => document.getElementById(id);
byId("about-copyright-license").textContent = COPYRIGHT_LICENSE_TEXT;
byId("copyright-license").textContent = COPYRIGHT_LICENSE_TEXT;
const WATCHLIST_KEY = "aiCryptoAssistant.watchlist.v1";
const MARKETS_PER_PAGE = 12;
const OVERVIEW_CACHE_MS = 5 * 60_000;
const SIGNAL_CACHE_MS = 5 * 60_000;
const SIGNAL_INTERVALS = ["15m", "1h", "4h", "1d"];
const SIGNAL_STORAGE_KEY = "aiCryptoAssistant.signalAudit.v1";
const signalCandleCache = new Map();
const signalSnapshots = new Map();
let signalChanges = [];
let activeSignalSymbol = "";
let scanInProgress = false;
let currentInterval = "1m";
let currentAnalysisInterval = "15m";
let requestNumber = 0;
let marketSnapshot = new Map();
let marketSnapshotTime = 0;
let currentEuroRate = NaN;
let currentMarketPage = 0;
let watchlistOnly = false;
let watchlist = readWatchlist();
let selectedMarkets = new Set();
let backtestController = null;
let backtestRuns = [];
let backtestTradesPage = 0;
let activeBacktestResult = null;
const selectedBacktestRuns = new Set();
const selectedBacktestSymbols = new Set();
const quickAnalysisCache = new Map();
const quickAnalysisRequests = new Map();
let paperStore = null;
let paperAccount = null;
let paperTickTimer = null;
let paperTickInProgress = false;
let paperDataFresh = false;
let paperHistoryPage = 0;
let selectedPaperSymbols = new Set(["BTCUSDT", "ETHUSDT"]);
let paperTickMessage = "Wacht op start.";
let paperLastUpdate = null;

function readSignalAudit() {
  try {
    const stored = JSON.parse(localStorage.getItem(SIGNAL_STORAGE_KEY) || "{}");
    if (stored && typeof stored === "object") {
      for (const item of Array.isArray(stored.snapshots) ? stored.snapshots.slice(-300) : []) {
        if (typeof item?.symbol === "string" && item.result?.label) signalSnapshots.set(item.symbol, item);
      }
      signalChanges = Array.isArray(stored.changes) ? stored.changes.filter((item) => item && typeof item.symbol === "string").slice(-200) : [];
    }
  } catch (_) { /* Lokale opslag kan uitgeschakeld zijn; de scan werkt dan alleen tijdens deze sessie. */ }
}

function saveSignalAudit() {
  try {
    localStorage.setItem(SIGNAL_STORAGE_KEY, JSON.stringify({ snapshots: [...signalSnapshots.values()].slice(-300), changes: signalChanges.slice(-200) }));
    return true;
  } catch (_) { return false; }
}

function compactSignalResult(result) {
  return { available: result.available, label: result.label, score: result.score, alignment: result.alignment,
    frameCount: result.frameCount, disagreement: result.disagreement, frameSummary: result.frameSummary,
    reasonsFor: result.reasonsFor, reasonsAgainst: result.reasonsAgainst, reason: result.reason, analyzedAt: result.analyzedAt, audit: result.audit };
}

function signalClass(label) {
  return label?.includes("VERKOPEN") ? "signal-negative" : label?.includes("KOPEN") ? "signal-positive" : "signal-neutral";
}

function renderSignalChanges() {
  const target = byId("signal-changes");
  const list = byId("signal-history-list");
  byId("history-count").textContent = `${signalChanges.length} wijzigingen`;
  const recent = signalChanges.slice(-5).reverse();
  target.textContent = recent.length ? recent.map((item) => `${SYMBOLS.get(item.symbol)?.display || item.symbol}: ${item.oldLabel} → ${item.newLabel} · ${formatLocalTime(item.changedAt)}`).join(" | ") : "Nog geen wijzigingen.";
  list.replaceChildren();
  if (!signalChanges.length) { list.textContent = "Nog geen signaalwijzigingen. De eerste scan vormt de beginmeting."; return; }
  for (const item of signalChanges.slice(-20).reverse()) {
    const row = document.createElement("div"); row.className = "history-change-row";
    const pair = document.createElement("strong"); pair.textContent = SYMBOLS.get(item.symbol)?.display || item.symbol;
    const change = document.createElement("span"); change.textContent = `${item.oldLabel} → ${item.newLabel}`;
    const time = document.createElement("small"); time.textContent = formatLocalTime(item.changedAt);
    row.append(pair, change, time); list.append(row);
  }
}

function renderSignalDetail(symbol = activeSignalSymbol) {
  activeSignalSymbol = symbol;
  const snapshot = signalSnapshots.get(symbol);
  const display = SYMBOLS.get(symbol)?.display || symbol?.replace(/USDT$/, "/USDT") || "";
  byId("detail-signal-pair").textContent = display ? `${display} · ${snapshot ? "laatste opgeslagen scan" : "nog niet gescand"}` : "Selecteer een munt en voer een scan uit";
  byId("detail-signal-badge").textContent = snapshot ? snapshot.result.label : "NOG NIET GESCAND";
  byId("detail-signal-badge").className = `sample-label ${snapshot ? signalClass(snapshot.result.label) : ""}`;
  byId("detail-signal-label").textContent = snapshot ? snapshot.result.label : "Nog geen beoordeling";
  byId("detail-signal-label").className = `detail-signal-label ${snapshot ? signalClass(snapshot.result.label) : ""}`;
  byId("detail-signal-alignment").textContent = snapshot && snapshot.result.alignment !== null ? `${snapshot.result.alignment}% factorovereenstemming` : "—";
  byId("detail-signal-score").textContent = snapshot && snapshot.result.score !== null ? `${snapshot.result.score} / 100` : "—";
  byId("detail-signal-time").textContent = snapshot ? formatLocalTime(snapshot.timestamp) : "—";
  const frameTarget = byId("detail-timeframes"); frameTarget.replaceChildren();
  if (snapshot?.result.frameSummary) {
    for (const interval of SIGNAL_INTERVALS) {
      const info = snapshot.result.frameSummary[interval];
      const item = document.createElement("span"); item.textContent = info ? `${interval}: ${info.direction} (${info.score})` : `${interval}: niet beschikbaar`; frameTarget.append(item);
    }
    if (snapshot.result.disagreement) { const note = document.createElement("strong"); note.textContent = "Let op: tijdsframes spreken elkaar tegen."; frameTarget.append(note); }
    if (snapshot.result.reason) { const note = document.createElement("strong"); note.textContent = snapshot.result.reason; frameTarget.append(note); }
  } else frameTarget.textContent = "Tijdsframes verschijnen na de scan.";
  for (const [id, values] of [["signal-reasons-for", snapshot?.result.reasonsFor || []], ["signal-reasons-against", snapshot?.result.reasonsAgainst || []]]) {
    const list = byId(id); list.replaceChildren();
    if (!values.length) { const item = document.createElement("li"); item.textContent = "Geen beschikbare gegevens in deze richting."; list.append(item); }
    else for (const value of values) { const item = document.createElement("li"); item.textContent = value; list.append(item); }
  }
}

function renderSignalScanner() {
  const rows = byId("signal-rows"); rows.replaceChildren();
  const entries = [...signalSnapshots.values()].sort((a, b) => (b.result.alignment || 0) - (a.result.alignment || 0));
  if (!entries.length) { const row = document.createElement("tr"); const cell = marketCell("Nog geen volledige scans. Er worden geen voorbeeldsignalen getoond.", "table-placeholder"); cell.colSpan = 8; row.append(cell); rows.append(row); }
  for (const item of entries) {
    const row = document.createElement("tr"); row.className = "signal-result-row";
    const pair = document.createElement("button"); pair.type = "button"; pair.className = "pair-open"; pair.textContent = SYMBOLS.get(item.symbol)?.display || item.symbol.replace(/USDT$/, "/USDT");
    pair.addEventListener("click", () => { byId("symbol-select").value = item.symbol; renderSignalDetail(item.symbol); byId("signaal-detail").scrollIntoView({ behavior: "smooth", block: "start" }); refreshMarket(); });
    const pairCell = document.createElement("td"); pairCell.append(pair); row.append(pairCell);
    const labelCell = marketCell(item.result.label); labelCell.className = signalClass(item.result.label); row.append(labelCell);
    row.append(marketCell(item.result.alignment === null ? "—" : `${item.result.alignment}%`)); row.append(marketCell(item.result.score === null ? "—" : String(item.result.score)));
    const firstFrame = item.result.frameSummary?.["4h"] || item.result.frameSummary?.["1d"] || item.result.frameSummary?.["1h"];
    row.append(marketCell(firstFrame?.direction || "—"));
    row.append(marketCell(Number.isFinite(item.rsi) ? formatNumber(item.rsi, 1) : "—"));
    row.append(marketCell(item.macd || "—")); row.append(marketCell(formatLocalTime(item.timestamp)));
    row.addEventListener("click", (event) => { if (event.target !== pair) renderSignalDetail(item.symbol); });
    rows.append(row);
  }
  const interesting = byId("interesting-list"); interesting.replaceChildren();
  const picks = entries.filter((item) => item.result.available && item.result.label !== "GEEN ACTIE" && item.result.alignment >= 60).slice(0, 6);
  if (!picks.length) interesting.textContent = "Geen voldoende uitgesproken signaal in de opgeslagen scans.";
  for (const item of picks) { const chip = document.createElement("button"); chip.type = "button"; chip.className = `interesting-chip ${signalClass(item.result.label)}`; chip.textContent = `${item.symbol.replace(/USDT$/, "")}: ${item.result.label} · ${item.result.alignment}%`; chip.addEventListener("click", () => renderSignalDetail(item.symbol)); interesting.append(chip); }
  renderSignalChanges();
}

async function getSignalCandles(symbol, interval) {
  const key = `${symbol}:${interval}`; const cached = signalCandleCache.get(key);
  if (cached && Date.now() - cached.time < SIGNAL_CACHE_MS) return cached.candles;
  const rows = await getJson(`/klines?symbol=${symbol}&interval=${interval}&limit=210`);
  const candles = parseClosedCandles(rows);
  signalCandleCache.set(key, { time: Date.now(), candles });
  return candles;
}

async function analyzeSignalSymbol(symbol) {
  const market = marketSnapshot.get(symbol);
  if (!market || !SYMBOLS.has(symbol)) throw new Error("Deze markt is niet meer beschikbaar.");
  const outcomes = await Promise.allSettled(SIGNAL_INTERVALS.map(async (interval) => {
    const candles = await getSignalCandles(symbol, interval);
    return [interval, scoreSignalFrame(candles, market.lastPrice)];
  }));
  const frames = Object.fromEntries(outcomes.filter((outcome) => outcome.status === "fulfilled").map((outcome) => outcome.value));
  for (let index = 0; index < SIGNAL_INTERVALS.length; index += 1) {
    if (outcomes[index].status === "rejected") frames[SIGNAL_INTERVALS[index]] = { available: false, reason: "Marktgegevens tijdelijk niet beschikbaar.", factors: [], score: null, analysis: null };
  }
  const combined = combineSignalFrames(frames);
  combined.audit = Object.fromEntries(SIGNAL_INTERVALS.map((interval) => {
    const frame = frames[interval]; const analysis = frame.analysis;
    return [interval, { available: frame.available, score: frame.score, candleCount: frame.count || analysis?.count || 0,
      factors: frame.factors.map(({ key, direction, weight, evidence }) => ({ key, direction, weight, evidence })),
      readings: analysis ? { trend: analysis.trend, rsi: analysis.rsi, macd: analysis.macd.tone,
        macdValues: { line: analysis.macd.line, signal: analysis.macd.signal, histogram: analysis.macd.histogram },
        averages: { sma20: analysis.averages.sma20, sma50: analysis.averages.sma50, sma200: analysis.averages.sma200, ema20: analysis.averages.ema20, ema50: analysis.averages.ema50 },
        volume: analysis.volume ? { comparison: analysis.volume.comparison, latest: analysis.volume.latest, average: analysis.volume.average } : null,
        priceAbove: analysis.priceAbove } : null }];
  }));
  const result = compactSignalResult(combined);
  const previous = signalSnapshots.get(symbol);
  const changed = createSignalChange(previous, { ...result, symbol });
  if (changed) {
    signalChanges.push(changed);
    signalChanges = signalChanges.slice(-200);
  }
  const snapshot = { symbol, result, timestamp: Date.now(), rsi: frames["4h"]?.analysis?.rsi ?? frames["1h"]?.analysis?.rsi ?? null,
    macd: frames["4h"]?.analysis?.macd?.tone ?? frames["1h"]?.analysis?.macd?.tone ?? null };
  signalSnapshots.delete(symbol); signalSnapshots.set(symbol, snapshot);
  if (activeSignalSymbol === symbol) renderSignalDetail(symbol);
  return snapshot;
}

function buildAiAnalysisContext(symbol = byId("symbol-select").value) {
  const market = marketSnapshot.get(symbol);
  const snapshot = signalSnapshots.get(symbol);
  const audit = snapshot?.result?.audit || {};
  const missingData = [];
  if (!market || !(market.lastPrice > 0)) missingData.push("Actuele marktprijs ontbreekt.");
  if (!snapshot?.result?.available) missingData.push(snapshot?.result?.reason || "Voer eerst een technische scan uit voor deze munt.");
  const timeframes = Object.fromEntries(SIGNAL_INTERVALS.map((interval) => {
    const details = audit[interval];
    const cached = signalCandleCache.get(`${symbol}:${interval}`)?.candles || [];
    if (!details?.available) missingData.push(`${interval}: ${details?.reason || "indicatoren ontbreken"}`);
    if (!cached.length) missingData.push(`${interval}: recente historische koersgegevens ontbreken.`);
    return [interval, {
      available: details?.available === true,
      score: Number.isFinite(details?.score) ? details.score : null,
      candleCount: Number.isFinite(details?.candleCount) ? details.candleCount : 0,
      indicators: details?.readings || null,
      factors: Array.isArray(details?.factors) ? details.factors : [],
      recentCandles: cached.length ? cached.slice(-20).map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume })) : null,
    }];
  }));
  return {
    schemaVersion: 1,
    symbol,
    generatedAt: Date.now(),
    market: market ? { price: market.lastPrice, quoteCurrency: "USDT", source: "Binance Vision openbare marktgegevens", timestamp: marketSnapshotTime } : null,
    technicalSignal: snapshot?.result?.available ? {
      label: snapshot.result.label, score: snapshot.result.score, factorAlignment: snapshot.result.alignment,
      disagreement: snapshot.result.disagreement, timeframes: snapshot.result.frameSummary,
    } : null,
    timeframes,
    missingData: [...new Set(missingData)],
    earlierAnalysis: null,
  };
}

async function scanSymbols(symbols) {
  if (scanInProgress) return;
  const unique = [...new Set(symbols)].filter((symbol) => SYMBOLS.has(symbol));
  if (!unique.length) { byId("scan-status").textContent = "Selecteer munten of voeg munten toe aan je watchlist."; return; }
  scanInProgress = true;
  for (const id of ["scan-selected", "scan-watchlist"]) byId(id).disabled = true;
  let completed = 0; let failed = 0;
  byId("scan-status").textContent = `Scan gestart: 0 van ${unique.length} munten. Vier tijdsframes per munt.`;
  try {
    for (let start = 0; start < unique.length; start += 2) {
      const group = unique.slice(start, start + 2);
      const results = await Promise.allSettled(group.map((symbol) => analyzeSignalSymbol(symbol)));
      for (let i = 0; i < results.length; i += 1) {
        if (results[i].status === "fulfilled") completed += 1;
        else { failed += 1; signalSnapshots.set(group[i], { symbol: group[i], timestamp: Date.now(), result: { available: false, label: "ONVOLDOENDE GEGEVENS", score: null, alignment: null, reasonsFor: [], reasonsAgainst: [], reason: "Marktgegevens tijdelijk niet beschikbaar." } }); }
      }
      renderSignalScanner();
      byId("scan-status").textContent = `Bezig: ${completed + failed} van ${unique.length} munten · ${failed} niet beschikbaar.`;
    }
    const saved = saveSignalAudit();
    byId("scan-status").textContent = `Klaar: ${completed} geanalyseerd, ${failed} zonder volledige gegevens${saved ? " · resultaten lokaal bewaard" : " · lokale opslag niet beschikbaar"}.`;
  } finally {
    scanInProgress = false;
    for (const id of ["scan-selected", "scan-watchlist"]) byId(id).disabled = false;
  }
}

function readWatchlist() {
  try {
    const stored = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "[]");
    return new Set(Array.isArray(stored) ? stored.filter((item) => typeof item === "string" && /^[A-Z0-9]+USDT$/.test(item)) : []);
  } catch (_) {
    return new Set();
  }
}

function saveWatchlist() {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify([...watchlist]));
    return true;
  } catch (_) {
    return false;
  }
}

function formatEuro(value) {
  return new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(value);
}

function formatNumber(value, digits = 2) {
  return new Intl.NumberFormat("nl-BE", { maximumFractionDigits: digits }).format(value);
}

function formatLocalTime(timestamp) {
  return new Intl.DateTimeFormat("nl-BE", {
    timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "medium",
  }).format(new Date(timestamp));
}

async function getJson(path, externalSignal) {
  const timeoutSignal = AbortSignal.timeout(10_000);
  const requestSignal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`${MARKET_DATA_ROOT}${path}`, {
    method: "GET",
    mode: "cors",
    cache: "no-store",
    signal: requestSignal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`De gegevensbron antwoordde met status ${response.status}.`);
  return response.json();
}

function showError(message) {
  byId("market-error").textContent = message;
  byId("market-error").hidden = false;
  byId("current-price").textContent = "Niet beschikbaar";
  byId("last-update").textContent = "Geen actuele update";
  byId("data-state").innerHTML = "<span></span> Geen actuele verbinding";
  byId("data-state").classList.add("offline");
}

function clearError() {
  byId("market-error").hidden = true;
  byId("market-error").textContent = "";
  byId("data-state").classList.remove("offline");
}

function drawChart(candles) {
  const chart = byId("price-chart");
  const line = byId("chart-line");
  const labels = byId("chart-labels");
  const message = byId("chart-message");
  if (!candles.length) {
    line.setAttribute("d", "");
    byId("chart-sma20").setAttribute("d", "");
    byId("chart-sma50").setAttribute("d", "");
    byId("chart-sma200").setAttribute("d", "");
    labels.replaceChildren();
    message.textContent = "Er zijn nog geen historische gegevens beschikbaar.";
    message.hidden = false;
    chart.classList.add("empty");
    return;
  }

  const closes = candles.map((candle) => candle.close);
  const chartIndicators = calculateIndicators(candles, null).averages;
  const allValues = [...closes, ...chartIndicators.sma20Series, ...chartIndicators.sma50Series, ...chartIndicators.sma200Series].filter(Number.isFinite);
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const spread = max - min || Math.max(max * 0.002, 1);
  const left = 50;
  const right = 744;
  const top = 27;
  const bottom = 178;
  const toPath = (series) => {
    const points = series.map((value, index) => {
      if (!Number.isFinite(value)) return null;
      const x = left + (index / Math.max(series.length - 1, 1)) * (right - left);
      const y = bottom - ((value - min) / spread) * (bottom - top);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).filter(Boolean);
    return points.length ? `M ${points.join(" L ")}` : "";
  };
  const points = closes.map((value, index) => {
    const x = left + (index / Math.max(closes.length - 1, 1)) * (right - left);
    const y = bottom - ((value - min) / spread) * (bottom - top);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  line.setAttribute("d", `M ${points.join(" L ")}`);
  byId("chart-sma20").setAttribute("d", toPath(chartIndicators.sma20Series));
  byId("chart-sma50").setAttribute("d", toPath(chartIndicators.sma50Series));
  byId("chart-sma200").setAttribute("d", toPath(chartIndicators.sma200Series));
  labels.innerHTML = `<text x="4" y="30">${formatNumber(max, 2)}</text><text x="4" y="183">${formatNumber(min, 2)}</text><text x="48" y="211">${formatLocalTime(candles[0].time)}</text><text x="748" y="211" text-anchor="end">${formatLocalTime(candles[candles.length - 1].time)}</text>`;
  message.hidden = true;
  chart.classList.remove("empty");
}

function clearCandleDetails() {
  for (const id of ["ohlc-time", "ohlc-open", "ohlc-high", "ohlc-low", "ohlc-close", "ohlc-volume"]) byId(id).textContent = "—";
}

function parseClosedCandles(rows) {
  if (!Array.isArray(rows)) return [];
  const now = Date.now();
  return rows.map((row) => ({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
    low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), closeTime: Number(row[6]),
  })).filter((candle) => Object.values(candle).every(Number.isFinite)
    && candle.close > 0 && candle.open > 0 && candle.high >= candle.low
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.volume >= 0 && candle.closeTime <= now);
}

function showValueOrNotEnough(value, formatter) {
  return Number.isFinite(value) ? formatter(value) : "Onvoldoende gegevens";
}

function renderAnalysis(candles, currentPrice, usdPerEuro, symbol) {
  const analysis = calculateIndicators(candles, currentPrice);
  const quoteToEuro = 1 / usdPerEuro;
  const formatIndicatorPrice = (value) => formatEuro(value * quoteToEuro);
  byId("analysis-pair").textContent = `${SYMBOLS.get(symbol).display} · ${currentAnalysisInterval}`;
  byId("trend-value").textContent = analysis.trend.toLocaleUpperCase("nl-BE");
  byId("trend-value").className = analysis.trend === "Stijgend" ? "trend-up"
    : analysis.trend === "Dalend" ? "trend-down" : "trend-neutral";
  byId("rsi-value").textContent = showValueOrNotEnough(analysis.rsi, (value) => formatNumber(value, 2));
  byId("rsi-note").textContent = analysis.rsiTone === "Onvoldoende gegevens" ? analysis.rsiTone : `${analysis.rsiTone} · 30/70 zijn referentiegrenzen`;
  byId("macd-state").textContent = analysis.macd.tone.toLocaleUpperCase("nl-BE");
  byId("macd-note").textContent = "MACD-lijn vergeleken met de signaallijn; geen handelsadvies";
  byId("macd-line").textContent = showValueOrNotEnough(analysis.macd.line, formatIndicatorPrice);
  byId("macd-signal").textContent = showValueOrNotEnough(analysis.macd.signal, formatIndicatorPrice);
  byId("macd-histogram").textContent = showValueOrNotEnough(analysis.macd.histogram, formatIndicatorPrice);
  byId("volume-state").textContent = analysis.volume ? analysis.volume.comparison.toLocaleUpperCase("nl-BE") : "Onvoldoende gegevens";
  byId("volume-note").textContent = analysis.volume
    ? `Laatste gesloten: ${formatNumber(analysis.volume.latest, 4)} ${symbol.replace("USDT", "")} · gemiddelde ${formatNumber(analysis.volume.average, 4)}`
    : "Minstens 21 gesloten perioden nodig";

  for (const period of [20, 50, 200]) {
    const key = `sma${period}`;
    byId(`${key}-value`).textContent = showValueOrNotEnough(analysis.averages[key], formatIndicatorPrice);
    byId(`${key}-position`).textContent = analysis.priceAbove[key] === null
      ? "Prijsvergelijking niet beschikbaar"
      : analysis.priceAbove[key] ? `Huidige prijs boven SMA ${period}` : `Huidige prijs onder SMA ${period}`;
  }
  for (const period of [20, 50]) {
    const key = `ema${period}`;
    byId(`${key}-value`).textContent = showValueOrNotEnough(analysis.averages[key], formatIndicatorPrice);
  }

  const requiredHistory = 200;
  const sufficiency = candles.length < requiredHistory
    ? `Er zijn ${candles.length} afgesloten tijdvakken. Voor SMA 200 zijn minstens 200 nodig; ontbrekende waarden blijven leeg.`
    : `${candles.length} volledig afgesloten tijdvakken gebruikt.`;
  byId("analysis-state").textContent = `${sufficiency} Laatst bijgewerkt: ${formatLocalTime(Date.now())}.`;
  byId("analysis-error").hidden = true;
  byId("analysis-error").textContent = "";
}

function buildMarketOptions(selectedSymbol) {
  const select = byId("symbol-select");
  const markets = [...SYMBOLS.entries()].sort((left, right) => {
    const volumeDifference = (marketSnapshot.get(right[0])?.quoteVolume || 0) - (marketSnapshot.get(left[0])?.quoteVolume || 0);
    return volumeDifference || left[0].localeCompare(right[0]);
  });
  select.replaceChildren();
  for (const [symbol, info] of markets) {
    const option = document.createElement("option");
    option.value = symbol;
    option.textContent = `${info.display} · ${info.asset}`;
    select.append(option);
  }
  if (SYMBOLS.has(selectedSymbol)) select.value = selectedSymbol;
  else if (SYMBOLS.has("BTCUSDT")) select.value = "BTCUSDT";
  else select.value = markets[0]?.[0] || "";
}

function updateSelectionCount() {
  byId("selected-count").textContent = String(selectedMarkets.size);
  byId("watchlist-count").textContent = String(watchlist.size);
}

function marketCell(text, className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = text;
  return cell;
}

function updateOverviewRow(symbol, analysis, error = false) {
  const row = document.getElementById(`overview-${symbol}`);
  if (!row) return;
  if (error) {
    for (const className of ["overview-trend", "overview-rsi", "overview-macd", "overview-volume"]) {
      row.querySelector(`.${className}`).textContent = "Niet beschikbaar";
    }
    return;
  }
  row.querySelector(".overview-trend").textContent = analysis.trend.toLocaleUpperCase("nl-BE");
  row.querySelector(".overview-rsi").textContent = Number.isFinite(analysis.rsi)
    ? `${formatNumber(analysis.rsi, 1)} · ${analysis.rsiTone.replace(/ \(.+/, "")}` : "Onvoldoende data";
  row.querySelector(".overview-macd").textContent = analysis.macd.tone;
  row.querySelector(".overview-volume").textContent = analysis.volume?.comparison || "Onvoldoende data";
  if (analysis.volume) row.querySelector(".overview-volume").title = `Laatste gesloten volume ${formatNumber(analysis.volume.latest, 4)}; gemiddelde ${formatNumber(analysis.volume.average, 4)}`;
}

async function getOverviewAnalysis(symbol, market) {
  const key = `${symbol}:${currentAnalysisInterval}`;
  const cached = quickAnalysisCache.get(key);
  if (cached && Date.now() - cached.time < OVERVIEW_CACHE_MS) return cached.value;
  if (quickAnalysisRequests.has(key)) return quickAnalysisRequests.get(key);
  const request = (async () => {
    const rows = await getJson(`/klines?symbol=${symbol}&interval=${currentAnalysisInterval}&limit=210`);
    const candles = parseClosedCandles(rows);
    const value = calculateIndicators(candles, Number(market.lastPrice));
    quickAnalysisCache.set(key, { time: Date.now(), value });
    if (quickAnalysisCache.size > 100) quickAnalysisCache.delete(quickAnalysisCache.keys().next().value);
    return value;
  })();
  quickAnalysisRequests.set(key, request);
  try { return await request; }
  finally { quickAnalysisRequests.delete(key); }
}

async function updateVisibleOverview(rows) {
  for (let start = 0; start < rows.length; start += 4) {
    const interval = currentAnalysisInterval;
    const group = rows.slice(start, start + 4);
    await Promise.all(group.map(async (market) => {
      try {
        const analysis = await getOverviewAnalysis(market.symbol, market);
        if (interval === currentAnalysisInterval) {
          updateOverviewRow(market.symbol, analysis);
        }
      } catch (error) {
        console.warn(`Overzichtsanalyse niet beschikbaar voor ${market.symbol}:`, error);
        if (interval === currentAnalysisInterval) updateOverviewRow(market.symbol, null, true);
      }
    }));
  }
}

function renderMarketOverview() {
  const search = byId("coin-search").value.trim().toUpperCase().replaceAll("/", "");
  const allMarkets = [...marketSnapshot.values()]
    .filter((market) => market.symbol.endsWith("USDT") && Number(market.lastPrice) > 0)
    .sort((left, right) => right.quoteVolume - left.quoteVolume);
  let filtered = allMarkets;
  if (watchlistOnly) filtered = filtered.filter((market) => watchlist.has(market.symbol));
  if (search) filtered = filtered.filter((market) => market.symbol.includes(search) || market.symbol.replace("USDT", "/USDT").includes(search));
  const limit = (currentMarketPage + 1) * MARKETS_PER_PAGE;
  const visible = filtered.slice(0, limit);
  const rows = byId("market-rows");
  rows.replaceChildren();

  if (!visible.length) {
    const empty = document.createElement("tr");
    const cell = marketCell(watchlistOnly && !watchlist.size ? "Je watchlist is nog leeg. Voeg een munt toe met de ster naast een markt." : "Geen markten gevonden. Pas je zoekopdracht aan.", "table-placeholder");
    cell.colSpan = 9;
    empty.append(cell);
    rows.append(empty);
  }

  for (const market of visible) {
    const symbol = market.symbol;
    const info = SYMBOLS.get(symbol) || { display: symbol.replace(/USDT$/, "/USDT"), asset: symbol.replace(/USDT$/, "") };
    const row = document.createElement("tr");
    row.id = `overview-${symbol}`;
    const selection = document.createElement("input");
    selection.type = "checkbox";
    selection.checked = selectedMarkets.has(symbol);
    selection.setAttribute("aria-label", `${info.display} selecteren`);
    selection.addEventListener("change", () => {
      if (selection.checked) selectedMarkets.add(symbol); else selectedMarkets.delete(symbol);
      updateSelectionCount();
    });
    const selectCell = document.createElement("td"); selectCell.append(selection); row.append(selectCell);

    const pairCell = document.createElement("td"); pairCell.className = "pair-cell";
    const pair = document.createElement("button"); pair.type = "button"; pair.className = "pair-open"; pair.textContent = info.display;
    pair.title = `Open detail voor ${info.display}`;
    pair.addEventListener("click", () => {
      byId("symbol-select").value = symbol;
      renderSignalDetail(symbol);
      byId("detail-markt").scrollIntoView({ behavior: "smooth", block: "start" });
      refreshMarket();
    });
    const baseName = document.createElement("small"); baseName.textContent = info.asset;
    pairCell.append(pair, baseName); row.append(pairCell);

    const euroPrice = Number(market.lastPrice) / currentEuroRate;
    row.append(marketCell(Number.isFinite(euroPrice) ? formatEuro(euroPrice) : "—", "overview-price"));
    row.append(marketCell("Laden…", "overview-trend"));
    row.append(marketCell("Laden…", "overview-rsi"));
    row.append(marketCell("Laden…", "overview-macd"));
    const volumeCell = marketCell("Laden…", "overview-volume"); row.append(volumeCell);
    row.append(marketCell(formatLocalTime(marketSnapshotTime), "overview-update"));

    const watchCell = document.createElement("td");
    const watchButton = document.createElement("button");
    watchButton.type = "button"; watchButton.className = `watch-star${watchlist.has(symbol) ? " on-watchlist" : ""}`;
    watchButton.textContent = watchlist.has(symbol) ? "★" : "☆";
    watchButton.title = watchlist.has(symbol) ? "Verwijder uit watchlist" : "Voeg toe aan watchlist";
    watchButton.setAttribute("aria-label", watchButton.title);
    watchButton.addEventListener("click", () => {
      if (watchlist.has(symbol)) watchlist.delete(symbol); else watchlist.add(symbol);
      const saved = saveWatchlist();
      updateSelectionCount();
      byId("market-list-message").textContent = saved ? "Watchlist op deze computer bewaard." : "Opslaan is door deze browser niet beschikbaar.";
      renderMarketOverview();
    });
    watchCell.append(watchButton); row.append(watchCell);
    rows.append(row);
  }

  byId("market-count").textContent = `${allMarkets.length} actieve USDT-markten · ${filtered.length} gevonden · ${visible.length} getoond`;
  byId("load-more-markets").hidden = visible.length >= filtered.length;
  byId("watchlist-filter").classList.toggle("selected", watchlistOnly);
  updateSelectionCount();
  byId("market-list-message").textContent = `Overzichtsberekeningen voor ${currentAnalysisInterval} worden per zichtbare munt geladen.`;
  void updateVisibleOverview(visible);
}

function loadMarketSnapshot(rows, selectedSymbol) {
  if (!Array.isArray(rows)) throw new Error("De marktbron gaf geen marktlijst terug.");
  const nextSymbols = new Map();
  const nextMarkets = new Map();
  for (const item of rows) {
    const symbol = String(item.symbol || "");
    if (!symbol.endsWith("USDT")) continue;
    const lastPrice = Number(item.lastPrice);
    const quoteVolume = Number(item.quoteVolume);
    if (!(lastPrice > 0) || !Number.isFinite(quoteVolume) || quoteVolume < 0) continue;
    const asset = symbol.slice(0, -4);
    nextSymbols.set(symbol, { display: `${asset}/USDT`, asset });
    nextMarkets.set(symbol, { symbol, lastPrice, quoteVolume });
  }
  if (!nextMarkets.size) throw new Error("De marktbron heeft geen actieve USDT-markten teruggegeven.");
  SYMBOLS.clear();
  for (const [symbol, details] of nextSymbols) SYMBOLS.set(symbol, details);
  marketSnapshot = nextMarkets;
  marketSnapshotTime = Date.now();
  buildMarketOptions(selectedSymbol);
  renderMarketOverview();
  renderBacktestSymbolOptions();
  updatePaperSymbolOptions();
}

function displayCandle(candle) {
  byId("ohlc-time").textContent = formatLocalTime(candle.time);
  byId("ohlc-open").textContent = `${formatNumber(candle.open, 4)} USDT`;
  byId("ohlc-high").textContent = `${formatNumber(candle.high, 4)} USDT`;
  byId("ohlc-low").textContent = `${formatNumber(candle.low, 4)} USDT`;
  byId("ohlc-close").textContent = `${formatNumber(candle.close, 4)} USDT`;
  byId("ohlc-volume").textContent = formatNumber(candle.volume, 4);
}

async function refreshMarket() {
  if (!INTERVALS.has(currentInterval) || !ANALYSIS_INTERVALS.has(currentAnalysisInterval)) return;
  const previousSymbol = byId("symbol-select").value;
  const thisRequest = ++requestNumber;
  byId("refresh-button").disabled = true;
  byId("refresh-button").classList.add("loading");
  byId("data-state").innerHTML = "<span></span> Marktgegevens ophalen";
  try {
    const marketRows = await getJson("/ticker/24hr?type=MINI");
    if (thisRequest !== requestNumber) return;
    loadMarketSnapshot(marketRows, previousSymbol);
    const symbol = byId("symbol-select").value;
    const selectedSymbol = SYMBOLS.get(symbol);
    const ticker = marketSnapshot.get(symbol);
    if (!selectedSymbol || !ticker) throw new Error("De geselecteerde markt is niet beschikbaar.");

    const chartPromise = getJson(`/klines?symbol=${symbol}&interval=${currentInterval}&limit=${HISTORY_LIMIT}`);
    const analysisPromise = currentAnalysisInterval === currentInterval
      ? chartPromise : getJson(`/klines?symbol=${symbol}&interval=${currentAnalysisInterval}&limit=${HISTORY_LIMIT}`);
    const [eurResult, chartResult, analysisResult] = await Promise.allSettled([
      getJson("/ticker/price?symbol=EURUSDT"), chartPromise, analysisPromise,
    ]);
    if (thisRequest !== requestNumber) return;

    if (eurResult.status === "fulfilled" && Number(eurResult.value.price) > 0) {
      currentEuroRate = Number(eurResult.value.price);
      clearError();
      byId("current-price").textContent = formatEuro(Number(ticker.lastPrice) / currentEuroRate);
      byId("selected-pair").textContent = `${selectedSymbol.display} · ${selectedSymbol.asset} · omgerekend met EUR/USDT`;
      byId("last-update").textContent = formatLocalTime(marketSnapshotTime);
      byId("data-state").innerHTML = "<span></span> Echte actuele gegevens";
      byId("chart-pair").textContent = selectedSymbol.display;
      byId("analysis-pair").textContent = `${selectedSymbol.display} · ${currentAnalysisInterval}`;
      renderMarketOverview();
    } else {
      showError("De eurokoers is nu niet beschikbaar. Probeer straks opnieuw.");
    }

    if (chartResult.status === "fulfilled") {
      const chartCandles = parseClosedCandles(chartResult.value);
      if (chartCandles.length) {
        byId("chart-description").textContent = `Slotprijs in USDT · ${chartCandles.length} gesloten perioden van ${currentInterval}`;
        byId("history-state").textContent = `Echte historische gegevens · ${chartCandles.length} gesloten perioden · tijd in Brussel · volume in ${selectedSymbol.asset}`;
        drawChart(chartCandles);
        displayCandle(chartCandles[chartCandles.length - 1]);
      } else {
        drawChart([]);
        clearCandleDetails();
        byId("chart-message").textContent = "Er zijn onvoldoende geldige historische gegevens voor de grafiek.";
        byId("chart-message").hidden = false;
        byId("history-state").textContent = "De gegevensbron heeft geen volledig afgesloten koersperioden teruggegeven.";
      }
    } else {
      drawChart([]);
      clearCandleDetails();
      byId("chart-message").textContent = "Historische koersgegevens zijn nu niet beschikbaar.";
      byId("chart-message").hidden = false;
      byId("history-state").textContent = "De grafiek kon niet worden bijgewerkt; eerdere gegevens kunnen verouderd zijn.";
    }

    if (analysisResult.status === "fulfilled" && eurResult.status === "fulfilled" && Number(eurResult.value.price) > 0) {
      const analysisCandles = parseClosedCandles(analysisResult.value);
      byId("analysis-pair").textContent = `${selectedSymbol.display} · ${currentAnalysisInterval}`;
      renderAnalysis(analysisCandles, Number(ticker.lastPrice), currentEuroRate, symbol);
    } else if (analysisResult.status !== "fulfilled") {
      byId("analysis-error").textContent = "De technische gegevens voor deze munt zijn tijdelijk niet bereikbaar. Eerdere waarden kunnen verouderd zijn.";
      byId("analysis-error").hidden = false;
      byId("analysis-state").textContent = "De analyse kon niet worden bijgewerkt.";
    }

    if (eurResult.status !== "fulfilled" || !(Number(eurResult.value?.price) > 0)) {
      currentEuroRate = NaN;
      renderMarketOverview();
      byId("analysis-error").textContent = "De analysegegevens voor deze munt zijn tijdelijk niet bereikbaar. De getoonde waarden kunnen nog van de vorige update zijn.";
      byId("analysis-error").hidden = false;
      byId("analysis-state").textContent = "Omrekening naar euro is niet beschikbaar; de technische waarden zijn niet bijgewerkt.";
    }
  } catch (error) {
    if (thisRequest !== requestNumber) return;
    showError("De marktgegevens zijn nu niet bereikbaar. Controleer je internetverbinding en probeer opnieuw.");
    byId("analysis-error").textContent = "De gegevens konden niet worden vernieuwd. Eventuele eerdere waarden zijn mogelijk verouderd.";
    byId("analysis-error").hidden = false;
    byId("history-state").textContent = "Historische gegevens zijn niet bijgewerkt. Eerder geladen gegevens kunnen verouderd zijn.";
    if (!byId("chart-line").getAttribute("d")) byId("chart-message").textContent = "Historische gegevens zijn nu niet beschikbaar.";
    byId("market-list-message").textContent = marketSnapshot.size
      ? "De lijst kon niet vernieuwd worden. De getoonde markten kunnen verouderd zijn."
      : "De muntenlijst is niet beschikbaar. Controleer je internetverbinding en probeer opnieuw.";
    if (!marketSnapshot.size) {
      byId("market-count").textContent = "Markten niet beschikbaar";
      const placeholder = document.createElement("tr");
      const cell = marketCell("Er konden geen openbare markten worden opgehaald.", "table-placeholder");
      cell.colSpan = 9;
      placeholder.append(cell);
      byId("market-rows").replaceChildren(placeholder);
    }
    console.warn("Marktgegevens niet beschikbaar:", error);
  } finally {
    if (thisRequest === requestNumber) {
      byId("refresh-button").disabled = false;
      byId("refresh-button").classList.remove("loading");
    }
  }
}

byId("refresh-button").addEventListener("click", refreshMarket);
byId("symbol-select").addEventListener("change", () => { activeSignalSymbol = byId("symbol-select").value; renderSignalDetail(activeSignalSymbol); refreshMarket(); });
byId("scan-selected").addEventListener("click", () => void scanSymbols([...selectedMarkets]));
byId("scan-watchlist").addEventListener("click", () => void scanSymbols([...watchlist]));
byId("ai-analysis-button").addEventListener("click", () => {
  try { void requestAiAnalysis(buildAiAnalysisContext()); }
  catch (_) { byId("ai-connection-status").textContent = "De analysegegevens zijn nog niet compleet. De rest van de app blijft beschikbaar."; }
});
byId("coin-search").addEventListener("input", () => { currentMarketPage = 0; renderMarketOverview(); });
byId("watchlist-filter").addEventListener("click", () => { watchlistOnly = !watchlistOnly; currentMarketPage = 0; renderMarketOverview(); });
byId("load-more-markets").addEventListener("click", () => { currentMarketPage += 1; renderMarketOverview(); });
document.querySelectorAll("[data-interval]").forEach((button) => {
  button.addEventListener("click", () => {
    currentInterval = button.dataset.interval;
    document.querySelectorAll("[data-interval]").forEach((item) => item.classList.toggle("selected", item === button));
    refreshMarket();
  });
});
document.querySelectorAll("[data-analysis-interval]").forEach((button) => {
  button.addEventListener("click", () => {
    currentAnalysisInterval = button.dataset.analysisInterval;
    quickAnalysisCache.clear();
    document.querySelectorAll("[data-analysis-interval]").forEach((item) => item.classList.toggle("selected", item === button));
    renderMarketOverview();
    refreshMarket();
  });
});
byId("load-more-markets").hidden = true;

// Fase 5: alleen openbare candles ophalen en virtuele Fase 3-simulaties uitvoeren.
const BACKTEST_PAGE_SIZE = 1000;
const BACKTEST_TRADE_PAGE_SIZE = 25;
const BACKTEST_HISTORY_LIMIT = 5;
const BACKTEST_WARMUP_CANDLES = 210;
const APP_BACKTEST_INTERVAL_MS = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

function backtestDateString(date) {
  const year = date.getFullYear();
  return `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function initializeBacktestControls() {
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 86_400_000);
  byId("backtest-start-date").value = backtestDateString(start);
  byId("backtest-end-date").value = backtestDateString(end);
  byId("backtest-symbol-search").addEventListener("input", renderBacktestSymbolOptions);
  byId("backtest-symbols").addEventListener("change", () => {
    const select = byId("backtest-symbols");
    const visibleValues = new Set([...select.options].map((option) => option.value).filter(Boolean));
    for (const symbol of visibleValues) selectedBacktestSymbols.delete(symbol);
    for (const option of select.selectedOptions) selectedBacktestSymbols.add(option.value);
    select.dataset.touched = "true";
  });
  byId("backtest-use-watchlist").addEventListener("click", () => selectBacktestSymbols(watchlist));
  byId("backtest-use-selected").addEventListener("click", () => selectBacktestSymbols(selectedMarkets));
  byId("backtest-start").addEventListener("click", () => void startBacktest());
  byId("backtest-cancel").addEventListener("click", () => backtestController?.abort());
  byId("backtest-trades-prev").addEventListener("click", () => renderBacktestTrades(backtestTradesPage - 1));
  byId("backtest-trades-next").addEventListener("click", () => renderBacktestTrades(backtestTradesPage + 1));
  byId("backtest-compare").addEventListener("click", renderBacktestComparison);
  renderBacktestSymbolOptions();
}

function renderBacktestSymbolOptions() {
  const select = byId("backtest-symbols");
  if (!select) return;
  const query = byId("backtest-symbol-search").value.trim().toUpperCase().replace("/", "");
  const previous = new Set(selectedBacktestSymbols);
  const symbols = [...SYMBOLS.values()].filter((item) => !query || item.symbol.includes(query) || item.display.replace("/", "").includes(query));
  select.replaceChildren();
  for (const item of symbols) {
    const option = document.createElement("option");
    option.value = item.symbol;
    option.textContent = item.display;
    option.selected = previous.has(item.symbol);
    select.append(option);
  }
  if (!select.dataset.touched && !previous.size) {
    for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
      const option = [...select.options].find((entry) => entry.value === symbol);
      if (option) { option.selected = true; selectedBacktestSymbols.add(symbol); }
    }
  }
  if (!symbols.length) {
    const option = document.createElement("option"); option.textContent = "Geen munten gevonden"; option.disabled = true; select.append(option);
  }
}

function selectBacktestSymbols(symbols) {
  const select = byId("backtest-symbols");
  const chosen = new Set(symbols);
  byId("backtest-symbol-search").value = "";
  selectedBacktestSymbols.clear();
  for (const symbol of chosen) selectedBacktestSymbols.add(symbol);
  renderBacktestSymbolOptions();
  for (const option of select.options) option.selected = chosen.has(option.value);
  select.dataset.touched = "true";
}

function updateBacktestProgress(label, completed, total) {
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round(completed / total * 100))) : 0;
  byId("backtest-progress-label").textContent = label;
  byId("backtest-progress-percent").textContent = `${percent}%`;
  byId("backtest-progress").value = percent;
}

async function fetchBacktestCandles(symbol, interval, from, until, signal, onPage) {
  const candles = [];
  const step = APP_BACKTEST_INTERVAL_MS[interval];
  let cursor = Math.max(0, from - BACKTEST_WARMUP_CANDLES * step);
  let page = 0;
  while (cursor < until) {
    if (signal.aborted) throw new DOMException("Backtest gestopt.", "AbortError");
    const params = new URLSearchParams({ symbol, interval, startTime: String(cursor), endTime: String(until - 1), limit: String(BACKTEST_PAGE_SIZE) });
    const rows = await getJson(`/klines?${params}`, signal);
    if (!rows.length) break;
    const parsed = parseClosedCandles(rows);
    candles.push(...parsed);
    page += 1;
    onPage?.(page);
    const next = Number(rows[rows.length - 1]?.[0]) + step;
    if (!Number.isFinite(next) || next <= cursor || rows.length < BACKTEST_PAGE_SIZE) break;
    cursor = next;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  const unique = new Map(candles.map((candle) => [candle.time, candle]));
  return [...unique.values()].sort((a, b) => a.time - b.time);
}

function readBacktestConfig() {
  const selected = [...byId("backtest-symbols").selectedOptions].map((option) => option.value).filter(Boolean);
  const startTime = Date.parse(`${byId("backtest-start-date").value}T00:00:00Z`);
  const endTime = Date.parse(`${byId("backtest-end-date").value}T00:00:00Z`) + 86_400_000;
  const config = {
    symbols: selected, interval: byId("backtest-interval").value, startTime, endTime,
    startCapital: Number(byId("backtest-capital").value), feePercent: Number(byId("backtest-fee").value),
    slippagePercent: Number(byId("backtest-slippage").value), maxPositionEur: Number(byId("backtest-max-position").value),
    stopLossPercent: Number(byId("backtest-stop").value), takeProfitPercent: Number(byId("backtest-target").value),
    maxOpenPositions: Number(byId("backtest-max-open").value),
  };
  validateBacktestConfig(config);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) throw new Error("Kies een geldige begin- en einddatum.");
  if (endTime > Date.now() + 86_400_000) throw new Error("De einddatum kan niet in de toekomst liggen.");
  if (endTime - startTime > 3 * 366 * 86_400_000) throw new Error("Kies een periode van maximaal drie jaar om de test beheersbaar te houden.");
  return config;
}

async function startBacktest() {
  if (backtestController) return;
  byId("backtest-error").hidden = true;
  byId("backtest-results").hidden = true;
  byId("backtest-progress-wrap").hidden = false;
  byId("backtest-start").disabled = true;
  byId("backtest-cancel").disabled = false;
  backtestController = new AbortController();
  const { signal } = backtestController;
  try {
    const config = readBacktestConfig();
    const span = config.endTime - config.startTime;
    const estimatedCandles = Math.ceil(span / APP_BACKTEST_INTERVAL_MS[config.interval]) * config.symbols.length;
    if (estimatedCandles > 500_000) throw new Error("Deze test bevat te veel candles. Kies minder munten, een kortere periode of grover tijdsframe.");
    const datasets = {};
    const warnings = [];
    const totalTasks = config.symbols.length * 4 + 1;
    let completedTasks = 0;
    const updateFetchProgress = (label) => updateBacktestProgress(label, completedTasks, totalTasks);
    for (let index = 0; index < config.symbols.length; index += 1) {
      const symbol = config.symbols[index];
      updateFetchProgress(`Historische gegevens ophalen: ${SYMBOLS.get(symbol)?.display || symbol} (${index + 1}/${config.symbols.length})`);
      const frameResults = await Promise.allSettled(BACKTEST_TIMEFRAMES.map(async (interval) => {
        const bars = await fetchBacktestCandles(symbol, interval, config.startTime, config.endTime, signal);
        completedTasks += 1; updateFetchProgress(`Historische gegevens opgehaald: ${SYMBOLS.get(symbol)?.display || symbol} · ${interval}`);
        return [interval, bars];
      }));
      const frames = {};
      let selectedFrameAvailable = false;
      frameResults.forEach((result, frameIndex) => {
        const interval = BACKTEST_TIMEFRAMES[frameIndex];
        if (result.status === "fulfilled") { frames[interval] = result.value[1]; if (interval === config.interval && frames[interval].length) selectedFrameAvailable = true; }
        else if (result.reason?.name === "AbortError") throw result.reason;
        else warnings.push(`${symbol.replace("USDT", "/USDT")} · ${interval}: gegevens konden niet worden opgehaald.`);
      });
      datasets[symbol] = frames;
      if (!selectedFrameAvailable) warnings.push(`${symbol.replace("USDT", "/USDT")} is overgeslagen: er ontbreken gegevens voor ${config.interval}.`);
    }
    const usableSymbols = config.symbols.filter((symbol) => datasets[symbol]?.[config.interval]?.length);
    if (!usableSymbols.length) throw new Error("Geen van de geselecteerde munten heeft bruikbare historische gegevens voor dit tijdsframe.");
    config.symbols = usableSymbols;
    updateFetchProgress("Historische euro-omrekening ophalen…");
    const euroCandles = await fetchBacktestCandles("EURUSDT", config.interval, config.startTime, config.endTime, signal);
    completedTasks = totalTasks;
    if (!euroCandles.some((candle) => candle.closeTime >= config.startTime && candle.closeTime <= config.endTime)) {
      throw new Error("De historische EUR/USDT-koers ontbreekt voor de testperiode. Er wordt geen euro-omrekening verzonnen.");
    }
    byId("backtest-status").textContent = "Koersen opgehaald; de virtuele simulatie wordt uitgevoerd.";
    const result = await runTechnicalBacktest({ config, datasets, euroCandles, warnings, signal, onProgress: (progress) => updateBacktestProgress("Technische signalen en virtuele uitkomsten berekenen…", progress.completed, progress.total) });
    result.name = byId("backtest-test-name").value.trim() || `Test ${backtestRuns.length + 1}`;
    result.createdAt = Date.now();
    result.id = `${result.createdAt}-${Math.random().toString(36).slice(2, 8)}`;
    backtestRuns.unshift(result);
    backtestRuns = backtestRuns.slice(0, BACKTEST_HISTORY_LIMIT);
    selectedBacktestRuns.clear();
    selectedBacktestRuns.add(result.id);
    activeBacktestResult = result;
    renderBacktestResult(result);
    renderBacktestRuns();
    byId("backtest-status").textContent = `Klaar: ${result.tradeCount} virtuele transacties.`;
  } catch (error) {
    if (error.name === "AbortError") byId("backtest-status").textContent = "Backtest gestopt. Er is geen transactie uitgevoerd.";
    else { byId("backtest-error").textContent = error.message || "De backtest kon niet worden uitgevoerd."; byId("backtest-error").hidden = false; byId("backtest-status").textContent = "Pas de instellingen aan of probeer later opnieuw."; }
  } finally {
    backtestController = null;
    byId("backtest-start").disabled = false;
    byId("backtest-cancel").disabled = true;
    byId("backtest-progress-wrap").hidden = true;
  }
}

function renderBacktestResult(result) {
  activeBacktestResult = result;
  byId("backtest-results").hidden = false;
  byId("backtest-result-title").textContent = result.name;
  byId("backtest-result-period").textContent = `${result.config.symbols.map((symbol) => SYMBOLS.get(symbol)?.display || symbol).join(", ")} · ${result.config.interval} · ${new Date(result.testStartTime).toLocaleDateString("nl-BE")} t/m ${new Date(result.testEndTime - 1).toLocaleDateString("nl-BE")}`;
  const warningTarget = byId("backtest-result-warnings");
  warningTarget.replaceChildren(); warningTarget.hidden = !result.warnings.length;
  result.warnings.forEach((warning) => { const item = document.createElement("div"); item.textContent = warning; warningTarget.append(item); });
  const metrics = [
    ["Startkapitaal", formatEuro(result.startCapital)], ["Eindvermogen", formatEuro(result.endingCapital)],
    ["Winst / verlies", `${formatEuro(result.totalProfitLoss)} (${formatNumber(result.returnPercent, 2)}%)`],
    ["Virtuele transacties", String(result.tradeCount)], ["Winnaars / verliezers", `${result.winningTrades} / ${result.losingTrades}`],
    ["Winpercentage", `${formatNumber(result.winRate, 1)}%`], ["Grootste winst", formatEuro(result.largestWin)],
    ["Grootste verlies", formatEuro(result.largestLoss)], ["Gemiddelde winst", formatEuro(result.averageWin)],
    ["Gemiddeld verlies", formatEuro(result.averageLoss)], ["Grootste terugval", `${formatNumber(result.maxDrawdownPercent, 2)}%`],
    ["Geteste periode", `${new Date(result.testStartTime).toLocaleDateString("nl-BE")} t/m ${new Date(result.testEndTime - 1).toLocaleDateString("nl-BE")}`],
    ["Totale transactiekosten", formatEuro(result.feesEur)], ["Totale slippage", formatEuro(result.slippageEur)],
    ["Rekentijd", `${formatNumber(result.durationMs / 1000, 1)} seconden`],
  ];
  const grid = byId("backtest-metrics"); grid.replaceChildren();
  for (const [label, value] of metrics) { const card = document.createElement("div"); card.className = "backtest-metric"; const title = document.createElement("small"); title.textContent = label; const content = document.createElement("strong"); content.textContent = value; card.append(title, content); grid.append(card); }
  byId("backtest-cost-note").textContent = `Ingestelde kosten: ${formatNumber(result.config.feePercent, 2)}% per koop en verkoop · slippage: ${formatNumber(result.config.slippagePercent, 2)}% per koop en verkoop · maximaal ${formatEuro(result.config.maxPositionEur)} per positie.`;
  drawBacktestEquity(result.equityCurve);
  renderBacktestTrades(0);
}

function drawBacktestEquity(points) {
  const path = byId("backtest-equity-line"); const labels = byId("backtest-equity-labels"); labels.replaceChildren();
  if (!points.length) { path.setAttribute("d", ""); return; }
  const values = points.map((item) => item.equity); const min = Math.min(...values); const max = Math.max(...values); const spread = max - min || Math.max(max * 0.01, 1);
  const coords = points.map((item, index) => `${55 + index / Math.max(points.length - 1, 1) * 800},${205 - (item.equity - min) / spread * 170}`);
  path.setAttribute("d", `M ${coords.join(" L ")}`);
  const low = document.createElementNS("http://www.w3.org/2000/svg", "text"); low.setAttribute("x", "5"); low.setAttribute("y", "205"); low.textContent = formatEuro(min);
  const high = document.createElementNS("http://www.w3.org/2000/svg", "text"); high.setAttribute("x", "5"); high.setAttribute("y", "35"); high.textContent = formatEuro(max);
  labels.append(low, high);
}

function renderBacktestTrades(page) {
  if (!activeBacktestResult) return;
  const trades = activeBacktestResult.trades; const pages = Math.max(1, Math.ceil(trades.length / BACKTEST_TRADE_PAGE_SIZE));
  backtestTradesPage = Math.max(0, Math.min(pages - 1, page));
  byId("backtest-trade-count").textContent = ` · ${trades.length} totaal`;
  byId("backtest-trades-page").textContent = `Pagina ${backtestTradesPage + 1} van ${pages}`;
  byId("backtest-trades-prev").disabled = backtestTradesPage === 0;
  byId("backtest-trades-next").disabled = backtestTradesPage + 1 >= pages;
  const body = byId("backtest-trades"); body.replaceChildren();
  const visible = trades.slice(backtestTradesPage * BACKTEST_TRADE_PAGE_SIZE, (backtestTradesPage + 1) * BACKTEST_TRADE_PAGE_SIZE);
  for (const trade of visible) {
    const row = document.createElement("tr");
    const fields = [formatLocalTime(trade.entryTime), formatLocalTime(trade.exitTime), SYMBOLS.get(trade.symbol)?.display || trade.symbol, formatNumber(trade.entryPriceUsdt, 8), formatNumber(trade.exitPriceUsdt, 8), formatNumber(trade.quantity, 8), formatEuro(trade.netProfitEur), trade.exitReason];
    for (const value of fields) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    const detailsCell = document.createElement("td"); const button = document.createElement("button"); button.type = "button"; button.textContent = "Bekijk uitleg";
    button.addEventListener("click", () => { const details = byId("backtest-trade-detail"); details.hidden = false; details.textContent = `${SYMBOLS.get(trade.symbol)?.display || trade.symbol}: Fase 3-label bij instap was ${trade.entryReasons.label} (score ${trade.entryReasons.score}). Positieve factoren: ${trade.entryReasons.reasonsFor.join("; ") || "geen"}. Tegensignalen: ${trade.entryReasons.reasonsAgainst.join("; ") || "geen"}. De koop is virtueel uitgevoerd op de volgende candle-opening; verkoopreden: ${trade.exitReason}.`; });
    detailsCell.append(button); row.append(detailsCell); body.append(row);
  }
  if (!trades.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 9; cell.textContent = "Er waren geen Fase 3-signalen die aan de koopregels voldeden."; row.append(cell); body.append(row); }
}

function renderBacktestRuns() {
  const container = byId("backtest-runs"); container.replaceChildren();
  byId("backtest-run-count").textContent = `${backtestRuns.length} tests`;
  if (!backtestRuns.length) { container.textContent = "Nog geen backtests uitgevoerd."; return; }
  for (const run of backtestRuns) {
    const item = document.createElement("label"); item.className = "backtest-run-item";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = selectedBacktestRuns.has(run.id); checkbox.disabled = !selectedBacktestRuns.has(run.id) && selectedBacktestRuns.size >= 2;
    checkbox.addEventListener("change", () => { checkbox.checked ? selectedBacktestRuns.add(run.id) : selectedBacktestRuns.delete(run.id); renderBacktestRuns(); });
    const text = document.createElement("span"); text.textContent = `${run.name} · ${run.config.interval} · ${run.config.symbols.length} munt(en) · ${formatEuro(run.totalProfitLoss)} (${formatNumber(run.returnPercent, 2)}%)`;
    const open = document.createElement("button"); open.type = "button"; open.textContent = "Openen"; open.addEventListener("click", () => renderBacktestResult(run));
    item.append(checkbox, text, open); container.append(item);
  }
  byId("backtest-compare").disabled = selectedBacktestRuns.size !== 2;
}

function renderBacktestComparison() {
  const selected = backtestRuns.filter((run) => selectedBacktestRuns.has(run.id));
  if (selected.length !== 2) return;
  const rows = [["Test", ...selected.map((run) => run.name)], ["Periode / tijdsframe", ...selected.map((run) => `${new Date(run.testStartTime).toLocaleDateString("nl-BE")} – ${new Date(run.testEndTime - 1).toLocaleDateString("nl-BE")} · ${run.config.interval}`)], ["Munten", ...selected.map((run) => run.config.symbols.map((symbol) => SYMBOLS.get(symbol)?.display || symbol).join(", "))], ["Eindvermogen", ...selected.map((run) => formatEuro(run.endingCapital))], ["Winst / verlies", ...selected.map((run) => `${formatEuro(run.totalProfitLoss)} (${formatNumber(run.returnPercent, 2)}%)`)], ["Transacties / winpercentage", ...selected.map((run) => `${run.tradeCount} / ${formatNumber(run.winRate, 1)}%`)], ["Grootste terugval", ...selected.map((run) => `${formatNumber(run.maxDrawdownPercent, 2)}%`)], ["Kosten / slippage", ...selected.map((run) => `${formatEuro(run.feesEur)} / ${formatEuro(run.slippageEur)}`)]];
  const table = document.createElement("table"); table.className = "market-table";
  for (const values of rows) { const tr = document.createElement("tr"); for (const value of values) { const cell = document.createElement(values[0] === value ? "th" : "td"); cell.textContent = value; tr.append(cell); } table.append(tr); }
  byId("backtest-comparison").replaceChildren(table); byId("backtest-comparison").hidden = false;
}

// Paper trading gebruikt verse leeskoersen en de bestaande Fase 3-signalen.
// Deze code roept zelf nooit een order-, wallet- of exchange-functie aan.
const PAPER_HISTORY_PAGE_SIZE = 50;

function paperSettingsFromForm(initialCapital = Number(byId("paper-capital").value)) {
  const symbols = [...byId("paper-symbols").selectedOptions].map((option) => option.value).filter(Boolean);
  return {
    initialCapitalEur: initialCapital, symbols,
    intervalMinutes: Number(byId("paper-interval").value), feePercent: Number(byId("paper-fee").value),
    slippagePercent: Number(byId("paper-slippage").value), maxPositionEur: Number(byId("paper-max-position").value),
    maxPositionPercent: Number(byId("paper-max-position-percent").value), maxOpenPositions: Number(byId("paper-max-open").value),
    maxExposurePercent: Number(byId("paper-max-exposure").value), stopLossPercent: Number(byId("paper-stop-percent").value),
    takeProfitPercent: Number(byId("paper-take-profit").value),
    riskProfile: byId("paper-risk-profile").value, riskPerTradePercent: Number(byId("paper-risk-trade").value),
    maxTotalRiskPercent: Number(byId("paper-risk-total").value), dailyLossLimitPercent: Number(byId("paper-daily-loss").value),
    maxDrawdownPercent: Number(byId("paper-max-drawdown").value), minRiskReward: Number(byId("paper-min-rr").value),
    stopLossMode: byId("paper-stop-mode").value, stopLossFixedEur: Number(byId("paper-stop-fixed").value),
  };
}

function updatePaperSymbolOptions() {
  const select = byId("paper-symbols");
  if (!select) return;
  const query = byId("paper-symbol-search").value.trim().toUpperCase().replace("/", "");
  const chosen = selectedPaperSymbols;
  const symbols = [...SYMBOLS.entries()].filter(([symbol, item]) => !query || symbol.includes(query) || item.display.replace("/", "").includes(query));
  select.replaceChildren();
  for (const [symbol, item] of symbols) {
    const option = document.createElement("option"); option.value = symbol; option.textContent = item.display; option.selected = chosen.has(symbol); select.append(option);
  }
  if (!symbols.length) { const option = document.createElement("option"); option.textContent = "Geen markten gevonden"; option.disabled = true; select.append(option); }
}

function selectPaperSymbols(symbols) {
  byId("paper-symbol-search").value = "";
  selectedPaperSymbols = new Set(symbols);
  updatePaperSymbolOptions();
  for (const option of byId("paper-symbols").options) option.selected = selectedPaperSymbols.has(option.value);
}

function syncPaperForm(account = paperAccount) {
  if (!account) return;
  byId("paper-capital").value = account.initialCapitalEur;
  byId("paper-capital").disabled = true;
  byId("paper-fee").value = account.feePercent;
  byId("paper-slippage").value = account.slippagePercent;
  byId("paper-max-position").value = account.maxPositionEur;
  byId("paper-max-position-percent").value = account.maxPositionPercent;
  byId("paper-max-open").value = account.maxOpenPositions;
  byId("paper-max-exposure").value = account.maxExposurePercent;
  byId("paper-stop-percent").value = account.stopLossPercent;
  byId("paper-take-profit").value = account.takeProfitPercent;
  byId("paper-risk-profile").value = account.riskProfile || "balanced";
  byId("paper-risk-trade").value = account.riskPerTradePercent ?? 1;
  byId("paper-risk-total").value = account.maxTotalRiskPercent ?? 3;
  byId("paper-daily-loss").value = account.dailyLossLimitPercent ?? 3;
  byId("paper-max-drawdown").value = account.maxDrawdownLimitPercent ?? 15;
  byId("paper-min-rr").value = account.minRiskReward ?? 1;
  byId("paper-stop-mode").value = account.stopLossMode || "percent";
  byId("paper-stop-fixed").value = account.stopLossFixedEur ?? 0;
  byId("paper-interval").value = String(account.intervalMinutes);
  selectedPaperSymbols = new Set(account.symbols);
  updatePaperSymbolOptions();
  updatePaperStopMode();
}

function showPaperError(message) {
  byId("paper-error").textContent = message;
  byId("paper-error").hidden = false;
}

async function persistPaperAccount(candidate, tradesAdded = []) {
  await paperStore.save(candidate, tradesAdded);
  paperAccount = candidate;
  renderPaperDashboard();
}

function accountWithPaperSettings(account, settings) {
  const candidate = { ...account, ...settings, lastUpdatedAt: Date.now() };
  candidate.initialCapitalEur = account.initialCapitalEur;
  candidate.maxDrawdownLimitPercent = settings.maxDrawdownPercent;
  delete candidate.maxDrawdownPercent;
  return candidate;
}

async function savePaperSettings() {
  byId("paper-error").hidden = true;
  try {
    const settings = paperSettingsFromForm(paperAccount?.initialCapitalEur);
    PaperTradingEngine.validateSettings(settings);
    if (!paperAccount) {
      paperAccount = PaperTradingEngine.createAccount(settings);
      await paperStore.save(paperAccount);
      syncPaperForm(paperAccount);
      paperTickMessage = "Virtuele rekening gemaakt en lokaal opgeslagen. Klik Start paper trading om te beginnen.";
      renderPaperDashboard();
      return;
    }
    const candidate = accountWithPaperSettings(paperAccount, settings);
    await persistPaperAccount(candidate);
    paperTickMessage = "Instellingen lokaal bewaard.";
    renderPaperDashboard();
    if (candidate.status !== "stopped") schedulePaperTick(candidate.status === "running" ? 0 : candidate.intervalMinutes * 60_000);
  } catch (error) { showPaperError(error.message || "De instellingen konden niet worden bewaard."); }
}

async function changePaperStatus(status) {
  if (!paperAccount) {
    if (status === "running") { await savePaperSettings(); if (!paperAccount) return; }
    else return;
  }
  byId("paper-error").hidden = true;
  if (status === "running" || status === "paused") {
    try {
      const settings = paperSettingsFromForm(paperAccount.initialCapitalEur);
      PaperTradingEngine.validateSettings(settings);
      paperAccount = accountWithPaperSettings(paperAccount, settings);
    } catch (error) { showPaperError(error.message); return; }
  }
  const previous = paperAccount;
  const candidate = PaperTradingEngine.setStatus(previous, status);
  try {
    await persistPaperAccount(candidate);
    paperTickMessage = status === "running" ? "Paper trading gestart. Er worden alleen virtuele transacties uitgevoerd."
      : status === "paused" ? "Gepauzeerd. Posities blijven staan; er worden geen virtuele transacties uitgevoerd."
        : "Gestopt. Posities en geschiedenis zijn lokaal bewaard.";
    if (status === "stopped") clearPaperTimer(); else schedulePaperTick(status === "running" ? 0 : status === "paused" ? 0 : previous.intervalMinutes * 60_000);
    renderPaperDashboard();
  } catch (error) { paperAccount = previous; showPaperError(error.message || "De status kon niet veilig worden opgeslagen."); }
}

async function resetPaperAccount() {
  const confirmed = window.confirm("Hiermee worden alle paper-tradingposities en resultaten van deze computer gewist. Doorgaan?");
  if (!confirmed) return;
  clearPaperTimer();
  byId("paper-error").hidden = true;
  try {
    const settings = paperSettingsFromForm();
    PaperTradingEngine.validateSettings(settings);
    await paperStore.reset();
    paperAccount = PaperTradingEngine.createAccount(settings);
    await paperStore.save(paperAccount);
    paperDataFresh = false;
    paperTickMessage = "De virtuele rekening en resultaten zijn gewist. Nieuwe oefenrekening lokaal opgeslagen.";
    syncPaperForm(paperAccount); renderPaperDashboard();
  } catch (error) { showPaperError(error.message || "De paperrekening kon niet worden gereset."); }
}

function clearPaperTimer() {
  if (paperTickTimer !== null) window.clearTimeout(paperTickTimer);
  paperTickTimer = null;
}

function schedulePaperTick(delayMs) {
  clearPaperTimer();
  if (!paperAccount || paperAccount.status === "stopped") return;
  paperTickTimer = window.setTimeout(async () => {
    await runPaperTick();
    if (paperAccount && paperAccount.status !== "stopped") schedulePaperTick(paperAccount.intervalMinutes * 60_000);
  }, Math.max(0, delayMs));
}

async function runPaperTick() {
  if (paperTickInProgress || !paperAccount || paperAccount.status === "stopped") return;
  paperTickInProgress = true;
  const statusAtStart = paperAccount.status;
  paperDataFresh = false;
  renderPaperDashboard();
  try {
    const selectedSymbol = byId("symbol-select").value;
    const [marketRows, euroQuote] = await Promise.all([
      getJson("/ticker/24hr?type=MINI"), getJson("/ticker/price?symbol=EURUSDT"),
    ]);
    if (!(Number(euroQuote.price) > 0)) throw new Error("De actuele EUR/USDT-koers ontbreekt.");
    loadMarketSnapshot(marketRows, selectedSymbol);
    currentEuroRate = Number(euroQuote.price);
    const marketTimestamp = marketSnapshotTime;
    const observations = [];
    const symbolsToFollow = [...new Set([...paperAccount.symbols, ...paperAccount.positions.map((position) => position.symbol)])].sort();
    for (const symbol of symbolsToFollow) {
      const market = marketSnapshot.get(symbol);
      const fresh = Boolean(market && market.lastPrice > 0 && currentEuroRate > 0 && Date.now() - marketTimestamp <= 90_000);
      const observation = {
        symbol, fresh, priceUsdt: market?.lastPrice, priceEur: market ? market.lastPrice / currentEuroRate : NaN,
        timestamp: marketTimestamp, signal: { available: false, label: "ONVOLDOENDE GEGEVENS", score: null }, aiAnalysis: null,
      };
      if (fresh && statusAtStart === "running") {
        try {
          for (const interval of SIGNAL_INTERVALS) signalCandleCache.delete(`${symbol}:${interval}`);
          const snapshot = await analyzeSignalSymbol(symbol);
          observation.signal = snapshot.result;
          const previousLabel = paperAccount.latestSignals[symbol]?.label;
          const isNewBuy = PaperTradingEngine.BUY_LABELS.includes(snapshot.result.label)
            && !PaperTradingEngine.BUY_LABELS.includes(previousLabel)
            && !paperAccount.positions.some((position) => position.symbol === symbol);
          if (isNewBuy && aiAnalysisAvailable) observation.aiAnalysis = await requestAiAnalysis(buildAiAnalysisContext(symbol));
        } catch (error) {
          observation.signal = { available: false, label: "ONVOLDOENDE GEGEVENS", score: null,
            reason: "Technische marktgegevens zijn tijdelijk niet beschikbaar." };
        }
      }
      observations.push(observation);
    }
    if (!paperAccount || paperAccount.status === "stopped") return;
    const result = PaperTradingEngine.applyCycle(paperAccount, observations, Date.now());
    await persistPaperAccount(result.account, result.tradesAdded);
    paperDataFresh = observations.length > 0 && observations.every((item) => item.fresh);
    paperLastUpdate = Date.now();
    const events = result.events;
    const opened = events.filter((event) => event.type === "opened").length;
    const closed = events.filter((event) => event.type === "closed").length;
    const rejected = events.filter((event) => event.type === "rejected");
    const unavailable = observations.filter((item) => !item.fresh).length;
    paperTickMessage = statusAtStart === "paused"
      ? `Gepauzeerd · verse koersen bijgewerkt voor ${observations.length - unavailable} van ${observations.length} munten. Geen virtuele transacties uitgevoerd.`
      : `Koersen en signalen bijgewerkt · ${opened} posities geopend · ${closed} gesloten${unavailable ? ` · ${unavailable} munten zonder verse koers` : ""}.`;
    if (rejected.length) paperTickMessage += ` ${rejected.map((event) => `${event.symbol.replace(/USDT$/, "")}: ${event.reason}`).join(" ")}`;
    if (unavailable) paperTickMessage += " Voor munten zonder verse koers zijn geen papertransacties uitgevoerd.";
    renderPaperDashboard();
  } catch (_) {
    paperDataFresh = false;
    paperTickMessage = "Marktgegevens zijn tijdelijk niet beschikbaar. Er wordt geen nieuwe papertransactie uitgevoerd; eerdere posities en resultaten blijven bewaard.";
    renderPaperDashboard();
  } finally { paperTickInProgress = false; }
}

function renderPaperSymbolFilter() {
  const select = byId("paper-filter-symbol"); const previous = select.value;
  const symbols = [...new Set([...(paperAccount?.symbols || []), ...(paperAccount?.trades || []).map((trade) => trade.symbol)])].sort();
  select.replaceChildren();
  const all = document.createElement("option"); all.value = ""; all.textContent = "Alle munten"; select.append(all);
  for (const symbol of symbols) { const option = document.createElement("option"); option.value = symbol; option.textContent = SYMBOLS.get(symbol)?.display || symbol.replace(/USDT$/, "/USDT"); select.append(option); }
  if (symbols.includes(previous)) select.value = previous;
}

function renderPaperHistory() {
  const body = byId("paper-history-rows"); body.replaceChildren();
  if (!paperAccount) return;
  const symbol = byId("paper-filter-symbol").value;
  const from = byId("paper-filter-from").value ? Date.parse(`${byId("paper-filter-from").value}T00:00:00Z`) : -Infinity;
  const to = byId("paper-filter-to").value ? Date.parse(`${byId("paper-filter-to").value}T00:00:00Z`) + 86_400_000 : Infinity;
  const side = byId("paper-filter-side").value; const resultFilter = byId("paper-filter-result").value;
  const query = byId("paper-filter-reason").value.trim().toLocaleLowerCase("nl-BE");
  const trades = paperAccount.trades.filter((trade) => trade.time >= from && trade.time < to
    && (!symbol || trade.symbol === symbol) && (!side || trade.side === side)
    && (!resultFilter || (trade.side === "VERKOOP" && (resultFilter === "win" ? trade.realizedProfitLossEur > 0 : trade.realizedProfitLossEur < 0)))
    && (!query || `${trade.reason} ${trade.signalLabel}`.toLocaleLowerCase("nl-BE").includes(query)))
    .sort((a, b) => b.time - a.time);
  byId("paper-trade-count").textContent = `${trades.length} transacties`;
  const pages = Math.max(1, Math.ceil(trades.length / PAPER_HISTORY_PAGE_SIZE));
  paperHistoryPage = Math.max(0, Math.min(pages - 1, paperHistoryPage));
  byId("paper-history-page").textContent = `Pagina ${paperHistoryPage + 1} van ${pages}`;
  byId("paper-history-prev").disabled = paperHistoryPage === 0;
  byId("paper-history-next").disabled = paperHistoryPage + 1 >= pages;
  const visible = trades.slice(paperHistoryPage * PAPER_HISTORY_PAGE_SIZE, (paperHistoryPage + 1) * PAPER_HISTORY_PAGE_SIZE);
  if (!visible.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 11; cell.className = "table-placeholder"; cell.textContent = "Geen transacties gevonden met deze filters."; row.append(cell); body.append(row); return; }
  for (const trade of visible) {
    const row = document.createElement("tr");
    const analysis = trade.aiAnalysis ? `${trade.aiAnalysis.label} · analyse-sterkte ${formatNumber(trade.aiAnalysis.confidence, 0)}%` : "Niet ingesteld / niet gebruikt";
    const values = [formatLocalTime(trade.time), SYMBOLS.get(trade.symbol)?.display || trade.symbol.replace(/USDT$/, "/USDT"), trade.side,
      `${formatEuro(trade.priceEur)} (${formatNumber(trade.priceUsdt, 8)} USDT)`, formatNumber(trade.quantity, 8), formatEuro(trade.feeEur),
      formatEuro(trade.slippageEur), trade.realizedProfitLossEur === null ? "—" : formatEuro(trade.realizedProfitLossEur), trade.reason,
      `${Number.isFinite(trade.stopLossEur) ? formatEuro(trade.stopLossEur) : "uit"} / ${Number.isFinite(trade.takeProfitEur) ? formatEuro(trade.takeProfitEur) : "uit"}`, analysis];
    for (const value of values) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    body.append(row);
  }
}

function renderPaperEquity() {
  const line = byId("paper-equity-line"); const labels = byId("paper-equity-labels");
  labels.replaceChildren();
  const points = paperAccount?.equity || [];
  if (!points.length) { line.setAttribute("d", ""); return; }
  const values = points.map((item) => item.valueEur); const min = Math.min(...values); const max = Math.max(...values); const spread = max - min || Math.max(max * 0.01, 1);
  line.setAttribute("d", `M ${points.map((item, index) => `${55 + index / Math.max(points.length - 1, 1) * 800},${190 - (item.valueEur - min) / spread * 155}`).join(" L ")}`);
  const low = document.createElementNS("http://www.w3.org/2000/svg", "text"); low.setAttribute("x", "5"); low.setAttribute("y", "190"); low.textContent = formatEuro(min);
  const high = document.createElementNS("http://www.w3.org/2000/svg", "text"); high.setAttribute("x", "5"); high.setAttribute("y", "35"); high.textContent = formatEuro(max);
  labels.append(low, high);
}

function renderPaperDashboard() {
  const configured = Boolean(paperAccount);
  const account = paperAccount;
  renderPaperRiskDashboard();
  const status = account?.status || "stopped";
  byId("paper-status-badge").textContent = !configured ? "REKENING INSTELLEN"
    : status === "running" ? "ACTIEF · VIRTUELE TRANSACTIES"
      : status === "paused" ? "GEPAUZEERD · POSITIES BEHOUDEN" : "GESTOPT · DATA BEWAARD";
  byId("paper-status-badge").className = `paper-state-badge ${status === "running" ? "is-running" : ""}`;
  byId("paper-start").disabled = status === "running";
  byId("paper-pause").disabled = !configured || status !== "running";
  byId("paper-stop").disabled = !configured || status === "stopped";
  byId("paper-reset").disabled = !configured;
  byId("paper-save-settings").disabled = !paperStore;
  byId("paper-capital").disabled = configured;
  byId("paper-status").textContent = paperTickMessage;
  byId("paper-ai-note").textContent = aiAnalysisAvailable
    ? "De bestaande AI-aansluiting is beschikbaar. AI-uitkomsten worden alleen na de Fase 4-controles bij een nieuwe paperpositie bewaard."
    : "AI-analyse is niet ingesteld. Oefenhandel gebruikt alleen de technische signalen uit Fase 3; er wordt geen AI-uitkomst verzonnen.";
  byId("paper-live-state").textContent = paperDataFresh ? "VERSE LIVE KOERSEN"
    : status === "running" || status === "paused" ? "GEEN VERSE KOERS · GEEN NIEUWE TRANSACTIES" : "WACHT OP START";
  byId("paper-live-state").className = `paper-live-state ${paperDataFresh ? "is-fresh" : "is-stale"}`;
  byId("paper-portfolio-update").textContent = paperLastUpdate ? `Koersen gecontroleerd: ${formatLocalTime(paperLastUpdate)}${paperDataFresh ? " · echt en actueel" : " · niet actueel"}` : "Nog geen actuele marktupdate";
  if (!account) {
    for (const id of ["paper-metric-start", "paper-metric-cash", "paper-metric-total"]) byId(id).textContent = formatEuro(Number(byId("paper-capital").value) || 0);
    byId("paper-metric-positions").textContent = formatEuro(0); byId("paper-metric-realized").textContent = formatEuro(0);
    byId("paper-metric-unrealized").textContent = formatEuro(0); byId("paper-metric-profit").textContent = formatEuro(0);
    byId("paper-metric-return").textContent = "0,00%"; byId("paper-metric-today").textContent = "0 transacties · €0,00";
  } else {
    const value = PaperTradingEngine.portfolio(account);
    byId("paper-metric-start").textContent = formatEuro(account.initialCapitalEur);
    byId("paper-metric-cash").textContent = formatEuro(value.availableCashEur);
    byId("paper-metric-positions").textContent = formatEuro(value.positionValueEur);
    byId("paper-metric-total").textContent = formatEuro(value.totalEur);
    byId("paper-metric-realized").textContent = formatEuro(value.realizedProfitLossEur);
    byId("paper-metric-unrealized").textContent = formatEuro(value.unrealizedProfitLossEur);
    byId("paper-metric-profit").textContent = formatEuro(value.totalProfitLossEur);
    byId("paper-metric-return").textContent = `${value.returnPercent >= 0 ? "+" : ""}${formatNumber(value.returnPercent, 2)}%`;
    const todayKey = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Brussels" });
    const todaysTrades = account.trades.filter((trade) => new Date(trade.time).toLocaleDateString("sv-SE", { timeZone: "Europe/Brussels" }) === todayKey);
    const todaysPnl = todaysTrades.filter((trade) => trade.side === "VERKOOP").reduce((sum, trade) => sum + trade.realizedProfitLossEur, 0);
    byId("paper-metric-today").textContent = `${todaysTrades.length} transacties · ${formatEuro(todaysPnl)}`;
  }

  const positionBody = byId("paper-positions"); positionBody.replaceChildren();
  const positions = account?.positions || [];
  byId("paper-position-count").textContent = `${positions.length} open posities`;
  if (!positions.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 14; cell.className = "table-placeholder"; cell.textContent = "Er zijn nog geen open paperposities."; row.append(cell); positionBody.append(row); }
  for (const position of positions) {
    const gross = position.quantity * position.lastPriceEur;
    const net = gross * (1 - (account.slippagePercent || 0) / 100) * (1 - (account.feePercent || 0) / 100);
    const pnl = net - position.entryNotionalEur - position.entryFeeEur;
    const row = document.createElement("tr");
    const estimatedRisk = position.plannedRiskEur ?? position.quantity * (position.entryPriceEur - (position.stopLossEur || position.entryPriceEur)) * (1 + (account.feePercent + account.slippagePercent) / 100);
    const estimatedReward = position.plannedRewardEur ?? NaN;
    const values = [SYMBOLS.get(position.symbol)?.display || position.symbol.replace(/USDT$/, "/USDT"),
      `${formatNumber(position.quantity, 8)} ${position.symbol.replace(/USDT$/, "")}`, formatEuro(position.entryPriceEur),
      paperDataFresh ? formatEuro(position.lastPriceEur) : `${formatEuro(position.lastPriceEur)} · verouderd`,
      formatEuro(net), formatEuro(pnl), Number.isFinite(position.stopLossEur) ? formatEuro(position.stopLossEur) : "uit",
      Number.isFinite(position.stopLossEur) ? `${formatNumber((position.entryPriceEur - position.stopLossEur) / position.entryPriceEur * 100, 2)}%` : "—",
      formatEuro(estimatedRisk), Number.isFinite(position.takeProfitEur) ? formatEuro(position.takeProfitEur) : "uit",
      Number.isFinite(position.potentialProfitBeforeCostsEur) ? formatEuro(position.potentialProfitBeforeCostsEur) : "—",
      Number.isFinite(estimatedReward) ? formatEuro(estimatedReward) : "—", Number.isFinite(position.riskReward) ? `1:${formatNumber(position.riskReward, 2)}` : "—",
      formatLocalTime(position.lastPriceAt)];
    for (const value of values) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    positionBody.append(row);
  }

  const signalList = byId("paper-signals"); signalList.replaceChildren();
  const signalItems = Object.entries(account?.latestSignals || {}).sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0)).slice(0, 12);
  if (!signalItems.length) signalList.textContent = "Nog geen verse signalen.";
  for (const [symbol, signal] of signalItems) {
    const item = document.createElement("div"); item.className = "paper-list-item";
    const title = document.createElement("strong"); title.textContent = `${SYMBOLS.get(symbol)?.display || symbol.replace(/USDT$/, "/USDT")} · ${signal.label}`;
    const note = document.createElement("span"); note.textContent = `${signal.fresh && paperDataFresh ? "Vers" : "Verouderd / geen nieuwe beoordeling"} · score ${Number.isFinite(signal.score) ? signal.score : "—"} · ${signal.reason || ""}`;
    item.append(title, note); signalList.append(item);
  }

  const recent = byId("paper-recent-trades"); recent.replaceChildren();
  const recentTrades = (account?.trades || []).slice().sort((a, b) => b.time - a.time).slice(0, 8);
  if (!recentTrades.length) recent.textContent = "Nog geen virtuele transacties.";
  for (const trade of recentTrades) {
    const item = document.createElement("div"); item.className = "paper-list-item";
    const title = document.createElement("strong"); title.textContent = `${trade.side} · ${SYMBOLS.get(trade.symbol)?.display || trade.symbol.replace(/USDT$/, "/USDT")} · ${formatEuro(trade.priceEur)}`;
    const detail = document.createElement("span"); detail.textContent = `${formatLocalTime(trade.time)} · kosten ${formatEuro(trade.feeEur)} · ${trade.reason}`;
    item.append(title, detail); recent.append(item);
  }

  const sales = (account?.trades || []).filter((trade) => trade.side === "VERKOOP");
  const wins = sales.filter((trade) => trade.realizedProfitLossEur > 0); const losses = sales.filter((trade) => trade.realizedProfitLossEur < 0);
  const avg = sales.length ? sales.reduce((sum, trade) => sum + trade.realizedProfitLossEur, 0) / sales.length : 0;
  const stats = [["Totaal transacties", account?.trades.length || 0], ["Afgesloten posities", sales.length],
    ["Winstgevende", wins.length], ["Verliesgevende", losses.length],
    ["Winrate", `${sales.length ? formatNumber(wins.length / sales.length * 100, 1) : "0,0"}%`],
    ["Totaal virtueel resultaat", formatEuro(account?.realizedProfitLossEur || 0)], ["Gemiddeld resultaat", formatEuro(avg)],
    ["Grootste winst", wins.length ? formatEuro(Math.max(...wins.map((trade) => trade.realizedProfitLossEur))) : formatEuro(0)],
    ["Grootste verlies", losses.length ? formatEuro(Math.min(...losses.map((trade) => trade.realizedProfitLossEur))) : formatEuro(0)],
    ["Maximale terugval", `${formatNumber(account?.maxDrawdownPercent || 0, 2)}%`],
    ["Transactiekosten totaal", formatEuro(account?.lifetimeFeesEur || 0)], ["Slippage totaal", formatEuro(account?.lifetimeSlippageEur || 0)],
    ["Portefeuillerendement", `${formatNumber(account ? PaperTradingEngine.portfolio(account).returnPercent : 0, 2)}%`]];
  const statistics = byId("paper-statistics"); statistics.replaceChildren();
  for (const [label, value] of stats) { const card = document.createElement("div"); card.className = "paper-stat-card"; const name = document.createElement("small"); name.textContent = label; const amount = document.createElement("strong"); amount.textContent = String(value); card.append(name, amount); statistics.append(card); }
  renderPaperEquity(); renderPaperSymbolFilter(); renderPaperHistory();
}

function renderPaperRiskDashboard() {
  const container = byId("paper-risk-metrics");
  const warning = byId("paper-risk-warning");
  const resume = byId("paper-risk-resume");
  container.replaceChildren();
  if (!paperAccount) {
    warning.textContent = "Maak eerst een oefenrekening om het risicodashboard te gebruiken.";
    resume.hidden = true;
    return;
  }
  const account = paperAccount;
  const value = PaperTradingEngine.portfolio(account);
  const openRisk = PaperTradingEngine.totalOpenRisk(account);
  const maxRisk = value.totalEur * account.maxTotalRiskPercent / 100;
  const dailyPnl = value.totalEur - (account.dailyStartEquityEur ?? account.initialCapitalEur);
  const dailyLimit = (account.dailyStartEquityEur ?? account.initialCapitalEur) * account.dailyLossLimitPercent / 100;
  const drawdown = account.peakEquityEur > 0 ? Math.max(0, (account.peakEquityEur - value.totalEur) / account.peakEquityEur * 100) : 0;
  const deployed = account.positions.reduce((sum, position) => sum + position.quantity * position.lastPriceEur, 0);
  const items = [
    ["Profil", ({ cautious: "Voorzichtig", balanced: "Gemiddeld", aggressive: "Agressief" })[account.riskProfile] || "Gemiddeld"],
    ["Risico per transactie", `${formatNumber(account.riskPerTradePercent, 2)}% · ${formatEuro(value.totalEur * account.riskPerTradePercent / 100)}`],
    ["Totaal open risico", `${formatEuro(openRisk)} / ${formatEuro(maxRisk)}`],
    ["Risicoruimte beschikbaar", formatEuro(Math.max(0, maxRisk - openRisk))],
    ["Dagresultaat / limiet", `${formatEuro(dailyPnl)} / −${formatEuro(dailyLimit)}`],
    ["Huidige / maximale drawdown", `${formatNumber(drawdown, 2)}% / ${formatNumber(account.maxDrawdownLimitPercent, 2)}%`],
    ["Open posities / maximum", `${account.positions.length} / ${account.maxOpenPositions}`],
    ["Portefeuille in posities", `${formatEuro(deployed)} · ${formatNumber(value.totalEur ? deployed / value.totalEur * 100 : 0, 1)}%`],
    ["Correlatie", "Niet berekend · geen betrouwbare gegevens"],
  ];
  for (const [label, amount] of items) {
    const card = document.createElement("div"); card.className = "paper-stat-card";
    const name = document.createElement("small"); name.textContent = label;
    const number = document.createElement("strong"); number.textContent = amount;
    card.append(name, number); container.append(card);
  }
  const warnings = [];
  if (account.dailyLossLocked) warnings.push("Dagelijkse verlieslimiet bereikt: nieuwe papertransacties zijn tot de volgende lokale dag geblokkeerd.");
  if (account.riskLock) warnings.push(`${account.riskLock.reason}: nieuwe posities blijven geblokkeerd tot je handmatig hervat.`);
  if (openRisk >= maxRisk) warnings.push("De maximale gezamenlijke open risico ruimte is bereikt.");
  warning.textContent = warnings.join(" ") || "Geen risicoblokkade actief. Elke nieuwe positie wordt vóór opening opnieuw gecontroleerd.";
  warning.classList.toggle("has-warning", warnings.length > 0);
  resume.hidden = !account.riskLock;
  const history = byId("paper-risk-history"); history.replaceChildren();
  const logs = [...(account.riskHistory || [])].slice(-100).reverse();
  byId("paper-risk-count").textContent = `${(account.riskHistory || []).length} controles`;
  if (!logs.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 5; cell.className = "table-placeholder"; cell.textContent = "Nog geen risicocontroles."; row.append(cell); history.append(row); }
  for (const log of logs) {
    const row = document.createElement("tr");
    const values = [formatLocalTime(log.time), log.symbol ? (SYMBOLS.get(log.symbol)?.display || log.symbol) : "Portefeuille", log.outcome, log.reason, (log.checks || []).map((check) => `${check.passed ? "✓" : "✕"} ${check.rule}`).join(" · ")];
    for (const value of values) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    history.append(row);
  }
}

function initializePaperControls() {
  byId("paper-symbol-search").addEventListener("input", updatePaperSymbolOptions);
  byId("paper-symbols").addEventListener("change", () => {
    const select = byId("paper-symbols");
    const visibleValues = new Set([...select.options].map((option) => option.value).filter(Boolean));
    for (const symbol of visibleValues) selectedPaperSymbols.delete(symbol);
    for (const option of select.selectedOptions) selectedPaperSymbols.add(option.value);
  });
  byId("paper-use-watchlist").addEventListener("click", () => selectPaperSymbols([...watchlist]));
  byId("paper-use-selected").addEventListener("click", () => selectPaperSymbols([...selectedMarkets]));
  byId("paper-save-settings").addEventListener("click", () => void savePaperSettings());
  byId("paper-start").addEventListener("click", () => void changePaperStatus("running"));
  byId("paper-pause").addEventListener("click", () => void changePaperStatus("paused"));
  byId("paper-stop").addEventListener("click", () => void changePaperStatus("stopped"));
  byId("paper-reset").addEventListener("click", () => void resetPaperAccount());
  byId("paper-risk-profile").addEventListener("change", (event) => {
    const profile = PaperTradingEngine.PROFILE_DEFAULTS[event.target.value];
    if (!profile) return;
    byId("paper-risk-trade").value = profile.riskPerTradePercent;
    byId("paper-max-position").value = profile.maxPositionEur;
    byId("paper-max-position-percent").value = profile.maxPositionPercent;
    byId("paper-max-open").value = profile.maxOpenPositions;
    byId("paper-max-exposure").value = profile.maxExposurePercent;
    byId("paper-risk-total").value = profile.maxTotalRiskPercent;
    byId("paper-daily-loss").value = profile.dailyLossLimitPercent;
    byId("paper-max-drawdown").value = profile.maxDrawdownPercent;
    byId("paper-min-rr").value = profile.minRiskReward;
    byId("paper-stop-percent").value = profile.stopLossPercent;
    byId("paper-take-profit").value = profile.takeProfitPercent;
    byId("paper-stop-mode").value = "percent";
    updatePaperStopMode();
  });
  byId("paper-stop-mode").addEventListener("change", updatePaperStopMode);
  byId("paper-risk-resume").addEventListener("click", async () => {
    if (!paperAccount?.riskLock) return;
    if (!window.confirm("Je hervat ondanks de bereikte maximale drawdown. De drawdownmeting start vanaf de huidige portefeuillewaarde. Doorgaan?")) return;
    try {
      const candidate = PaperTradingEngine.resumeRiskLock(paperAccount);
      candidate.status = "running";
      await persistPaperAccount(candidate);
      paperTickMessage = "Risicoblokkade handmatig hervat. Nieuwe posities volgen weer na verse gegevens en volledige risicocontrole.";
      schedulePaperTick(0);
    } catch (error) { showPaperError(error.message || "De risicoblokkade kon niet worden hervat."); }
  });
  for (const id of ["paper-filter-symbol", "paper-filter-from", "paper-filter-to", "paper-filter-side", "paper-filter-result", "paper-filter-reason"]) {
    byId(id).addEventListener("input", () => { paperHistoryPage = 0; renderPaperHistory(); });
    byId(id).addEventListener("change", () => { paperHistoryPage = 0; renderPaperHistory(); });
  }
  byId("paper-history-prev").addEventListener("click", () => { paperHistoryPage -= 1; renderPaperHistory(); });
  byId("paper-history-next").addEventListener("click", () => { paperHistoryPage += 1; renderPaperHistory(); });
  updatePaperSymbolOptions();
  updatePaperStopMode();
  renderPaperDashboard();
}

function updatePaperStopMode() {
  const fixed = byId("paper-stop-mode").value === "fixed";
  byId("paper-stop-percent").disabled = fixed;
  byId("paper-stop-fixed").disabled = !fixed;
}

async function initializePaperTrading() {
  try {
    paperStore = PaperTradingEngine.createStore();
    paperAccount = await paperStore.load();
    if (paperAccount) {
      syncPaperForm(paperAccount);
      paperTickMessage = paperAccount.status === "running" ? "Eerder actieve paper trading hervat vanaf de lokaal bewaarde rekening." : "Lokale oefenrekening en geschiedenis geladen.";
    } else paperTickMessage = "Kies je virtuele startkapitaal en munten. Er is nog geen paperrekening aangemaakt.";
    renderPaperDashboard();
    if (paperAccount?.status === "running" || paperAccount?.status === "paused") schedulePaperTick(0);
  } catch (error) {
    paperStore = null;
    paperAccount = null;
    paperTickMessage = "Lokale database niet beschikbaar. Paper trading blijft uitgeschakeld; er wordt niets virtueel of echt uitgevoerd.";
    showPaperError(error.message || paperTickMessage);
    renderPaperDashboard();
  }
}

initializeBacktestControls();
initializePaperControls();
void initializePaperTrading();
readSignalAudit();
renderSignalScanner();
activeSignalSymbol = byId("symbol-select").value || "BTCUSDT";
renderSignalDetail(activeSignalSymbol);
void initializeAiBridge();

// Fase 8: de browser praat uitsluitend met de lokale, vaste read-only routes.
function exchangeText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function showExchangeError(message) {
  const node = document.getElementById("exchange-error");
  if (!node) return;
  node.textContent = message;
  node.hidden = !message;
}

async function exchangeRequest(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || "De exchange is momenteel niet beschikbaar.");
  return body;
}

function renderExchangeBalances(balances) {
  const node = document.getElementById("exchange-balances");
  if (!node) return;
  node.replaceChildren();
  if (!balances?.length) { node.textContent = "Geen niet-lege balansen teruggekregen."; return; }
  for (const item of balances.slice(0, 100)) {
    const row = document.createElement("div");
    row.className = "exchange-data-row";
    const name = document.createElement("strong"); name.textContent = item.asset;
    const value = document.createElement("span"); value.textContent = `Beschikbaar ${formatNumber(item.free, 8)} · vastgezet ${formatNumber(item.locked, 8)}`;
    row.append(name, value); node.append(row);
  }
}

function renderExchangeOrders(orders) {
  const node = document.getElementById("exchange-open-orders");
  if (!node) return;
  node.replaceChildren();
  if (!orders?.length) { node.textContent = "Geen openstaande orders teruggekregen."; return; }
  for (const item of orders.slice(0, 100)) {
    const row = document.createElement("div"); row.className = "exchange-data-row";
    const name = document.createElement("strong"); name.textContent = `${item.symbol} · ${item.side}`;
    const value = document.createElement("span"); value.textContent = `${item.type} · ${item.status} · ${item.quantity} @ ${item.price}`;
    row.append(name, value); node.append(row);
  }
}

function setActiveMode(mode) {
  const badge = document.getElementById("active-mode-badge");
  const labels = {
    TESTNET: ["TESTNET · SANDBOX", "TESTNET actief · de paperrekening blijft apart"],
    LIVE: ["LIVE · ALLEEN-LEZEN", "LIVE account · alleen-lezen; geen LIVE-orders"],
    "LIVE ACCOUNT": ["LIVE · ALLEEN-LEZEN", "LIVE account · alleen-lezen; geen LIVE-orders"],
    PAPER: ["PAPER TRADING · VIRTUEEL GELD", "PAPER TRADING · virtueel"],
    UNKNOWN: ["MODUS ONBEKEND · FAIL-CLOSED", "Actieve modus kon niet worden bevestigd; acties zijn geblokkeerd"],
  };
  const [badgeText, detailText] = labels[mode] || labels.PAPER;
  if (badge) badge.textContent = badgeText;
  exchangeText("exchange-mode", detailText);
}

async function loadExchangeAccount() {
  const [account, openOrders] = await Promise.all([
    exchangeRequest("/api/exchange/account"), exchangeRequest("/api/exchange/open-orders"),
  ]);
  renderExchangeBalances(account.balances);
  renderExchangeOrders(openOrders.orders);
  exchangeText("exchange-valuation-note", "Geschatte totaalwaarde: niet beschikbaar; er is geen totale USDT-waardering door de exchange opgehaald.");
  exchangeText("exchange-action-status", "Accountgegevens zijn echt door de exchange teruggegeven (alleen lezen). ");
}

async function initializeExchangePanel() {
  try {
    const status = await exchangeRequest("/api/exchange/status");
    exchangeText("exchange-name", status.exchange || "Exchange niet ingesteld");
    exchangeText("exchange-mode", status.mode === "TESTNET" ? "TESTNET · oefenaccount" : status.mode === "LIVE ACCOUNT" ? "LIVE ACCOUNT · alleen-lezen" : "PAPER TRADING · virtueel en apart");
    setActiveMode(status.configured ? status.mode : "PAPER");
    exchangeText("exchange-state", status.connected ? "VERBONDEN · ALLEEN LEZEN" : status.partial ? "CONFIGURATIE ONVOLLEDIG" : status.state === "not_tested" ? "INGESTELD · NOG NIET GETEST" : "VERBINDING NOG NIET INGESTELD");
    exchangeText("exchange-connected", status.connected ? "Verbonden" : "Niet verbonden");
    exchangeText("exchange-message", status.message || "Geen verbinding ingesteld.");
    exchangeText("exchange-last-success", status.lastSuccess ? formatLocalTime(status.lastSuccess) : "Nog niet beschikbaar");
    for (const id of ["exchange-test", "exchange-account-refresh", "exchange-markets-refresh"]) {
      const button = document.getElementById(id);
      if (button) button.disabled = !status.configured;
    }
  } catch {
    setActiveMode("UNKNOWN");
    exchangeText("exchange-message", "De status van de accountverbinding kon niet worden opgehaald. Marktgegevens en paper trading blijven werken.");
  }

  document.getElementById("exchange-test")?.addEventListener("click", async () => {
    showExchangeError("");
    exchangeText("exchange-action-status", "Verbinding controleren…");
    try {
      const result = await exchangeRequest("/api/exchange/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      exchangeText("exchange-state", "VERBONDEN · ALLEEN LEZEN");
      exchangeText("exchange-connected", "Verbonden");
      exchangeText("exchange-name", result.exchange);
      exchangeText("exchange-mode", result.mode === "TESTNET" ? "TESTNET · fictief saldo" : "LIVE ACCOUNT · alleen-lezen");
      exchangeText("exchange-last-success", result.lastSuccess ? formatLocalTime(result.lastSuccess) : "Zojuist");
      renderExchangeBalances(result.balances);
      exchangeText("exchange-action-status", "Verbinding bevestigd. Alleen-lezen functies zijn beschikbaar.");
      document.getElementById("exchange-account-refresh").disabled = false;
      document.getElementById("exchange-markets-refresh").disabled = false;
      await loadExchangeAccount();
    } catch (error) {
      exchangeText("exchange-connected", "Niet verbonden");
      exchangeText("exchange-state", "VERBINDING MISLUKT");
      exchangeText("exchange-action-status", "De verbinding kon niet worden getest.");
      showExchangeError(error.message || "Verbinding mislukt. Controleer de configuratie en probeer opnieuw.");
    }
  });
  document.getElementById("exchange-account-refresh")?.addEventListener("click", async () => {
    showExchangeError("");
    try { await loadExchangeAccount(); }
    catch (error) { showExchangeError(error.message || "Accountgegevens tijdelijk niet beschikbaar."); }
  });
  document.getElementById("exchange-markets-refresh")?.addEventListener("click", async () => {
    showExchangeError(""); exchangeText("exchange-market-count", "Markten ophalen…");
    try {
      const data = await exchangeRequest("/api/exchange/markets");
      const pairs = data.markets || [];
      const quoteCounts = new Map();
      for (const pair of pairs) quoteCounts.set(pair.quote, (quoteCounts.get(pair.quote) || 0) + 1);
      const usdt = pairs.filter(pair => pair.quote === "USDT");
      const sample = usdt.slice(0, 12).map(pair => `${pair.base}/${pair.quote}`).join(", ");
      exchangeText("exchange-market-count", `${pairs.length} beschikbare spotmarkten; ${usdt.length} met USDT. ${sample ? `Voorbeelden: ${sample}${usdt.length > 12 ? " …" : ""}` : ""}`);
      exchangeText("exchange-action-status", "Dynamische marktlijst rechtstreeks van de exchange opgehaald.");
    } catch (error) { exchangeText("exchange-market-count", "Marktlijst niet beschikbaar."); showExchangeError(error.message || "Markten konden niet worden opgehaald."); }
  });
}
void initializeExchangePanel();

let preparedTestnetOrder = null;
function testnetPhase7RiskSettings() {
  const account = paperAccount || {};
  return {
    profile: account.riskProfile || document.getElementById("paper-risk-profile")?.value || "balanced",
    riskPerTradePercent: account.riskPerTradePercent ?? Number(document.getElementById("paper-risk-trade")?.value ?? 1),
    maxPositionEur: account.maxPositionEur ?? Number(document.getElementById("paper-max-position")?.value ?? 1000),
    maxPositionPercent: account.maxPositionPercent ?? Number(document.getElementById("paper-max-position-percent")?.value ?? 10),
    maxOpenPositions: account.maxOpenPositions ?? Number(document.getElementById("paper-max-open")?.value ?? 3),
    maxExposurePercent: account.maxExposurePercent ?? Number(document.getElementById("paper-max-exposure")?.value ?? 50),
    maxTotalRiskPercent: account.maxTotalRiskPercent ?? Number(document.getElementById("paper-risk-total")?.value ?? 3),
    dailyLossLimitPercent: account.dailyLossLimitPercent ?? Number(document.getElementById("paper-daily-loss")?.value ?? 3),
    maxDrawdownPercent: account.maxDrawdownLimitPercent ?? Number(document.getElementById("paper-max-drawdown")?.value ?? 15),
    minRiskReward: account.minRiskReward ?? Number(document.getElementById("paper-min-rr")?.value ?? 1.5),
  };
}
async function loadTestnetPanel() {
  const status = await exchangeRequest("/api/testnet/status");
  const accountStatus = status.enabled ? null : await exchangeRequest("/api/exchange/status").catch(() => null);
  setActiveMode(status.enabled ? "TESTNET" : accountStatus ? accountStatus.configured ? accountStatus.mode : "PAPER" : "UNKNOWN");
  exchangeText("testnet-mode", status.message);
  document.getElementById("testnet-prepare").disabled = !status.enabled;
  const result = status.enabled
    ? await exchangeRequest("/api/testnet/sync")
    : await exchangeRequest("/api/testnet/orders").catch(() => ({orders: []}));
  renderTestnetPortfolio(result.portfolio);
  const root = document.getElementById("testnet-orders"); root.replaceChildren();
  if (!result.orders.length) { root.textContent = "Nog geen Testnet-orders geregistreerd."; return; }
  for (const order of result.orders) {
    const row = document.createElement("div"); row.className = "exchange-data-row";
    const title = document.createElement("strong"); title.textContent = `${order.symbol} · ${order.status}`;
    const fees = Array.isArray(order.fees) && order.fees.length
      ? order.fees.map(fee => fee.amount == null ? "commissie onbekend" : `${fee.amount} ${fee.asset || ""}`).join(", ")
      : "fee nog niet door exchange bevestigd";
    const detail = document.createElement("span"); detail.textContent = `Werkelijk gevuld: ${order.executedQty ?? "onbekend"} · Gem. fillprijs: ${order.averageEntry ?? "onbekend"} · Fees: ${fees} · Bescherming: ${order.protection || "niet bevestigd"} · ${order.clientOrderId} · ${formatLocalTime(order.createdAt)}`;
    row.append(title, detail); root.append(row);
  }
}
function renderTestnetPortfolio(portfolio) {
  const root = document.getElementById("testnet-portfolio");
  if (!root) return;
  root.replaceChildren();
  if (!portfolio) { root.textContent = "Testnet-portefeuille nog niet gesynchroniseerd."; return; }
  const values = [
    ["Modus", "TESTNET"], ["Equity (USDT)", portfolio.equityUSDT],
    ["Gerealiseerde P/L (USDT)", portfolio.realizedPnlUSDT], ["Ongerealiseerde P/L (USDT)", portfolio.unrealizedPnlUSDT],
    ["Open risico (USDT)", portfolio.openRiskUSDT], ["Dagresultaat sinds eerste lokale sync (indicatief, USDT)", portfolio.dailyPnlUSDT],
    ["Dagresultaatstatus", portfolio.dailyPnlStatus === "UNAVAILABLE_RECONCILIATION" ? "Niet beschikbaar · reconciliatie vereist" : "Indicatief · geen historische dagopeningsbalans"],
    ["Portfolio peak (USDT)", portfolio.portfolioPeakUSDT], ["Drawdown", `${Number(portfolio.drawdownPercent || 0).toFixed(2)}%`],
    ["Risicoblokkade", portfolio.dailyLossLocked ? "Dagverlieslimiet bereikt" : portfolio.drawdownLocked ? "Drawdown · hervatten vereist" : "Geen"],
    ["Accountreconciliatie", portfolio.reconciliationRequired ? "VEREIST · orders geblokkeerd" : "Gesynchroniseerd"],
    ["Reconciliatiereden", portfolio.reconciliationReasons?.join(" · ") || "Geen"],
    ["Gereserveerde open BUY-orders", (portfolio.reservedBuyOrders || []).map(order => `${order.symbol} ${order.quantity} @ ${order.price} USDT (niet gevuld)`).join(" · ") || "Geen"],
    ["Onbekende open exchange-orders", portfolio.untrackedOpenOrders?.length || 0],
    ["Onbekende open order-lists", portfolio.untrackedOrderLists?.length || 0],
    ["Niet-geboekte accountactiva", portfolio.untrackedAssets?.map(item => `${item.quantity} ${item.asset}`).join(", ") || "Geen"],
    ["Fees per asset", Object.entries(portfolio.feesByAsset || {}).map(([asset, amount]) => `${amount} ${asset}`).join(", ") || "Nog geen exchange fees"],
  ];
  for (const [label, value] of values) {
    const row = document.createElement("div"); row.className = "exchange-data-row";
    const title = document.createElement("strong"); title.textContent = label;
    const detail = document.createElement("span"); detail.textContent = String(value ?? "onbekend");
    row.append(title, detail); root.append(row);
  }
  for (const position of portfolio.positions || []) {
    const row = document.createElement("div"); row.className = "exchange-data-row";
    const title = document.createElement("strong"); title.textContent = `${position.symbol} · ${position.quantity} open`;
    const detail = document.createElement("span"); detail.textContent = `Gem. entry ${position.averageEntry} USDT · waarde ${position.marketValue} USDT · unrealized ${position.unrealizedPnl} USDT · bescherming: ${position.protection || "niet bevestigd"}`;
    row.append(title, detail); root.append(row);
  }
  const resume = document.getElementById("testnet-resume-risk");
  if (resume) resume.hidden = !portfolio.drawdownLocked;
}
function showTestnetError(message = "") {
  const node = document.getElementById("testnet-error"); node.textContent = message; node.hidden = !message;
}
document.getElementById("testnet-order-form")?.addEventListener("submit", async event => {
  event.preventDefault(); showTestnetError("");
  try {
    const result = await exchangeRequest("/api/testnet/prepare", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({
      symbol:document.getElementById("testnet-symbol").value.trim().toUpperCase(), side:document.getElementById("testnet-side").value,
      quantity:Number(document.getElementById("testnet-quantity").value), stopLoss:Number(document.getElementById("testnet-stop").value), takeProfit:Number(document.getElementById("testnet-target").value),
      riskSettings:testnetPhase7RiskSettings()
    })});
    preparedTestnetOrder = result.order;
    const fields = [["Exchange",preparedTestnetOrder.exchange],["Paar",preparedTestnetOrder.symbol],["Koop/verkoop",preparedTestnetOrder.side],["Hoeveelheid",preparedTestnetOrder.quantity],["Actuele prijs",preparedTestnetOrder.price+" USDT"],["Ordertype",preparedTestnetOrder.orderType],["Stop-loss",preparedTestnetOrder.stopLoss],["Take-profit",preparedTestnetOrder.takeProfit],["Maximaal risico",preparedTestnetOrder.maxRisk+" USDT"],["Geschatte kosten",preparedTestnetOrder.estimatedFees+" USDT"],["Commissiepercentage",(preparedTestnetOrder.commissionRate*100).toFixed(4)+"% per fill"],["Beschikbare balans",preparedTestnetOrder.availableBalance+" USDT"],["Prijstijdstip",formatLocalTime(preparedTestnetOrder.priceTimestamp)]];
    const summary=document.getElementById("testnet-order-summary"); summary.replaceChildren();
    for (const [label,value] of fields) {const line=document.createElement("div"); const key=document.createElement("strong");key.textContent=label;const val=document.createElement("span");val.textContent=String(value);line.append(key,val);summary.append(line);}
    document.getElementById("testnet-confirm-card").hidden=false;
  } catch(error) { showTestnetError(error.message || "De order is niet voorbereid; er is niets verstuurd."); }
});
document.getElementById("testnet-cancel")?.addEventListener("click", () => { preparedTestnetOrder=null; document.getElementById("testnet-confirm-card").hidden=true; });
document.getElementById("testnet-confirm")?.addEventListener("click", async event => {
  if (!preparedTestnetOrder) return;
  const button=event.currentTarget; button.disabled=true; showTestnetError("");
  try {
    const result=await exchangeRequest("/api/testnet/confirm",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientOrderId:preparedTestnetOrder.clientOrderId,confirmed:true})});
    exchangeText("testnet-mode",`Testnet-orderstatus: ${result.status}. Controleer bescherming en werkelijk gevuld aantal.`);
    preparedTestnetOrder=null; document.getElementById("testnet-confirm-card").hidden=true; await loadTestnetPanel();
  } catch(error) { showTestnetError(error.message || "Status onbekend. Controleer eerst orderstatus; klik niet opnieuw."); }
  finally { button.disabled=false; }
});
document.getElementById("testnet-refresh")?.addEventListener("click", () => loadTestnetPanel().catch(e=>showTestnetError(e.message)));
document.getElementById("testnet-resume-risk")?.addEventListener("click", async event => {
  const button = event.currentTarget; button.disabled = true;
  try {
    await exchangeRequest("/api/testnet/resume", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({confirmed:true})});
    await loadTestnetPanel();
  } catch (error) { showTestnetError(error.message || "De drawdownblokkade kon niet worden hervat."); }
  finally { button.disabled = false; }
});
void loadTestnetPanel().catch(()=>setActiveMode("UNKNOWN"));
document.documentElement.classList.add("app-ready");
refreshMarket();
window.setInterval(refreshMarket, REFRESH_INTERVAL_MS);
