"use strict";

// Thin process boundary over the existing Phase 7 engine; Testnet cannot send
// orders if this shared engine is missing or returns an invalid response.
require("./risk-profiles.js");
require("./paper-trading.js");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const request = JSON.parse(input);
    const engine = globalThis.PaperTradingEngine;
    if (!engine || typeof engine.checkRisk !== "function") throw new Error("Phase 7 risk engine unavailable");
    const result = engine.checkRisk(request.account, request.item, request.timestamp);
    process.stdout.write(JSON.stringify({ allowed: result.allowed, quantity: result.quantity, checks: result.checks,
      plannedRisk: result.plannedRiskEur, riskReward: result.riskReward, drawdown: result.drawdown,
      dailyPnl: result.dailyPnl, dailyLimit: result.dailyLimitEur }));
  } catch (_) {
    process.stdout.write(JSON.stringify({ allowed: false, error: "risk_engine_error" }));
    process.exitCode = 1;
  }
});
