// Optional Claude-backed engine. Only used when ANTHROPIC_API_KEY is set (see
// src/ai/engine.js for the switch). Every function here either returns a
// well-formed result or throws — engine.js catches failures and falls back to
// the rule-based engine, so a live demo never breaks because of a network
// hiccup, rate limit, or malformed model output.
//
// Grounding note: legal concepts and counterarguments are supplied to the
// model from the curated knowledge base, and related forum threads / lessons
// are chosen deterministically by src/ai/matcher.js. The model rephrases and
// reasons over real content; it is never asked to invent citations.

const Anthropic = require('@anthropic-ai/sdk');
const concepts = require('../../data/legal-concepts.json');
const rulesEngine = require('./rulesEngine');
const { pick } = require('../lib/i18n');

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const LANGUAGE_NAMES = {
  en: 'English',
  zh: 'Simplified Chinese (中文)',
  ms: 'Bahasa Melayu',
  ta: 'Tamil (தமிழ்)'
};

function languageRule(lang) {
  return `Write ALL user-facing text in ${LANGUAGE_NAMES[lang] || 'English'}. Keep legal citations (case names, statute names, and neutral citations such as [2007] SGCA 37) in their original form — do not translate them.`;
}

const RESPONSIBLE_AI_PREAMBLE = `You are the AI engine behind "Case Compass", a responsible AI case-preparation
companion for self-represented persons preparing a civil dispute in Singapore (typically for the Small Claims
Tribunals). You are NOT a lawyer and must never claim to be one. Follow these rules strictly:
- Never predict whether the user will win or lose. Produce a neutral preparation view only.
- Never invent a statute, case name, citation, or URL. Use only what is supplied to you in the prompt.
- Where you are unsure, say so explicitly rather than inventing detail.
- Actively surface counterarguments and alternative interpretations instead of validating the user's account.
- Do not impersonate a real judge, tribunal officer, or claim authority you do not have.
- Keep language plain, calm, and professional — never dramatic or alarmist.
- Base output only on what the user actually told you; if information is missing, treat it as missing.`;

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

async function intakeTurn(caseRecord, userText, lang) {
  // engine.js records the current message before calling us. Keep it out of
  // history because it is supplied once below as the latest message.
  const history = caseRecord.intake.messages.slice(0, -1).map((m) => `${m.role.toUpperCase()}: ${m.text}`).join('\n');
  const system = `${RESPONSIBLE_AI_PREAMBLE}

${languageRule(lang)}

You are conducting a structured intake interview to fill these slots from the user's free-text answers:
- disputeType: one of goods, services, deposit_tenancy, debt_loan, property_damage, employment, other
- amountClaimed: a short dollar string like "$800", or null
- whatHappened: a short narrative summary in the user's own words
- timeline: dates or deadlines mentioned, or null
- evidence: array of canonical labels the user says they HAVE, drawn only from:
  "Receipt/Invoice", "Contract/Agreement", "Written correspondence", "Photos/Video", "Witness",
  "Payment/transfer record", "Payslip/salary record". If the user says they do NOT have something, do not list it.
- priorContact: "Yes", "No", or null
- desiredOutcome: one of refund, replacement, repair, compensation, deposit_return, repayment, unpaid_salary, or null

First, address the substance of the LATEST USER MESSAGE in one or two plain sentences. If it answers a question
you asked, acknowledge the specific information supplied; do not ask that question again. If it asks a direct
question, answer only from the supplied facts and these instructions. Say exactly what is unknown when the facts
do not support an answer. Do not use generic acknowledgements, restate the user's question, or repeat a previous
follow-up.

Then ask ONE targeted follow-up question at a time for the single most useful missing slot. After at most 6 user
turns, or once you have enough for a reasonable preparation view, stop asking and set complete=true. The reply
must contain an answer or acknowledgement before a follow-up unless the intake is complete.
Note: employment/salary disputes are NOT heard by the Small Claims Tribunals; do not tell the user to file there.

Respond with ONLY a JSON object, no other text:
{"slots": {...all slots, carrying forward previous values if unchanged...}, "assistantText": "...", "complete": true|false}`;

  const userPrompt = `Current known slots: ${JSON.stringify(caseRecord.intake.slots)}
Conversation so far:
${history}
LATEST USER MESSAGE: ${userText}

Return the JSON object described in the system prompt.`;

  const result = await callJSON(system, userPrompt);
  if (!result.slots || typeof result.assistantText !== 'string') throw new Error('Malformed intake JSON from LLM');
  return { slots: result.slots, assistantText: result.assistantText, complete: !!result.complete };
}

