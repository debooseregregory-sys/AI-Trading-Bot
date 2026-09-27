"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { console, setTimeout, AbortSignal, performance: { now: (() => { let value = 0; return () => (value += 1); })() } };
context.globalThis = context;
vm.createContext(context);
for (const file of ["src/indicators.js", "src/signals.js", "src/backtest.js"]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

const baseTime = Date.UTC(2024, 0, 1);
const intervals = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
function candles(interval, mode = "reversal") {
  const step = intervals[interval];
  const count = Math.floor((250 * 86_400_000) / step);
  let prior = 100;
  return Array.from({ length: count }, (_, index) => {
    const dailyTrend = mode === "reversal" ? (index < Math.floor(count * 0.86) ? 0.045 : -0.25) : mode === "up" ? 0.045 : 0;
    const trend = dailyTrend * (step / intervals["1d"]) / 100;
    const close = prior * (1 + trend);
    const wick = Math.max(prior, close) * (mode === "reversal" && index > count * 0.86 ? 0.025 : 0.001);
    const bar = { time: baseTime + index * step, open: prior, high: Math.max(prior, close) + wick, low: Math.min(prior, close) - wick, close, volume: 10 + (index % 7), closeTime: baseTime + (index + 1) * step - 1 };
    prior = close;
    return bar;
  });
}

const data = { BTCUSDT: Object.fromEntries(Object.keys(intervals).map((interval) => [interval, candles(interval)])) };
data.ETHUSDT = Object.fromEntries(Object.keys(intervals).map((interval) => [interval, candles(interval, "up").map((bar) => ({ ...bar, close: bar.close * 0.03, open: bar.open * 0.03, low: bar.low * 0.03, high: bar.high * 0.03 }))]));
const euro = candles("1d", "flat").map((bar) => ({ ...bar, open: 1.08, high: 1.09, low: 1.07, close: 1.08 }));
const config = {
  symbols: ["BTCUSDT", "ETHUSDT"], interval: "1d", startTime: baseTime + 200 * intervals["1d"], endTime: baseTime + 250 * intervals["1d"],
  startCapital: 10_000, feePercent: 0.1, slippagePercent: 0.05, maxPositionEur: 1_000,
  stopLossPercent: 5, takeProfitPercent: 10, maxOpenPositions: 1,
};

(async () => {
  assert.throws(() => context.validateBacktestConfig({ ...config, startTime: config.endTime }), /datums/);
  assert.throws(() => context.validateBacktestConfig({ ...config, feePercent: -1 }), /Transactiekosten/);
  assert.throws(() => context.validateBacktestConfig({ ...config, symbols: Array(21).fill("BTCUSDT") }), /maximaal 20/);
  assert.throws(() => context.validateBacktestConfig({ ...config, maxPositionEur: 10_000_001 }), /Maximaal bedrag/);
  assert.equal(context.scoreSignalFrame(data.BTCUSDT["1d"].slice(0, 199), 100).available, false, "minimale historie wordt afgedwongen");

  const result = await context.runTechnicalBacktest({ config, datasets: data, euroCandles: euro });
  assert.equal(result.config.symbols.length, 2, "meerdere munten verwerkt");
  assert.ok(result.equityCurve.length > 1, "vermogensgrafiekpunten aangemaakt");
  assert.equal(result.endingCapital, result.startCapital + result.totalProfitLoss);
  assert.ok(result.feesEur >= 0 && result.slippageEur >= 0, "kosten/slippage niet-negatief");
  assert.ok(result.trades.every((trade) => Number.isFinite(trade.netProfitEur)), "transactieresultaten zijn echt berekend");

  const noCost = await context.runTechnicalBacktest({ config: { ...config, feePercent: 0, slippagePercent: 0 }, datasets: data, euroCandles: euro });
  assert.ok(noCost.endingCapital >= result.endingCapital, "kosten mogen uitkomst niet verbeteren");
  const singleSlot = await context.runTechnicalBacktest({ config: { ...config, maxOpenPositions: 1 }, datasets: data, euroCandles: euro });
  assert.ok(singleSlot.trades.length >= 0, "limiet gelijktijdige posities geaccepteerd");

  const futureChanged = structuredClone(data);
  for (const series of Object.values(futureChanged.BTCUSDT)) for (const bar of series) {
    if (bar.time > config.startTime + 10 * intervals["1d"]) { bar.open *= 10; bar.high *= 10; bar.low *= 10; bar.close *= 10; }
  }
  const causal = await context.runTechnicalBacktest({ config: { ...config, endTime: config.startTime + 10 * intervals["1d"] }, datasets: futureChanged, euroCandles: euro });
  const originalPrefix = await context.runTechnicalBacktest({ config: { ...config, endTime: config.startTime + 10 * intervals["1d"] }, datasets: data, euroCandles: euro });
  assert.deepEqual(causal.trades.map((trade) => [trade.entryTime, trade.entryPriceUsdt]), originalPrefix.trades.map((trade) => [trade.entryTime, trade.entryPriceUsdt]), "latere koersen wijzigen eerdere besluiten niet");

  const controller = new AbortController(); controller.abort();
  await assert.rejects(context.runTechnicalBacktest({ config, datasets: data, euroCandles: euro, signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(context.runTechnicalBacktest({ config, datasets: data, euroCandles: [] }), /EUR\/USDT/);
  console.log(`Backtest-engine smoke tests geslaagd: ${result.tradeCount} virtuele transacties, ${result.equityCurve.length} vermogenspunten.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
