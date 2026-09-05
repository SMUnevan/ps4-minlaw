require('dotenv').config();
const express = require('express');
const path = require('path');

const engine = require('./src/ai/engine');
const { newCase, requireCase } = require('./src/lib/caseStore');
const literacyLessons = require('./data/literacy-lessons.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function asyncRoute(handler) {
  return (req, res, next) => handler(req, res, next).catch(next);
}

app.get('/api/meta', (req, res) => {
  res.json({ llmActive: engine.isLLMActive(), name: 'Case Compass' });
});

// ---- Case preparation flow ----

app.post(
  '/api/case',
  asyncRoute(async (req, res) => {
    const caseRecord = newCase();
    const openingPrompt = engine.getOpeningPrompt();
    caseRecord.intake.messages.push({ role: 'assistant', text: openingPrompt });
    res.json({ caseId: caseRecord.id, openingPrompt });
  })
);

app.get(
  '/api/case/:id',
  asyncRoute(async (req, res) => {
    const caseRecord = requireCase(req.params.id);
    res.json(caseRecord);
  })
);

app.post(
  '/api/case/:id/intake',
  asyncRoute(async (req, res) => {
    const caseRecord = requireCase(req.params.id);
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    const result = await engine.intakeTurn(caseRecord, message.trim());
    res.json(result);
  })
);

app.post(
  '/api/case/:id/analyze',
  asyncRoute(async (req, res) => {
    const caseRecord = requireCase(req.params.id);
    const map = await engine.buildCaseMap(caseRecord);
    const report = await engine.buildReadinessReport(caseRecord);
    res.json({ map, report });
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
    const result = await engine.startRoleplay(caseRecord, mode);
    res.json(result);
  })
);

app.post(
  '/api/case/:id/roleplay/message',
  asyncRoute(async (req, res) => {
    const caseRecord = requireCase(req.params.id);
    const { mode, message } = req.body;
    if (mode !== 'opposing' && mode !== 'tribunal') {
      return res.status(400).json({ error: 'mode must be "opposing" or "tribunal"' });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    const result = await engine.continueRoleplay(caseRecord, mode, message.trim());
    res.json(result);
  })
);

app.post(
  '/api/case/:id/roleplay/report',
  asyncRoute(async (req, res) => {
    const caseRecord = requireCase(req.params.id);
    const report = await engine.buildSimulationReport(caseRecord);
    res.json(report);
  })
);

// ---- Legal Literacy Hub (kept fully separate from the active-case flow) ----

app.get('/api/literacy', (req, res) => {
  const { disputeType } = req.query;
  const lessons = literacyLessons.map(({ check, ...rest }) => ({
    ...rest,
    recommended: disputeType ? rest.tags.includes(disputeType) : false
  }));
  if (disputeType) {
    lessons.sort((a, b) => Number(b.recommended) - Number(a.recommended));
  }
  res.json(lessons);
});

app.get('/api/literacy/:id', (req, res) => {
  const lesson = literacyLessons.find((l) => l.id === req.params.id);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
  res.json(lesson);
});

// ---- Error handling ----

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Case Compass running at http://localhost:${PORT}`);
  console.log(`AI engine: ${engine.isLLMActive() ? 'Claude (LLM)' : 'rule-based (no API key set)'}`);
});
