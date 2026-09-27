// Minimal asynchronous IndexedDB double for persistence-contract testing.
class FakeRequest { constructor(result) { this.result=result; setTimeout(()=>this.onsuccess?.(),0); } }
class FakeTx {
  constructor(db,names,mode){this.db=db;this.mode=mode;this.names=names;setTimeout(()=>this.oncomplete?.(),0);}
  objectStore(name){return new FakeStore(this.db.stores.get(name),this.mode);}
}
class FakeStore {
  constructor(rows,mode){this.rows=rows;this.mode=mode;}
  get(key){return new FakeRequest(this.rows.get(key));}
  getAll(){return new FakeRequest([...this.rows.values()]);}
  put(value){if(this.mode!=='readwrite')throw Error('readonly');this.rows.set(value.id ?? value.time,value);return new FakeRequest(value);}
  clear(){if(this.mode!=='readwrite')throw Error('readonly');this.rows.clear();return new FakeRequest(undefined);}
}
class FakeDb {
  constructor(){this.stores=new Map();this.objectStoreNames={contains:(name)=>this.stores.has(name)};}
  createObjectStore(name){this.stores.set(name,new Map());return this.stores.get(name);}
  transaction(names,mode){return new FakeTx(this,names,mode);}
}
const database=new FakeDb();
const fs=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');
vm.runInThisContext(fs.readFileSync('src/paper-trading.js','utf8'),{filename:'src/paper-trading.js'});
const indexedDb={open(){const request={};setTimeout(()=>{if(!database.stores.has('account')){request.result=database;request.onupgradeneeded?.();}else request.result=database;request.onsuccess?.();},0);return request;}};
(async()=>{
 const settings={initialCapitalEur:10000,symbols:['BTCUSDT','ETHUSDT'],intervalMinutes:5,feePercent:.1,slippagePercent:.05,maxPositionEur:1000,maxPositionPercent:10,maxOpenPositions:3,maxExposurePercent:50,stopLossPercent:5,takeProfitPercent:10,riskProfile:'cautious',riskPerTradePercent:.5,maxTotalRiskPercent:1.5,dailyLossLimitPercent:2,maxDrawdownPercent:10,minRiskReward:1.5};
 const engine=globalThis.PaperTradingEngine;
 let store=engine.createStore(indexedDb); let account=engine.createAccount(settings,1000);
 await store.save(account); store=engine.createStore(indexedDb);
 let restored=await store.load(); assert.equal(restored.initialCapitalEur,10000);assert.equal(JSON.stringify(restored.symbols),JSON.stringify(['BTCUSDT','ETHUSDT']));assert.equal(restored.cashEur,10000);assert.equal(restored.equity.length,1);assert.equal(restored.riskProfile,'cautious');assert.equal(restored.riskPerTradePercent,.5);assert.equal(restored.maxTotalRiskPercent,1.5);assert.equal(restored.dailyLossLimitPercent,2);assert.equal(restored.maxDrawdownLimitPercent,10);assert.equal(restored.riskHistory.length,0);
 account=engine.setStatus(restored,'running',2000);await store.save(account);restored=await store.load();assert.equal(restored.status,'running');
 await store.reset();assert.equal(await store.load(),null);
 console.log('IndexedDB persistence smoke tests passed: account/settings/status survive reload; reset clears paper-only stores.');
})().catch(error=>{console.error(error);process.exitCode=1;});


