// Provider-neutral request templates for the browser's BYOK AI integration.
// This module never receives or stores an API key. The browser sends each
// request directly to the provider selected in Settings.
//
// Grounding note: legal concepts and counterarguments are supplied to the
// model from the curated knowledge base, and related forum threads / lessons
// are chosen deterministically by src/ai/matcher.js. The model rephrases and
// reasons over real content; it is never asked to invent citations.

const rulesEngine = require('./rulesEngine');
const { pick } = require('../lib/i18n');

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

function buildIntakeRequest(caseRecord, userText, lang) {
  // The current browser message is supplied separately below, so history only
  // contains the previously recorded conversation.
  const history = caseRecord.intake.messages.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join('\n');
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

  return { systemPrompt: system, userPrompt, maxTokens: 1024 };
}

function buildReadinessReportRequest(caseRecord, map, lang) {
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

  return { systemPrompt: system, userPrompt, maxTokens: 2000 };
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

function buildRoleplayStartRequest(caseRecord, mode, lang) {
  const system = buildRoleplaySystem(caseRecord, mode, lang);
  const userPrompt = `Begin the simulation now. Produce your opening line only (one question or one challenging
statement, in character, under 40 words). Respond with ONLY JSON: {"assistantText": "..."}`;
  return { systemPrompt: system, userPrompt, maxTokens: 400 };
}

function buildRoleplayTurnRequest(caseRecord, mode, userText, lang) {
  const system = buildRoleplaySystem(caseRecord, mode, lang);
  const history = [...caseRecord.roleplay.turns, { role: 'user', text: userText }]
    .map((t) => `${t.role === 'ai' ? 'YOU' : 'USER'}: ${t.text}`)
    .join('\n');
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

  return { systemPrompt: system, userPrompt, maxTokens: 400 };
}

function buildSimulationReportRequest(caseRecord, lang) {
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

  return { systemPrompt: system, userPrompt, maxTokens: 2000 };
}

module.exports = {
  buildIntakeRequest,
  buildReadinessReportRequest,
  buildRoleplayStartRequest,
  buildRoleplayTurnRequest,
  buildSimulationReportRequest
};
