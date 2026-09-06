const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const engine = require('../src/ai/engine');
const { newCase } = require('../src/lib/caseStore');

// Exercise browser provider functions without initializing the UI or using a key.
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const context = vm.createContext({ document: { addEventListener() {} } });
vm.runInContext(source.replace("document.addEventListener('DOMContentLoaded', init);",
  'globalThis.testAPI = { callProvider, requestAIOrFallback, state };'), context);
const { callProvider, requestAIOrFallback, state } = context.testAPI;

async function main() {
  for (const provider of ['gemini', 'openrouter']) {
    const config = { provider, apiKey: 'test-only', model: 'test-model' };
    state.aiConfig = config;
    state.caseId = 'test-case';
    let calls = 0;
    const budgets = [];
    const request = { systemPrompt: 'Return JSON', userPrompt: 'Test', maxTokens: 1024 };
    context.fetch = async (url, options) => {
      if (url.startsWith('/api/')) return { ok: true, json: async () => request };
      const body = JSON.parse(options.body);
      budgets.push(provider === 'gemini' ? body.generationConfig.maxOutputTokens : body.max_tokens);
      calls++;
      return { ok: true, json: async () => provider === 'gemini'
        ? { candidates: [{ content: { parts: [{ text: '{not output}', thought: true }, { text: calls === 1 ? '{' : '{"ok":true}' }] } }] }
        : { choices: [{ message: { content: calls === 1 ? 'Incomplete' : [{ type: 'text', text: '{"ok":true}' }] } }] } };
    };
    assert.strictEqual((await callProvider(config, request)).ok, true);
    assert.deepStrictEqual(budgets, [8192, 16384]);
    context.fetch = async (url) => ({ ok: true, json: async () => url.startsWith('/api/') ? request : {} });
    assert.strictEqual(await requestAIOrFallback('intake', { message: 'Test' }), null);
    assert.strictEqual(await requestAIOrFallback('report', {}), null);
    context.fetch = async () => ({ ok: false, status: 401, text: async () => '' });
    await assert.rejects(callProvider(config, request), (err) => err.providerKind === 'key');
  }
  const record = newCase();
  const result = await engine.intakeTurn(record, 'I bought a laptop for $800 and want a refund.', 'en', { slots: null, assistantText: 5 });
  assert.strictEqual(result.fallback, true);
  assert.strictEqual(record.intake.slots.amountClaimed, '$800');
  assert(engine.buildCaseMap(record, 'en').facts.length > 0);
  const report = await engine.buildReadinessReport(record, 'en', { strengths: 'invalid' });
  assert.strictEqual(report.fallback, true);
  assert(Array.isArray(report.counterarguments));
  await engine.intakeTurn(record, 'I have a receipt.', 'en');
  assert.strictEqual(record.map, null);
  assert.strictEqual(record.report, null);
  console.log('Provider retry, intake fallback, report fallback, and cache regression tests passed.');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
