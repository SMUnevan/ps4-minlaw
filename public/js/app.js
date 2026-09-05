(() => {
  'use strict';

  const state = {
    caseId: null,
    disputeType: null,
    roleplayMode: null,
    lessons: [],
    currentLessonId: null,
    mapBuilt: false
  };

  const $ = (id) => document.getElementById(id);
  const views = ['landing', 'intake', 'map', 'roleplay', 'simreport', 'literacy', 'lesson'];

  function showView(name) {
    for (const v of views) {
      $('view-' + v).classList.toggle('active', v === name);
    }
    const isLiteracy = name === 'literacy' || name === 'lesson';
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', (btn.dataset.tab === 'literacy') === isLiteracy);
    });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function addBubble(logEl, role, text) {
    const div = document.createElement('div');
    div.className = 'bubble ' + role;
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    return div;
  }

  // ---------- AI badge ----------
  async function loadMeta() {
    try {
      const meta = await api('/api/meta');
      $('aiBadge').textContent = meta.llmActive ? 'Engine: Claude (live)' : 'Engine: rule-based (offline-safe)';
    } catch {
      $('aiBadge').textContent = 'Engine: unknown';
    }
  }

  // ---------- Case creation & intake ----------
  async function startCase() {
    const data = await api('/api/case', { method: 'POST' });
    state.caseId = data.caseId;
    localStorage.setItem('caseCompassCaseId', data.caseId);
    $('intakeLog').innerHTML = '';
    addBubble($('intakeLog'), 'assistant', data.openingPrompt);
    $('intakeCompleteBar').hidden = true;
    showView('intake');
  }

  async function sendIntakeMessage() {
    const input = $('intakeInput');
    const text = input.value.trim();
    if (!text || !state.caseId) return;
    addBubble($('intakeLog'), 'user', text);
    input.value = '';
    input.disabled = true;
    try {
      const result = await api(`/api/case/${state.caseId}/intake`, {
        method: 'POST',
        body: JSON.stringify({ message: text })
      });
      addBubble($('intakeLog'), 'assistant', result.assistantText);
      if (result.complete) $('intakeCompleteBar').hidden = false;
    } catch (err) {
      addBubble($('intakeLog'), 'system', 'Something went wrong: ' + err.message);
    } finally {
      input.disabled = false;
      input.focus();
    }
  }

  // ---------- Case map + readiness report ----------
  function statusLabel(s) {
    return s === 'supported' ? 'Supported' : s === 'uncertain' ? 'Uncertain' : 'Missing';
  }

  function renderMap(map) {
    $('mapDisputeType').textContent = 'Case type: ' + map.disputeTypeLabel;
    const grid = $('mapGrid');
    grid.innerHTML = '';

    const factsCol = document.createElement('div');
    factsCol.className = 'map-col';
    factsCol.innerHTML = '<h4>Facts</h4>';
    for (const f of map.facts) {
      factsCol.innerHTML += `<div class="map-item"><span class="pill ${f.status}">${statusLabel(f.status)}</span><div>${escapeHtml(f.text)}</div></div>`;
    }
    grid.appendChild(factsCol);

    const evCol = document.createElement('div');
    evCol.className = 'map-col';
    evCol.innerHTML = '<h4>Evidence</h4>';
    for (const e of map.evidence) {
      evCol.innerHTML += `<div class="map-item"><span class="pill ${e.status}">${statusLabel(e.status)}</span><div>${escapeHtml(e.text)}</div></div>`;
    }
    grid.appendChild(evCol);

    const lawCol = document.createElement('div');
    lawCol.className = 'map-col';
    lawCol.innerHTML = '<h4>Relevant Law &amp; Process</h4>';
    for (const l of map.law) {
      lawCol.innerHTML += `<div class="law-item"><strong>${escapeHtml(l.title)}</strong><div>${escapeHtml(l.plainLanguage)}</div><div class="verify">Verify: ${escapeHtml(l.verify)}</div></div>`;
    }
    grid.appendChild(lawCol);
  }

  function renderReport(report) {
    $('reportDisclaimer').textContent = report.disclaimer;
    const grid = $('reportGrid');
    grid.innerHTML = '';
    const sections = [
      ['strengths', 'Supported points', report.strengths],
      ['weaknesses', 'Weak points', report.weaknesses],
      ['missing', 'Missing information & documents to gather', [...report.missingInfo, ...report.documentsToGather.map((d) => 'Gather: ' + d)]],
      ['counter', 'Possible counterarguments', report.counterarguments]
    ];
    for (const [cls, title, items] of sections) {
      const card = document.createElement('div');
      card.className = 'report-card ' + cls;
      card.innerHTML = `<h4>${title}</h4><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('') || '<li>None noted.</li>'}</ul>`;
      grid.appendChild(card);
    }
  }

  async function buildMap() {
    showView('map');
    $('mapLoading').hidden = false;
    $('mapGrid').innerHTML = '';
    $('reportGrid').innerHTML = '';
    try {
      const { map, report } = await api(`/api/case/${state.caseId}/analyze`, { method: 'POST' });
      state.disputeType = deriveDisputeTypeId(map.disputeTypeLabel);
      state.mapBuilt = true;
      renderMap(map);
      renderReport(report);
    } catch (err) {
      $('mapGrid').innerHTML = `<div class="disclaimer-banner">Could not build the case map: ${escapeHtml(err.message)}</div>`;
    } finally {
      $('mapLoading').hidden = true;
    }
  }

  function deriveDisputeTypeId(label) {
    const map = {
      'Goods / purchase dispute': 'goods',
      'Services dispute (contractor, repair, event, etc.)': 'services',
      'Deposit / tenancy dispute': 'deposit_tenancy',
      'Money owed / loan between individuals': 'debt_loan',
      'Property damage dispute': 'property_damage'
    };
    return map[label] || 'other';
  }

  // ---------- Role-play ----------
  async function startRoleplay(mode) {
    state.roleplayMode = mode;
    $('roleplayTitle').textContent = mode === 'opposing' ? 'Opposing Party Mode' : 'Tribunal Questioning Mode';
    $('roleplayLog').innerHTML = '';
    showView('roleplay');
    try {
      const result = await api(`/api/case/${state.caseId}/roleplay/start`, {
        method: 'POST',
        body: JSON.stringify({ mode })
      });
      $('roleplayDisclaimer').textContent = result.disclaimer;
      addBubble($('roleplayLog'), 'assistant', result.assistantText);
    } catch (err) {
      addBubble($('roleplayLog'), 'system', 'Something went wrong: ' + err.message);
    }
  }

  async function sendRoleplayMessage() {
    const input = $('roleplayInput');
    const text = input.value.trim();
    if (!text || !state.caseId) return;
    addBubble($('roleplayLog'), 'user', text);
    input.value = '';
    input.disabled = true;
    try {
      const result = await api(`/api/case/${state.caseId}/roleplay/message`, {
        method: 'POST',
        body: JSON.stringify({ mode: state.roleplayMode, message: text })
      });
      addBubble($('roleplayLog'), 'assistant', result.assistantText);
      if (result.ended) {
        addBubble($('roleplayLog'), 'system', 'This round has ended — click "End Session & Get Report" below when ready.');
      }
    } catch (err) {
      addBubble($('roleplayLog'), 'system', 'Something went wrong: ' + err.message);
    } finally {
      input.disabled = false;
      input.focus();
    }
  }

  async function endRoleplayAndReport() {
    try {
      const report = await api(`/api/case/${state.caseId}/roleplay/report`, { method: 'POST' });
      renderSimReport(report);
      showView('simreport');
    } catch (err) {
      alert('Could not build the report: ' + err.message);
    }
  }

  function renderSimReport(report) {
    $('simModeLabel').textContent = 'Mode: ' + (report.mode === 'opposing' ? 'Opposing Party' : 'Tribunal Questioning');
    const grid = $('simGrid');
    grid.innerHTML = '';
    const cols = [
      ['held', 'Held up well', report.heldUp],
      ['mid', 'Could be stronger', report.couldBeStronger],
      ['weak', 'Weak points', report.weak]
    ];
    for (const [cls, title, items] of cols) {
      const col = document.createElement('div');
      col.className = 'sim-col ' + cls;
      col.innerHTML = `<h4>${title} (${items.length})</h4>` +
        (items.length
          ? items.map((qa) => `<div class="qa-pair"><div class="q">${escapeHtml(qa.question)}</div><div>${escapeHtml(qa.answer)}</div></div>`).join('')
          : '<p style="color:var(--ink-soft);font-size:0.88rem;">None in this round.</p>');
      grid.appendChild(col);
    }
    $('simRecommendations').innerHTML = report.recommendations.map((r) => `<li>${escapeHtml(r)}</li>`).join('');
  }

  // ---------- Legal Literacy Hub ----------
  async function loadLiteracy() {
    const qs = state.disputeType ? `?disputeType=${encodeURIComponent(state.disputeType)}` : '';
    const lessons = await api('/api/literacy' + qs);
    state.lessons = lessons;
    const grid = $('lessonGrid');
    grid.innerHTML = lessons
      .map(
        (l) => `
      <div class="lesson-card" data-id="${l.id}">
        ${l.recommended ? '<span class="badge-recommended">Recommended for your case</span><br/>' : ''}
        <h3>${escapeHtml(l.title)}</h3>
        <p>${escapeHtml(l.summary)}</p>
      </div>`
      )
      .join('');
    grid.querySelectorAll('.lesson-card').forEach((card) => {
      card.addEventListener('click', () => openLesson(card.dataset.id));
    });
    showView('literacy');
  }

  async function openLesson(id) {
    const lesson = await api('/api/literacy/' + id);
    state.currentLessonId = id;
    $('lessonTitle').textContent = lesson.title;
    $('lessonContent').innerHTML = lesson.content.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
    const c = lesson.check;
    $('lessonCheck').innerHTML = `
      <strong>Quick check:</strong>
      <p>${escapeHtml(c.question)}</p>
      <div id="checkOptions"></div>
      <div class="check-explanation" id="checkExplanation" hidden></div>
    `;
    const optsEl = $('checkOptions');
    c.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'check-option';
      btn.textContent = opt;
      btn.addEventListener('click', () => {
        optsEl.querySelectorAll('.check-option').forEach((b, j) => {
          b.classList.remove('correct', 'incorrect');
          if (j === c.answerIndex) b.classList.add('correct');
        });
        if (i !== c.answerIndex) btn.classList.add('incorrect');
        const exp = $('checkExplanation');
        exp.hidden = false;
        exp.textContent = (i === c.answerIndex ? 'Correct. ' : 'Not quite. ') + c.explanation;
      });
      optsEl.appendChild(btn);
    });
    showView('lesson');
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------- Resume an in-progress case on reload ----------
  async function tryResume() {
    const savedId = localStorage.getItem('caseCompassCaseId');
    if (!savedId) return;
    try {
      const c = await api('/api/case/' + savedId);
      state.caseId = c.id;
      $('intakeLog').innerHTML = '';
      for (const m of c.intake.messages) addBubble($('intakeLog'), m.role, m.text);
      if (c.intake.complete) $('intakeCompleteBar').hidden = false;
      if (c.map && c.report) {
        state.disputeType = deriveDisputeTypeId(c.map.disputeTypeLabel);
        state.mapBuilt = true;
        renderMap(c.map);
        renderReport(c.report);
        showView('map');
      } else {
        showView('intake');
      }
    } catch {
      localStorage.removeItem('caseCompassCaseId');
    }
  }

  // ---------- Wiring ----------
  function init() {
    loadMeta();

    $('btnStartCase').addEventListener('click', startCase);
    $('btnGoLiteracyFromHero').addEventListener('click', loadLiteracy);
    $('btnGoLiteracyFromSim').addEventListener('click', loadLiteracy);

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'literacy') loadLiteracy();
        else showView(state.caseId ? (state.mapBuilt ? 'map' : 'intake') : 'landing');
      });
    });

    $('btnIntakeSend').addEventListener('click', sendIntakeMessage);
    $('intakeInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendIntakeMessage();
      }
    });

    $('btnBuildMap').addEventListener('click', buildMap);
    $('btnStartOpposing').addEventListener('click', () => startRoleplay('opposing'));
    $('btnStartTribunal').addEventListener('click', () => startRoleplay('tribunal'));

    $('btnRoleplaySend').addEventListener('click', sendRoleplayMessage);
    $('roleplayInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendRoleplayMessage();
      }
    });
    $('btnEndRoleplay').addEventListener('click', endRoleplayAndReport);

    $('btnBackToMapFromSim').addEventListener('click', () => showView('map'));
    $('btnBackToHub').addEventListener('click', loadLiteracy);

    tryResume();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
