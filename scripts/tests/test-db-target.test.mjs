// node --test scripts/tests/test-db-target.test.mjs
//
// web/scripts/test-db-setup.ts (`npm run test:seed`, which scripts/run-e2e-tests.sh
// runs in CI mode) goes through the Supabase Data API and DELETEs the
// stock_prices and shorts rows of five stock codes before it inserts random
// fixtures, and it used to fall back to the prod project's URL. These pin that
// it refuses to start unless SUPABASE_URL is set and is not prod. This job
// installs no web dependencies, so the guard is a dependency-free module and the
// script itself is read as text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PROD_PROJECT_REF, resolveSeedTarget } from "../../web/scripts/test-db-target.mjs";

const readRepo = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const script = readRepo("web/scripts/test-db-setup.ts");

const LOCAL = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_ANON_KEY: "local-anon-key" };
/** A legacy Supabase key: a JWT whose payload carries the project's ref. */
const jwt = (payload) =>
  [{ alg: "HS256", typ: "JWT" }, payload].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".signature";

test("the prod ref is supabase/config.toml's project_id", () => {
  assert.match(readRepo("supabase/config.toml"), new RegExp(`^project_id = "${PROD_PROJECT_REF}"$`, "m"));
});

test("refuses without SUPABASE_URL: there is no default project any more", () => {
  for (const env of [{ SUPABASE_ANON_KEY: "k" }, { SUPABASE_URL: "", SUPABASE_ANON_KEY: "k" }, { SUPABASE_URL: "   ", SUPABASE_ANON_KEY: "k" }]) {
    assert.throws(() => resolveSeedTarget(env), /SUPABASE_URL is not set, and there is no default project any more/);
  }
});

test("refuses the prod project, however its URL is written", () => {
  for (const url of [
    `https://${PROD_PROJECT_REF}.supabase.co`,
    `https://${PROD_PROJECT_REF}.supabase.co/`,
    `https://${PROD_PROJECT_REF.toUpperCase()}.supabase.co`,
    `https://${PROD_PROJECT_REF}.supabase.co/rest/v1`,
    ` https://${PROD_PROJECT_REF}.supabase.co `,
    `http://${PROD_PROJECT_REF}.supabase.co`,
  ]) {
    assert.throws(
      () => resolveSeedTarget({ SUPABASE_URL: url, SUPABASE_ANON_KEY: "k" }),
      new RegExp(`SUPABASE_URL is the prod Supabase project \\(${PROD_PROJECT_REF}\\).*refuses to run`),
      url,
    );
  }
});

test("refuses a prod key whatever the URL, so a proxy or custom domain cannot hide prod", () => {
  const prodKey = jwt({ iss: "supabase", ref: PROD_PROJECT_REF, role: "anon" });
  assert.throws(
    () => resolveSeedTarget({ SUPABASE_URL: "https://db.example.com", SUPABASE_ANON_KEY: prodKey }),
    /SUPABASE_ANON_KEY is a key of the prod Supabase project.*whatever SUPABASE_URL says/,
  );
});

test("refuses a missing key and a URL that is not http(s), before anything is sent", () => {
  assert.throws(() => resolveSeedTarget({ SUPABASE_URL: LOCAL.SUPABASE_URL }), /SUPABASE_ANON_KEY is not set/);
  for (const url of ["127.0.0.1:54321", "postgresql://admin:password@localhost:5438/shorts", "not a url"]) {
    assert.throws(() => resolveSeedTarget({ SUPABASE_URL: url, SUPABASE_ANON_KEY: "k" }), /SUPABASE_URL is not an http\(s\) URL/, url);
  }
});

test("seeds a local or test project, with whichever key it is given", () => {
  assert.deepEqual(resolveSeedTarget(LOCAL), { url: LOCAL.SUPABASE_URL, key: LOCAL.SUPABASE_ANON_KEY });
  const testKey = jwt({ iss: "supabase", ref: "abcdefghijklmnopqrst", role: "anon" });
  assert.deepEqual(resolveSeedTarget({ SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_ANON_KEY: testKey }), {
    url: "https://abcdefghijklmnopqrst.supabase.co",
    key: testKey,
  });
  // the local stack's own demo key carries no ref; a new-style key is no JWT
  const localDemoKey = jwt({ iss: "supabase-demo", role: "anon" });
  assert.equal(resolveSeedTarget({ ...LOCAL, SUPABASE_ANON_KEY: localDemoKey }).key, localDemoKey);
  assert.equal(resolveSeedTarget({ ...LOCAL, SUPABASE_ANON_KEY: "sb_publishable_abc123" }).key, "sb_publishable_abc123");
});

test("test-db-setup.ts takes its target only from the guard, before it creates a client", () => {
  assert.ok(!script.toLowerCase().includes(PROD_PROJECT_REF), "no prod URL anywhere in the script");
  assert.doesNotMatch(script, /process\.env\.SUPABASE_(URL|ANON_KEY)/, "only the guard reads the target from the environment");
  assert.match(script, /^import \{ resolveSeedTarget \} from '\.\/test-db-target\.mjs';$/m);
  const body = script.slice(script.indexOf("async function setupTestDatabase() {"));
  const guard = body.indexOf("const { url, key } = resolveSeedTarget(process.env);");
  assert.ok(guard > 0, "setupTestDatabase starts by resolving the target");
  assert.ok(guard < body.indexOf("createClient(url, key)"), "the guard runs before the client is created");
  assert.equal([...script.matchAll(/createClient\(/g)].length, 1, "one client, built from the guarded target");
  // web/package.json is "type": "module", where `require.main === module` throws
  assert.equal(JSON.parse(readRepo("web/package.json")).type, "module");
  assert.doesNotMatch(script.replace(/\/\/.*$/gm, ""), /\brequire\b/);
});
