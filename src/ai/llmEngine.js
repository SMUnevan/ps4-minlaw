// Optional Claude-backed engine. Only used when ANTHROPIC_API_KEY is set
// (see src/ai/engine.js for the switch). Every function here either returns
// a well-formed result or throws - engine.js is responsible for catching
// failures and falling back to the rule-based engine, so a live demo never
// breaks because of a network hiccup, rate limit, or malformed model output.

const Anthropic = require('@anthropic-ai/sdk');
const concepts = require('../../data/legal-concepts.json');
const rulesEngine = require('./rulesEngine');

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const RESPONSIBLE_AI_PREAMBLE = `You are the AI engine behind "Case Compass", a responsible AI case-preparation
companion for self-represented persons (SRPs) preparing a civil dispute (e.g. for Singapore's Small Claims
Tribunal). You are NOT a lawyer and must never claim to be one. Follow these rules strictly:
- Never predict whether the user will win or lose. Produce a neutral preparation view only.
- Never state a legal proposition as certain fact unless it is clearly general, widely-known information; where
  unsure, say so explicitly rather than inventing detail.
- Actively surface counterarguments and alternative interpretations instead of validating the user's account.
- Do not impersonate a real judge, tribunal officer, or claim authority you do not have.
- Keep language plain, calm, and professional - never dramatic or alarmist.
- Output must depend only on what the user actually told you; if information is missing, treat it as missing.`;

async function callJSON(systemPrompt, userPrompt, maxTokens = 1024) {
  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });
  const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('LLM did not return parseable JSON: ' + text.slice(0, 200));
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function intakeTurn(caseRecord, userText) {
  const history = caseRecord.intake.messages.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join('\n');
  const system = `${RESPONSIBLE_AI_PREAMBLE}

You are conducting a structured intake interview to fill these slots from the user's free-text answers:
disputeType (one of: goods, services, deposit_tenancy, debt_loan, property_damage, other),
amountClaimed (a dollar figure as a short string, or null), whatHappened (a short narrative summary),
timeline (dates/deadlines mentioned, or null), evidence (array of short evidence labels the user says they
have, e.g. "Receipt/Invoice", "Written correspondence", "Photos/Video", "Witness", "Contract/Agreement",
"Payment/transfer record"; empty array if none), priorContact ("Yes", "No", or null), desiredOutcome (short
phrase or null).

Ask ONE targeted follow-up question at a time for the single most useful missing slot. After at most 6 user
turns total, or once you have enough for a reasonable preparation view, stop asking and set complete=true.
Respond with ONLY a JSON object, no other text: {"slots": {...all slots, using previous values if unchanged...},
"assistantText": "...", "complete": true|false}`;

  const userPrompt = `Current known slots: ${JSON.stringify(caseRecord.intake.slots)}
Conversation so far:
${history}
LATEST USER MESSAGE: ${userText}

Return the JSON object described in the system prompt.`;

  const result = await callJSON(system, userPrompt);
  if (!result.slots || typeof result.assistantText !== 'string') throw new Error('Malformed intake JSON from LLM');
  return { slots: result.slots, assistantText: result.assistantText, complete: !!result.complete };
}

async function buildCaseMap(caseRecord) {
  const system = `${RESPONSIBLE_AI_PREAMBLE}

You will build a "Fact-Evidence-Law map" from the user's intake. You are given a small curated legal
knowledge base below - you MUST only cite concepts from this knowledge base (do not invent statutes,
case names, or legal rules not present here). Each fact and evidence item must be tagged with a status:
"supported" (clearly stated/present), "uncertain" (partially clear or unverified), or "missing" (not provided
or not yet gathered).

KNOWLEDGE BASE (concepts): ${JSON.stringify(concepts.concepts)}
EVIDENCE SUGGESTIONS BY DISPUTE TYPE: ${JSON.stringify(concepts.evidenceSuggestions)}
DISPUTE TYPES: ${JSON.stringify(concepts.disputeTypes.map((d) => ({ id: d.id, label: d.label, concepts: d.concepts })))}

Respond with ONLY a JSON object, no other text:
{"disputeTypeLabel": "...", "facts": [{"text":"...", "status":"supported|uncertain|missing"}, ...],
"evidence": [{"text":"...", "status":"supported|uncertain|missing"}, ...],
"law": [{"title":"...", "plainLanguage":"...", "verify":"...", "confidence":"..."}, ...] }
The "law" array items must be copied from the knowledge base concepts relevant to this dispute type (do not
alter their plainLanguage/verify/confidence text).`;

  const userPrompt = `Intake slots: ${JSON.stringify(caseRecord.intake.slots)}`;
  const result = await callJSON(system, userPrompt, 1536);
  if (!Array.isArray(result.facts) || !Array.isArray(result.evidence) || !Array.isArray(result.law)) {
    throw new Error('Malformed case map JSON from LLM');
  }
  return result;
}

