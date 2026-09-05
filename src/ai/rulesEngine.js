// Fully self-contained, deterministic engine. No network calls, no API key
// needed. This is the default engine, and the guaranteed fallback whenever
// the LLM engine (src/ai/llmEngine.js) is unavailable or errors out - see
// src/ai/engine.js for the selection logic.

const concepts = require('../../data/legal-concepts.json');

const MAX_INTAKE_TURNS = 6;
const MAX_ROLEPLAY_TURNS = 5;

const SLOT_ORDER = ['disputeType', 'amountClaimed', 'evidence', 'priorContact', 'desiredOutcome', 'timeline'];

const QUESTIONS = {
  disputeType:
    "To point you to the right information: which best describes it - a problem with goods you bought, a service/contractor issue, a rental deposit dispute, money someone owes you personally, or property damage?",
  amountClaimed: 'Roughly how much money is involved in this dispute (an estimate is fine)?',
  evidence:
    'What documents or proof do you currently have - for example receipts, contracts, messages, photos, or witnesses? If you have none yet, just say so.',
  priorContact:
    'Have you already raised this issue with the other party (e.g. asked for a refund, sent a message)? What happened when you did?',
  desiredOutcome: 'What outcome are you hoping for - for example a refund, repair, replacement, or repayment?',
  timeline: 'When did this happen, and is there any deadline or time pressure you are aware of?'
};

const OPENING_PROMPT =
  "Tell me what happened, in your own words - don't worry about legal terms, just describe the situation as you would to a friend.";

function findDisputeType(id) {
  return concepts.disputeTypes.find((d) => d.id === id) || concepts.disputeTypes.find((d) => d.id === 'other');
}

function detectDisputeType(text) {
  const lower = text.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const dt of concepts.disputeTypes) {
    if (dt.id === 'other') continue;
    let score = 0;
    for (const kw of dt.keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = dt.id;
    }
  }
  return bestScore > 0 ? best : null;
}

function extractAmount(text) {
  let m = text.match(/(?:s\$|\$|sgd)\s?([\d,]+(?:\.\d{1,2})?)/i);
  if (!m) m = text.match(/([\d,]{2,7})\s?(?:dollars|bucks)\b/i);
  if (!m) return null;
  return '$' + m[1].replace(/,/g, '');
}

const NEGATION_WINDOW = /\b(no|not|don'?t|dont|without|never|lack(?:ing)?|didn'?t keep|missing)\b[^.?!,]{0,25}\b(KEYWORD)\b/;

function mentionedButNegated(lower, keywordPattern) {
  const re = new RegExp(NEGATION_WINDOW.source.replace('KEYWORD', keywordPattern), 'i');
  return re.test(lower);
}

function extractEvidence(text) {
  const lower = text.toLowerCase();
  const found = [];
  const patterns = [
    [/receipt|invoice/, 'receipt|invoice', 'Receipt/Invoice'],
    [/contract|agreement|tenancy agreement/, 'contract|agreement', 'Contract/Agreement'],
    [/whatsapp|text message|\bsms\b|\bemail\b|correspondence|\bchat\b/, 'whatsapp|text message|sms|email|correspondence|chat', 'Written correspondence'],
    [/photo|video|picture|screenshot/, 'photo|video|picture|screenshot', 'Photos/Video'],
    [/witness/, 'witness', 'Witness'],
    [/bank transfer|paynow|transfer record|payment record/, 'bank transfer|paynow|transfer record|payment record', 'Payment/transfer record']
  ];
  for (const [posRe, negKeyword, label] of patterns) {
    if (posRe.test(lower) && !found.includes(label) && !mentionedButNegated(lower, negKeyword)) {
      found.push(label);
    }
  }
  if (
    /\bno (evidence|documents|proof)\b/.test(lower) ||
    /don'?t have (any )?(evidence|proof|documents)/.test(lower) ||
    /nothing (in writing|documented)/.test(lower)
  ) {
    found.push('__none__');
  }
  return found;
}

function extractPriorContact(text) {
  const lower = text.toLowerCase();
  const no = /(never|haven'?t|have not|did not|didn'?t)\s+(contact|ask|tell|inform|email|call|message|complain)/;
  const yes = /\b(i |we )?(already )?(asked|contacted|emailed|called|messaged|told|informed|complained|requested|sent a demand|wrote to)/;
  if (no.test(lower)) return 'No';
  if (yes.test(lower)) return 'Yes';
  return null;
}

function extractDesiredOutcome(text) {
  const lower = text.toLowerCase();
  const options = [
    [/full refund|refund/, 'A refund'],
    [/replace(ment)?/, 'A replacement'],
    [/repair|fix it/, 'A repair'],
    [/compensat/, 'Compensation for losses'],
    [/apolog/, 'An apology'],
    [/deposit back|return.*deposit/, 'Return of deposit'],
    [/pay me back|repay|owed/, 'Repayment of money owed']
  ];
  for (const [re, label] of options) if (re.test(lower)) return label;
  return null;
}

