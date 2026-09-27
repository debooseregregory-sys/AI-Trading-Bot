// Fase 3: controleerbare analyse-regels. Deze module kent geen handelsfuncties.
"use strict";

const SIGNAL_CONFIG = Object.freeze({
  timeframeWeights: Object.freeze({ "15m": 1, "1h": 2, "4h": 3, "1d": 4 }),
  factorWeights: Object.freeze({ trend: 14, macd: 12, sma20: 7, sma50: 10, sma200: 12, ema20: 6, ema50: 8, rsi: 8, volume: 5, movement: 8 }),
  thresholds: Object.freeze({ strongBuy: 60, possibleBuy: 25, possibleSell: -25, strongSell: -60 }),
  minimumCandles: 200,
});

function scoreSignalFrame(candles, currentPrice, calculate = globalThis.calculateIndicators) {
  if (!Array.isArray(candles) || candles.length < SIGNAL_CONFIG.minimumCandles || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { available: false, reason: `Onvoldoende geldige koersgegevens (minstens ${SIGNAL_CONFIG.minimumCandles} gesloten perioden nodig).`, factors: [], score: null, analysis: null };
  }
  const analysis = calculate(candles, currentPrice);
  const factors = [];
  const add = (key, direction, evidence) => {
    if (direction === null || !evidence) return;
    factors.push({ key, direction, weight: SIGNAL_CONFIG.factorWeights[key], evidence });
  };
  add("trend", analysis.trend === "Stijgend" ? 1 : analysis.trend === "Dalend" ? -1 : analysis.trend === "Zijwaarts / onduidelijk" ? 0 : null,
    `Trend: ${analysis.trend.toLowerCase()}.`);
  add("macd", analysis.macd.tone === "Positief" ? 1 : analysis.macd.tone === "Negatief" ? -1 : analysis.macd.tone === "Neutraal" ? 0 : null,
    `MACD is ${analysis.macd.tone.toLowerCase()}.`);
  for (const [key, title] of [["sma20", "SMA 20"], ["sma50", "SMA 50"], ["sma200", "SMA 200"]]) {
    const average = analysis.averages[key];
    const distance = Number.isFinite(average) ? (currentPrice - average) / average : NaN;
    const direction = !Number.isFinite(distance) ? null : Math.abs(distance) <= 0.0005 ? 0 : Math.sign(distance);
    add(key, direction, direction === null ? null : `Prijs staat ${direction > 0 ? "boven" : direction < 0 ? "onder" : "vrijwel gelijk aan"} ${title}.`);
  }
  for (const [key, title] of [["ema20", "EMA 20"], ["ema50", "EMA 50"]]) {
    const average = analysis.averages[key];
    const distance = Number.isFinite(average) ? (currentPrice - average) / average : NaN;
    const direction = !Number.isFinite(distance) ? null : Math.abs(distance) <= 0.0005 ? 0 : Math.sign(distance);
    add(key, direction, direction === null ? null : `Prijs staat ${direction > 0 ? "boven" : direction < 0 ? "onder" : "vrijwel gelijk aan"} ${title}.`);
  }
  const rsi = analysis.rsi;
  // RSI krijgt slechts een kleine, begrensde bijdrage: extreme waarden zijn geen automatisch signaal.
  add("rsi", !Number.isFinite(rsi) ? null : rsi > 55 && rsi < 70 ? 1 : rsi > 30 && rsi < 45 ? -1 : 0,
    Number.isFinite(rsi) ? `RSI is ${rsi.toFixed(1)} (${analysis.rsiTone.toLowerCase()}); dit is geen zelfstandig signaal.` : null);
  const latestCandle = candles.at(-1);
  const volumeDirection = !analysis.volume || analysis.volume.comparison !== "Hoger dan gemiddeld" ? 0
    : latestCandle.close > latestCandle.open ? 0.5 : latestCandle.close < latestCandle.open ? -0.5 : 0;
  add("volume", analysis.volume ? volumeDirection : null,
    analysis.volume ? `Volume is ${analysis.volume.comparison.toLowerCase()}${volumeDirection > 0 ? " bij een stijgende periode" : volumeDirection < 0 ? " bij een dalende periode" : ""}; beperkte bevestiging.` : null);
  const movement = candles.length >= 6 ? ((candles.at(-1).close - candles.at(-6).close) / candles.at(-6).close) * 100 : NaN;
  add("movement", Number.isFinite(movement) ? Math.abs(movement) < 0.05 ? 0 : Math.sign(movement) : null,
    Number.isFinite(movement) ? `Koers bewoog ${movement >= 0 ? "omhoog" : "omlaag"} ${Math.abs(movement).toFixed(2)}% over 5 perioden.` : null);
  const possibleWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
  if (!possibleWeight || factors.length < 7 || !Number.isFinite(analysis.averages.sma200)) {
    return { available: false, reason: "Er ontbreken indicatoren die nodig zijn voor een betrouwbare vergelijking.", factors, score: null, analysis };
  }
  const score = factors.reduce((sum, factor) => sum + (factor.direction * factor.weight), 0) / possibleWeight * 100;
  return { available: true, score: Math.max(-100, Math.min(100, score)), analysis, factors, movement, count: candles.length };
}