function knowledgeBaseFor(lang) {
  const out = {};
  for (const [id, c] of Object.entries(concepts.concepts)) {
    out[id] = {
      title: pick(c.title, lang),
      plainLanguage: pick(c.plainLanguage, lang),
      verify: pick(c.verify, lang),
      confidence: c.confidence,
      sources: c.sources
    };
  }
  return out;
}

async function buildCaseMap(caseRecord, lang) {
  const dt = rulesEngine.findDisputeType(caseRecord.intake.slots.disputeType || 'other');
  const suggestions = concepts.evidenceSuggestions[dt.id] || concepts.evidenceSuggestions.other;

  const system = `${RESPONSIBLE_AI_PREAMBLE}

${languageRule(lang)}

Build a "Fact-Evidence-Law map" from the user's intake. You are given a curated knowledge base below. You MUST
only cite concepts from it — do not invent statutes, cases, or URLs. Each fact must be one atomic proposition,
not a copied narrative. Put dates, sequences, and deadlines only in the timeline fact; never repeat a timeline
entry as a general fact. Tag each fact and evidence item with a status: "supported" (clearly stated or held),
"uncertain" (partially clear or unverified), or "missing" (not provided or not yet gathered).

RELEVANT CONCEPT IDS FOR THIS DISPUTE TYPE: ${JSON.stringify(dt.concepts)}
KNOWLEDGE BASE: ${JSON.stringify(knowledgeBaseFor(lang))}
SUGGESTED EVIDENCE FOR THIS DISPUTE TYPE: ${JSON.stringify(suggestions.map((s) => ({ id: s.id, label: pick(s.label, lang) })))}

Respond with ONLY a JSON object:
{"disputeTypeId": "${dt.id}", "disputeTypeLabel": "...",
 "facts": [{"text":"...","status":"supported|uncertain|missing"}],
 "evidence": [{"id":"...","text":"...","status":"supported|uncertain|missing"}],
 "law": [{"id":"...","title":"...","plainLanguage":"...","verify":"...","confidence":"...","sources":[{"label":"...","url":"..."}]}]}
Copy each law entry's plainLanguage, verify, confidence and sources verbatim from the knowledge base.`;

  const userPrompt = `Intake slots: ${JSON.stringify(caseRecord.intake.slots)}`;
  const result = await callJSON(system, userPrompt, 2000);
  if (!Array.isArray(result.facts) || !Array.isArray(result.evidence) || !Array.isArray(result.law)) {
    throw new Error('Malformed case map JSON from LLM');
  }
  return { disputeTypeId: dt.id, disputeTypeLabel: pick(dt.label, lang), ...result };
}

async function buildReadinessReport(caseRecord, map, lang) {
  const dt = rulesEngine.findDisputeType(caseRecord.intake.slots.disputeType || 'other');

  const system = `${RESPONSIBLE_AI_PREAMBLE}

${languageRule(lang)}

Produce a neutral Case Readiness Report from the given Fact-Evidence-Law map. Do not predict outcomes.
Base "counterarguments" on the supplied list — you may tailor the wording to the user's facts, but do not
invent new legal theories.

Respond with ONLY a JSON object:
{"disputeTypeLabel":"...", "strengths":["..."], "weaknesses":["..."], "missingInfo":["..."],
 "documentsToGather":["..."], "counterarguments":["..."], "disclaimer":"..."}`;

  const userPrompt = `Case map: ${JSON.stringify(map)}
Counterarguments for this dispute type: ${JSON.stringify(pick(dt.counterarguments, lang))}
Use this exact disclaimer text: ${JSON.stringify(require('../lib/i18n').t(lang, 'report.disclaimer'))}`;

  const result = await callJSON(system, userPrompt, 2000);
  if (!Array.isArray(result.strengths) || !Array.isArray(result.weaknesses)) {
    throw new Error('Malformed readiness report JSON from LLM');
  }
  return { disputeTypeId: dt.id, ...result };
}

