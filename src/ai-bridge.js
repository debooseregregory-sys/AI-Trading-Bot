// Fase 4: gebruikt uitsluitend de bestaande lokale /api/ai-aansluiting.
"use strict";

const AI_SIGNAL_LABELS = new Set(["KOPEN", "MOGELIJK KOPEN", "GEEN ACTIE", "MOGELIJK VERKOPEN", "VERKOPEN"]);
let aiAnalysisAvailable = false;

function redactAiError(message) {
  return String(message || "De AI-analyse is niet beschikbaar.")
    .replace(/sk-[A-Za-z0-9_-]{16,}/gi, "[verborgen sleutel]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [verborgen]")
    .replace(/(?:api[_ -]?key|secret)\s*[:=]\s*\S+/gi, "sleutel=[verborgen]")
    .slice(0, 240);
}

function renderAiAnalysis(result, context) {
  const title = document.getElementById("ai-output-title");
  const body = document.getElementById("ai-output-body");
  const status = document.getElementById("ai-connection-status");
  const valid = result && AI_SIGNAL_LABELS.has(result.label)
    && Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 100
    && Array.isArray(result.positiveFactorIds) && result.positiveFactorIds.length <= 12
    && Array.isArray(result.negativeFactorIds) && result.negativeFactorIds.length <= 12
    && Array.isArray(result.missingIntervals) && Array.isArray(result.conflictPairs);
  if (!valid) throw new Error("De AI-dienst gaf geen volledig, controleerbaar antwoord terug.");

  const citedFactors = (ids, direction) => ids.map((id) => {
    if (typeof id !== "string" || !/^(15m|1h|4h|1d)\.[a-z0-9]+$/.test(id)) throw new Error("De AI verwees naar een onbekende factor.");
    const [interval, key] = id.split(".");
    const factor = context.timeframes?.[interval]?.factors?.find((item) => item.key === key);
    if (!factor || (direction > 0 ? factor.direction <= 0 : factor.direction >= 0)) throw new Error("De AI noemde een factor die niet bij de marktgegevens past.");
    return `${interval}: ${factor.evidence}`;
  });
  const positive = citedFactors(result.positiveFactorIds, 1);
  const negative = citedFactors(result.negativeFactorIds, -1);
  const allowedMissing = result.missingIntervals.every((interval) =>
    ["15m", "1h", "4h", "1d"].includes(interval) && context.timeframes?.[interval]?.available === false);
  const allowedConflicts = result.conflictPairs.every((pair) => {
    if (typeof pair !== "string") return false;
    const [first, second] = pair.split("|");
    const left = context.timeframes?.[first]?.score; const right = context.timeframes?.[second]?.score;
    return first !== second && Number.isFinite(left) && Number.isFinite(right)
      && ((left >= 25 && right <= -25) || (left <= -25 && right >= 25));
  });
  if (!allowedMissing || !allowedConflicts) throw new Error("De AI verwees naar ontbrekende of tegenstrijdige gegevens die niet zijn aangetroffen.");

  title.textContent = `AI-analyse: ${result.label} · analyse-sterkte ${Math.round(result.confidence)}%`;
  body.replaceChildren();
  const addLine = (heading, text) => {
    const paragraph = document.createElement("p");
    const strong = document.createElement("strong"); strong.textContent = `${heading} `;
    const span = document.createElement("span"); span.textContent = text;
    paragraph.append(strong, span); body.append(paragraph);
  };
  const technicalLabel = context.technicalSignal?.label;
  addLine("Analyse:", `De AI beoordeelt ${context.symbol.replace(/USDT$/, "/USDT")} als ${result.label}. Het technische Fase 3-signaal is ${technicalLabel || "niet beschikbaar"}.`);
  addLine("Positieve factoren:", positive.length ? positive.join(" · ") : "Geen positieve factoren geselecteerd.");
  addLine("Negatieve factoren:", negative.length ? negative.join(" · ") : "Geen negatieve factoren geselecteerd.");
  if (result.conflictPairs.length) addLine("Tijdsframes spreken elkaar tegen:", result.conflictPairs.map((pair) => pair.replace("|", " tegenover ")).join(" · "));
  const missing = [...new Set([...context.missingData, ...result.missingIntervals.map((interval) => `${interval}: indicatoren ontbreken.`)])];
  if (missing.length) addLine("Ontbrekende gegevens:", missing.join(" · "));
  addLine("Conclusie:", result.conflictPairs.length || missing.length
    ? "De gegevens zijn niet volledig eenduidig; behandel deze beoordeling daarom voorzichtig."
    : `De AI heeft de beschikbare gegevens ingedeeld als ${result.label}. Dit blijft een analyse, geen voorspelling.`);
  status.textContent = "AI-analyse ontvangen. Analyse-sterkte is geen kans op winst.";
  return {
    label: result.label, confidence: result.confidence,
    positiveFactorIds: result.positiveFactorIds.slice(), negativeFactorIds: result.negativeFactorIds.slice(),
    missingIntervals: result.missingIntervals.slice(), conflictPairs: result.conflictPairs.slice(),
    technicalLabel: technicalLabel || null, analyzedAt: Date.now(),
  };
}

async function initializeAiBridge() {
  const status = document.getElementById("ai-connection-status");
  const button = document.getElementById("ai-analysis-button");
  if (location.protocol === "file:") {
    status.textContent = "Start run_local.bat om de lokale, beveiligde aansluiting te controleren.";
    button.disabled = true;
    return;
  }
  try {
    const response = await fetch("/api/ai/status", { method: "GET", cache: "no-store", credentials: "same-origin" });
    const data = await response.json();
    if (!response.ok) throw new Error("status niet beschikbaar");
    status.textContent = data.message || "Lokale aansluiting actief; AI-dienst nog niet gekozen.";
    aiAnalysisAvailable = data.analysisAvailable === true;
    button.disabled = !aiAnalysisAvailable;
  } catch (_) {
    status.textContent = "De lokale AI-aansluiting is niet bereikbaar. Start het programma met run_local.bat.";
    button.disabled = true;
  }
}

async function requestAiAnalysis(context) {
  const status = document.getElementById("ai-connection-status");
  const button = document.getElementById("ai-analysis-button");
  if (!aiAnalysisAvailable) {
    status.textContent = "Er is nog geen AI-dienst ingesteld. Er is niets verstuurd.";
    return;
  }
  if (new TextEncoder().encode(JSON.stringify(context)).length > 64 * 1024) {
    status.textContent = "De analysegegevens zijn te groot om veilig te versturen.";
    return;
  }
  button.disabled = true;
  status.textContent = "De AI-analyse wordt opgehaald…";
  try {
    const response = await fetch("/api/ai/analyze", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(context),
    });
    const data = await response.json();
    if (response.status === 503 && data.error === "ai_provider_not_configured") {
      aiAnalysisAvailable = false;
      button.disabled = true;
      status.textContent = data.message || "Er is nog geen AI-dienst ingesteld. Er is niets verstuurd.";
      return;
    }
    if (!response.ok) throw new Error(data.message || "De AI-analyse is nu niet beschikbaar.");
    return renderAiAnalysis(data, context);
  } catch (error) {
    status.textContent = error instanceof TypeError
      ? "De lokale AI-aansluiting is niet bereikbaar. De rest van de app blijft beschikbaar."
      : redactAiError(error.message);
    return null;
  } finally {
    button.disabled = !aiAnalysisAvailable;
  }
}

globalThis.initializeAiBridge = initializeAiBridge;
globalThis.requestAiAnalysis = requestAiAnalysis;
