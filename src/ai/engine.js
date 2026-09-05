// Single entry point used by all routes. Picks the LLM engine when an API key
// is configured, otherwise (or on any LLM failure) uses the rule-based engine.
// This is the only file that decides which backend runs, and the only file
// that mutates shared caseRecord state — both engines are called as near-pure
// functions.

const rulesEngine = require('./rulesEngine');
const matcher = require('./matcher');
const { normaliseLang } = require('../lib/i18n');

let llmEngine = null;

function useLLM() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function getLLM() {
  if (!llmEngine) llmEngine = require('./llmEngine');
  return llmEngine;
}

async function tryLLM(fn, label) {
  if (!useLLM()) return null;
  try {
    return await fn(getLLM());
  } catch (err) {
    console.warn(`[engine] LLM ${label} failed, falling back to rule engine: ${err.message}`);
    return null;
  }
}

function isLLMActive() {
  return useLLM();
}

function getOpeningPrompt(lang) {
  return rulesEngine.getOpeningPrompt(normaliseLang(lang));
}

async function intakeTurn(caseRecord, userText, lang) {
  const l = normaliseLang(lang);
  caseRecord.intake.messages.push({ role: 'user', text: userText });

  let result = await tryLLM((llm) => llm.intakeTurn(caseRecord, userText, l), 'intakeTurn');
  if (result) {
    caseRecord.intake.slots = { ...caseRecord.intake.slots, ...result.slots };
  } else {
    result = rulesEngine.intakeTurn(caseRecord, userText, l); // mutates slots directly
  }

  caseRecord.intake.messages.push({ role: 'assistant', text: result.assistantText });
  if (result.complete) caseRecord.intake.complete = true;
  return { assistantText: result.assistantText, complete: !!result.complete };
}

async function buildCaseMap(caseRecord, lang) {
  const l = normaliseLang(lang);
  // Cached per language: switching language rebuilds rather than showing stale text.
  if (caseRecord.map && caseRecord.mapLang === l) return caseRecord.map;

  let map = await tryLLM((llm) => llm.buildCaseMap(caseRecord, l), 'buildCaseMap');
  if (!map) map = rulesEngine.buildCaseMap(caseRecord, l);

  caseRecord.map = map;
  caseRecord.mapLang = l;
  caseRecord.report = null; // report is derived from the map, so invalidate it
  return map;
}

async function buildReadinessReport(caseRecord, lang) {
  const l = normaliseLang(lang);
  if (caseRecord.report && caseRecord.reportLang === l) return caseRecord.report;

  const map = await buildCaseMap(caseRecord, l);
  let report = await tryLLM((llm) => llm.buildReadinessReport(caseRecord, map, l), 'buildReadinessReport');
  if (!report) report = rulesEngine.buildReadinessReport(caseRecord, map, l);

  caseRecord.report = report;
  caseRecord.reportLang = l;
  return report;
}

function buildRelated(caseRecord, lang) {
  return matcher.matchRelated(caseRecord, normaliseLang(lang));
}

async function startRoleplay(caseRecord, mode, lang) {
  const l = normaliseLang(lang);
  caseRecord.roleplay.mode = mode;
  caseRecord.roleplay.turns = [];
  caseRecord.roleplay.queue = [];

  let result = await tryLLM((llm) => llm.roleplayStart(caseRecord, mode, l), 'roleplayStart');
  if (!result) result = rulesEngine.roleplayStart(caseRecord, mode, l);

  caseRecord.roleplay.turns.push({ role: 'ai', text: result.assistantText });
  return {
    assistantText: result.assistantText,
    disclaimer: result.disclaimer || rulesEngine.roleplayDisclaimer(mode, l),
    ended: false
  };
}

async function continueRoleplay(caseRecord, mode, userText, lang) {
  const l = normaliseLang(lang);
  caseRecord.roleplay.turns.push({ role: 'user', text: userText });

  let result = await tryLLM((llm) => llm.roleplayTurn(caseRecord, mode, userText, l), 'roleplayTurn');
  if (!result) result = rulesEngine.roleplayTurn(caseRecord, mode, userText, l);

  caseRecord.roleplay.turns.push({ role: 'ai', text: result.assistantText });
  return { assistantText: result.assistantText, ended: !!result.ended };
}

async function buildSimulationReport(caseRecord, lang) {
  const l = normaliseLang(lang);
  let report = await tryLLM((llm) => llm.buildSimulationReport(caseRecord, l), 'buildSimulationReport');
  if (!report) report = rulesEngine.buildSimulationReport(caseRecord, l);
  caseRecord.simulationReport = report;
  return report;
}

module.exports = {
  isLLMActive,
  getOpeningPrompt,
  intakeTurn,
  buildCaseMap,
  buildReadinessReport,
  buildRelated,
  startRoleplay,
  continueRoleplay,
  buildSimulationReport
};
