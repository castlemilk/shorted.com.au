import test from "node:test";
import assert from "node:assert/strict";
import { bindDeploymentIdentity, newDeploymentIdentity } from "../vercel-deployment-identity.mjs";

test("every production build gets a valid, distinct Vercel identity", () => {
  const first = newDeploymentIdentity();
  const second = newDeploymentIdentity();
  assert.match(first, /^shorted-[a-f0-9]{24}$/);
  assert.notEqual(first, second);
  assert.equal(bindDeploymentIdentity({ version: 3 }, { config: { deploymentId: first } }, first).deploymentId, first);
  assert.equal(bindDeploymentIdentity({ version: 3, deploymentId: first }, { config: { deploymentId: first } }, first).deploymentId, first);
});

test("a prebuilt release cannot proceed with a missing or mismatched identity", () => {
  const expected = newDeploymentIdentity();
  assert.throws(() => bindDeploymentIdentity({ version: 3 }, {}, expected), /Next.js build/);
  assert.throws(() => bindDeploymentIdentity({ version: 3, deploymentId: newDeploymentIdentity() }, { config: { deploymentId: expected } }, expected), /different deployment ID/);
  assert.throws(() => bindDeploymentIdentity({ version: 3 }, { config: { deploymentId: newDeploymentIdentity() } }, expected), /Next.js build/);
  assert.throws(() => bindDeploymentIdentity({ version: 2 }, { config: { deploymentId: expected } }, expected), /version 3/);
  assert.throws(() => bindDeploymentIdentity({}, {}, "dpl_invalid"), /valid, unique/);
});
