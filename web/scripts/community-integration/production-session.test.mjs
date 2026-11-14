import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const directory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(directory, "../..");

test("real production auth accepts only the synthetic encrypted session and keeps credentials disabled", () => {
  const script = `
    import assert from 'node:assert/strict';
    import { Auth } from '@auth/core';
    import { syntheticSessionCookie } from './scripts/community-integration/production-session.mjs';
    const module = await import('./src/server/auth.ts');
    const { authOptions } = module.default ?? module;
    const provider = authOptions.providers[0].options ?? authOptions.providers[0];
    assert.equal(await provider.authorize({
      email: process.env.E2E_TEST_EMAIL,
      password: process.env.E2E_TEST_PASSWORD,
    }), null);
    assert.equal(authOptions.cookies.sessionToken.options.secure, true);
    const cookie = await syntheticSessionCookie(process.env.NEXTAUTH_SECRET, 'postgres');
    assert.equal(cookie.name, authOptions.cookies.sessionToken.name);
    const response = await Auth(new Request('https://127.0.0.1/api/auth/session', {
      headers: { cookie: cookie.name + '=' + cookie.value },
    }), { ...authOptions, basePath: '/api/auth' });
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.equal(session.user.id, 'synthetic-community-postgres');
    assert.equal(session.user.emailVerified, true);
    assert.equal(session.user.isAdmin, false);
    const anonymous = await Auth(new Request('https://127.0.0.1/api/auth/session'), {
      ...authOptions, basePath: '/api/auth',
    });
    assert.equal(await anonymous.json(), null);
    console.log('Production synthetic session and disabled credentials verified');
  `;
  const env = Object.fromEntries(
    ["PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "LD_LIBRARY_PATH"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: webRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...env,
        NODE_ENV: "production",
        NEXTAUTH_SECRET: randomUUID(),
        // Even the matching non-production credential remains rejected.
        ALLOW_E2E_AUTH: "true",
        E2E_TEST_EMAIL: "community-integration-postgres@example.test",
        E2E_TEST_PASSWORD: randomUUID(),
        NODE_OPTIONS: `--require=${path.join(directory, "local-network-only.cjs")}`,
      },
    },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(
    result.stdout,
    /Production synthetic session and disabled credentials verified/,
  );
});