function buildRoleplaySystem(caseRecord, mode, lang) {
  const roleDescription =
    mode === 'opposing'
      ? 'You are role-playing as the OPPOSING PARTY in this dispute. Raise plausible objections, factual disagreements, and counterarguments in character, as that party would speak. Stay respectful but firm.'
      : "You are role-playing a TRIBUNAL QUESTIONING mode. Ask the kind of clarifying, probing questions a tribunal officer might ask to test whether facts are clear and supported. You must NOT impersonate a real judge, use a judge's title, or claim to predict how a real tribunal would rule.";

  return `${RESPONSIBLE_AI_PREAMBLE}

${languageRule(lang)}

${roleDescription}
Case facts you may draw on (do not invent facts beyond these): ${JSON.stringify(caseRecord.intake.slots)}
Keep each line short (under 40 words), one question or challenge at a time, and never break character to give legal advice.
Every turn after the opening must directly engage with the user's immediately preceding answer: identify one
concrete point that needs proof, is unclear, or is challenged, then ask one new question about that point. Never
repeat a question already asked or ignore an answer by moving to a generic scripted question.`;
}

async function roleplayStart(caseRecord, mode, lang) {
  const system = buildRoleplaySystem(caseRecord, mode, lang);
  const userPrompt = `Begin the simulation now. Produce your opening line only (one question or one challenging
statement, in character, under 40 words). Respond with ONLY JSON: {"assistantText": "..."}`;
  const result = await callJSON(system, userPrompt, 400);
  if (typeof result.assistantText !== 'string') throw new Error('Malformed roleplay-start JSON from LLM');
  return { assistantText: result.assistantText, disclaimer: rulesEngine.roleplayDisclaimer(mode, lang), ended: false };
}

async function roleplayTurn(caseRecord, mode, userText, lang) {
  const system = buildRoleplaySystem(caseRecord, mode, lang);
  const history = caseRecord.roleplay.turns.map((t) => `${t.role === 'ai' ? 'YOU' : 'USER'}: ${t.text}`).join('\n');
  const aiTurns = caseRecord.roleplay.turns.filter((t) => t.role === 'ai').length;
  const shouldWrapUp = aiTurns >= 4;

  const userPrompt = `Conversation so far:
${history}

${
  shouldWrapUp
    ? 'You have asked enough for this round — deliver a brief closing line and set ended=true.'
    : "Continue with your next single line (one question or challenge, under 40 words). Set ended=true only if you judge you have sufficiently stress-tested the user's case."
}
Respond with ONLY JSON: {"assistantText": "...", "ended": true|false}`;

  const result = await callJSON(system, userPrompt, 400);
  if (typeof result.assistantText !== 'string') throw new Error('Malformed roleplay-turn JSON from LLM');
  return { assistantText: result.assistantText, ended: !!result.ended };
}

async function buildSimulationReport(caseRecord, lang) {
  const system = `${RESPONSIBLE_AI_PREAMBLE}

${languageRule(lang)}

Review this role-play transcript and classify each AI-question/user-answer pair into exactly one of:
heldUp (clear, specific, evidence-backed answer), couldBeStronger (adequate but vague or generic),
weak (uncertain, evasive, or very short, e.g. "I don't know"). Then give 2-4 short, practical
recommendations for further preparation. Do not predict outcomes. Quote the question and answer verbatim.

Respond with ONLY JSON: {"heldUp":[{"question":"...","answer":"..."}], "couldBeStronger":[...],
"weak":[...], "recommendations":["..."]}`;

  const userPrompt = `Mode: ${caseRecord.roleplay.mode}
Transcript: ${JSON.stringify(caseRecord.roleplay.turns)}`;

  const result = await callJSON(system, userPrompt, 2000);
  if (!Array.isArray(result.heldUp) || !Array.isArray(result.recommendations)) {
    throw new Error('Malformed simulation report JSON from LLM');
  }
  return {
    mode: caseRecord.roleplay.mode,
    heldUp: result.heldUp,
    couldBeStronger: result.couldBeStronger || [],
    weak: result.weak || [],
    recommendations: result.recommendations
  };
}

module.exports = {
  intakeTurn,
  buildCaseMap,
  buildReadinessReport,
  roleplayStart,
  roleplayTurn,
  buildSimulationReport
};
