// Fully self-contained, deterministic engine. No network calls, no API key
// needed. This is the default engine and the guaranteed fallback whenever the
// LLM engine (src/ai/llmEngine.js) is unavailable or errors out — see
// src/ai/engine.js for the selection logic.
//
// It works in all four supported languages: English keyword lists live in
// data/legal-concepts.json, and data/keywords.json extends matching to
// Chinese, Malay and Tamil.

const concepts = require('../../data/legal-concepts.json');
const kw = require('../../data/keywords.json');
const { t, pick, normaliseLang } = require('../lib/i18n');

const MAX_INTAKE_TURNS = 6;
const MAX_ROLEPLAY_TURNS = 5;

const SLOT_ORDER = ['disputeType', 'amountClaimed', 'evidence', 'priorContact', 'desiredOutcome', 'timeline'];

const QUESTION_KEYS = {
  disputeType: 'intake.q.disputeType',
  amountClaimed: 'intake.q.amountClaimed',
  evidence: 'intake.q.evidence',
  priorContact: 'intake.q.priorContact',
  desiredOutcome: 'intake.q.desiredOutcome',
  timeline: 'intake.q.timeline'
};

// Clause boundaries in all four languages. Splitting on these lets us decide
// whether a negation applies to a particular evidence mention, which works
// regardless of whether the language puts the negation before the noun
// (English/Chinese/Malay) or after it (Tamil).
const CLAUSE_SPLIT = /[.?!,;、，。？！；\n]+/;

function findDisputeType(id) {
  return concepts.disputeTypes.find((d) => d.id === id) || concepts.disputeTypes.find((d) => d.id === 'other');
}

function disputeLabel(id, lang) {
  return pick(findDisputeType(id).label, lang);
}

function detectDisputeType(text) {
  const lower = text.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const dt of concepts.disputeTypes) {
    if (dt.id === 'other') continue;
    let score = 0;
    for (const k of dt.keywords) if (lower.includes(k)) score++;
    const extra = kw.disputeTypes[dt.id];
    if (extra) {
      for (const list of Object.values(extra)) {
        for (const k of list) if (text.includes(k)) score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = dt.id;
    }
  }
  return bestScore > 0 ? best : null;
}

function extractAmount(text) {
  for (const pattern of kw.amountPatterns) {
    const m = text.match(new RegExp(pattern, 'i'));
    if (m && m[1]) return '$' + m[1].replace(/,/g, '');
  }
  return null;
}

