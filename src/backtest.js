// Fase 5: virtuele portfolio-simulatie. Besluiten op candle-close, uitvoering op volgende open.
"use strict";

const BACKTEST_TIMEFRAMES = Object.freeze(["15m", "1h", "4h", "1d"]);
const BACKTEST_INTERVAL_MS = Object.freeze({ "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 });
const BACKTEST_BUY_LABELS = new Set(["KOPEN", "MOGELIJK KOPEN"]);
const BACKTEST_SELL_LABELS = new Set(["VERKOPEN", "MOGELIJK VERKOPEN"]);

function validateBacktestConfig(config) {
  if (!Array.isArray(config.symbols) || config.symbols.length < 1) throw new Error("Selecteer minstens één munt.");
  if (config.symbols.length > 20) throw new Error("Selecteer maximaal 20 munten per backtest om de historische gegevensophaling beheersbaar te houden.");
  if (!BACKTEST_INTERVAL_MS[config.interval]) throw new Error("Kies een geldig tijdsframe.");
  if (!(Number.isFinite(config.startTime) && Number.isFinite(config.endTime) && config.startTime < config.endTime)) throw new Error("De gekozen datums zijn ongeldig.");
  if (!(Number.isFinite(config.startCapital) && config.startCapital > 0 && config.startCapital <= 10_000_000)) throw new Error("Startkapitaal moet groter zijn dan nul en maximaal €10.000.000.");
  if (!(Number.isFinite(config.feePercent) && config.feePercent >= 0 && config.feePercent <= 5)) throw new Error("Transactiekosten moeten tussen 0% en 5% liggen.");
  if (!(Number.isFinite(config.slippagePercent) && config.slippagePercent >= 0 && config.slippagePercent <= 5)) throw new Error("Slippage moet tussen 0% en 5% liggen.");
  if (!(Number.isFinite(config.maxPositionEur) && config.maxPositionEur >= 1 && config.maxPositionEur <= 10_000_000)) throw new Error("Maximaal bedrag per positie moet tussen €1 en €10.000.000 liggen.");
  if (!(Number.isFinite(config.stopLossPercent) && config.stopLossPercent >= 0 && config.stopLossPercent <= 90)) throw new Error("Stop-loss moet tussen 0% en 90% liggen; 0 schakelt hem uit.");
  if (!(Number.isFinite(config.takeProfitPercent) && config.takeProfitPercent >= 0 && config.takeProfitPercent <= 500)) throw new Error("Doelprijs moet tussen 0% en 500% liggen; 0 schakelt hem uit.");
  if (!Number.isInteger(config.maxOpenPositions) || config.maxOpenPositions < 1 || config.maxOpenPositions > 100) throw new Error("Gelijktijdige posities moeten tussen 1 en 100 liggen.");
}

function makeBacktestEvents(datasets, symbols, interval, startTime, endTime) {
  const timeline = new Map();
  for (const symbol of symbols) {
    const bars = datasets[symbol]?.[interval] || [];
    for (const candle of bars) {
      if (candle.time < startTime || candle.time >= endTime || candle.closeTime > endTime) continue;
      if (!timeline.has(candle.time)) timeline.set(candle.time, new Map());
      timeline.get(candle.time).set(symbol, candle);
    }
  }
  return [...timeline.entries()].sort((a, b) => a[0] - b[0]);
}

async function runTechnicalBacktest(options) {
  const { config, datasets, euroCandles, signal, onProgress } = options;
  validateBacktestConfig(config);
  const symbols = [...new Set(config.symbols)].sort();
  const events = makeBacktestEvents(datasets, symbols, config.interval, config.startTime, config.endTime);
  if (!events.length) throw new Error("Voor deze periode zijn geen volledig afgesloten koersgegevens beschikbaar.");
  const rateCandles = (euroCandles || []).filter((candle) => candle.closeTime <= config.endTime).sort((a, b) => a.time - b.time);
  if (!rateCandles.length) throw new Error("De historische EUR/USDT-omrekening ontbreekt; er wordt geen euro-resultaat verzonnen.");

  const startedAt = performance.now();
  const dataPointers = Object.fromEntries(symbols.map((symbol) => [symbol, Object.fromEntries(BACKTEST_TIMEFRAMES.map((interval) => [interval, -1]))]));
  const rateAtTime = new Map(rateCandles.map((candle) => [candle.time, candle]));
  let ratePointer = -1;
  let cash = config.startCapital;
  const positions = new Map();
  const pendingActions = new Map();
  const lastCloses = new Map();
  let nextTradeId = 1;
  const trades = [];
  const equityCurve = [];
  let peakEquity = config.startCapital;
  let maxDrawdownPercent = 0;
  let totalFees = 0;
  let totalSlippage = 0;
  const warnings = [...(options.warnings || [])];
  const factorSummary = (signalResult) => ({
    score: signalResult.score, label: signalResult.label,
    reasonsFor: signalResult.reasonsFor.slice(0, 8), reasonsAgainst: signalResult.reasonsAgainst.slice(0, 8),
    timeframes: signalResult.frameSummary,
  });
  const getEurRate = (time, preferOpen) => {
    const exact = rateAtTime.get(time);
    if (exact) return preferOpen ? exact.open : exact.close;
    let low = 0; let high = rateCandles.length - 1; let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (rateCandles[mid].time <= time) { found = mid; low = mid + 1; } else high = mid - 1;
    }
    return found >= 0 && rateCandles[found].closeTime <= time ? rateCandles[found].close : NaN;
  };
  const closePosition = (symbol, position, rawPrice, rate, time, reason) => {
    if (!(Number.isFinite(rawPrice) && rawPrice > 0 && Number.isFinite(rate) && rate > 0)) return false;
    const sellPrice = rawPrice * (1 - config.slippagePercent / 100);
    const grossEur = position.quantity * sellPrice / rate;
    const exitFee = grossEur * config.feePercent / 100;
    const entryCost = position.entryNotionalEur + position.entryFeeEur;
    const netProceeds = grossEur - exitFee;
    const pnl = netProceeds - entryCost;
    const referenceEur = position.quantity * rawPrice / rate;
    totalSlippage += Math.max(0, referenceEur - grossEur);
    totalFees += exitFee;
    cash += netProceeds;
    trades.push({
      id: nextTradeId++, symbol, entryTime: position.entryTime, exitTime: time,
      entryPriceUsdt: position.entryPrice, exitPriceUsdt: sellPrice,
      entryRate: position.entryRate, exitRate: rate, quantity: position.quantity,
      entryNotionalEur: position.entryNotionalEur, entryFeeEur: position.entryFeeEur,
      exitFeeEur: exitFee, netProfitEur: pnl,
      returnPercent: entryCost > 0 ? pnl / entryCost * 100 : 0,
      exitReason: reason, entryReasons: position.entryReasons,
    });
    positions.delete(symbol);
    pendingActions.delete(symbol);
    return true;
  };
  const enterPosition = (symbol, candle, action, rate) => {
    if (positions.has(symbol) || positions.size >= config.maxOpenPositions || !(cash > 0) || !(rate > 0)) return false;
    const buyPrice = candle.open * (1 + config.slippagePercent / 100);
    const notional = Math.min(config.maxPositionEur, cash / (1 + config.feePercent / 100));
    if (!(Number.isFinite(buyPrice) && buyPrice > 0 && notional > 0)) return false;
    const quantity = notional * rate / buyPrice;
    const grossEur = quantity * buyPrice / rate;
    const entryFeeEur = grossEur * config.feePercent / 100;
    if (grossEur + entryFeeEur > cash + 1e-8) return false;
    cash -= grossEur + entryFeeEur;
    totalFees += entryFeeEur;
    totalSlippage += quantity * (buyPrice - candle.open) / rate;
    positions.set(symbol, {
      quantity, entryPrice: buyPrice, entryTime: candle.time, entryRate: rate,
      entryNotionalEur: grossEur, entryFeeEur,
      stopPrice: config.stopLossPercent > 0 ? buyPrice * (1 - config.stopLossPercent / 100) : null,
      targetPrice: config.takeProfitPercent > 0 ? buyPrice * (1 + config.takeProfitPercent / 100) : null,
      entryReasons: action.reasons,
    });
    pendingActions.delete(symbol);
    return true;
  };

  const totalEvents = events.length;
  let processed = 0;
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    if (signal?.aborted) { const error = new Error("Backtest gestopt."); error.name = "AbortError"; throw error; }
    const [time, candlesBySymbol] = events[eventIndex];
    while (ratePointer + 1 < rateCandles.length && rateCandles[ratePointer + 1].time <= time) ratePointer += 1;
    const eventRateCandle = rateCandles[ratePointer]?.time === time ? rateCandles[ratePointer] : null;
    const rateAtOpen = eventRateCandle?.open || getEurRate(time, true);

    for (const symbol of symbols) {
      const candle = candlesBySymbol.get(symbol);
      if (!candle) continue;
      const action = pendingActions.get(symbol);
      if (action?.type === "sell" && positions.has(symbol)) closePosition(symbol, positions.get(symbol), candle.open, rateAtOpen, time, "Signaal om te verkopen; uitgevoerd bij volgende opening");
      if (action?.type === "buy" && !positions.has(symbol)) enterPosition(symbol, candle, action, rateAtOpen);
      const position = positions.get(symbol);
      if (position) {
        const atOpen = candle.open;
        if (position.stopPrice && atOpen <= position.stopPrice) {
          closePosition(symbol, position, atOpen, rateAtOpen, time, "Stop-loss; koers opende onder de grens");
        } else if (position.targetPrice && atOpen >= position.targetPrice) {
          closePosition(symbol, position, atOpen, rateAtOpen, time, "Doelprijs; koers opende boven de grens");
        } else {
          const stopHit = position.stopPrice && candle.low <= position.stopPrice;
          const targetHit = position.targetPrice && candle.high >= position.targetPrice;
          if (stopHit) closePosition(symbol, position, position.stopPrice, rateAtOpen, candle.closeTime, targetHit ? "Stop-loss eerst (stop en doel geraakt in dezelfde candle)" : "Stop-loss geraakt");
          else if (targetHit) closePosition(symbol, position, position.targetPrice, rateAtOpen, candle.closeTime, "Doelprijs geraakt");
        }
      }
      lastCloses.set(symbol, candle.close);
      const pointers = dataPointers[symbol];
      const frames = {};
      for (const interval of BACKTEST_TIMEFRAMES) {
        const series = datasets[symbol]?.[interval] || [];
        let pointer = pointers[interval];
        while (pointer + 1 < series.length && series[pointer + 1].closeTime <= candle.closeTime) pointer += 1;
        pointers[interval] = pointer;
        frames[interval] = pointer >= 0
          ? scoreSignalFrame(series.slice(Math.max(0, pointer - 209), pointer + 1), candle.close)
          : { available: false, score: null, factors: [], reason: "Nog geen afgesloten koersgegevens." };
      }
      const decision = combineSignalFrames(frames);
      if (decision.available) {
        if (!positions.has(symbol) && BACKTEST_BUY_LABELS.has(decision.label)) {
          pendingActions.set(symbol, { type: "buy", reasons: factorSummary(decision) });
        } else if (positions.has(symbol) && BACKTEST_SELL_LABELS.has(decision.label)) {
          pendingActions.set(symbol, { type: "sell", reasons: factorSummary(decision) });
        } else if ((positions.has(symbol) && BACKTEST_BUY_LABELS.has(decision.label)) || (!positions.has(symbol) && BACKTEST_SELL_LABELS.has(decision.label))) {
          pendingActions.delete(symbol);
        }
      }
    }

    const rateAtClose = eventRateCandle?.close || getEurRate(time, false);
    let equity = cash;
    for (const [symbol, position] of positions) {
      const price = lastCloses.get(symbol);
      if (Number.isFinite(price) && rateAtClose > 0) {
        const estimatedSale = position.quantity * price * (1 - config.slippagePercent / 100) / rateAtClose;
        equity += estimatedSale * (1 - config.feePercent / 100);
      }
    }
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, (peakEquity - equity) / peakEquity * 100);
    const sampleEvery = Math.max(1, Math.ceil(totalEvents / 1000));
    if (eventIndex % sampleEvery === 0 || eventIndex === totalEvents - 1) equityCurve.push({ time, equity });
    processed += 1;
    if (eventIndex % 200 === 0 || eventIndex === totalEvents - 1) {
      onProgress?.({ stage: "simulatie", completed: processed, total: totalEvents, percent: Math.round(processed / totalEvents * 100) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const finalEvent = events.at(-1);
  const finalTime = finalEvent ? finalEvent[0] + BACKTEST_INTERVAL_MS[config.interval] : config.endTime;
  const lastRateCandle = rateCandles.filter((candle) => candle.closeTime <= finalTime).at(-1);
  const finalRate = lastRateCandle?.close;
  for (const [symbol, position] of [...positions]) {
    const finalPrice = lastCloses.get(symbol);
    if (Number.isFinite(finalPrice) && finalRate > 0) closePosition(symbol, position, finalPrice, finalRate, finalTime, "Backtestperiode afgelopen; positie virtueel gesloten");
  }
  const endingCapital = cash;
  const pnl = endingCapital - config.startCapital;
  const winning = trades.filter((trade) => trade.netProfitEur > 0);
  const losing = trades.filter((trade) => trade.netProfitEur < 0);
  const average = (list) => list.length ? list.reduce((sum, trade) => sum + trade.netProfitEur, 0) / list.length : 0;
  const totalDurationMs = performance.now() - startedAt;
  const lastEquity = equityCurve.at(-1);
  if (!lastEquity || lastEquity.time !== finalTime) equityCurve.push({ time: finalTime, equity: endingCapital });
  return {
    config: { ...config, symbols },
    startCapital: config.startCapital, endingCapital, totalProfitLoss: pnl,
    returnPercent: pnl / config.startCapital * 100,
    tradeCount: trades.length, winningTrades: winning.length, losingTrades: losing.length,
    winRate: trades.length ? winning.length / trades.length * 100 : 0,
    largestWin: winning.length ? Math.max(...winning.map((trade) => trade.netProfitEur)) : 0,
    largestLoss: losing.length ? Math.min(...losing.map((trade) => trade.netProfitEur)) : 0,
    averageWin: average(winning), averageLoss: average(losing), maxDrawdownPercent,
    feesEur: totalFees, slippageEur: totalSlippage,
    durationMs: totalDurationMs, trades, equityCurve, warnings, testStartTime: config.startTime, testEndTime: config.endTime,
  };
}

globalThis.validateBacktestConfig = validateBacktestConfig;
globalThis.runTechnicalBacktest = runTechnicalBacktest;
