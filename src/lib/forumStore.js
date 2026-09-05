// Community Forum store. Seed threads come from data/forum-threads.json and
// are clearly marked as demonstration content. Questions posted through the
// app are held in memory in a "pending moderation" state — mirroring the
// intended model where a public legal body (e.g. Pro Bono SG / MinLaw)
// approves an answer from a verified legal professional before publication.

const { v4: uuid } = require('uuid');
const seed = require('../../data/forum-threads.json');
const { pick } = require('./i18n');

const threads = new Map();
for (const t of seed.threads) {
  threads.set(t.id, { ...t, seeded: true });
}

// ---- Anonymity protection -------------------------------------------------
// The forum promises anonymity, so we strip obvious direct identifiers before
// anything is stored, not just before it is displayed.
const PII_PATTERNS = [
  { name: 'nric', re: /\b[STFGM]\d{7}[A-Z]\b/gi, replacement: '[NRIC removed]' },
  { name: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, replacement: '[email removed]' },
  { name: 'phone', re: /\b[89]\d{7}\b/g, replacement: '[phone removed]' }
];

function redactPII(text) {
  let out = String(text);
  const removed = [];
  for (const { name, re, replacement } of PII_PATTERNS) {
    if (re.test(out)) removed.push(name);
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return { text: out, removed };
}

function localiseThreadSummary(thread, lang) {
  const topic = seed.topics.find((t) => t.id === thread.topic);
  return {
    id: thread.id,
    topic: thread.topic,
    topicLabel: topic ? pick(topic.label, lang) : thread.topic,
    tags: thread.tags,
    lang: thread.lang,
    title: thread.title,
    excerpt: thread.body.length > 180 ? thread.body.slice(0, 180).trim() + '…' : thread.body,
    askedAt: thread.askedAt,
    views: thread.views,
    status: thread.status,
    answerCount: (thread.answers || []).length,
    seeded: !!thread.seeded
  };
}

function localiseThreadFull(thread, lang) {
  return {
    ...localiseThreadSummary(thread, lang),
    body: thread.body,
    answers: thread.answers || []
  };
}

function listThreads({ lang, query, topic, limit }) {
  const q = (query || '').trim().toLowerCase();
  let items = [...threads.values()];

  if (topic && topic !== 'all') items = items.filter((t) => t.topic === topic);

  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    items = items.filter((t) => {
      const haystack = (t.title + ' ' + t.body + ' ' + t.tags.join(' ')).toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  items.sort((a, b) => (a.askedAt < b.askedAt ? 1 : -1));
  if (limit) items = items.slice(0, limit);
  return items.map((t) => localiseThreadSummary(t, lang));
}

function getThread(id, lang) {
  const thread = threads.get(id);
  if (!thread) return null;
  thread.views += 1;
  return localiseThreadFull(thread, lang);
}

function addQuestion({ title, body, topic, lang }) {
  const cleanTitle = redactPII(title);
  const cleanBody = redactPII(body);
  const removed = [...new Set([...cleanTitle.removed, ...cleanBody.removed])];

  const thread = {
    id: 'q-' + uuid().slice(0, 8),
    topic: topic || 'procedure',
    tags: [topic || 'procedure'],
    lang: lang || 'en',
    title: cleanTitle.text,
    body: cleanBody.text,
    askedAt: new Date().toISOString().slice(0, 10),
    views: 0,
    status: 'pending',
    answers: [],
    seeded: false
  };
  threads.set(thread.id, thread);
  return { thread: localiseThreadFull(thread, lang), redacted: removed };
}

function getTopics(lang) {
  return seed.topics.map((t) => ({ id: t.id, label: pick(t.label, lang) }));
}

function rawThreads() {
  return [...threads.values()];
}

module.exports = { listThreads, getThread, addQuestion, getTopics, rawThreads, redactPII };
