(() => {
  'use strict';

  const LS_CASE = 'caseCompassCaseId';
  const LS_LANG = 'caseCompassLang';
  const LS_DONE = 'caseCompassLessonsDone';

  const state = {
    lang: 'en',
    strings: {},
    languages: [],
    caseId: null,
    mapBuilt: false,
    mapRenderedLang: null,
    roleplayMode: null,
    currentLesson: null,
    currentThread: null,
    tracks: [],
    topics: [],
    doneLessons: new Set(),
    lastRelated: null
  };

  const $ = (id) => document.getElementById(id);
  const VIEWS = ['landing', 'intake', 'map', 'roleplay', 'simreport', 'learn', 'lesson', 'forum', 'thread', 'ask'];
  const TAB_FOR_VIEW = {
    landing: 'case', intake: 'case', map: 'case', roleplay: 'case', simreport: 'case',
    learn: 'learn', lesson: 'learn',
    forum: 'forum', thread: 'forum', ask: 'forum'
  };

  let currentView = 'landing';

  function t(key) {
    return state.strings[key] || key;
  }

  function showView(name) {
    currentView = name;
    for (const v of VIEWS) $('view-' + v).classList.toggle('active', v === name);
    const tab = TAB_FOR_VIEW[name];
    document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
    window.scrollTo(0, 0);
  }

  async function api(path, opts) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(path + sep + 'lang=' + state.lang, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function esc(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function addBubble(logEl, role, text) {
    const div = document.createElement('div');
    div.className = 'bubble ' + role;
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------- i18n ----------
  async function loadStrings() {
    const data = await api('/api/strings');
    state.strings = data.strings;
    applyStaticStrings();
  }

  function applyStaticStrings() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.dataset.i18nHtml);
    });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      el.placeholder = t(el.dataset.i18nPh);
    });
    document.documentElement.lang = state.lang;
  }

  function renderLangSwitch() {
    $('langSwitch').innerHTML = state.languages
      .map((l) => `<button class="lang-btn ${l.code === state.lang ? 'active' : ''}" data-lang="${l.code}" title="${esc(l.label)}">${esc(l.short)}</button>`)
      .join('');
    $('langSwitch').querySelectorAll('.lang-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchLanguage(btn.dataset.lang));
    });
  }

  async function switchLanguage(lang) {
    if (lang === state.lang) return;
    state.lang = lang;
    localStorage.setItem(LS_LANG, lang);
    await loadStrings();
    renderLangSwitch();
    await refreshCurrentView();
  }

  // Entry point for the Case Preparation tab. Rebuilds the map if it was last
  // rendered in a different language, so switching language elsewhere in the
  // app never leaves a stale translation behind.
  async function goToCaseView() {
    if (!state.caseId) return showView('landing');
    if (!state.mapBuilt) return showView('intake');
    if (state.mapRenderedLang !== state.lang) return buildMap();
    showView('map');
  }

  // Re-fetches server-rendered content for the active view in the new language.
  async function refreshCurrentView() {
    if (currentView === 'map' && state.caseId) {
      await buildMap();
    } else if (currentView === 'learn') {
      await loadLearn();
    } else if (currentView === 'lesson' && state.currentLesson) {
      await openLesson(state.currentLesson);
    } else if (currentView === 'forum') {
      await loadForum();
    } else if (currentView === 'thread' && state.currentThread) {
      await openThread(state.currentThread);
    }
  }

  // ---------- Meta ----------
  async function loadMeta() {
    try {
      const meta = await api('/api/meta');
      state.languages = meta.languages;
      $('aiBadge').textContent = t(meta.llmActive ? 'engine.llm' : 'engine.rules');
      renderLangSwitch();
    } catch {
      $('aiBadge').textContent = '—';
    }
  }

  // ---------- Case intake ----------
  async function startCase() {
    const data = await api('/api/case', { method: 'POST', body: JSON.stringify({}) });
    state.caseId = data.caseId;
    state.mapBuilt = false;
    localStorage.setItem(LS_CASE, data.caseId);
    $('intakeLog').innerHTML = '';
    addBubble($('intakeLog'), 'assistant', data.openingPrompt);
    $('intakeCompleteBar').hidden = true;
    showView('intake');
    $('intakeInput').focus();
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
      addBubble($('intakeLog'), 'system', err.message);
    } finally {
      input.disabled = false;
      input.focus();
    }
  }

  // ---------- Case map + report ----------
  function statusLabel(s) {
    return t('status.' + s);
  }

  function renderMap(map) {
    $('mapDisputeType').textContent = `${t('map.caseType')}: ${map.disputeTypeLabel}`;
    const grid = $('mapGrid');

    const factsHtml = map.facts
      .map((f) => `<div class="map-item"><span class="pill ${f.status}">${esc(statusLabel(f.status))}</span><div>${esc(f.text)}</div></div>`)
      .join('');
    const evidenceHtml = map.evidence
      .map((e) => `<div class="map-item"><span class="pill ${e.status}">${esc(statusLabel(e.status))}</span><div>${esc(e.text)}</div></div>`)
      .join('');
    const lawHtml = map.law
      .map((l) => `
        <div class="law-item">
          <strong>${esc(l.title)}<span class="conf-tag conf-${esc(l.confidence)}">${esc(l.confidence === 'verified' ? 'verified source' : 'general principle')}</span></strong>
          <p>${esc(l.plainLanguage)}</p>
          <div class="verify-note">${esc(t('map.verify'))}: ${esc(l.verify)}</div>
          <div class="source-links">${(l.sources || [])
            .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">↗ ${esc(s.label)}</a>`)
            .join('')}</div>
        </div>`)
      .join('');

    grid.innerHTML = `
      <div class="map-col"><h4>${esc(t('map.facts'))}</h4>${factsHtml}</div>
      <div class="map-col"><h4>${esc(t('map.evidence'))}</h4>${evidenceHtml}</div>
      <div class="map-col"><h4>${esc(t('map.law'))}</h4>${lawHtml}</div>`;
  }

  function renderReport(report) {
    $('reportDisclaimer').textContent = report.disclaimer;
    const sections = [
      ['strengths', t('report.strengths'), report.strengths],
      ['weaknesses', t('report.weaknesses'), report.weaknesses],
      ['missing', t('report.missing'), [...report.missingInfo, ...report.documentsToGather.map((d) => `${t('report.gather')}: ${d}`)]],
      ['counter', t('report.counter'), report.counterarguments]
    ];
    $('reportGrid').innerHTML = sections
      .map(([cls, title, items]) => `
        <div class="report-card ${cls}">
          <h4>${esc(title)}</h4>
          <ul>${items.length ? items.map((i) => `<li>${esc(i)}</li>`).join('') : `<li>${esc(t('report.none'))}</li>`}</ul>
        </div>`)
      .join('');
  }

  function reasonText(reason) {
    if (!reason) return '';
    const parts = [];
    if (reason.disputeLabel) parts.push(reason.disputeLabel);
    if (reason.terms && reason.terms.length) parts.push(reason.terms.join(' · '));
    return parts.join(' · ');
  }

  function renderRelated(related) {
    state.lastRelated = related;

    const threadsEl = $('relatedThreads');
    if (!related.threads.length) {
      threadsEl.innerHTML = `<p class="empty-note">${esc(t('related.none'))}</p>`;
    } else {
      threadsEl.innerHTML = related.threads
        .map((th) => `
          <div class="related-card" data-thread="${esc(th.id)}">
            <h4>${esc(th.title)}</h4>
            <p class="snippet">${esc(th.excerpt)}</p>
            <div class="match-reason">${esc(t('related.why'))}: ${esc(reasonText(th.reason))}</div>
            <div class="related-meta">
              <span class="badge verified">${esc(th.answerCount)} ${esc(t('related.answers'))}</span>
              <span>${esc(t('related.viewThread'))} →</span>
            </div>
          </div>`)
        .join('');
      threadsEl.querySelectorAll('[data-thread]').forEach((card) => {
        card.addEventListener('click', () => openThread(card.dataset.thread));
      });
    }

    const lessonsEl = $('relatedLessons');
    if (!related.lessons.length) {
      lessonsEl.innerHTML = `<p class="empty-note">${esc(t('related.none'))}</p>`;
    } else {
      lessonsEl.innerHTML = related.lessons
        .map((ls) => `
          <div class="related-card" data-lesson="${esc(ls.id)}">
            <h4>${esc(ls.title)}</h4>
            <p class="snippet">${esc(ls.summary)}</p>
            <div class="match-reason">${esc(t('related.why'))}: ${esc(reasonText(ls.reason))}</div>
            <div class="related-meta">
              <span class="chip">${esc(ls.minutes)} ${esc(t('learn.minutes'))}</span>
              ${ls.hasCase ? `<span class="chip case">${esc(t('learn.cases'))}</span>` : ''}
              <span>${esc(t('related.viewLesson'))} →</span>
            </div>
          </div>`)
        .join('');
      lessonsEl.querySelectorAll('[data-lesson]').forEach((card) => {
        card.addEventListener('click', () => openLesson(card.dataset.lesson));
      });
    }
  }

  async function buildMap() {
    showView('map');
    $('mapLoading').hidden = false;
    try {
      const { map, report, related } = await api(`/api/case/${state.caseId}/analyze`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      state.mapBuilt = true;
      state.mapRenderedLang = state.lang;
      renderMap(map);
      renderReport(report);
      renderRelated(related);
    } catch (err) {
      $('mapGrid').innerHTML = `<div class="disclaimer-banner warn">${esc(err.message)}</div>`;
    } finally {
      $('mapLoading').hidden = true;
    }
  }

  // ---------- Role-play ----------
  async function startRoleplay(mode) {
    state.roleplayMode = mode;
    $('roleplayTitle').textContent = t(mode === 'opposing' ? 'stress.opposing.title' : 'stress.tribunal.title');
    $('roleplayLog').innerHTML = '';
    showView('roleplay');
    try {
      const result = await api(`/api/case/${state.caseId}/roleplay/start`, {
        method: 'POST',
        body: JSON.stringify({ mode })
      });
      $('roleplayDisclaimer').textContent = result.disclaimer;
      addBubble($('roleplayLog'), 'assistant', result.assistantText);
      $('roleplayInput').focus();
    } catch (err) {
      addBubble($('roleplayLog'), 'system', err.message);
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
      if (result.ended) addBubble($('roleplayLog'), 'system', t('rp.ended'));
    } catch (err) {
      addBubble($('roleplayLog'), 'system', err.message);
    } finally {
      input.disabled = false;
      input.focus();
    }
  }

  async function endRoleplay() {
    try {
      const report = await api(`/api/case/${state.caseId}/roleplay/report`, { method: 'POST', body: JSON.stringify({}) });
      $('simModeLabel').textContent = `${t('sim.mode')}: ${t(report.mode === 'opposing' ? 'stress.opposing.title' : 'stress.tribunal.title')}`;
      const cols = [
        ['held', t('sim.held'), report.heldUp],
        ['mid', t('sim.mid'), report.couldBeStronger],
        ['weak', t('sim.weak'), report.weak]
      ];
      $('simGrid').innerHTML = cols
        .map(([cls, title, items]) => `
          <div class="sim-col ${cls}">
            <h4>${esc(title)} (${items.length})</h4>
            ${items.length
              ? items.map((qa) => `<div class="qa-pair"><div class="q">${esc(qa.question)}</div><div>${esc(qa.answer)}</div></div>`).join('')
              : `<p class="empty-note">${esc(t('sim.noneRound'))}</p>`}
          </div>`)
        .join('');
      $('simRecommendations').innerHTML = report.recommendations.map((r) => `<li>${esc(r)}</li>`).join('');
      showView('simreport');
    } catch (err) {
      addBubble($('roleplayLog'), 'system', err.message);
    }
  }

  // ---------- Learning Hub ----------
  function loadDoneLessons() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_DONE) || '[]');
      state.doneLessons = new Set(Array.isArray(raw) ? raw : []);
    } catch {
      state.doneLessons = new Set();
    }
  }

  function markLessonDone(id) {
    state.doneLessons.add(id);
    try {
      localStorage.setItem(LS_DONE, JSON.stringify([...state.doneLessons]));
    } catch {
      /* storage unavailable — progress simply isn't persisted */
    }
  }

  async function loadLearn() {
    state.tracks = await api('/api/learn/tracks');
    const total = state.tracks.reduce((n, tr) => n + tr.lessons.length, 0);
    const done = state.tracks.reduce((n, tr) => n + tr.lessons.filter((l) => state.doneLessons.has(l.id)).length, 0);
    const pct = total ? Math.round((done / total) * 100) : 0;

    $('learnProgress').innerHTML = `
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="progress-label">${done} / ${total} ${esc(t('learn.progress'))}</span>`;

    const recommended = new Set((state.lastRelated ? state.lastRelated.lessons : []).map((l) => l.id));

    $('trackList').innerHTML = state.tracks
      .map((tr) => `
        <section class="track">
          <div class="track-head">
            <div class="track-icon" aria-hidden="true">${esc(tr.icon)}</div>
            <div><h3>${esc(tr.title)}</h3><p>${esc(tr.description)}</p></div>
          </div>
          <div class="lesson-row">
            ${tr.lessons.map((l) => {
              const done = state.doneLessons.has(l.id);
              return `
                <article class="lesson-card ${done ? 'done' : ''}" data-lesson="${esc(l.id)}">
                  <h4>${esc(l.title)}</h4>
                  <p>${esc(l.summary)}</p>
                  <div class="lesson-card-meta">
                    <span class="chip">${esc(l.minutes)} ${esc(t('learn.minutes'))}</span>
                    ${l.hasCase ? `<span class="chip case">${esc(t('learn.cases'))}</span>` : ''}
                    ${done ? `<span class="chip done">✓ ${esc(t('learn.done'))}</span>` : ''}
                    ${recommended.has(l.id) ? `<span class="chip rec">${esc(t('learn.recommended'))}</span>` : ''}
                  </div>
                </article>`;
            }).join('')}
          </div>
        </section>`)
      .join('');

    $('trackList').querySelectorAll('[data-lesson]').forEach((card) => {
      card.addEventListener('click', () => openLesson(card.dataset.lesson));
    });
    showView('learn');
  }

  function findNextLesson(lessonId) {
    const flat = [];
    for (const tr of state.tracks) for (const l of tr.lessons) flat.push(l.id);
    const idx = flat.indexOf(lessonId);
    return idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;
  }

  async function openLesson(id) {
    const lesson = await api('/api/learn/lessons/' + encodeURIComponent(id));
    state.currentLesson = id;

    $('lessonMeta').innerHTML = `
      <span class="chip">${esc(lesson.minutes)} ${esc(t('learn.minutes'))}</span>
      ${lesson.caseNote ? `<span class="chip case">${esc(t('learn.cases'))}</span>` : ''}
      ${state.doneLessons.has(id) ? `<span class="chip done">✓ ${esc(t('learn.done'))}</span>` : ''}`;
    $('lessonTitle').textContent = lesson.title;
    $('lessonContent').innerHTML = lesson.content.map((p) => `<p>${esc(p)}</p>`).join('');

    $('lessonCase').innerHTML = lesson.caseNote
      ? `<div class="case-note">
           <div class="case-label">${esc(t('learn.cases'))}</div>
           <div class="citation">${esc(lesson.caseNote.citation)}</div>
           <p>${esc(lesson.caseNote.why)}</p>
           <a href="${esc(lesson.caseNote.url)}" target="_blank" rel="noopener noreferrer">↗ ${esc(lesson.caseNote.url)}</a>
         </div>`
      : '';

    $('lessonSources').innerHTML = `
      <h4>${esc(t('learn.sources'))}</h4>
      <p class="verify-hint">${esc(t('learn.verifyNote'))}</p>
      <ul>${lesson.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a></li>`).join('')}</ul>`;

    const check = lesson.check;
    $('lessonCheck').innerHTML = `
      <div class="check-label">${esc(t('learn.check'))}</div>
      <p class="q">${esc(check.question)}</p>
      <div id="checkOptions"></div>
      <div class="check-explanation" id="checkExplanation" hidden></div>`;

    const optsEl = $('checkOptions');
    check.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'check-option';
      btn.textContent = opt;
      btn.addEventListener('click', () => {
        optsEl.querySelectorAll('.check-option').forEach((b, j) => {
          b.disabled = true;
          if (j === check.answerIndex) b.classList.add('correct');
        });
        if (i !== check.answerIndex) btn.classList.add('incorrect');
        const exp = $('checkExplanation');
        exp.hidden = false;
        exp.textContent = (i === check.answerIndex ? t('learn.correct') : t('learn.incorrect')) + ' ' + check.explanation;
        markLessonDone(id);
        $('lessonMeta').innerHTML += `<span class="chip done">✓ ${esc(t('learn.done'))}</span>`;
      });
      optsEl.appendChild(btn);
    });

    const nextId = findNextLesson(id);
    $('lessonNav').innerHTML = `
      <button class="btn btn-ghost" data-act="back">${esc(t('learn.back'))}</button>
      ${nextId ? `<button class="btn btn-primary" data-act="next">${esc(t('learn.next'))} →</button>` : ''}`;
    $('lessonNav').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => (b.dataset.act === 'next' ? openLesson(nextId) : loadLearn()));
    });

    showView('lesson');
  }

  // ---------- Forum ----------
  async function loadTopics() {
    state.topics = await api('/api/forum/topics');
    const options = `<option value="all">${esc(t('forum.allTopics'))}</option>` +
      state.topics.map((tp) => `<option value="${esc(tp.id)}">${esc(tp.label)}</option>`).join('');
    const filter = $('forumTopic');
    const prev = filter.value;
    filter.innerHTML = options;
    if (prev) filter.value = prev;
    $('askTopic').innerHTML = state.topics.map((tp) => `<option value="${esc(tp.id)}">${esc(tp.label)}</option>`).join('');
  }

  async function loadForum() {
    await loadTopics();
    await renderThreadList();
    showView('forum');
  }

  async function renderThreadList() {
    const q = $('forumSearch').value.trim();
    const topic = $('forumTopic').value || 'all';
    const threads = await api(`/api/forum/threads?q=${encodeURIComponent(q)}&topic=${encodeURIComponent(topic)}`);

    if (!threads.length) {
      $('threadList').innerHTML = `<p class="empty-note">${esc(t('forum.empty'))}</p>`;
      return;
    }

    $('threadList').innerHTML = threads
      .map((th) => `
        <article class="thread-card" data-thread="${esc(th.id)}">
          <h3>${esc(th.title)}</h3>
          <p class="snippet">${esc(th.excerpt)}</p>
          <div class="thread-meta">
            <span class="badge topic">${esc(th.topicLabel)}</span>
            ${th.status === 'pending'
              ? `<span class="badge pending">${esc(t('forum.pending'))}</span>`
              : `<span class="badge verified">✓ ${esc(th.answerCount)} ${esc(t('forum.answers'))}</span>`}
            <span class="badge lang">${esc(t('forum.askedIn'))} ${esc(th.lang.toUpperCase())}</span>
            ${th.seeded ? `<span class="badge demo">demo</span>` : ''}
            <span>${esc(th.askedAt)}</span>
            <span>· ${esc(th.views)} ${esc(t('forum.views'))}</span>
          </div>
        </article>`)
      .join('');

    $('threadList').querySelectorAll('[data-thread]').forEach((card) => {
      card.addEventListener('click', () => openThread(card.dataset.thread));
    });
  }

  async function openThread(id) {
    const thread = await api('/api/forum/threads/' + encodeURIComponent(id));
    state.currentThread = id;

    const answersHtml = thread.answers.length
      ? thread.answers
          .map((a) => `
            <div class="answer ${a.authorRole === 'agency' ? 'agency' : ''}">
              <div class="answer-head">
                <span class="answer-author">${esc(a.authorLabel)}</span>
                ${a.authorRole === 'verified_lawyer' ? `<span class="badge verified">✓ ${esc(t('forum.verified'))}</span>` : ''}
                ${a.moderated ? `<span class="badge topic">${esc(t('forum.moderated'))} · ${esc(a.moderatedBy)}</span>` : ''}
                <span>${esc(a.answeredAt)}</span>
              </div>
              <div class="answer-body">${esc(a.body)}</div>
            </div>`)
          .join('')
      : `<div class="disclaimer-banner warn">${esc(t('forum.pending'))} — ${esc(t('forum.moderation'))}</div>`;

    $('threadDetail').innerHTML = `
      <div class="thread-detail">
        <div class="thread-meta">
          <span class="badge topic">${esc(thread.topicLabel)}</span>
          <span class="badge lang">${esc(t('forum.askedIn'))} ${esc(thread.lang.toUpperCase())}</span>
          ${thread.seeded ? `<span class="badge demo">demo</span>` : ''}
          <span>${esc(thread.askedAt)}</span>
          <span>· ${esc(thread.views)} ${esc(t('forum.views'))}</span>
        </div>
        <h2>${esc(thread.title)}</h2>
        <div class="thread-body">${esc(thread.body)}</div>
        ${answersHtml}
      </div>`;

    showView('thread');
  }

  async function submitQuestion(ev) {
    ev.preventDefault();
    const title = $('askTitle').value.trim();
    const body = $('askBody').value.trim();
    if (!title || !body) return;

    try {
      const result = await api('/api/forum/threads', {
        method: 'POST',
        body: JSON.stringify({ title, body, topic: $('askTopic').value })
      });
      const redactedNote = result.redacted.length
        ? `<div class="disclaimer-banner warn">Removed before publishing: ${esc(result.redacted.join(', '))}</div>`
        : '';
      $('askResult').innerHTML = `${redactedNote}<div class="disclaimer-banner info">${esc(t('forum.submitted'))}</div>`;
      $('askForm').reset();
      await renderThreadList();
    } catch (err) {
      $('askResult').innerHTML = `<div class="disclaimer-banner warn">${esc(err.message)}</div>`;
    }
  }

  // ---------- Resume ----------
  async function tryResume() {
    const saved = localStorage.getItem(LS_CASE);
    if (!saved) return;
    try {
      const c = await api('/api/case/' + saved);
      state.caseId = c.id;
      $('intakeLog').innerHTML = '';
      for (const m of c.intake.messages) addBubble($('intakeLog'), m.role, m.text);
      if (c.intake.complete) $('intakeCompleteBar').hidden = false;
      if (c.map && c.report) {
        state.mapBuilt = true;
        await buildMap();
      } else {
        showView('intake');
      }
    } catch {
      localStorage.removeItem(LS_CASE);
    }
  }

  // ---------- Wiring ----------
  function bindEnter(inputId, handler) {
    $(inputId).addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handler();
      }
    });
  }

  let searchTimer = null;

  async function init() {
    const savedLang = localStorage.getItem(LS_LANG);
    if (savedLang) state.lang = savedLang;
    loadDoneLessons();

    await loadStrings();
    await loadMeta();
    applyStaticStrings();

    $('brandHome').addEventListener('click', goToCaseView);
    $('btnStartCase').addEventListener('click', startCase);
    $('btnGoLearnHero').addEventListener('click', loadLearn);
    $('btnGoForumHero').addEventListener('click', loadForum);
    $('btnGoLearnFromSim').addEventListener('click', loadLearn);

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab === 'learn') loadLearn();
        else if (tab === 'forum') loadForum();
        else goToCaseView();
      });
    });

    $('btnIntakeSend').addEventListener('click', sendIntakeMessage);
    bindEnter('intakeInput', sendIntakeMessage);
    $('btnBuildMap').addEventListener('click', buildMap);

    $('btnStartOpposing').addEventListener('click', () => startRoleplay('opposing'));
    $('btnStartTribunal').addEventListener('click', () => startRoleplay('tribunal'));
    $('btnRoleplaySend').addEventListener('click', sendRoleplayMessage);
    bindEnter('roleplayInput', sendRoleplayMessage);
    $('btnEndRoleplay').addEventListener('click', endRoleplay);
    $('btnBackToMapFromSim').addEventListener('click', goToCaseView);

    $('btnBackToLearn').addEventListener('click', loadLearn);

    $('btnBackToForum').addEventListener('click', loadForum);
    $('btnAskQuestion').addEventListener('click', () => {
      $('askResult').innerHTML = '';
      showView('ask');
    });
    $('btnCancelAsk').addEventListener('click', loadForum);
    $('askForm').addEventListener('submit', submitQuestion);
    $('forumSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderThreadList, 250);
    });
    $('forumTopic').addEventListener('change', renderThreadList);

    await tryResume();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
