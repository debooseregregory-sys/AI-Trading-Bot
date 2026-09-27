// Fase 6: virtuele transacties en lokale IndexedDB-opslag. Deze module heeft
// bewust geen netwerk-, exchange-, order-, wallet- of opnamefunctie.
(() => {
  "use strict";

  const DATABASE_NAME = "aiCryptoAssistant.paper.v1";
  const DATABASE_VERSION = 1;
  const BUY_LABELS = new Set(["KOPEN", "MOGELIJK KOPEN"]);
  const SELL_LABELS = new Set(["VERKOPEN", "MOGELIJK VERKOPEN"]);
  const VALID_LABELS = new Set([...BUY_LABELS, "GEEN ACTIE", ...SELL_LABELS]);
  const LIMITS = Object.freeze({ maxSymbols: 20, maxTrades: 1_000_000, maxEquityPoints: 20_000 });

  const PROFILE_DEFAULTS = Object.freeze({
    cautious: Object.freeze({ riskPerTradePercent: 0.5, maxPositionEur: 500, maxPositionPercent: 5, maxOpenPositions: 2, maxExposurePercent: 25, maxTotalRiskPercent: 1.5, dailyLossLimitPercent: 2, maxDrawdownPercent: 10, minRiskReward: 1.5, stopLossPercent: 4, takeProfitPercent: 8 }),
    balanced: Object.freeze({ riskPerTradePercent: 1, maxPositionEur: 1000, maxPositionPercent: 10, maxOpenPositions: 3, maxExposurePercent: 50, maxTotalRiskPercent: 3, dailyLossLimitPercent: 3, maxDrawdownPercent: 15, minRiskReward: 1.5, stopLossPercent: 5, takeProfitPercent: 10 }),
    aggressive: Object.freeze({ riskPerTradePercent: 2, maxPositionEur: 2000, maxPositionPercent: 20, maxOpenPositions: 5, maxExposurePercent: 75, maxTotalRiskPercent: 6, dailyLossLimitPercent: 5, maxDrawdownPercent: 25, minRiskReward: 1, stopLossPercent: 7, takeProfitPercent: 14 }),
  });

  function validateSettings(settings) {
    if (!Number.isFinite(settings.initialCapitalEur) || settings.initialCapitalEur < 100 || settings.initialCapitalEur > 10_000_000) throw new Error("Kies een virtueel startkapitaal tussen €100 en €10.000.000.");
    if (!Number.isFinite(settings.feePercent) || settings.feePercent < 0 || settings.feePercent > 5) throw new Error("Virtuele transactiekosten moeten tussen 0% en 5% liggen.");
    if (!Number.isFinite(settings.slippagePercent) || settings.slippagePercent < 0 || settings.slippagePercent > 5) throw new Error("Virtuele slippage moet tussen 0% en 5% liggen.");
    if (!Number.isFinite(settings.maxPositionEur) || settings.maxPositionEur < 1 || settings.maxPositionEur > 10_000_000) throw new Error("Maximaal bedrag per positie moet tussen €1 en €10.000.000 liggen.");
    if (!Number.isFinite(settings.maxPositionPercent) || settings.maxPositionPercent < 1 || settings.maxPositionPercent > 100) throw new Error("Maximaal percentage per positie moet tussen 1% en 100% liggen.");
    if (!Number.isInteger(settings.maxOpenPositions) || settings.maxOpenPositions < 1 || settings.maxOpenPositions > LIMITS.maxSymbols) throw new Error("Maximaal aantal gelijktijdige posities moet tussen 1 en 20 liggen.");
    if (!Number.isFinite(settings.maxExposurePercent) || settings.maxExposurePercent < 1 || settings.maxExposurePercent > 100) throw new Error("Maximale totale blootstelling moet tussen 1% en 100% liggen.");
    if (!Number.isFinite(settings.stopLossPercent) || settings.stopLossPercent < 0 || settings.stopLossPercent > 90) throw new Error("Stop-loss moet tussen 0% en 90% liggen; 0 schakelt deze uit.");
    if (!Number.isFinite(settings.takeProfitPercent) || settings.takeProfitPercent < 0 || settings.takeProfitPercent > 500) throw new Error("Take-profit moet tussen 0% en 500% liggen; 0 schakelt deze uit.");
    const riskPerTradePercent = settings.riskPerTradePercent ?? 1;
    const maxTotalRiskPercent = settings.maxTotalRiskPercent ?? 3;
    const dailyLossLimitPercent = settings.dailyLossLimitPercent ?? 3;
    const maxDrawdownPercent = settings.maxDrawdownPercent ?? 15;
    const minRiskReward = settings.minRiskReward ?? 1;
    const stopLossFixedEur = settings.stopLossFixedEur ?? 0;
    const stopLossMode = settings.stopLossMode ?? "percent";
    if (!Number.isFinite(riskPerTradePercent) || riskPerTradePercent < 0.1 || riskPerTradePercent > 10) throw new Error("Risico per transactie moet tussen 0,1% en 10% liggen.");
    if (!Number.isFinite(maxTotalRiskPercent) || maxTotalRiskPercent < riskPerTradePercent || maxTotalRiskPercent > 50) throw new Error("Totaalrisico moet minstens zo hoog zijn als risico per transactie en maximaal 50%.");
    if (!Number.isFinite(dailyLossLimitPercent) || dailyLossLimitPercent < 0.1 || dailyLossLimitPercent > 50) throw new Error("Dagelijkse verlieslimiet moet tussen 0,1% en 50% liggen.");
    if (!Number.isFinite(maxDrawdownPercent) || maxDrawdownPercent < 1 || maxDrawdownPercent > 90) throw new Error("Maximale drawdown moet tussen 1% en 90% liggen.");
    if (!Number.isFinite(minRiskReward) || minRiskReward < 0.1 || minRiskReward > 20) throw new Error("Minimale risico/rendement-verhouding moet tussen 0,1 en 20 liggen.");
    if (!["percent", "fixed"].includes(stopLossMode)) throw new Error("Kies een geldige stop-lossmethode.");
    if (!Number.isFinite(stopLossFixedEur) || stopLossFixedEur < 0 || stopLossFixedEur > 10_000_000) throw new Error("Vaste stop-lossafstand moet een positief bedrag zijn.");
    if (stopLossMode === "fixed" && stopLossFixedEur <= 0) throw new Error("Een vaste stop-lossafstand is verplicht.");
    if (![1, 5, 15].includes(settings.intervalMinutes)) throw new Error("Kies een verversing van 1, 5 of 15 minuten.");
    if (!Array.isArray(settings.symbols) || settings.symbols.length < 1 || settings.symbols.length > LIMITS.maxSymbols) throw new Error("Selecteer tussen 1 en 20 munten voor paper trading.");
    if (new Set(settings.symbols).size !== settings.symbols.length || settings.symbols.some((symbol) => typeof symbol !== "string" || !/^[A-Z0-9]{2,24}USDT$/.test(symbol))) throw new Error("De muntselectie bevat een ongeldige of dubbele markt.");
  }

  function createAccount(settings, now = Date.now()) {
    validateSettings(settings);
    return {
      id: "primary", version: 1, initialCapitalEur: settings.initialCapitalEur,
      cashEur: settings.initialCapitalEur, realizedProfitLossEur: 0,
      lifetimeFeesEur: 0, lifetimeSlippageEur: 0, maxDrawdownPercent: 0,
      peakEquityEur: settings.initialCapitalEur, tradeSequence: 0,
      status: "stopped", symbols: [...settings.symbols], intervalMinutes: settings.intervalMinutes,
      feePercent: settings.feePercent, slippagePercent: settings.slippagePercent,
      maxPositionEur: settings.maxPositionEur, maxPositionPercent: settings.maxPositionPercent,
      maxOpenPositions: settings.maxOpenPositions, maxExposurePercent: settings.maxExposurePercent,
      stopLossPercent: settings.stopLossPercent, takeProfitPercent: settings.takeProfitPercent,
      riskProfile: settings.riskProfile || "balanced", riskPerTradePercent: settings.riskPerTradePercent ?? 1,
      maxTotalRiskPercent: settings.maxTotalRiskPercent ?? 3, dailyLossLimitPercent: settings.dailyLossLimitPercent ?? 3,
      maxDrawdownLimitPercent: settings.maxDrawdownPercent ?? 15, minRiskReward: settings.minRiskReward ?? 1,
      stopLossMode: settings.stopLossMode || "percent", stopLossFixedEur: settings.stopLossFixedEur ?? 0,
      dailyDateKey: localDateKey(now), dailyStartEquityEur: settings.initialCapitalEur, dailyLossLocked: false,
      riskLock: null, riskHistory: [],
      positions: [], trades: [], equity: [{ time: now, valueEur: settings.initialCapitalEur }],
      latestSignals: {}, lastUpdatedAt: now, lastCycleAt: null,
    };
  }

  function localDateKey(timestamp) {
    const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function totalOpenRisk(account) {
    return account.positions.reduce((sum, position) => {
      if (!Number.isFinite(position.stopLossEur) || position.stopLossEur <= 0 || position.stopLossEur >= position.entryPriceEur) return sum + position.quantity * position.entryPriceEur;
      const unit = position.entryPriceEur - position.stopLossEur + (position.entryPriceEur + position.stopLossEur) * (account.feePercent + account.slippagePercent) / 100;
      return sum + position.quantity * unit;
    }, 0);
  }

  function recordRisk(account, timestamp, symbol, checks, outcome, reason) {
    account.riskHistory ||= [];
    account.riskHistory.push({ time: timestamp, symbol, outcome, reason, checks, settings: {
      profile: account.riskProfile, riskPerTradePercent: account.riskPerTradePercent,
      maxPositionEur: account.maxPositionEur, maxPositionPercent: account.maxPositionPercent,
      maxOpenPositions: account.maxOpenPositions, maxExposurePercent: account.maxExposurePercent,
      maxTotalRiskPercent: account.maxTotalRiskPercent, dailyLossLimitPercent: account.dailyLossLimitPercent,
      maxDrawdownPercent: account.maxDrawdownLimitPercent, minRiskReward: account.minRiskReward,
      stopLossMode: account.stopLossMode, stopLossPercent: account.stopLossPercent, stopLossFixedEur: account.stopLossFixedEur,
    } });
    if (account.riskHistory.length > 5000) account.riskHistory.splice(0, account.riskHistory.length - 5000);
  }

  function checkRisk(account, item, timestamp) {
    const entry = item.priceEur * (1 + account.slippagePercent / 100);
    const stop = account.stopLossMode === "fixed" ? entry - account.stopLossFixedEur : entry * (1 - account.stopLossPercent / 100);
    const target = account.takeProfitPercent > 0 ? entry * (1 + account.takeProfitPercent / 100) : NaN;
    const equity = portfolio(account).totalEur;
    const dailyPnl = equity - account.dailyStartEquityEur;
    const dailyLimitEur = account.dailyStartEquityEur * account.dailyLossLimitPercent / 100;
    const drawdown = account.peakEquityEur > 0 ? (account.peakEquityEur - equity) / account.peakEquityEur * 100 : 0;
    const riskPerUnit = entry - stop + (entry + stop) * (account.feePercent + account.slippagePercent) / 100;
    const rewardPerUnit = target - entry - (target + entry) * (account.feePercent + account.slippagePercent) / 100;
    const riskBudget = equity * account.riskPerTradePercent / 100;
    const maxPos = Math.min(account.maxPositionEur, equity * account.maxPositionPercent / 100);
    const positionCapQuantity = maxPos / entry;
    const quantity = Math.min(riskBudget / riskPerUnit, positionCapQuantity,
      Math.max(0, equity * account.maxExposurePercent / 100 - account.positions.reduce((sum, p) => sum + p.quantity * p.lastPriceEur, 0)) / entry,
      account.cashEur / (entry * (1 + account.feePercent / 100)));
    const plannedRiskEur = quantity * riskPerUnit;
    const plannedRewardEur = quantity * rewardPerUnit;
    const rr = plannedRiskEur > 0 ? plannedRewardEur / plannedRiskEur : NaN;
    const checks = [
      { rule: "verse marktgegevens", passed: validPriceObservation(item, timestamp) },
      { rule: "geldige stop-loss", passed: Number.isFinite(stop) && stop > 0 && stop < entry && account.stopLossPercent > 0 || account.stopLossMode === "fixed" && Number.isFinite(stop) && stop > 0 && stop < entry },
      { rule: "risico per transactie", passed: plannedRiskEur > 0 && plannedRiskEur <= riskBudget + 1e-8 },
      { rule: "maximale positieomvang", passed: quantity * entry <= maxPos + 1e-8 },
      { rule: "maximaal aantal posities", passed: account.positions.length < account.maxOpenPositions },
      { rule: "totale blootstelling", passed: quantity > 0 },
      { rule: "gezamenlijk risico", passed: totalOpenRisk(account) + plannedRiskEur <= equity * account.maxTotalRiskPercent / 100 + 1e-8 },
      { rule: "dagelijkse verlieslimiet", passed: !account.dailyLossLocked && dailyPnl > -dailyLimitEur },
      { rule: "maximale drawdown", passed: !account.riskLock && drawdown < account.maxDrawdownLimitPercent },
      { rule: "voldoende virtuele cash", passed: quantity > 0 && quantity * entry * (1 + account.feePercent / 100) <= account.cashEur + 1e-8 },
      { rule: "take-profit en minimale risico/rendement-verhouding", passed: Number.isFinite(target) && rewardPerUnit > 0 && rr >= account.minRiskReward },
    ];
    const failed = checks.filter((check) => !check.passed);
    const reason = failed.length ? `Papertransactie geblokkeerd: ${failed.map((check) => check.rule).join(", ")} voldoet niet.` : null;
    return { allowed: !failed.length, reason, checks, entry, stop, target, quantity, plannedRiskEur, plannedRewardEur, riskReward: rr, dailyPnl, dailyLimitEur, drawdown };
  }

  function safeAnalysis(analysis) {
    if (!analysis || typeof analysis !== "object") return null;
    if (!VALID_LABELS.has(analysis.label) || !Number.isFinite(analysis.confidence)) return null;
    return {
      label: analysis.label, confidence: Math.max(0, Math.min(100, analysis.confidence)),
      positiveFactorIds: Array.isArray(analysis.positiveFactorIds) ? analysis.positiveFactorIds.slice(0, 12) : [],
      negativeFactorIds: Array.isArray(analysis.negativeFactorIds) ? analysis.negativeFactorIds.slice(0, 12) : [],
      missingIntervals: Array.isArray(analysis.missingIntervals) ? analysis.missingIntervals.slice(0, 4) : [],
      conflictPairs: Array.isArray(analysis.conflictPairs) ? analysis.conflictPairs.slice(0, 6) : [],
      technicalLabel: VALID_LABELS.has(analysis.technicalLabel) ? analysis.technicalLabel : null,
      analyzedAt: Number.isFinite(analysis.analyzedAt) ? analysis.analyzedAt : null,
    };
  }

  function validPriceObservation(item, now) {
    return item && item.fresh === true && Number.isFinite(item.priceEur) && item.priceEur > 0
      && Number.isFinite(item.priceUsdt) && item.priceUsdt > 0
      && Number.isFinite(item.timestamp) && item.timestamp <= now + 5000 && now - item.timestamp <= 90_000;
  }

  function validSignal(signal) {
    return signal?.available === true && VALID_LABELS.has(signal.label)
      && Number.isFinite(signal.score) && signal.score >= -100 && signal.score <= 100;
  }

  function nextTradeId(account, timestamp) {
    account.tradeSequence += 1;
    return `paper-${timestamp}-${account.tradeSequence}`;
  }

  function closePosition(account, position, item, timestamp, reason) {
    const executionPriceEur = item.priceEur * (1 - account.slippagePercent / 100);
    const grossProceedsEur = position.quantity * executionPriceEur;
    const feeEur = grossProceedsEur * account.feePercent / 100;
    const proceedsEur = grossProceedsEur - feeEur;
    const entryCostEur = position.entryNotionalEur + position.entryFeeEur;
    const realizedProfitLossEur = proceedsEur - entryCostEur;
    const slippageEur = Math.max(0, (item.priceEur - executionPriceEur) * position.quantity);
    account.cashEur += proceedsEur;
    account.realizedProfitLossEur += realizedProfitLossEur;
    account.lifetimeFeesEur += feeEur;
    account.lifetimeSlippageEur += slippageEur;
    account.trades.push({
      id: nextTradeId(account, timestamp), positionId: position.id, time: timestamp,
      symbol: position.symbol, side: "VERKOOP", priceEur: executionPriceEur,
      marketPriceEur: item.priceEur, priceUsdt: item.priceUsdt, quantity: position.quantity,
      feeEur, slippageEur, realizedProfitLossEur, reason,
      signalLabel: VALID_LABELS.has(item.signal?.label) ? item.signal.label : "ONVOLDOENDE GEGEVENS",
      technicalScore: Number.isFinite(item.signal?.score) ? item.signal.score : null,
      aiAnalysis: safeAnalysis(item.aiAnalysis) || safeAnalysis(position.aiAnalysis), stopLossEur: position.stopLossEur,
      takeProfitEur: position.takeProfitEur, entryTime: position.entryTime,
      entryPriceEur: position.entryPriceEur,
    });
    account.positions = account.positions.filter((open) => open.id !== position.id);
    return realizedProfitLossEur;
  }

  function openPosition(account, item, timestamp) {
    if (account.positions.some((position) => position.symbol === item.symbol)) return { opened: false, reason: "Er staat al een paperpositie voor deze munt open." };
    const risk = checkRisk(account, item, timestamp);
    if (!risk.allowed || risk.quantity * risk.entry < 1) {
      const reason = risk.reason || "De risicolimiet laat geen positie van minimaal €1 toe.";
      recordRisk(account, timestamp, item.symbol, risk.checks, "GEBLOKKEERD", reason);
      return { opened: false, reason, risk };
    }
    const executionPriceEur = risk.entry;
    const quantity = risk.quantity;
    const actualNotionalEur = quantity * executionPriceEur;
    const feeEur = actualNotionalEur * account.feePercent / 100;
    const totalCostEur = actualNotionalEur + feeEur;
    if (!(Number.isFinite(quantity) && quantity > 0 && totalCostEur <= account.cashEur + 1e-8)) return { opened: false, reason: "Onvoldoende virtuele cash na transactiekosten." };
    const slippageEur = Math.max(0, (executionPriceEur - item.priceEur) * quantity);
    const positionId = nextTradeId(account, timestamp);
    const position = {
      id: positionId, symbol: item.symbol, quantity, entryTime: timestamp,
      entryPriceEur: executionPriceEur, entryPriceUsdt: executionPriceEur * (item.priceUsdt / item.priceEur),
      entryNotionalEur: actualNotionalEur, entryFeeEur: feeEur, entrySlippageEur: slippageEur,
      lastPriceEur: item.priceEur, lastPriceUsdt: item.priceUsdt, lastPriceAt: timestamp,
      stopLossEur: risk.stop, takeProfitEur: risk.target,
      plannedRiskEur: risk.plannedRiskEur, plannedRewardEur: risk.plannedRewardEur,
      potentialProfitBeforeCostsEur: risk.quantity * (risk.target - risk.entry), riskReward: risk.riskReward,
      signalLabel: item.signal.label, technicalScore: item.signal.score,
      signalReason: item.signal.reason || item.signal.reasonsFor?.slice(0, 4).join("; ") || "Fase 3 technisch signaal",
      aiAnalysis: safeAnalysis(item.aiAnalysis),
    };
    account.cashEur -= totalCostEur;
    account.lifetimeFeesEur += feeEur;
    account.lifetimeSlippageEur += slippageEur;
    account.positions.push(position);
    account.trades.push({
      id: positionId, positionId, time: timestamp, symbol: item.symbol,
      side: "KOOP", priceEur: executionPriceEur, marketPriceEur: item.priceEur,
      priceUsdt: position.entryPriceUsdt, quantity, feeEur, slippageEur,
      realizedProfitLossEur: null, reason: position.signalReason,
      signalLabel: item.signal.label, technicalScore: item.signal.score,
      aiAnalysis: position.aiAnalysis, stopLossEur: position.stopLossEur,
      takeProfitEur: position.takeProfitEur, entryTime: timestamp,
      entryPriceEur: executionPriceEur,
    });
    recordRisk(account, timestamp, item.symbol, risk.checks, "TOEGESTAAN", "Alle verplichte risicocontroles zijn geslaagd.");
    return { opened: true, position };
  }

  function portfolio(account) {
    const rawPositionValueEur = account.positions.reduce((sum, position) => sum + position.quantity * position.lastPriceEur, 0);
    const liquidationValueEur = account.positions.reduce((sum, position) => {
      const proceeds = position.quantity * position.lastPriceEur * (1 - account.slippagePercent / 100);
      return sum + proceeds * (1 - account.feePercent / 100);
    }, 0);
    const totalEur = account.cashEur + liquidationValueEur;
    return {
      availableCashEur: account.cashEur, rawPositionValueEur,
      positionValueEur: liquidationValueEur, totalEur,
      realizedProfitLossEur: account.realizedProfitLossEur,
      unrealizedProfitLossEur: totalEur - account.initialCapitalEur - account.realizedProfitLossEur,
      totalProfitLossEur: totalEur - account.initialCapitalEur,
      returnPercent: account.initialCapitalEur > 0 ? (totalEur - account.initialCapitalEur) / account.initialCapitalEur * 100 : 0,
      openPositions: account.positions.length,
    };
  }

  function applyCycle(previous, observations, timestamp = Date.now(), options = {}) {
    const account = structuredClone(previous);
    account.riskHistory ||= []; account.riskLock ||= null;
    account.riskPerTradePercent ??= 1; account.maxTotalRiskPercent ??= 3;
    account.dailyLossLimitPercent ??= 3; account.maxDrawdownLimitPercent ??= 15;
    account.minRiskReward ??= 1; account.stopLossMode ||= "percent"; account.stopLossFixedEur ??= 0;
    account.dailyDateKey ||= localDateKey(timestamp); account.dailyStartEquityEur ??= account.initialCapitalEur;
    account.dailyLossLocked ||= false;
    if (account.status === "stopped") return { account, tradesAdded: [], events: [], portfolio: portfolio(account) };
    const canTrade = account.status === "running";
    const bySymbol = new Map((Array.isArray(observations) ? observations : []).map((item) => [item.symbol, item]));
    const tradesBefore = account.trades.length;
    const events = [];
    const currentDateKey = localDateKey(timestamp);
    if (currentDateKey !== account.dailyDateKey) {
      account.dailyDateKey = currentDateKey;
      account.dailyStartEquityEur = portfolio(account).totalEur;
      account.dailyLossLocked = false;
      recordRisk(account, timestamp, null, [{ rule: "daggrens volgens lokale tijdzone", passed: true }], "DAGRESET", "Nieuwe lokale handelsdag; de dagmeting is opnieuw gestart.");
    }
    // Mark open posities using only fresh prices before checking portfolio-wide limits.
    for (const item of bySymbol.values()) if (validPriceObservation(item, timestamp)) {
      for (const position of account.positions.filter((open) => open.symbol === item.symbol)) {
        position.lastPriceEur = item.priceEur; position.lastPriceUsdt = item.priceUsdt; position.lastPriceAt = timestamp;
      }
    }
    const markedEquity = portfolio(account).totalEur;
    const dayPnl = markedEquity - account.dailyStartEquityEur;
    const dayLimit = account.dailyStartEquityEur * account.dailyLossLimitPercent / 100;
    if (!account.dailyLossLocked && dayPnl <= -dayLimit) {
      account.dailyLossLocked = true;
      recordRisk(account, timestamp, null, [{ rule: "dagelijkse verlieslimiet", passed: false, dailyPnlEur: dayPnl, limitEur: dayLimit }], "GEBLOKKEERD", "Dagelijkse verlieslimiet bereikt; nieuwe paperposities zijn geblokkeerd.");
      events.push({ type: "risk-locked", reason: "Dagelijkse verlieslimiet bereikt." });
    }
    const drawdown = account.peakEquityEur > 0 ? (account.peakEquityEur - markedEquity) / account.peakEquityEur * 100 : 0;
    if (!account.riskLock && drawdown >= account.maxDrawdownLimitPercent) {
      account.riskLock = { time: timestamp, reason: "Maximale drawdown bereikt", drawdownPercent: drawdown };
      recordRisk(account, timestamp, null, [{ rule: "maximale drawdown", passed: false, drawdownPercent: drawdown }], "GEBLOKKEERD", "Maximale drawdown bereikt; handmatige hervatting is nodig.");
      events.push({ type: "risk-locked", reason: "Maximale drawdown bereikt; handmatige hervatting vereist." });
    }
    const symbolsToManage = [...new Set([...account.symbols, ...account.positions.map((position) => position.symbol)])].sort();
    for (const symbol of symbolsToManage) {
      const item = bySymbol.get(symbol);
      if (!validPriceObservation(item, timestamp)) {
        if (account.latestSignals[symbol]) account.latestSignals[symbol] = { ...account.latestSignals[symbol], fresh: false };
        continue;
      }
      const previousLabel = account.latestSignals[symbol]?.label || null;
      const hasSignal = validSignal(item.signal);
      const signal = hasSignal ? { label: item.signal.label, score: item.signal.score, alignment: item.signal.alignment ?? null,
        reason: item.signal.reason || item.signal.reasonsFor?.slice(0, 4).join("; ") || "Fase 3 technisch signaal",
        timestamp: item.timestamp, fresh: true } : null;
      if (signal) account.latestSignals[symbol] = signal;
      else if (account.latestSignals[symbol]) account.latestSignals[symbol] = { ...account.latestSignals[symbol], fresh: false };
      const position = account.positions.find((open) => open.symbol === symbol);
      if (position) {
        const stopReached = Number.isFinite(position.stopLossEur) && item.priceEur <= position.stopLossEur;
        const targetReached = Number.isFinite(position.takeProfitEur) && item.priceEur >= position.takeProfitEur;
        if (canTrade && !account.dailyLossLocked && (stopReached || targetReached || (hasSignal && SELL_LABELS.has(item.signal.label)))) {
          const reason = stopReached ? "Stop-loss bereikt op verse live marktprijs"
            : targetReached ? "Take-profit bereikt op verse live marktprijs"
              : `Fase 3-verkoopsignaal: ${signal.label}`;
          const pnl = closePosition(account, position, item, timestamp, reason);
          events.push({ type: "closed", symbol, reason, profitLossEur: pnl });
        }
      } else if (account.symbols.includes(symbol) && canTrade && hasSignal && BUY_LABELS.has(signal.label) && !BUY_LABELS.has(previousLabel)) {
        const result = openPosition(account, { ...item, signal }, timestamp);
        if (result.opened) events.push({ type: "opened", symbol, reason: signal.reason, positionId: result.position.id });
        else { events.push({ type: "rejected", symbol, reason: result.reason }); }
      }
    }
    if (account.trades.length > LIMITS.maxTrades) throw new Error("De paperhandelsdatabase heeft de maximale veilige omvang bereikt.");
    const value = portfolio(account).totalEur;
    account.peakEquityEur = Math.max(account.peakEquityEur, value);
    if (account.peakEquityEur > 0) account.maxDrawdownPercent = Math.max(account.maxDrawdownPercent, (account.peakEquityEur - value) / account.peakEquityEur * 100);
    const last = account.equity.at(-1);
    if (!last || timestamp - last.time >= 60_000) account.equity.push({ time: timestamp, valueEur: value });
    if (account.equity.length > LIMITS.maxEquityPoints) account.equity = account.equity.filter((_, index) => index % 2 === 0);
    account.lastCycleAt = timestamp; account.lastUpdatedAt = timestamp;
    return { account, tradesAdded: account.trades.slice(tradesBefore), events, portfolio: portfolio(account) };
  }

  function setStatus(previous, status, timestamp = Date.now()) {
    if (!new Set(["running", "paused", "stopped"]).has(status)) throw new Error("Onbekende paperhandelsstatus.");
    const account = structuredClone(previous); account.status = status; account.lastUpdatedAt = timestamp;
    return account;
  }

  function resumeRiskLock(previous, timestamp = Date.now()) {
    const account = structuredClone(previous);
    account.riskLock = null;
    // Explicit acknowledgement establishes a new drawdown reference; historical maximum remains recorded.
    account.peakEquityEur = portfolio(account).totalEur;
    recordRisk(account, timestamp, null, [{ rule: "handmatige risicohervatting", passed: true }], "HANDMATIG HERVAT", "Gebruiker heeft de risicoblokkade handmatig hervat; de drawdownreferentie is opnieuw ingesteld.");
    return account;
  }

  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("De lokale database kon niet worden gelezen."));
  });

  function createStore(indexedDb = globalThis.indexedDB) {
    let databasePromise;
    let lastEquityTime = null;
    let lastEquityLength = null;
    function database() {
      if (!indexedDb) return Promise.reject(new Error("Lokale databaseopslag is niet beschikbaar. Start de app met run_local.bat."));
      if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
        const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("account")) db.createObjectStore("account", { keyPath: "id" });
          if (!db.objectStoreNames.contains("positions")) db.createObjectStore("positions", { keyPath: "id" });
          if (!db.objectStoreNames.contains("trades")) db.createObjectStore("trades", { keyPath: "id" });
          if (!db.objectStoreNames.contains("equity")) db.createObjectStore("equity", { keyPath: "time" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("De lokale paperhandelsdatabase kon niet worden geopend."));
        request.onblocked = () => reject(new Error("Sluit andere vensters van de app en probeer opnieuw."));
      });
      return databasePromise;
    }
    return {
      async load() {
        const db = await database();
        const tx = db.transaction(["account", "positions", "trades", "equity"], "readonly");
        const accountReq = tx.objectStore("account").get("primary");
        const positionsReq = tx.objectStore("positions").getAll();
        const tradesReq = tx.objectStore("trades").getAll();
        const equityReq = tx.objectStore("equity").getAll();
        const [account, positions, trades, equity] = await Promise.all([requestResult(accountReq), requestResult(positionsReq), requestResult(tradesReq), requestResult(equityReq)]);
        if (!account) return null;
        account.positions = positions; account.trades = trades.sort((a, b) => a.time - b.time); account.equity = equity.sort((a, b) => a.time - b.time);
        if (!Array.isArray(account.symbols) || !Array.isArray(account.positions) || !Array.isArray(account.trades)) throw new Error("De opgeslagen paperhandelsgegevens zijn beschadigd en kunnen niet veilig worden geladen.");
        lastEquityTime = account.equity.at(-1)?.time ?? null;
        lastEquityLength = account.equity.length;
        return account;
      },
      async save(account, tradesAdded = []) {
        const db = await database();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(["account", "positions", "trades", "equity"], "readwrite");
          const storedAccount = { ...account }; delete storedAccount.positions; delete storedAccount.trades; delete storedAccount.equity;
          tx.objectStore("account").put(storedAccount);
          const positions = tx.objectStore("positions"); positions.clear(); account.positions.forEach((item) => positions.put(item));
          const trades = tx.objectStore("trades"); tradesAdded.forEach((item) => trades.put(item));
          const equity = tx.objectStore("equity");
          if (lastEquityLength !== null && account.equity.length < lastEquityLength) {
            equity.clear(); account.equity.slice(-LIMITS.maxEquityPoints).forEach((item) => equity.put(item));
          } else if (account.equity.length && account.equity.at(-1).time !== lastEquityTime) {
            equity.put(account.equity.at(-1));
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error("De lokale database kon paper trading niet opslaan."));
          tx.onabort = () => reject(tx.error || new Error("Opslaan is afgebroken; de laatste wijziging is niet bevestigd."));
        });
        lastEquityLength = account.equity.length;
        lastEquityTime = account.equity.at(-1)?.time ?? null;
      },
      async reset() {
        const db = await database();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(["account", "positions", "trades", "equity"], "readwrite");
          for (const name of ["account", "positions", "trades", "equity"]) tx.objectStore(name).clear();
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error || new Error("De paperhandelsgegevens konden niet worden gewist."));
          tx.onabort = () => reject(tx.error || new Error("Het resetten is afgebroken."));
        });
        lastEquityTime = null; lastEquityLength = null;
      },
    };
  }

  globalThis.PaperTradingEngine = Object.freeze({ validateSettings, createAccount, applyCycle, setStatus, resumeRiskLock, portfolio, totalOpenRisk, checkRisk, PROFILE_DEFAULTS, createStore, BUY_LABELS: [...BUY_LABELS], SELL_LABELS: [...SELL_LABELS] });
})();