function looksLikeTimeline(text) {
  return /\b(yesterday|last (week|month|year)|(\d{1,2}\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|\d{1,2}\/\d{1,2}|\d{4}|ago|weeks? ago|months? ago|days? ago)\b/i.test(
    text
  );
}

function firstMissingSlot(slots) {
  for (const slot of SLOT_ORDER) {
    if (slot === 'evidence') {
      if (!slots.evidence || slots.evidence.length === 0) return slot;
      continue;
    }
    if (!slots[slot]) return slot;
  }
  return null;
}

function getOpeningPrompt() {
  return OPENING_PROMPT;
}

function intakeTurn(caseRecord, userText) {
  const { slots } = caseRecord.intake;

  if (!slots.whatHappened) slots.whatHappened = userText;

  const dt = detectDisputeType(userText);
  if (dt && !slots.disputeType) slots.disputeType = dt;

  const amt = extractAmount(userText);
  if (amt && !slots.amountClaimed) slots.amountClaimed = amt;

  const ev = extractEvidence(userText);
  for (const e of ev) if (!slots.evidence.includes(e)) slots.evidence.push(e);

  const pc = extractPriorContact(userText);
  if (pc && !slots.priorContact) slots.priorContact = pc;

  const outcome = extractDesiredOutcome(userText);
  if (outcome && !slots.desiredOutcome) slots.desiredOutcome = outcome;

  if (!slots.timeline && looksLikeTimeline(userText)) slots.timeline = userText;

  const userTurns = caseRecord.intake.messages.filter((m) => m.role === 'user').length + 1;
  const missing = firstMissingSlot(slots);

  if (!missing || userTurns >= MAX_INTAKE_TURNS) {
    if (!slots.timeline) slots.timeline = 'Not specified';
    return {
      assistantText:
        "Thanks - that's enough for me to put together your Fact-Evidence-Law map and a Case Readiness Report. Building it now.",
      complete: true
    };
  }

  return { assistantText: QUESTIONS[missing], complete: false };
}

function buildCaseMap(caseRecord) {
  const { slots } = caseRecord.intake;
  const dt = findDisputeType(slots.disputeType || 'other');

  const facts = [
    { text: slots.whatHappened || 'Not yet described.', status: slots.whatHappened ? 'supported' : 'missing' },
    {
      text: `Amount involved: ${slots.amountClaimed || 'not specified'}`,
      status: slots.amountClaimed ? 'supported' : 'missing'
    },
    {
      text: `Prior contact with other party: ${slots.priorContact || 'not specified'}`,
      status: slots.priorContact ? (slots.priorContact === 'Yes' ? 'supported' : 'uncertain') : 'missing'
    },
    {
      text: `Desired outcome: ${slots.desiredOutcome || 'not specified'}`,
      status: slots.desiredOutcome ? 'supported' : 'missing'
    }
  ];
  if (slots.timeline && slots.timeline !== 'Not specified') {
    facts.push({ text: `Timeline: ${slots.timeline}`, status: 'supported' });
  } else {
    facts.push({ text: 'Timeline: not clearly specified', status: 'missing' });
  }

  const haveEvidence = slots.evidence.filter((e) => e !== '__none__');
  const evidenceItems = haveEvidence.map((text) => ({ text, status: 'supported' }));
  const suggested = concepts.evidenceSuggestions[dt.id] || concepts.evidenceSuggestions.other;
  for (const s of suggested) {
    const already = haveEvidence.some((h) => s.toLowerCase().includes(h.toLowerCase().split('/')[0]));
    if (!already) evidenceItems.push({ text: s, status: 'missing' });
  }

  const law = dt.concepts.map((cid) => {
    const c = concepts.concepts[cid];
    return { title: c.title, plainLanguage: c.plainLanguage, verify: c.verify, confidence: c.confidence };
  });

  return { disputeTypeLabel: dt.label, facts, evidence: evidenceItems, law };
}

function buildReadinessReport(caseRecord, map) {
  const { slots } = caseRecord.intake;
  const dt = findDisputeType(slots.disputeType || 'other');

  const strengths = map.facts
    .filter((f) => f.status === 'supported')
    .map((f) => f.text)
    .concat(map.evidence.filter((e) => e.status === 'supported').map((e) => `You have: ${e.text}`));

  const weaknesses = [];
  if (!slots.amountClaimed) weaknesses.push('The amount you are claiming has not been clearly quantified yet.');
  if (slots.priorContact !== 'Yes') {
    weaknesses.push(
      'It is unclear whether you formally raised this with the other party before escalating - tribunals often expect this step to have been taken.'
    );
  }
  const missingEvidence = map.evidence.filter((e) => e.status === 'missing').map((e) => e.text);
  if (missingEvidence.length) {
    weaknesses.push(`You do not yet appear to have: ${missingEvidence.join(', ')}.`);
  }
  if (!weaknesses.length) weaknesses.push('No major gaps detected from what you shared - keep gathering supporting detail regardless.');

  const missingInfo = map.facts.filter((f) => f.status === 'missing').map((f) => f.text);

  return {
    disputeTypeLabel: dt.label,
    strengths,
    weaknesses,
    missingInfo,
    documentsToGather: missingEvidence,
    counterarguments: dt.counterarguments,
    disclaimer:
      'This is a neutral preparation view based only on what you told this app. It does not predict whether you will win or lose, and it is not a substitute for legal advice.'
  };
}

const ROLEPLAY_DISCLAIMER = {
  opposing:
    "Simulation only: I will now argue as the OTHER PARTY might, to help you stress-test your case. I am not a real person and do not know facts beyond what you've told this app.",
  tribunal:
    'Simulation only: I will now ask the kind of probing questions a tribunal officer might ask. I am not a real judge or tribunal, and nothing here predicts how an actual case would be decided.'
};

const TRIBUNAL_GENERIC = [
  'Walk me through, in order, exactly what happened - what did you do, and what did the other party do?',
  'What evidence do you have to support the amount you are claiming?',
  'Did you give the other party a chance to resolve this before escalating? What happened?',
  'Is there any part of your account that you are not fully certain about?',
  'What do you think the other party would say happened differently?',
  'For any point where you have no documents, is there another way you could support it - a witness, a photo, a message?'
];

const OPPOSING_OPENERS = ['That is not how I remember it. ', 'With respect, that is not accurate. ', 'I disagree - ', ''];

function buildRoleplayQueue(caseRecord, mode) {
  const { slots } = caseRecord.intake;
  const dt = findDisputeType(slots.disputeType || 'other');

  if (mode === 'opposing') {
    return dt.counterarguments.map((line, i) => OPPOSING_OPENERS[i % OPPOSING_OPENERS.length] + line);
  }

  const dynamic = [];
  if (!slots.amountClaimed) dynamic.push('You have not given a clear figure - exactly how much are you claiming, and how did you calculate it?');
  if (slots.priorContact !== 'Yes') dynamic.push('Did you formally ask the other party to resolve this before bringing it here? What did they say?');
  return [...dynamic, ...TRIBUNAL_GENERIC].slice(0, MAX_ROLEPLAY_TURNS);
}

function roleplayStart(caseRecord, mode) {
  const rp = caseRecord.roleplay;
  rp.queue = buildRoleplayQueue(caseRecord, mode).slice(0, MAX_ROLEPLAY_TURNS);
  const first = rp.queue.shift();
  return { disclaimer: ROLEPLAY_DISCLAIMER[mode], assistantText: first, ended: false };
}

function classifyAnswer(text) {
  const lower = text.toLowerCase().trim();
  if (lower.length < 12) return 'weak';
  if (/\b(i don'?t know|not sure|no idea|i guess|maybe|can'?t remember|not certain)\b/.test(lower)) return 'weak';
  if (/\$|\d{1,2}\/\d{1,2}|\b\d{4}\b|receipt|contract|message|email|photo|witness|invoice|screenshot|whatsapp/.test(lower)) return 'strong';
  if (lower.length > 60) return 'strong';
  return 'neutral';
}

function roleplayTurn(caseRecord, mode, userText) {
  const rp = caseRecord.roleplay;

  if (!rp.queue || rp.queue.length === 0) {
    const closing =
      mode === 'opposing'
        ? "That's my side of it. I think that's enough for now - let's see how your case held up."
        : "That's all my questions for this round. Let's review how your case held up.";
    return { assistantText: closing, ended: true };
  }

  const next = rp.queue.shift();
  return { assistantText: next, ended: rp.queue.length === 0 };
}

function buildSimulationReport(caseRecord) {
  const rp = caseRecord.roleplay;
  const heldUp = [];
  const couldBeStronger = [];
  const weak = [];

  for (let i = 0; i < rp.turns.length; i++) {
    const t = rp.turns[i];
    const next = rp.turns[i + 1];
    if (t.role === 'ai' && next && next.role === 'user') {
      const cls = classifyAnswer(next.text);
      const entry = { question: t.text, answer: next.text };
      if (cls === 'strong') heldUp.push(entry);
      else if (cls === 'weak') weak.push(entry);
      else couldBeStronger.push(entry);
    }
  }

  const recommendations = [];
  if (weak.length) {
    recommendations.push(
      'Revisit the weak points above and see if any document, message, or witness could turn them into supported points.'
    );
  }
  if (couldBeStronger.length) {
    recommendations.push('For the "could be stronger" answers, try adding a specific date, amount, or piece of evidence next time.');
  }
  recommendations.push('Re-check the Case Readiness Report\'s "Documents to gather" list before your actual hearing or negotiation.');
  if (!heldUp.length) recommendations.push('None of your answers this round were clearly strong yet - consider rehearsing your account once more.');

  return {
    mode: rp.mode,
    heldUp,
    couldBeStronger,
    weak,
    recommendations
  };
}

module.exports = {
  getOpeningPrompt,
  intakeTurn,
  buildCaseMap,
  buildReadinessReport,
  roleplayStart,
  roleplayTurn,
  buildSimulationReport,
  ROLEPLAY_DISCLAIMER
};
