const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const elements = new Map();
const getElement = (id) => {
  if (!elements.has(id)) elements.set(id, { textContent: '', disabled: true, children: [], replaceChildren(...items) { this.children = items; }, append(...items) { this.children.push(...items); } });
  return elements.get(id);
};
const document = { getElementById: getElement, createElement: () => ({ textContent: '', children: [], append(...items) { this.children.push(...items); } }) };
let fetchCalls = 0;
const context = { document, location: { protocol: 'file:' }, fetch: async () => { fetchCalls += 1; throw new Error('unexpected request'); }, TextEncoder, console };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(`${fs.readFileSync('src/ai-bridge.js', 'utf8')}\nglobalThis.render = renderAiAnalysis; globalThis.redact = redactAiError;`, context);

(async () => {
  await context.initializeAiBridge();
  assert.equal(getElement('ai-analysis-button').disabled, true);
  assert.match(getElement('ai-connection-status').textContent, /run_local\.bat/);
  await context.requestAiAnalysis({ symbol: 'BTCUSDT' });
  assert.equal(fetchCalls, 0, 'no-provider state must never transmit analysis data');
  assert.match(getElement('ai-connection-status').textContent, /geen AI-dienst/);

  const inputs = {
    symbol: 'BTCUSDT', technicalSignal: { label: 'GEEN ACTIE' }, missingData: ['1d ontbreekt'],
    timeframes: {
      '15m': { score: 40, available: true, factors: [{ key: 'trend', direction: 1, evidence: 'Trend is stijgend.' }] },
      '1h': { score: -40, available: true, factors: [{ key: 'macd', direction: -1, evidence: 'MACD is negatief.' }] },
      '4h': { score: 0, available: true, factors: [] },
      '1d': { score: null, available: false, factors: [] },
    },
  };
  context.render({ label: 'MOGELIJK KOPEN', confidence: 72, positiveFactorIds: ['15m.trend'], negativeFactorIds: ['1h.macd'], missingIntervals: ['1d'], conflictPairs: ['15m|1h'] }, inputs);
  const rendered = JSON.stringify(getElement('ai-output-body').children);
  assert.match(rendered, /Trend is stijgend/);
  assert.match(rendered, /MACD is negatief/);
  assert.match(rendered, /15m tegenover 1h/);
  assert.match(rendered, /1d ontbreekt/);
  assert.throws(() => context.render({ label: 'KOPEN', confidence: 80, positiveFactorIds: ['1d.fake'], negativeFactorIds: [], missingIntervals: [], conflictPairs: [] }, inputs), /niet bij de marktgegevens/);
  assert.throws(() => context.render({ label: 'KOPEN', confidence: 80, positiveFactorIds: ['1h.macd'], negativeFactorIds: [], missingIntervals: [], conflictPairs: [] }, inputs), /niet bij de marktgegevens/);
  assert.equal(context.redact('Request failed with sk-proj-12345678901234567890'), 'Request failed with [verborgen sleutel]');
  console.log('AI-bridgecontract: geen-provider zonder verzending; uitleg alleen uit gecontroleerde factoren; ontbrekende data/tegenstrijdige perioden gecontroleerd; sleutels gemaskeerd.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
