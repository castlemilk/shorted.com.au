import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXPECTED_LIMITS, verifyFunctionLimits } from '../verify-vercel-function-limits.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shorted-function-limits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [route, maxDuration] of Object.entries(EXPECTED_LIMITS)) {
    const dir = join(root, 'functions', `${route}.func`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs24.x', maxDuration, environment: { privateBinding: 'never-print-me' }, ...overrides[route] }));
  }
  return root;
}

test('verifies built ordinary and long-running warmers without emitting private bindings', async (t) => {
  const root = await fixture(t);
  const results = await verifyFunctionLimits(root);
  assert.equal(results.length, 5);
  assert.equal(results.find(r => r.route === '/api/static-pages/warm-cache').maxDuration, 120);
  assert.equal(results.find(r => r.route === '/api/pages/warm-cache').maxDuration, 300);
  assert.equal(JSON.stringify(results).includes('never-print-me'), false);
});

test('rejects a Fluid default accidentally replacing the prior ordinary route limit', async (t) => {
  const root = await fixture(t, { 'api/about/statistics': { maxDuration: 300 } });
  await assert.rejects(verifyFunctionLimits(root), /expected Node.js maxDuration 15s/);
});

test('rejects a wildcard override accidentally lowering explicit warm durations', async (t) => {
  const root = await fixture(t, { 'api/static-pages/warm-cache': { maxDuration: 15 } });
  await assert.rejects(verifyFunctionLimits(root), /expected Node.js maxDuration 120s/);
});