function combineSignalFrames(frames) {
  const available = Object.entries(SIGNAL_CONFIG.timeframeWeights)
    .filter(([interval]) => frames[interval]?.available)
    .map(([interval, weight]) => ({ interval, weight, frame: frames[interval] }));
  if (available.length < 3) return { available: false, label: "ONVOLDOENDE GEGEVENS", score: null, alignment: null, frames, reasonsFor: [], reasonsAgainst: [], reason: "Minstens 3 van de 4 tijdsframes moeten voldoende geldige gegevens hebben." };
  const denominator = available.reduce((sum, item) => sum + item.weight, 0);
  const score = available.reduce((sum, item) => sum + item.frame.score * item.weight, 0) / denominator;
  const label = score >= SIGNAL_CONFIG.thresholds.strongBuy ? "KOPEN"
    : score >= SIGNAL_CONFIG.thresholds.possibleBuy ? "MOGELIJK KOPEN"
      : score <= SIGNAL_CONFIG.thresholds.strongSell ? "VERKOPEN"
        : score <= SIGNAL_CONFIG.thresholds.possibleSell ? "MOGELIJK VERKOPEN" : "GEEN ACTIE";
  let bullish = 0; let bearish = 0; let total = 0;
  const reasonsFor = []; const reasonsAgainst = [];
  for (const { interval, weight, frame } of available) {
    for (const factor of frame.factors) {
      const importance = factor.weight * weight;
      total += importance;
      if (factor.direction > 0) bullish += importance * Math.abs(factor.direction);
      if (factor.direction < 0) bearish += importance * Math.abs(factor.direction);
      const message = `${interval}: ${factor.evidence}`;
      if (factor.direction > 0) reasonsFor.push(message);
      if (factor.direction < 0) reasonsAgainst.push(message);
    }
  }
  const alignment = total ? Math.round(Math.max(bullish, bearish) / total * 100) : 0;
  const positiveFrames = available.filter(({ frame }) => frame.score >= SIGNAL_CONFIG.thresholds.possibleBuy).length;
  const negativeFrames = available.filter(({ frame }) => frame.score <= SIGNAL_CONFIG.thresholds.possibleSell).length;
  return { available: true, label, score: Math.round(score), alignment, frames, frameCount: available.length,
    disagreement: positiveFrames > 0 && negativeFrames > 0,
    frameSummary: Object.fromEntries(available.map(({ interval, frame }) => [interval, { score: Math.round(frame.score), direction: frame.score >= 10 ? "Positief" : frame.score <= -10 ? "Negatief" : "Neutraal" }])),
    reasonsFor: reasonsFor.slice(0, 12), reasonsAgainst: reasonsAgainst.slice(0, 12), analyzedAt: Date.now() };
}

function createSignalChange(previous, next, timestamp = Date.now()) {
  if (!previous?.result?.available || !next?.available || previous.result.label === next.label) return null;
  return { symbol: next.symbol, oldLabel: previous.result.label, newLabel: next.label, changedAt: timestamp,
    oldScore: previous.result.score, newScore: next.score };
}

globalThis.SIGNAL_CONFIG = SIGNAL_CONFIG;
globalThis.scoreSignalFrame = scoreSignalFrame;
globalThis.combineSignalFrames = combineSignalFrames;
globalThis.createSignalChange = createSignalChange;
