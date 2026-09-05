const { v4: randomUUID } = require('uuid');

// In-memory store keyed by caseId. Fine for a hackathon demo (single process,
// no persistence needed across restarts). A production build would swap this
// for a real database without changing the route/engine interfaces below.
const cases = new Map();

function newCase() {
  const id = randomUUID();
  const record = {
    id,
    createdAt: new Date().toISOString(),
    intake: {
      messages: [],       // { role: 'user'|'assistant', text }
      slots: {
        disputeType: null,
        amountClaimed: null,
        whatHappened: null,
        timeline: null,
        evidence: [],
        priorContact: null,
        desiredOutcome: null
      },
      complete: false
    },
    map: null,             // built once intake is complete
    report: null,          // case readiness report
    roleplay: {
      mode: null,          // 'opposing' | 'tribunal'
      turns: [],           // canonical transcript: { role: 'ai'|'user', text }
      queue: []            // rule-engine-only scratch state; unused in LLM mode
    },
    simulationReport: null
  };
  cases.set(id, record);
  return record;
}

function getCase(id) {
  return cases.get(id) || null;
}

function requireCase(id) {
  const c = getCase(id);
  if (!c) {
    const err = new Error('Case not found. It may have expired or the server restarted.');
    err.status = 404;
    throw err;
  }
  return c;
}

module.exports = { newCase, getCase, requireCase };