async function buildReadinessReport(caseRecord, map) {
  const dt = concepts.disputeTypes.find((d) => d.id === (caseRecord.intake.slots.disputeType || 'other')) ||
    concepts.disputeTypes.find((d) => d.id === 'other');

  const system = `${RESPONSIBLE_AI_PREAMBLE}

Produce a neutral Case Readiness Report from the given Fact-Evidence-Law map. Do not predict outcomes.
Base "counterarguments" primarily on the provided list (you may lightly tailor wording to the user's facts,
but do not invent entirely new legal theories).

Respond with ONLY a JSON object, no other text:
{"disputeTypeLabel":"...", "strengths": ["..."], "weaknesses": ["..."], "missingInfo": ["..."],
"documentsToGather": ["..."], "counterarguments": ["..."],
"disclaimer": "This is a neutral preparation view based only on what you told this app. It does not predict whether you will win or lose, and it is not a substitute for legal advice."}`;

  const userPrompt = `Case map: ${JSON.stringify(map)}
Known counterarguments for this dispute type: ${JSON.stringify(dt.counterarguments)}`;

  const result = await callJSON(system, userPrompt, 1536);
  if (!Array.isArray(result.strengths) || !Array.isArray(result.weaknesses)) {
    throw new Error('Malformed readiness report JSON from LLM');
  }
  return result;
}

async function roleplayStart(caseRecord, mode) {
  const system = buildRoleplaySystem(caseRecord, mode);
  const userPrompt = `Begin the simulation now. Produce your opening line only (one question or one
challenging statement, in character, under 40 words). Respond with ONLY JSON: {"assistantText": "..."}`;
  const result = await callJSON(system, userPrompt, 300);
  if (typeof result.assistantText !== 'string') throw new Error('Malformed roleplay-start JSON from LLM');
  return { assistantText: result.assistantText, disclaimer: rulesEngine.ROLEPLAY_DISCLAIMER[mode], ended: false };
}

async function roleplayTurn(caseRecord, mode, userText) {
  const system = buildRoleplaySystem(caseRecord, mode);
  const history = caseRecord.roleplay.turns.map((t) => `${t.role === 'ai' ? 'YOU' : 'USER'}: ${t.text}`).join('\n');
  const turnsSoFar = caseRecord.roleplay.turns.filter((t) => t.role === 'ai').length;
  const shouldWrapUp = turnsSoFar >= 4;

  const userPrompt = `Conversation so far:
${history}
USER: ${userText}

${shouldWrapUp ? 'You have asked enough for this round - deliver a brief closing line and set ended=true.' : 'Continue the simulation with your next single line (one question or challenge, under 40 words). Set ended=true only if you judge you have sufficiently stress-tested the user\'s case.'}
Respond with ONLY JSON: {"assistantText": "...", "ended": true|false}`;

  const result = await callJSON(system, userPrompt, 300);
  if (typeof result.assistantText !== 'string') throw new Error('Malformed roleplay-turn JSON from LLM');
  return { assistantText: result.assistantText, ended: !!result.ended };
}

function buildRoleplaySystem(caseRecord, mode) {
  const roleDescription =
    mode === 'opposing'
      ? 'You are role-playing as the OPPOSING PARTY in this dispute. Raise plausible objections, factual disagreements, and counterarguments in character, as that party would speak. Stay respectful but firm.'
      : "You are role-playing a TRIBUNAL QUESTIONING mode. Ask the kind of clarifying, probing questions a tribunal officer might ask to test whether facts are clear and supported. You must NOT impersonate a real judge, use a judge's title, or claim to predict how a real tribunal would rule.";

  return `${RESPONSIBLE_AI_PREAMBLE}

${roleDescription}
Case facts you may draw on (do not invent facts beyond these): ${JSON.stringify(caseRecord.intake.slots)}
Keep each line short (under 40 words), one question or challenge at a time, and never break character to give legal advice.`;
}

async function buildSimulationReport(caseRecord) {
  const system = `${RESPONSIBLE_AI_PREAMBLE}

Review this role-play transcript and classify each AI-question/user-answer pair into exactly one of:
heldUp (clear, specific, evidence-backed answer), couldBeStronger (adequate but vague/generic answer),
weak (uncertain, evasive, or very short answer, e.g. "I don't know"). Then give 2-4 short, practical
recommendations for further preparation. Do not predict outcomes.

Respond with ONLY JSON: {"heldUp": [{"question":"...","answer":"..."}], "couldBeStronger": [...],
"weak": [...], "recommendations": ["..."]}`;

  const userPrompt = `Mode: ${caseRecord.roleplay.mode}
Transcript: ${JSON.stringify(caseRecord.roleplay.turns)}`;

  const result = await callJSON(system, userPrompt, 1536);
  if (!Array.isArray(result.heldUp) || !Array.isArray(result.recommendations)) {
    throw new Error('Malformed simulation report JSON from LLM');
  }
  return { mode: caseRecord.roleplay.mode, ...result };
}

module.exports = {
  intakeTurn,
  buildCaseMap,
  buildReadinessReport,
  roleplayStart,
  roleplayTurn,
  buildSimulationReport
};
