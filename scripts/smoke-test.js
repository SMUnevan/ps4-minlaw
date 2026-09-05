#!/usr/bin/env node
/**
 * End-to-end smoke test against a running server.
 *   node scripts/smoke-test.js [baseUrl]
 * Exits non-zero if any check fails. Uses only Node built-ins.
 */

const http = require('http');
const { URL } = require('url');

const BASE = process.argv[2] || 'http://localhost:3000';

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
          } catch (e) {
            reject(new Error(`Bad JSON from ${method} ${pathname}: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runCaseFlow(lang, messages, expectations) {
  console.log(`\nCase flow [${lang}]`);
  const created = await request('POST', `/api/case?lang=${lang}`, { lang });
  check(`${lang}: case created`, created.status === 200 && !!created.body.caseId);
  const id = created.body.caseId;

  let lastComplete = false;
  for (const msg of messages) {
    const r = await request('POST', `/api/case/${id}/intake?lang=${lang}`, { message: msg, lang });
    if (r.status !== 200) {
      check(`${lang}: intake turn accepted`, false, JSON.stringify(r.body));
      return null;
    }
    lastComplete = r.body.complete;
  }
  check(`${lang}: intake completed within ${messages.length} turns`, lastComplete === true);

  const analyzed = await request('POST', `/api/case/${id}/analyze?lang=${lang}`, { lang });
  check(`${lang}: analyze returned 200`, analyzed.status === 200, JSON.stringify(analyzed.body).slice(0, 200));
  if (analyzed.status !== 200) return null;

  const { map, report, related } = analyzed.body;
  check(`${lang}: dispute type = ${expectations.disputeTypeId}`, map.disputeTypeId === expectations.disputeTypeId, `got ${map.disputeTypeId}`);
  check(`${lang}: map has facts, evidence and law`, map.facts.length > 0 && map.evidence.length > 0 && map.law.length > 0);
  check(`${lang}: every law entry cites at least one source`, map.law.every((l) => (l.sources || []).length > 0));
  check(`${lang}: report has counterarguments`, report.counterarguments.length > 0);
  check(`${lang}: related forum threads matched`, related.threads.length > 0, `got ${related.threads.length}`);
  check(`${lang}: related lessons matched`, related.lessons.length > 0, `got ${related.lessons.length}`);
  check(`${lang}: no pending threads surfaced`, related.threads.every((t) => t.status !== 'pending'));

  if (expectations.evidenceSupported) {
    for (const id of expectations.evidenceSupported) {
      const row = map.evidence.find((e) => e.id === id);
      check(`${lang}: evidence "${id}" marked supported`, !!row && row.status === 'supported', row ? row.status : 'absent');
    }
  }
  if (expectations.evidenceMissing) {
    for (const id of expectations.evidenceMissing) {
      const row = map.evidence.find((e) => e.id === id);
      check(`${lang}: evidence "${id}" marked missing`, !!row && row.status === 'missing', row ? row.status : 'absent');
    }
  }
  // Negation check: evidence the user explicitly said they do NOT have must
  // never appear as supported (it may be listed as missing, or not listed at
  // all if it isn't a suggested document for this dispute type).
  if (expectations.evidenceNotSupported) {
    for (const id of expectations.evidenceNotSupported) {
      const row = map.evidence.find((e) => e.id === id);
      check(
        `${lang}: negated evidence "${id}" is not shown as supported`,
        !row || row.status !== 'supported',
        row ? row.status : 'absent'
      );
    }
  }

  // Role-play round trip
  const started = await request('POST', `/api/case/${id}/roleplay/start?lang=${lang}`, { mode: 'opposing', lang });
  check(`${lang}: roleplay started with a disclaimer`, started.status === 200 && !!started.body.disclaimer && !!started.body.assistantText);

  await request('POST', `/api/case/${id}/roleplay/message?lang=${lang}`, {
    mode: 'opposing',
    message: 'I have the chat messages and the transfer record dated 22 August 2026.',
    lang
  });
  await request('POST', `/api/case/${id}/roleplay/message?lang=${lang}`, { mode: 'opposing', message: 'I am not sure.', lang });

  const simReport = await request('POST', `/api/case/${id}/roleplay/report?lang=${lang}`, { lang });
  check(`${lang}: simulation report generated`, simReport.status === 200 && Array.isArray(simReport.body.recommendations));
  check(
    `${lang}: strong answer classified as held up`,
    simReport.body.heldUp.length >= 1,
    `heldUp=${simReport.body.heldUp.length} weak=${simReport.body.weak.length}`
  );
  check(`${lang}: uncertain answer classified as weak`, simReport.body.weak.length >= 1);

  return id;
}

async function main() {
  console.log(`Case Compass smoke test → ${BASE}`);

  const meta = await request('GET', '/api/meta');
  check('meta reachable', meta.status === 200);
  check('four languages exposed', meta.body.languages.length === 4);
  check('lessons loaded', meta.body.lessonCount > 0, `count=${meta.body.lessonCount}`);

  // English: goods dispute, explicitly says there is NO receipt.
  await runCaseFlow(
    'en',
    [
      'I bought a second-hand laptop from a seller on Carousell for $800. It stopped turning on after 3 days but the seller refuses to refund me.',
      'I have the Carousell chat messages and a PayNow transfer record, but no formal receipt.',
      'Yes, I messaged the seller asking for a refund but he said all sales are final.',
      'This happened 2 weeks ago, around 22 August 2026.'
    ],
    {
      disputeTypeId: 'goods',
      evidenceSupported: ['Written correspondence'],
      // "but no formal receipt" — English negation must stop this being counted as held.
      evidenceMissing: ['Receipt/Invoice'],
      evidenceNotSupported: ['Receipt/Invoice']
    }
  );

  // Chinese: tenancy deposit dispute, exercising non-English keyword matching.
  await runCaseFlow(
    'zh',
    [
      '我租了一间房间一年，房东到现在还没有退还我的押金 $1000。',
      '我有租约和退租时拍的照片，但没有收据。',
      '我已经联系过房东，他没有回复。',
      '这件事发生在上个月。'
    ],
    {
      disputeTypeId: 'deposit_tenancy',
      evidenceSupported: ['Contract/Agreement', 'Photos/Video'],
      // "但没有收据" — Chinese negation must stop this being counted as held.
      evidenceNotSupported: ['Receipt/Invoice']
    }
  );

  // Learning Hub
  console.log('\nLearning Hub');
  const tracks = await request('GET', '/api/learn/tracks?lang=en');
  check('tracks returned', tracks.status === 200 && tracks.body.length >= 4);
  const firstLessonId = tracks.body[0].lessons[0].id;
  for (const lang of ['en', 'zh', 'ms', 'ta']) {
    const lesson = await request('GET', `/api/learn/lessons/${firstLessonId}?lang=${lang}`);
    check(`lesson localised in ${lang}`, lesson.status === 200 && !!lesson.body.title && lesson.body.content.length > 0);
    check(`lesson ${lang} has sources`, lesson.body.sources.length > 0);
    check(
      `lesson ${lang} quiz well-formed`,
      Array.isArray(lesson.body.check.options) &&
        lesson.body.check.options.length >= 2 &&
        lesson.body.check.answerIndex < lesson.body.check.options.length
    );
  }
  const missingLesson = await request('GET', '/api/learn/lessons/does-not-exist');
  check('unknown lesson returns 404', missingLesson.status === 404);

  // Forum
  console.log('\nCommunity Forum');
  const threads = await request('GET', '/api/forum/threads?lang=en');
  check('forum threads listed', threads.status === 200 && threads.body.length > 0);
  check('demo threads are flagged as seeded', threads.body.some((t) => t.seeded === true));
  check(
    'user-submitted threads are never published as answered',
    threads.body.filter((t) => !t.seeded).every((t) => t.status === 'pending')
  );

  const searched = await request('GET', '/api/forum/threads?q=deposit');
  check('forum search filters', searched.body.length > 0 && searched.body.length < threads.body.length);

  const thread = await request('GET', `/api/forum/threads/${threads.body[0].id}`);
  check('thread detail returns answers', thread.status === 200 && Array.isArray(thread.body.answers));

  const posted = await request('POST', '/api/forum/threads', {
    title: 'Test question about a deposit',
    body: 'My landlord has my number 91234567 and my email test@example.com and my NRIC S1234567D. Can I get my deposit back?',
    topic: 'tenancy',
    lang: 'en'
  });
  check('question posted', posted.status === 200);
  check('posted question is pending moderation', posted.body.thread.status === 'pending');
  check('NRIC redacted', !posted.body.thread.body.includes('S1234567D'), posted.body.thread.body);
  check('phone redacted', !posted.body.thread.body.includes('91234567'));
  check('email redacted', !posted.body.thread.body.includes('test@example.com'));
  check('redaction reported to caller', posted.body.redacted.length === 3, JSON.stringify(posted.body.redacted));

  const afterPost = await request('GET', '/api/forum/threads?lang=en');
  check('posted question appears in listing', afterPost.body.some((t) => t.id === posted.body.thread.id));

  // Validation
  console.log('\nValidation');
  const badCase = await request('GET', '/api/case/does-not-exist');
  check('unknown case returns 404', badCase.status === 404);
  const emptyMsg = await request('POST', '/api/forum/threads', { title: '', body: '' });
  check('empty question rejected', emptyMsg.status === 400);

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err.message);
  process.exit(1);
});
