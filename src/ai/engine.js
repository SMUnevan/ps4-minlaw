// Single entry point used by all routes. Picks the LLM engine when an API
// key is configured, otherwise (or on any LLM failure) uses the rule-based
// engine. This is the only file that decides which backend runs, and the
// only file that mutates shared caseRecord state - both engines are called
// as near-pure functions.

const rulesEngine = require('./rulesEngine');
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

function getOpeningPrompt() {
  return rulesEngine.getOpeningPrompt();
}

function isLLMActive() {
  return useLLM();
}

async function intakeTurn(caseRecord, userText) {
  caseRecord.intake.messages.push({ role: 'user', text: userText });

  let result = await tryLLM((llm) => llm.intakeTurn(caseRecord, userText), 'intakeTurn');
  let usedLLM = !!result;
  if (result) {
    caseRecord.intake.slots = { ...caseRecord.intake.slots, ...result.slots };
  } else {
    result = rulesEngine.intakeTurn(caseRecord, userText); // mutates caseRecord.intake.slots directly
  }

  caseRecord.intake.messages.push({ role: 'assistant', text: result.assistantText });
  if (result.complete) caseRecord.intake.complete = true;
  return { assistantText: result.assistantText, complete: !!result.complete, usedLLM };
}

async function buildCaseMap(caseRecord) {
  let map = await tryLLM((llm) => llm.buildCaseMap(caseRecord), 'buildCaseMap');
  if (!map) map = rulesEngine.buildCaseMap(caseRecord);
  caseRecord.map = map;
  return map;
}

async function buildReadinessReport(caseRecord) {
  const map = caseRecord.map || (await buildCaseMap(caseRecord));
  let report = await tryLLM((llm) => llm.buildReadinessReport(caseRecord, map), 'buildReadinessReport');
  if (!report) report = rulesEngine.buildReadinessReport(caseRecord, map);
  caseRecord.report = report;
  return report;
}

async function startRoleplay(caseRecord, mode) {
  caseRecord.roleplay.mode = mode;
  caseRecord.roleplay.turns = [];
  caseRecord.roleplay.queue = [];

  let result = await tryLLM((llm) => llm.roleplayStart(caseRecord, mode), 'roleplayStart');
  if (!result) result = rulesEngine.roleplayStart(caseRecord, mode);

  caseRecord.roleplay.turns.push({ role: 'ai', text: result.assistantText });
  return { assistantText: result.assistantText, disclaimer: result.disclaimer, ended: false };
}

async function continueRoleplay(caseRecord, mode, userText) {
  caseRecord.roleplay.turns.push({ role: 'user', text: userText });

  let result = await tryLLM((llm) => llm.roleplayTurn(caseRecord, mode, userText), 'roleplayTurn');
  if (!result) result = rulesEngine.roleplayTurn(caseRecord, mode, userText);

  caseRecord.roleplay.turns.push({ role: 'ai', text: result.assistantText });
  return { assistantText: result.assistantText, ended: !!result.ended };
}

async function buildSimulationReport(caseRecord) {
  let report = await tryLLM((llm) => llm.buildSimulationReport(caseRecord), 'buildSimulationReport');
  if (!report) report = rulesEngine.buildSimulationReport(caseRecord);
  caseRecord.simulationReport = report;
  return report;
}

module.exports = {
  isLLMActive,
  getOpeningPrompt,
  intakeTurn,
  buildCaseMap,
  buildReadinessReport,
  startRoleplay,
  continueRoleplay,
  buildSimulationReport
};
