import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const deploy = readFileSync(new URL('./terraform-deploy.yml', import.meta.url), 'utf8');
const health = readFileSync(new URL('./post-deploy-smoke.yml', import.meta.url), 'utf8');
const job = deploy.split('  deploy-vercel-prod:\n')[1]?.split('\n  housing-contract-tests:')[0];

test('release smoke runs inside deployment, after promotion and before success summary', () => {
  assert.ok(job);
  const promote = job.indexOf('- name: Promote Vercel deployment to production');
  const smoke = job.indexOf('- name: Verify promoted production release');
  const summary = job.indexOf('- name: Production Deployment Summary');
  assert.ok(promote >= 0 && smoke > promote && summary > smoke);
  const step = job.slice(smoke, job.indexOf('\n      - name:', smoke + 1));
  assert.match(step, /node e2e\/release-smoke-ci\.mjs/);
  assert.doesNotMatch(step, /continue-on-error|if:.*always|\|\| true/);
  assert.match(step, /working-directory: web/);
  assert.match(step, /CLOUDFLARE_TESTING_BYPASS_SECRET/);
  assert.match(step, /exit 1/);
});

test('browser installation precedes mandatory release smoke', () => {
  const install = job.indexOf('- name: Install production smoke browser');
  const smoke = job.indexOf('- name: Verify promoted production release');
  assert.ok(install >= 0 && smoke > install);
  assert.match(job.slice(install, smoke), /npx playwright install --with-deps chromium/);
});

test('periodic health checks do not race a push deployment with a fixed sleep', () => {
  assert.match(health, /schedule:/);
  assert.match(health, /workflow_dispatch:/);
  assert.doesNotMatch(health, /^  push:/m);
  assert.doesNotMatch(health, /sleep 300/);
});

test('PR contract checks enforce smoke ordering', () => {
  const contracts = deploy.split('  housing-contract-tests:\n')[1]?.split('\n  run-tests:')[0];
  assert.match(contracts, /node --test \.github\/workflows\/production-smoke-order\.test\.mjs/);
});
