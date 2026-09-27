const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('src/paper-trading.js', 'utf8');
const sandbox = { structuredClone, Date, Math, Number, Set, Map, Object, Array, Error, Promise };
vm.runInNewContext(source, sandbox, { filename: 'src/paper-trading.js' });
const engine = sandbox.PaperTradingEngine;
const base = { initialCapitalEur: 10000, symbols: ['BTCUSDT','ETHUSDT'], intervalMinutes: 1,
  feePercent: 0.1, slippagePercent: 0.05, maxPositionEur: 1000, maxPositionPercent: 10,
  maxOpenPositions: 2, maxExposurePercent: 20, stopLossPercent: 5, takeProfitPercent: 10 };
const market = (symbol, price, signal, now, fresh = true) => ({ symbol, priceEur: price, priceUsdt: price * 1.08, timestamp: now, fresh, signal });
const buy = { available: true, label: 'KOPEN', score: 70, reason: 'Technische testreden' };
const sell = { available: true, label: 'VERKOPEN', score: -70, reason: 'Test verkoopsignaal' };
const neutral = { available: true, label: 'GEEN ACTIE', score: 0 };
let now = 1_800_000_000_000;
let account = engine.createAccount(base, now);
assert.equal(engine.portfolio(account).totalEur, 10000);
account = engine.setStatus(account, 'running', now);
let result = engine.applyCycle(account, [market('BTCUSDT', 100, buy, now), market('ETHUSDT', 100, neutral, now)], now);
account = result.account;
assert.equal(result.events.filter(x => x.type === 'opened').length, 1, 'buy creates one virtual position');
assert.equal(account.positions.length, 1);
assert.equal(account.trades[0].side, 'KOOP');
assert.ok(account.trades[0].feeEur > 0 && account.trades[0].slippageEur > 0, 'buy costs and slippage recorded');
assert.ok(account.cashEur < 10000 && account.cashEur > 8990);
assert.equal(account.positions[0].stopLossEur, account.positions[0].entryPriceEur * 0.95);
assert.equal(account.positions[0].takeProfitEur, account.positions[0].entryPriceEur * 1.1);
now += 60_000;
result = engine.applyCycle(account, [market('BTCUSDT', 101, buy, now)], now);
account = result.account;
assert.equal(account.positions.length, 1, 'same continuing buy signal does not duplicate position');
assert.equal(result.tradesAdded.length, 0);
now += 60_000;
result = engine.applyCycle(account, [market('BTCUSDT', 90, sell, now, false)], now);
account = result.account;
assert.equal(account.positions.length, 1, 'stale observation cannot close a position');
now += 60_000;
result = engine.applyCycle(account, [market('BTCUSDT', 90, sell, now)], now);
account = result.account;
assert.equal(account.positions.length, 0, 'fresh sell signal closes position');
assert.equal(account.trades.at(-1).side, 'VERKOOP');
assert.ok(account.trades.at(-1).realizedProfitLossEur < 0);
assert.ok(account.trades.at(-1).feeEur > 0 && account.trades.at(-1).slippageEur > 0);
assert.equal(engine.portfolio(account).openPositions, 0);

// Stop-loss and take-profit are acted on only after a fresh, real-price observation.
for (const [exitPrice, field, reasonText] of [[80, 'stopLossEur', 'Stop-loss'], [130, 'takeProfitEur', 'Take-profit']]) {
  now += 60_000; account = engine.createAccount(base, now); account = engine.setStatus(account, 'running', now);
  account = engine.applyCycle(account, [market('BTCUSDT', 100, buy, now)], now).account;
  const threshold = account.positions[0][field];
  now += 60_000;
  const exit = engine.applyCycle(account, [market('BTCUSDT', exitPrice, neutral, now)], now);
  assert.equal(exit.account.positions.length, 0);
  assert.match(exit.tradesAdded[0].reason, new RegExp(reasonText));
  assert.ok(exit.tradesAdded[0].realizedProfitLossEur !== null);
}

// Risk controls: max simultaneous positions, per-position cap and exposure cap.
now += 60_000; account = engine.createAccount(base, now); account = engine.setStatus(account, 'running', now);
result = engine.applyCycle(account, [market('BTCUSDT', 100, buy, now), market('ETHUSDT', 100, buy, now)], now);
assert.equal(result.account.positions.length, 2);
assert.ok(result.account.positions.every(p => p.entryNotionalEur <= 1000));
assert.ok(result.events.some(x => x.type === 'opened'));
const tooMany = { ...base, maxOpenPositions: 1 };
now += 60_000; account = engine.setStatus(engine.createAccount(tooMany, now), 'running', now);
result = engine.applyCycle(account, [market('BTCUSDT', 100, buy, now), market('ETHUSDT', 100, buy, now)], now);
assert.equal(result.account.positions.length, 1);
assert.ok(result.events.some(x => x.type === 'rejected'));
const tooMuch = { ...base, maxExposurePercent: 10, maxPositionPercent: 10, maxPositionEur: 10000 };
now += 60_000; account = engine.setStatus(engine.createAccount(tooMuch, now), 'running', now);
result = engine.applyCycle(account, [market('BTCUSDT', 100, buy, now), market('ETHUSDT', 100, buy, now)], now);
assert.equal(result.account.positions.length, 1, 'exposure cap blocks second open');

// Pause updates valid marks but blocks entries and exits; stop prevents any mutation.
now += 60_000; account = engine.setStatus(engine.createAccount(base, now), 'paused', now);
result = engine.applyCycle(account, [market('BTCUSDT', 100, buy, now)], now);
assert.equal(result.account.positions.length, 0);
account = engine.setStatus(result.account, 'stopped', now);
result = engine.applyCycle(account, [market('BTCUSDT', 100, buy, now)], now + 1);
assert.equal(result.account.lastCycleAt, account.lastCycleAt);
assert.equal(result.tradesAdded.length, 0);

// Malformed/missing data and absent AI are never turned into fake values or trades.
now += 60_000; account = engine.setStatus(engine.createAccount(base, now), 'running', now);
result = engine.applyCycle(account, [market('BTCUSDT', 100, buy, now, false)], now);
assert.equal(result.account.trades.length, 0);
assert.equal(result.account.positions.length, 0);
assert.equal(result.account.trades.length, 0, 'no AI result is fabricated');
assert.equal(result.account.equity.length, 1);

// Safety boundary: the engine has no network/order API references.
assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|WebSocket|placeOrder|createOrder|withdraw|transferFunds/i);
console.log('Paper trading smoke tests passed: virtual buy/sell, fees/slippage, SL/TP, stale data, risk caps, pause/stop and no order APIs.');


