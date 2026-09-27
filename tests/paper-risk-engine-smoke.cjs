const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('src/paper-trading.js', 'utf8');
const sandbox = { structuredClone, Date, Math, Number, Set, Map, Object, Array, Error, Promise };
vm.runInNewContext(source, sandbox, { filename: 'src/paper-trading.js' });
const engine = sandbox.PaperTradingEngine;
const base = { initialCapitalEur: 10000, symbols: ['BTCUSDT','ETHUSDT'], intervalMinutes: 1,
  feePercent: .1, slippagePercent: .05, maxPositionEur: 10000, maxPositionPercent: 100,
  maxOpenPositions: 2, maxExposurePercent: 90, stopLossPercent: 5, takeProfitPercent: 10,
  riskProfile: 'balanced', riskPerTradePercent: 1, maxTotalRiskPercent: 3,
  dailyLossLimitPercent: 3, maxDrawdownPercent: 15, minRiskReward: 1.5,
  stopLossMode: 'percent', stopLossFixedEur: 0 };
const buy = { available: true, label: 'KOPEN', score: 70, reason: 'test' };
const market = (symbol, price, now, signal = buy) => ({ symbol, priceEur: price, priceUsdt: price * 1.08, timestamp: now, fresh: true, signal });
let now = 1800000000000;
let account = engine.setStatus(engine.createAccount(base, now), 'running', now);
let result = engine.applyCycle(account, [market('BTCUSDT', 100, now), market('ETHUSDT', 100, now)], now);
account = result.account;
assert.equal(account.positions.length, 2);
assert.ok(account.positions.every(position => position.plannedRiskEur <= 100.000001), 'per-trade risk includes costs and stays below 1%');
assert.ok(account.positions.every(position => position.riskReward >= 1.5), 'minimum reward/risk is satisfied');
assert.ok(account.positions.every(position => position.potentialProfitBeforeCostsEur > position.plannedRewardEur), 'gross target profit is distinguished from the estimated net reward');
assert.equal(account.riskHistory.filter(row => row.outcome === 'TOEGESTAAN').length, 2);

// Total aggregate risk blocks the second position even when the position-count/cash caps permit it.
now += 60000;
const totalLimit = { ...base, maxTotalRiskPercent: 1 };
account = engine.setStatus(engine.createAccount(totalLimit, now), 'running', now);
result = engine.applyCycle(account, [market('BTCUSDT',100,now), market('ETHUSDT',100,now)], now);
assert.equal(result.account.positions.length, 1);
assert.ok(result.events.some(event => event.type === 'rejected' && /gezamenlijk risico/.test(event.reason)));

// Poor reward/risk blocks entries and logs the failed check.
now += 60000;
account = engine.setStatus(engine.createAccount({ ...base, minRiskReward: 3 }, now), 'running', now);
result = engine.applyCycle(account, [market('BTCUSDT',100,now)], now);
assert.equal(result.account.positions.length, 0);
assert.ok(result.account.riskHistory.at(-1).checks.some(check => check.rule.includes('risico/rendement') && !check.passed));

// Invalid/disabled stop-loss blocks entries; fixed price-distance stops also work.
now += 60000;
account = engine.setStatus(engine.createAccount({ ...base, stopLossPercent: 0 }, now), 'running', now);
result = engine.applyCycle(account, [market('BTCUSDT',100,now)], now);
assert.equal(result.account.positions.length, 0);
now += 60000;
account = engine.setStatus(engine.createAccount({ ...base, stopLossMode: 'fixed', stopLossFixedEur: 4 }, now), 'running', now);
result = engine.applyCycle(account, [market('BTCUSDT',100,now)], now);
assert.equal(result.account.positions.length, 1);
assert.ok(result.account.positions[0].stopLossEur < result.account.positions[0].entryPriceEur);

// Daily loss limit blocks additional trading and leaves existing positions open.
now += 60000;
account = engine.setStatus(engine.createAccount({ ...base, dailyLossLimitPercent: 3, maxDrawdownPercent: 50 }, now), 'running', now);
account = engine.applyCycle(account, [market('BTCUSDT',100,now)], now).account;
const openedId = account.positions[0].id;
now += 60000;
result = engine.applyCycle(account, [market('BTCUSDT',70,now,{available:true,label:'GEEN ACTIE',score:0}), market('ETHUSDT',100,now)], now);
assert.equal(result.account.dailyLossLocked, true);
assert.ok(result.account.positions.some(position => position.id === openedId), 'daily loss lock leaves existing position in place');
assert.ok(result.events.some(event => event.type === 'risk-locked'));

// Drawdown lock blocks new buys until explicit acknowledgement; lock survives account reload/save payload.
now += 60000;
account = engine.setStatus(engine.createAccount({ ...base, dailyLossLimitPercent: 50, maxDrawdownPercent: 1 }, now), 'running', now);
account = engine.applyCycle(account, [market('BTCUSDT',100,now)], now).account;
now += 60000;
result = engine.applyCycle(account, [market('BTCUSDT',90,now,{available:true,label:'GEEN ACTIE',score:0}), market('ETHUSDT',100,now)], now);
assert.ok(result.account.riskLock, 'drawdown persists a manual-resume lock');
assert.equal(result.account.positions.length, 0, 'drawdown lock still allows an already configured stop-loss exit');
assert.ok(result.account.riskHistory.some(row => row.outcome === 'GEBLOKKEERD'));
account = engine.resumeRiskLock(result.account, now + 1);
assert.equal(account.riskLock, null);
assert.equal(account.peakEquityEur, engine.portfolio(account).totalEur);
account.dailyLossLocked = true;
account = engine.resumeRiskLock(account, now + 2);
assert.equal(account.dailyLossLocked, true, 'manual drawdown resume must not bypass an active daily loss limit');

// Profile defaults are concrete, and the isolated engine has no order/exchange APIs.
assert.deepEqual(Object.keys(engine.PROFILE_DEFAULTS).sort(), ['aggressive','balanced','cautious']);
assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|WebSocket|placeOrder|createOrder|withdraw|transferFunds/i);
console.log('Phase 7 risk smoke tests passed: position sizing, caps, stop modes, risk/reward, daily loss lock, drawdown manual resume and order isolation.');