// Latin-script negations need word boundaries: a bare substring test would
// match "lack" inside "black" and wrongly discard evidence the user has.
const LATIN_NEGATION =
  /\b(no|not|never|without|lack|lacking|none|missing|dont|doesnt|didnt|havent|hasnt|cant|tiada|tak|tidak|bukan|tanpa|belum)\b|n['’]t\b/i;

// Chinese and Tamil are not whitespace-delimited, so substring matching is
// the correct approach for those.
const NON_LATIN_NEGATIONS = [...(kw.negation.zh || []), ...(kw.negation.ta || [])];

function hasNegation(clause) {
  if (LATIN_NEGATION.test(clause)) return true;
  return NON_LATIN_NEGATIONS.some((n) => clause.includes(n));
}

const EVIDENCE_EN_PATTERNS = [
  [/receipt|invoice/i, 'Receipt/Invoice'],
  [/contract|agreement|tenancy agreement/i, 'Contract/Agreement'],
  [/whatsapp|text message|\bsms\b|\bemail\b|correspondence|\bchat\b|\bmessages?\b/i, 'Written correspondence'],
  [/photo|video|picture|screenshot/i, 'Photos/Video'],
  [/witness/i, 'Witness'],
  [/bank transfer|paynow|transfer record|payment record|bank record/i, 'Payment/transfer record'],
  [/payslip|pay slip|salary record/i, 'Payslip/salary record']
];

/**
 * Returns the canonical evidence labels the user says they HAVE. A mention
 * inside a clause that also contains a negation ("but no formal receipt",
 * "ரசீது இல்லை") is treated as evidence they do NOT have, so it correctly
 * falls through to the "still to gather" list.
 */
function extractEvidence(text) {
  const found = [];
  const clauses = text.split(CLAUSE_SPLIT).filter((c) => c.trim());

  for (const clause of clauses) {
    const negated = hasNegation(clause);
    const hits = [];

    for (const [re, label] of EVIDENCE_EN_PATTERNS) {
      if (re.test(clause)) hits.push(label);
    }
    for (const [label, byLang] of Object.entries(kw.evidence)) {
      for (const list of Object.values(byLang)) {
        for (const term of list) {
          if (clause.includes(term) && !hits.includes(label)) hits.push(label);
        }
      }
    }

    if (!negated) {
      for (const h of hits) if (!found.includes(h)) found.push(h);
    }
  }
  return found;
}

function matchesAny(text, lists) {
  for (const list of lists) {
    for (const term of list) {
      if (term.trim() && text.toLowerCase().includes(term.toLowerCase())) return true;
    }
  }
  return false;
}

function extractPriorContact(text) {
  const noEn = /(never|haven'?t|have not|did not|didn'?t)\s+(contact|ask|tell|inform|email|call|message|complain)/i;
  const yesEn = /\b(i |we )?(already )?(asked|contacted|emailed|called|messaged|told|informed|complained|requested|sent a demand|wrote to|chased)/i;

  if (noEn.test(text) || matchesAny(text, Object.values(kw.priorContact.no))) return 'No';
  if (yesEn.test(text) || matchesAny(text, Object.values(kw.priorContact.yes))) return 'Yes';
  return null;
}

function extractDesiredOutcome(text) {
  for (const [key, byLang] of Object.entries(kw.desiredOutcome)) {
    if (matchesAny(text, Object.values(byLang))) return key;
  }
  return null;
}

const TEMPORAL_MARKER = /\d{1,2}\/\d{1,2}|\b(?:19|20)\d{2}\b|\b(?:today|yesterday|tomorrow|last|next|ago|before|after|since|until|deadline|week|weeks|month|months|year|years|day|days)\b|发生|之前|之后|上个月|昨天|今天|明天|minggu|bulan|tahun|semalam|hari ini|esok|sebelum|selepas|minggu lalu|bulan lalu|வருட|மாத|வாரம்|நேற்று|இன்று|நாளை|முன்|பின்/i;

function timelineEntries(text) {
  return String(text)
    .split(/[.!?。？！\n]+/)
    .flatMap((sentence) => sentence.split(/\s+(?:but|however|although)\s+/i))
    .map((part) => part.trim())
    .filter((part) => part && TEMPORAL_MARKER.test(part));
}

function mergeTimeline(existing, entries) {
  const all = [...(existing && existing !== '__not_specified__' ? existing.split(' | ') : []), ...entries];
  return [...new Set(all.map((entry) => entry.trim()).filter(Boolean))].join(' | ') || null;
}

function normaliseStatement(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function isTimelineOnly(text) {
  const trimmed = text.trim();
  if (/(?:happened|occurred|发生|berlaku|நடந்த)/i.test(trimmed) && TEMPORAL_MARKER.test(trimmed)) return true;
  return /^(?:on\s+)?(?:\d{1,2}\/\d{1,2}|(?:19|20)\d{2}|today|yesterday|tomorrow|last\b|next\b|发生|上个月|昨天|今天|明天|minggu|bulan|tahun|semalam|hari ini|esok|வருட|மாத|வாரம்|நேற்று|இன்று|நாளை)/i.test(trimmed);
}

function withoutTimelineDetails(text) {
  return text
    .replace(/\b(?:on|around)\s+\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+(?:\s+(?:19|20)\d{2})?/gi, '')
    .replace(/\b(?:19|20)\d{2}\b/g, '')
    .replace(/\b(?:after|before|since|until)\s+\d+\s+(?:day|days|week|weeks|month|months|year|years)\b/gi, '')
    .replace(/\b\d+\s+(?:day|days|week|weeks|month|months|year|years)\s+ago\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, '')
    .trim();
}

function atomicFacts(caseRecord) {
  const statements = [];
  const timeline = new Set(
    (caseRecord.intake.slots.timeline || '')
      .split(' | ')
      .map(normaliseStatement)
      .filter(Boolean)
  );

  for (const message of caseRecord.intake.messages) {
    if (message.role !== 'user') continue;
    for (const sentence of String(message.text).split(/[.!?。？！\n]+/)) {
      for (const fragment of sentence.split(/\s+(?:but|however|although)\s+|(?<=,\s)/i)) {
        const trimmed = fragment.trim();
        // A dated event belongs in the timeline only. This keeps a timeline
        // entry from reappearing as an indistinguishable fact.
        if (!trimmed || isTimelineOnly(trimmed) || TEMPORAL_MARKER.test(trimmed)) continue;
        if (/^(?:yes|no|ya|tidak|是|否|有|没有|ஆம்|இல்லை)[,，.!?。？！]?$/i.test(trimmed)) continue;
        const fact = withoutTimelineDetails(trimmed);
        const key = normaliseStatement(fact);
        if (key && !timeline.has(key) && !statements.some((entry) => normaliseStatement(entry) === key)) {
          statements.push(fact);
        }
      }
    }
  }

  if (!statements.length && caseRecord.intake.slots.whatHappened) {
    statements.push(caseRecord.intake.slots.whatHappened);
  }
  return statements.slice(0, 8).map((text) => ({ text, status: 'supported' }));
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

function getOpeningPrompt(lang) {
  return t(lang, 'intake.opening');
}

function intakeTurn(caseRecord, userText, lang) {
  const { slots } = caseRecord.intake;

  if (!slots.whatHappened) slots.whatHappened = userText;

  const dt = detectDisputeType(userText);
  if (dt && !slots.disputeType) slots.disputeType = dt;

  const amt = extractAmount(userText);
  if (amt && !slots.amountClaimed) slots.amountClaimed = amt;

  for (const e of extractEvidence(userText)) {
    if (!slots.evidence.includes(e)) slots.evidence.push(e);
  }

  const pc = extractPriorContact(userText);
  if (pc && !slots.priorContact) slots.priorContact = pc;

  const outcome = extractDesiredOutcome(userText);
  if (outcome && !slots.desiredOutcome) slots.desiredOutcome = outcome;

  const entries = timelineEntries(userText);
  if (entries.length) slots.timeline = mergeTimeline(slots.timeline, entries);

  const userTurns = caseRecord.intake.messages.filter((m) => m.role === 'user').length + 1;
  const missing = firstMissingSlot(slots);

  if (!missing || userTurns >= MAX_INTAKE_TURNS) {
    if (!slots.timeline) slots.timeline = '__not_specified__';
    return { assistantText: t(lang, 'intake.done'), complete: true };
  }

  return { assistantText: t(lang, QUESTION_KEYS[missing]), complete: false };
}

function localOutcome(key, lang) {
  const label = kw.outcomeLabels[key];
  return label ? pick(label, lang) : key;
}

function localPriorContact(value, lang) {
  const label = kw.priorContactLabels[value];
  return label ? pick(label, lang) : value;
}

function localEvidenceLabel(id, lang) {
  const label = concepts.evidenceLabels[id];
  return label ? pick(label, lang) : id;
}

function buildCaseMap(caseRecord, lang) {
  const l = normaliseLang(lang);
  const { slots } = caseRecord.intake;
  const dt = findDisputeType(slots.disputeType || 'other');
  const notSpecified = t(l, 'map.notSpecified');

  const facts = atomicFacts(caseRecord);
  if (!facts.length) facts.push({ text: t(l, 'map.notDescribed'), status: 'missing' });
  facts.push({
    text: `${t(l, 'map.amount')}: ${slots.amountClaimed || notSpecified}`,
    status: slots.amountClaimed ? 'supported' : 'missing'
  });
  facts.push({
    text: `${t(l, 'map.priorContact')}: ${slots.priorContact ? localPriorContact(slots.priorContact, l) : notSpecified}`,
    status: slots.priorContact ? (slots.priorContact === 'Yes' ? 'supported' : 'uncertain') : 'missing'
  });
  facts.push({
    text: `${t(l, 'map.outcome')}: ${slots.desiredOutcome ? localOutcome(slots.desiredOutcome, l) : notSpecified}`,
    status: slots.desiredOutcome ? 'supported' : 'missing'
  });

  if (slots.timeline && slots.timeline !== '__not_specified__') {
    facts.push({ text: `${t(l, 'map.timeline')}: ${slots.timeline}`, status: 'supported' });
  } else {
    facts.push({ text: t(l, 'map.timelineMissing'), status: 'missing' });
  }

  const have = slots.evidence.filter((e) => e !== '__none__');
  const suggestions = concepts.evidenceSuggestions[dt.id] || concepts.evidenceSuggestions.other;
  const suggestionIds = suggestions.map((s) => s.id);

  const evidence = [];
  // Evidence the user has that isn't already covered by a suggestion row.
  for (const id of have) {
    if (!suggestionIds.includes(id)) {
      evidence.push({ id, text: localEvidenceLabel(id, l), status: 'supported' });
    }
  }
  for (const s of suggestions) {
    evidence.push({ id: s.id, text: pick(s.label, l), status: have.includes(s.id) ? 'supported' : 'missing' });
  }

  const law = dt.concepts.map((cid) => {
    const c = concepts.concepts[cid];
    return {
      id: cid,
      title: pick(c.title, l),
      plainLanguage: pick(c.plainLanguage, l),
      verify: pick(c.verify, l),
      confidence: c.confidence,
      sources: c.sources || []
    };
  });

  return { disputeTypeId: dt.id, disputeTypeLabel: pick(dt.label, l), facts, evidence, law };
}

function buildReadinessReport(caseRecord, map, lang) {
  const l = normaliseLang(lang);
  const { slots } = caseRecord.intake;
  const dt = findDisputeType(slots.disputeType || 'other');

  const strengths = map.facts
    .filter((f) => f.status === 'supported')
    .map((f) => f.text)
    .concat(map.evidence.filter((e) => e.status === 'supported').map((e) => `${t(l, 'report.have')}: ${e.text}`));

  const weaknesses = [];
  if (!slots.amountClaimed) weaknesses.push(t(l, 'report.w.noAmount'));
  if (slots.priorContact !== 'Yes') weaknesses.push(t(l, 'report.w.noPriorContact'));

  const missingEvidence = map.evidence.filter((e) => e.status === 'missing').map((e) => e.text);
  if (missingEvidence.length) {
    weaknesses.push(t(l, 'report.w.missingEvidence', { items: missingEvidence.join(', ') }));
  }
  if (!weaknesses.length) weaknesses.push(t(l, 'report.w.none'));

  return {
    disputeTypeId: dt.id,
    disputeTypeLabel: pick(dt.label, l),
    strengths,
    weaknesses,
    missingInfo: map.facts.filter((f) => f.status === 'missing').map((f) => f.text),
    documentsToGather: missingEvidence,
    counterarguments: pick(dt.counterarguments, l),
    disclaimer: t(l, 'report.disclaimer')
  };
}

function roleplayDisclaimer(mode, lang) {
  return t(lang, mode === 'opposing' ? 'rp.disclaimer.opposing' : 'rp.disclaimer.tribunal');
}

function buildRoleplayQueue(caseRecord, mode, lang) {
  const l = normaliseLang(lang);
  const { slots } = caseRecord.intake;
  const dt = findDisputeType(slots.disputeType || 'other');

  if (mode === 'opposing') {
    const openers = [t(l, 'rp.o.opener1'), t(l, 'rp.o.opener2'), t(l, 'rp.o.opener3'), ''];
    return pick(dt.counterarguments, l).map((line, i) => openers[i % openers.length] + line);
  }

  const dynamic = [];
  if (!slots.amountClaimed) dynamic.push(t(l, 'rp.t.noAmount'));
  if (slots.priorContact !== 'Yes') dynamic.push(t(l, 'rp.t.noContact'));

  const generic = ['rp.t.1', 'rp.t.2', 'rp.t.3', 'rp.t.4', 'rp.t.5', 'rp.t.6'].map((k) => t(l, k));
  return [...dynamic, ...generic].slice(0, MAX_ROLEPLAY_TURNS);
}

function roleplayStart(caseRecord, mode, lang) {
  const rp = caseRecord.roleplay;
  rp.queue = buildRoleplayQueue(caseRecord, mode, lang).slice(0, MAX_ROLEPLAY_TURNS);
  const first = rp.queue.shift();
  return { disclaimer: roleplayDisclaimer(mode, lang), assistantText: first, ended: false };
}

function roleplayTurn(caseRecord, mode, userText, lang) {
  const rp = caseRecord.roleplay;
  const answer = String(userText).trim().replace(/\s+/g, ' ').slice(0, 160);
  const responsePrefix = t(lang, mode === 'opposing' ? 'rp.reply.opposing' : 'rp.reply.tribunal', { answer });
  if (!rp.queue || rp.queue.length === 0) {
    return {
      assistantText: responsePrefix + t(lang, mode === 'opposing' ? 'rp.close.opposing' : 'rp.close.tribunal'),
      ended: true
    };
  }
  const next = rp.queue.shift();
  return { assistantText: responsePrefix + next, ended: rp.queue.length === 0 };
}

const UNCERTAIN_PHRASES = [
  /\b(i don'?t know|not sure|no idea|i guess|maybe|can'?t remember|not certain)\b/i,
  /不确定|不知道|不记得|可能吧|没印象/,
  /tidak pasti|tak pasti|tak ingat|tidak ingat|entahlah/i,
  /தெரியாது|நினைவில்லை|உறுதியாகத் தெரியவில்லை/
];

const SPECIFIC_MARKERS = [
  /\$|\d{1,2}\/\d{1,2}|\b\d{4}\b/,
  /receipt|contract|message|email|photo|witness|invoice|screenshot|whatsapp|payslip/i,
  /收据|发票|合约|信息|电邮|照片|证人|截图|薪金单/,
  /resit|invois|kontrak|mesej|e-?mel|gambar|saksi|slip gaji/i,
  /ரசீது|ஒப்பந்தம்|செய்தி|மின்னஞ்சல்|புகைப்படம்|சாட்சி/
];

function classifyAnswer(text) {
  const trimmed = String(text).trim();
  if (trimmed.length < 12) return 'weak';
  for (const re of UNCERTAIN_PHRASES) if (re.test(trimmed)) return 'weak';
  for (const re of SPECIFIC_MARKERS) if (re.test(trimmed)) return 'strong';
  if (trimmed.length > 60) return 'strong';
  return 'neutral';
}

function buildSimulationReport(caseRecord, lang) {
  const l = normaliseLang(lang);
  const rp = caseRecord.roleplay;
  const heldUp = [];
  const couldBeStronger = [];
  const weak = [];

  for (let i = 0; i < rp.turns.length; i++) {
    const turn = rp.turns[i];
    const next = rp.turns[i + 1];
    if (turn.role === 'ai' && next && next.role === 'user') {
      const entry = { question: turn.text, answer: next.text };
      const cls = classifyAnswer(next.text);
      if (cls === 'strong') heldUp.push(entry);
      else if (cls === 'weak') weak.push(entry);
      else couldBeStronger.push(entry);
    }
  }

  const recommendations = [];
  if (weak.length) recommendations.push(t(l, 'sim.rec.weak'));
  if (couldBeStronger.length) recommendations.push(t(l, 'sim.rec.mid'));
  recommendations.push(t(l, 'sim.rec.docs'));
  if (!heldUp.length) recommendations.push(t(l, 'sim.rec.none'));

  return { mode: rp.mode, heldUp, couldBeStronger, weak, recommendations };
}

module.exports = {
  getOpeningPrompt,
  intakeTurn,
  buildCaseMap,
  buildReadinessReport,
  roleplayStart,
  roleplayTurn,
  buildSimulationReport,
  roleplayDisclaimer,
  findDisputeType,
  disputeLabel,
  detectDisputeType
};
