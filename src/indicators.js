// Losse, controleerbare berekeningen op echte, volledig gesloten koersperioden.
"use strict";

function movingAverageSeries(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    total += values[index];
    if (index >= period) total -= values[index - period];
    if (index >= period - 1) result[index] = total / period;
  }
  return result;
}

function exponentialAverageSeries(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;
  const alpha = 2 / (period + 1);
  let average = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = average;
  for (let index = period; index < values.length; index += 1) {
    average = (values[index] * alpha) + (average * (1 - alpha));
    result[index] = average;
  }
  return result;
}

function rsiSeries(values, period = 14) {
  const result = Array(values.length).fill(null);
  if (values.length <= period) return result;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const difference = values[index] - values[index - 1];
    averageGain += Math.max(difference, 0);
    averageLoss += Math.max(-difference, 0);
  }
  averageGain /= period;
  averageLoss /= period;
  const toRsi = () => averageGain === 0 && averageLoss === 0
    ? 50
    : averageLoss === 0
      ? 100
      : 100 - (100 / (1 + (averageGain / averageLoss)));
  result[period] = toRsi();
  for (let index = period + 1; index < values.length; index += 1) {
    const difference = values[index] - values[index - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(difference, 0)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(-difference, 0)) / period;
    result[index] = toRsi();
  }
  return result;
}

function macdSeries(values, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = exponentialAverageSeries(values, fast);
  const slowEma = exponentialAverageSeries(values, slow);
  const macd = values.map((_, index) => fastEma[index] === null || slowEma[index] === null
    ? null
    : fastEma[index] - slowEma[index]);
  const signal = Array(values.length).fill(null);
  const firstMacdIndex = macd.findIndex((value) => value !== null);
  const signalStart = firstMacdIndex + signalPeriod - 1;
  if (firstMacdIndex >= 0 && signalStart < values.length) {
    const alpha = 2 / (signalPeriod + 1);
    let average = macd.slice(firstMacdIndex, signalStart + 1).reduce((sum, value) => sum + value, 0) / signalPeriod;
    signal[signalStart] = average;
    for (let index = signalStart + 1; index < values.length; index += 1) {
      average = (macd[index] * alpha) + (average * (1 - alpha));
      signal[index] = average;
    }
  }
  const histogram = macd.map((value, index) => value === null || signal[index] === null ? null : value - signal[index]);
  return { macd, signal, histogram };
}

function calculateIndicators(candles, currentPrice) {
  const closes = candles.map((candle) => Number(candle.close));
  const volumes = candles.map((candle) => Number(candle.volume));
  const last = closes.length - 1;
  const sma20Series = movingAverageSeries(closes, 20);
  const sma50Series = movingAverageSeries(closes, 50);
  const sma200Series = movingAverageSeries(closes, 200);
  const ema20Series = exponentialAverageSeries(closes, 20);
  const ema50Series = exponentialAverageSeries(closes, 50);
  const rsi = rsiSeries(closes);
  const macd = macdSeries(closes);
  const atEnd = (series) => last >= 0 ? series[last] : null;
  const macdValue = atEnd(macd.macd);
  const signalValue = atEnd(macd.signal);
  const histogramValue = atEnd(macd.histogram);
  const sma20 = atEnd(sma20Series);
  const sma50 = atEnd(sma50Series);
  const sma200 = atEnd(sma200Series);
  let trend = "Onvoldoende gegevens";
  if (Number.isFinite(currentPrice) && Number.isFinite(sma20) && Number.isFinite(sma50)) {
    if (sma20 > sma50 && currentPrice > sma20) trend = "Stijgend";
    else if (sma20 < sma50 && currentPrice < sma20) trend = "Dalend";
    else trend = "Zijwaarts / onduidelijk";
  }

  let volume = null;
  if (volumes.length >= 21) {
    const previousVolumes = volumes.slice(-21, -1);
    const average = previousVolumes.reduce((sum, value) => sum + value, 0) / previousVolumes.length;
    const latest = volumes.at(-1);
    volume = {
      latest,
      average,
      comparison: latest > average * 1.15 ? "Hoger dan gemiddeld"
        : latest < average * 0.85 ? "Lager dan gemiddeld"
          : "Ongeveer gemiddeld",
    };
  }

  const histogramThreshold = Number.isFinite(currentPrice) ? Math.abs(currentPrice) * 0.0005 : 0;
  const macdTone = !Number.isFinite(histogramValue) ? "Onvoldoende gegevens"
    : histogramValue > histogramThreshold ? "Positief"
      : histogramValue < -histogramThreshold ? "Negatief"
        : "Neutraal";

  return {
    count: closes.length,
    trend,
    rsi: atEnd(rsi),
    rsiTone: !Number.isFinite(atEnd(rsi)) ? "Onvoldoende gegevens"
      : atEnd(rsi) <= 30 ? "Relatief laag (30 of lager)"
        : atEnd(rsi) >= 70 ? "Relatief hoog (70 of hoger)"
          : "Normaal bereik",
    macd: { line: macdValue, signal: signalValue, histogram: histogramValue, tone: macdTone },
    volume,
    averages: {
      sma20, sma50, sma200,
      ema20: atEnd(ema20Series), ema50: atEnd(ema50Series),
      sma20Series, sma50Series, sma200Series,
    },
    priceAbove: {
      sma20: Number.isFinite(sma20) && Number.isFinite(currentPrice) ? currentPrice > sma20 : null,
      sma50: Number.isFinite(sma50) && Number.isFinite(currentPrice) ? currentPrice > sma50 : null,
      sma200: Number.isFinite(sma200) && Number.isFinite(currentPrice) ? currentPrice > sma200 : null,
    },
  };
}

globalThis.calculateIndicators = calculateIndicators;
globalThis.movingAverageSeries = movingAverageSeries;
globalThis.exponentialAverageSeries = exponentialAverageSeries;
globalThis.rsiSeries = rsiSeries;
globalThis.macdSeries = macdSeries;
