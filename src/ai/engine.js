// Single entry point used by all routes. Provider calls happen in the browser
// with the user's local BYOK setting; this server only supplies safe request
// templates and records the returned result. The fact map remains deterministic
// so it is an exact record of user input.

const rulesEngine = require('./rulesEngine');
const matcher = require('./matcher');
const { normaliseLang } = require('../lib/i18n');

const llmEngine = require('./llmEngine');

function isLLMActive() {
  return false;
}

function getAIRequest(caseRecord, task, lang, options = {}) {
  const l = normaliseLang(lang);
  switch (task) {
    case 'intake': return llmEngine.buildIntakeRequest(caseRecord, options.message, l);
    case 'report': return llmEngine.buildReadinessReportRequest(caseRecord, buildCaseMap(caseRecord, l), l);
    case 'roleplay-start': return llmEngine.buildRoleplayStartRequest(caseRecord, options.mode, l);
    case 'roleplay-turn': return llmEngine.buildRoleplayTurnRequest(caseRecord, options.mode, options.message, l);
    case 'simulation-report': return llmEngine.buildSimulationReportRequest(caseRecord, l);
    default: {
      const err = new Error('Unknown AI request');
      err.status = 400;
      throw err;
    }
  }
}

function validResult(result, fields) {
  return result && typeof result === 'object' && fields.every((field) => typeof result[field] !== 'undefined');
}

function getOpeningPrompt(lang) {
  return rulesEngine.getOpeningPrompt(normaliseLang(lang));
}

async function intakeTurn(caseRecord, userText, lang, aiResult) {
  const l = normaliseLang(lang);
  caseRecord.intake.messages.push({ role: 'user', text: userText });

  let result = aiResult;
  const fallback = !result || !result.slots || typeof result.slots !== 'object' || Array.isArray(result.slots) ||
    !Array.isArray(result.slots.evidence) || !result.slots.evidence.every((item) => typeof item === 'string') ||
    typeof result.assistantText !== 'string' || !result.assistantText.trim() || typeof result.complete !== 'boolean';
  if (fallback) {
    result = rulesEngine.intakeTurn(caseRecord, userText, l);
  } else {
    caseRecord.intake.slots = { ...caseRecord.intake.slots, ...result.slots };
  }
  caseRecord.map = null;
  caseRecord.report = null;
  caseRecord.intake.messages.push({ role: 'assistant', text: result.assistantText });
  if (result.complete) caseRecord.intake.complete = true;
  return { assistantText: result.assistantText, complete: !!result.complete, fallback };
}

function buildCaseMap(caseRecord, lang) {
  const l = normaliseLang(lang);
  // Cached per language: switching language rebuilds rather than showing stale text.
  if (caseRecord.map && caseRecord.mapLang === l) return caseRecord.map;

  // The case map is deliberately deterministic. It is the record of what the
  // user said, so it must not depend on a model paraphrasing or merging facts.
  const map = rulesEngine.buildCaseMap(caseRecord, l);

  caseRecord.map = map;
  caseRecord.mapLang = l;
  caseRecord.report = null; // report is derived from the map, so invalidate it
  return map;
}

async function buildReadinessReport(caseRecord, lang, aiResult) {
  const l = normaliseLang(lang);
  if (caseRecord.report && caseRecord.reportLang === l) return caseRecord.report;

  const map = await buildCaseMap(caseRecord, l);
  let report = aiResult;
  if (!report || typeof report.disclaimer !== 'string' || !report.disclaimer.trim() ||
      !['strengths', 'weaknesses', 'missingInfo', 'documentsToGather', 'counterarguments'].every((field) =>
        Array.isArray(report[field]) && report[field].every((item) => typeof item === 'string'))) {
    report = rulesEngine.buildReadinessReport(caseRecord, map, l);
    report.fallback = true;
  }

  caseRecord.report = report;
  caseRecord.reportLang = l;
  return report;
}

function buildRelated(caseRecord, lang) {
  return matcher.matchRelated(caseRecord, normaliseLang(lang));
}

async function startRoleplay(caseRecord, mode, lang, aiResult) {
  const l = normaliseLang(lang);
  caseRecord.roleplay.mode = mode;
  caseRecord.roleplay.turns = [];
  caseRecord.roleplay.queue = [];

  let result = aiResult;
  if (result && !validResult(result, ['assistantText'])) throw new Error('Invalid AI response');
  if (!result) result = rulesEngine.roleplayStart(caseRecord, mode, l);

  caseRecord.roleplay.turns.push({ role: 'ai', text: result.assistantText });
  return {
    assistantText: result.assistantText,
    disclaimer: result.disclaimer || rulesEngine.roleplayDisclaimer(mode, l),
    ended: false
  };
}

async function continueRoleplay(caseRecord, mode, userText, lang, aiResult) {
  const l = normaliseLang(lang);
  caseRecord.roleplay.turns.push({ role: 'user', text: userText });

  let result = aiResult;
  if (result && !validResult(result, ['assistantText'])) throw new Error('Invalid AI response');
  if (!result) result = rulesEngine.roleplayTurn(caseRecord, mode, userText, l);

  caseRecord.roleplay.turns.push({ role: 'ai', text: result.assistantText });
  return { assistantText: result.assistantText, ended: !!result.ended };
}

async function buildSimulationReport(caseRecord, lang, aiResult) {
  const l = normaliseLang(lang);
  let report = aiResult;
  if (report && !validResult(report, ['heldUp', 'recommendations'])) throw new Error('Invalid AI response');
  if (!report) report = rulesEngine.buildSimulationReport(caseRecord, l);
  caseRecord.simulationReport = report;
  return report;
}

module.exports = {
  isLLMActive,
  getAIRequest,
  getOpeningPrompt,
  intakeTurn,
  buildCaseMap,
  buildReadinessReport,
  buildRelated,
  startRoleplay,
  continueRoleplay,
  buildSimulationReport
};
