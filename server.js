require('dotenv').config();
const express = require('express');
const path = require('path');

const engine = require('./src/ai/engine');
const { newCase, requireCase } = require('./src/lib/caseStore');
const content = require('./src/lib/content');
const forumStore = require('./src/lib/forumStore');
const i18n = require('./src/lib/i18n');
const strings = require('./data/i18n.json');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function asyncRoute(handler) {
  return (req, res, next) => handler(req, res, next).catch(next);
}

// Language comes from ?lang= or the JSON body, and is always normalised to a
// supported code so an unknown value degrades to English rather than erroring.
function langOf(req) {
  return i18n.normaliseLang((req.query && req.query.lang) || (req.body && req.body.lang));
}

function requireText(res, value, field) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    res.status(400).json({ error: `${field} is required` });
    return null;
  }
  return value.trim();
}

// ---- Meta ----

app.get('/api/meta', (req, res) => {
  res.json({
    name: 'Case Compass',
    llmActive: engine.isLLMActive(),
    languages: i18n.languages(),
    lessonCount: content.lessonCount()
  });
});

app.get('/api/strings', (req, res) => {
  const lang = langOf(req);
  res.json({ lang, strings: strings[lang] });
});

// ---- Case preparation ----

app.post(
  '/api/case',
  asyncRoute(async (req, res) => {
    const lang = langOf(req);
    const caseRecord = newCase();
    const openingPrompt = engine.getOpeningPrompt(lang);
    caseRecord.intake.messages.push({ role: 'assistant', text: openingPrompt });
    res.json({ caseId: caseRecord.id, openingPrompt });
  })
);

app.get(
  '/api/case/:id',
  asyncRoute(async (req, res) => {
    res.json(requireCase(req.params.id));
  })
);

app.post(
  '/api/case/:id/intake',
  asyncRoute(async (req, res) => {
    const caseRecord = requireCase(req.params.id);
    const message = requireText(res, req.body.message, 'message');
    if (!message) return;
    res.json(await engine.intakeTurn(caseRecord, message, langOf(req), req.body.aiResult));
  })
);

// Request templates contain case context but never credentials. The browser
// sends them directly to Gemini or OpenRouter using its locally stored key.
app.post(
  '/api/case/:id/ai-request',
  asyncRoute(async (req, res) => {
    const caseRecord = requireCase(req.params.id);
    res.json(engine.getAIRequest(caseRecord, req.body.task, langOf(req), req.body));
  })
);

app.post(
  '/api/case/:id/analyze',
  asyncRoute(async (req, res) => {
    const caseRecord = requireCase(req.params.id);
    const lang = langOf(req);
    const map = await engine.buildCaseMap(caseRecord, lang);
    const report = await engine.buildReadinessReport(caseRecord, lang, req.body.aiResult);
    const related = engine.buildRelated(caseRecord, lang);
    res.json({ map, report, related });
  })
);

app.get(
  '/api/case/:id/related',
  asyncRoute(async (req, res) => {
    const caseRecord = requireCase(req.params.id);
    res.json(engine.buildRelated(caseRecord, langOf(req)));
  })
);

app.post(
  '/api/case/:id/roleplay/start',
  asyncRoute(async (req, res) => {
    const caseRecord = requireCase(req.params.id);
    const { mode } = req.body;
    if (mode !== 'opposing' && mode !== 'tribunal') {
      return res.status(400).json({ error: 'mode must be "opposing" or "tribunal"' });
    }
    res.json(await engine.startRoleplay(caseRecord, mode, langOf(req), req.body.aiResult));
  })
);

app.post(
  '/api/case/:id/roleplay/message',
  asyncRoute(async (req, res) => {
    const caseRecord = requireCase(req.params.id);
    const { mode } = req.body;
    if (mode !== 'opposing' && mode !== 'tribunal') {
      return res.status(400).json({ error: 'mode must be "opposing" or "tribunal"' });
    }
    const message = requireText(res, req.body.message, 'message');
    if (!message) return;
    res.json(await engine.continueRoleplay(caseRecord, mode, message, langOf(req), req.body.aiResult));
  })
);

app.post(
  '/api/case/:id/roleplay/report',
  asyncRoute(async (req, res) => {
    const caseRecord = requireCase(req.params.id);
    res.json(await engine.buildSimulationReport(caseRecord, langOf(req), req.body.aiResult));
  })
);

// ---- Learning Hub ----

app.get('/api/learn/tracks', (req, res) => {
  res.json(content.getTracks(langOf(req)));
});

app.get('/api/learn/lessons/:id', (req, res) => {
  const lesson = content.getLesson(req.params.id, langOf(req));
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
  res.json(lesson);
});

// ---- Community Forum ----

app.get('/api/forum/topics', (req, res) => {
  res.json(forumStore.getTopics(langOf(req)));
});

app.get('/api/forum/threads', (req, res) => {
  const lang = langOf(req);
  res.json(
    forumStore.listThreads({
      lang,
      query: req.query.q || '',
      topic: req.query.topic || 'all'
    })
  );
});

app.get('/api/forum/threads/:id', (req, res) => {
  const thread = forumStore.getThread(req.params.id, langOf(req));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  res.json(thread);
});

app.post('/api/forum/threads', (req, res) => {
  const lang = langOf(req);
  const title = requireText(res, req.body.title, 'title');
  if (!title) return;
  const body = requireText(res, req.body.body, 'body');
  if (!body) return;
  if (title.length > 200 || body.length > 4000) {
    return res.status(400).json({ error: 'Question is too long' });
  }
  const result = forumStore.addQuestion({ title, body, topic: req.body.topic, lang });
  res.json(result);
});

// ---- Error handling ----

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Case Compass running at http://localhost:${PORT}`);
  console.log('AI providers: browser BYOK (Gemini or OpenRouter)');
  console.log(`Languages: ${i18n.LANGS.join(', ')} · Lessons: ${content.lessonCount()}`);
});
