import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertBuildNode, requiredBuildNode } from '../verify-build-node.mjs';

test('only the reviewed exact build patch passes', () => {
  assert.doesNotThrow(() => assertBuildNode('v24.22.1'));
  for (const version of ['v24.8.0','v24.19.0','v22.23.4','v26.12.1','v24.22.1-rc.1',undefined,'']) {
    assert.throws(() => assertBuildNode(version), /Use Node 24.22.1/);
  }
});
test('CLI checks the actual process and cannot be bypassed by an argument', () => {
  const script=fileURLToPath(new URL('../verify-build-node.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[script,'v24.22.1'],{encoding:'utf8'});
  if(process.version===`v${requiredBuildNode}`){
    assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).node,process.version);
  } else { assert.equal(result.status,1);assert.match(result.stderr,/Use Node 24.22.1/); }
});
