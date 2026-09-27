const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('src/paper-trading.js', 'utf8');
const profileJson = fs.readFileSync('src/risk-profiles.js', 'utf8').match(/globalThis\.PHASE7_RISK_PROFILES\s*=\s*(\{.*\})\s*;/s)[1];
const sandbox = { structuredClone, Date, Math, Number, Set, Map, Object, Array, Error, Promise, PHASE7_RISK_PROFILES: JSON.parse(profileJson) };
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

// Unfilled BUY orders are separate from positions but reserve Phase 7 risk,
// per-symbol size, portfolio exposure, cash and concurrent-position capacity.
now += 60000;
const reservedLimits = { ...base, riskPerTradePercent: 1, maxTotalRiskPercent: 1,
  maxPositionPercent: 20, maxExposurePercent: 30, maxOpenPositions: 3 };
account = engine.createAccount(reservedLimits, now);
const item = market('ETHUSDT', 100, now);
const withoutReservations = engine.checkRisk(account, item, now);
account.reservedOrders = [{ symbol: 'BTCUSDT', quantity: 5, priceEur: 100, stopLossEur: 90, feePercent: .1 }];
const oneOpenBuy = engine.checkRisk(account, item, now);
assert.ok(oneOpenBuy.quantity < withoutReservations.quantity, 'a single open BUY reserves aggregate risk and portfolio exposure');
assert.equal(oneOpenBuy.checks.find(check => check.rule === 'bekende open-orderreserveringen').passed, true);
assert.equal(account.positions.length, 0, 'unfilled BUY reservations are not reported as filled positions');

now += 60000;
account = engine.createAccount({ ...reservedLimits, maxTotalRiskPercent: 3, maxExposurePercent: 100,
  maxPositionPercent: 100, maxPositionEur: 10000, maxOpenPositions: 12 }, now);
account.reservedOrders = Array.from({ length: 7 }, (_, index) => ({
  symbol: `X${index}USDT`, quantity: 9, priceEur: 100, stopLossEur: 95, feePercent: .1,
}));
const manyOpenBuys = engine.checkRisk(account, market('NEWUSDT', 100, now), now);
assert.equal(manyOpenBuys.allowed, false, 'aggregate risk reserved by several open BUY orders blocks another entry');
assert.ok(manyOpenBuys.checks.some(check => check.rule === 'gezamenlijk risico' && !check.passed));

// Filled positions and the unfilled remainder are both counted after a partial fill.
now += 60000;
account = engine.createAccount({ ...reservedLimits, maxTotalRiskPercent: 1, maxPositionPercent: 100,
  maxPositionEur: 10000, maxExposurePercent: 100 }, now);
account.positions = [{ symbol: 'BTCUSDT', quantity: 4, lastPriceEur: 100, entryPriceEur: 100,
  stopLossEur: 0, takeProfitEur: 0 }];
account.reservedOrders = [{ symbol: 'BTCUSDT', quantity: 5, priceEur: 100, stopLossEur: 90, feePercent: .1 }];
const filledPlusReserved = engine.checkRisk(account, market('ETHUSDT', 100, now), now);
assert.equal(filledPlusReserved.allowed, false, 'the filled position and remaining open BUY share aggregate risk and position capacity');

// Missing or malformed open-order risk inputs fail closed.
account = engine.createAccount(reservedLimits, now);
account.reservedOrders = [{ symbol: 'BTCUSDT', quantity: 1, priceEur: 100, stopLossEur: null }];
const unknownReservation = engine.checkRisk(account, market('ETHUSDT', 100, now), now);
assert.equal(unknownReservation.allowed, false);
assert.equal(unknownReservation.checks.find(check => check.rule === 'bekende open-orderreserveringen').passed, false);

// Profile defaults are concrete, and the isolated engine has no order/exchange APIs.
assert.deepEqual(Object.keys(engine.PROFILE_DEFAULTS).sort(), ['aggressive','balanced','cautious']);
assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|WebSocket|placeOrder|createOrder|withdraw|transferFunds/i);
console.log('Phase 7 risk smoke tests passed: position sizing, caps, stop modes, risk/reward, daily loss lock, drawdown manual resume and order isolation.');
