// Connects a prepared case to the rest of the product: the Community Forum
// threads that faced the same problem, and the Learning Hub lessons that
// explain the concepts behind it. Deterministic and offline — the LLM engine
// uses the same shortlist so its suggestions are grounded in content that
// actually exists rather than invented references.

const concepts = require('../../data/legal-concepts.json');
const forumStore = require('../lib/forumStore');
const content = require('../lib/content');
const { pick } = require('../lib/i18n');

const STOPWORDS = new Set([
  'about', 'after', 'also', 'been', 'before', 'because', 'being', 'could', 'from', 'have', 'having', 'here',
  'into', 'just', 'like', 'more', 'much', 'never', 'only', 'other', 'over', 'said', 'same', 'should', 'some',
  'still', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'very',
  'want', 'were', 'what', 'when', 'which', 'while', 'with', 'would', 'your', 'told', 'says', 'said', 'back',
  'took', 'take', 'made', 'make', 'even', 'they', 'them', 'weeks', 'week', 'days', 'months', 'month', 'year'
]);

function caseText(caseRecord) {
  const s = caseRecord.intake.slots;
  return [s.whatHappened || '', ...(caseRecord.intake.messages || []).filter((m) => m.role === 'user').map((m) => m.text)]
    .join(' ')
    .slice(0, 4000);
}

function terms(text) {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

function disputeInfo(caseRecord) {
  const id = caseRecord.intake.slots.disputeType || 'other';
  return concepts.disputeTypes.find((d) => d.id === id) || concepts.disputeTypes.find((d) => d.id === 'other');
}

function matchThreads(caseRecord, lang, limit = 3) {
  const dt = disputeInfo(caseRecord);
  const text = caseText(caseRecord);
  const caseTerms = terms(text);
  const scored = [];

  for (const thread of forumStore.rawThreads()) {
    if (thread.status === 'pending') continue; // never surface unmoderated content as an answer

    let score = 0;
    const matchedTags = (dt.forumTags || []).filter((tag) => thread.tags.includes(tag));
    score += matchedTags.length * 4;

    const haystack = (thread.title + ' ' + thread.body + ' ' + thread.tags.join(' ')).toLowerCase();
    const matchedTerms = caseTerms.filter((term) => haystack.includes(term)).slice(0, 4);
    score += matchedTerms.length;

    if ((thread.answers || []).length) score += 2;
    if (thread.lang === lang) score += 1;

    if (score > 0) {
      scored.push({
        score,
        thread,
        reason: { disputeLabel: matchedTags.length ? pick(dt.label, lang) : null, terms: matchedTerms }
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ thread, reason }) => {
    const summary = forumStore.listThreads({ lang, query: '', topic: 'all' }).find((t) => t.id === thread.id);
    return { ...summary, reason };
  });
}

function matchLessons(caseRecord, lang, limit = 3) {
  const dt = disputeInfo(caseRecord);
  const caseTerms = terms(caseText(caseRecord));
  const wantedTags = new Set(dt.lessonTags || []);

  // Weak spots in the case steer the recommendation as well as the topic does.
  const slots = caseRecord.intake.slots;
  if (slots.priorContact !== 'Yes') wantedTags.add('procedure');
  if (!slots.evidence || slots.evidence.length === 0) wantedTags.add('evidence');

  const scored = [];
  for (const lesson of content.allLessons()) {
    let score = 0;
    const matchedTags = (lesson.tags || []).filter((tag) => wantedTags.has(tag));
    score += matchedTags.length * 3;

    const haystack = (pick(lesson.title, lang) + ' ' + pick(lesson.summary, lang)).toLowerCase();
    const matchedTerms = caseTerms.filter((term) => haystack.includes(term)).slice(0, 3);
    score += matchedTerms.length * 2;

    if (score > 0) {
      scored.push({
        score,
        lesson,
        reason: { disputeLabel: matchedTags.length ? pick(dt.label, lang) : null, terms: matchedTerms }
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ lesson, reason }) => ({
    ...content.lessonSummary(lesson.id, lang),
    reason
  }));
}

function matchRelated(caseRecord, lang) {
  return {
    threads: matchThreads(caseRecord, lang),
    lessons: matchLessons(caseRecord, lang)
  };
}

module.exports = { matchRelated, matchThreads, matchLessons };
