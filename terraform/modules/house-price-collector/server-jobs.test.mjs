// node --test terraform/modules/house-price-collector/server-jobs.test.mjs
//
// The server-side crawl schedules (S-SRV) ship INERT. Every one is created paused,
// and nothing runs until the reviewed cutover. These tests pin that, and the set of
// schedules, their cadence and their args. They read the Terraform source; they do not
// need a provider or credentials.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const main = readFileSync(join(here, "main.tf"), "utf8");
const variables = readFileSync(join(here, "variables.tf"), "utf8");
const prodMain = readFileSync(join(repoRoot, "terraform/environments/prod/main.tf"), "utf8");

// The body of `resource "<type>" "<name>" { ... }`, by brace matching.
function block(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated block: ${header}`);
}

const schedules = block(main, "server_crawl_schedules = {");
const serverResource = block(main, 'resource "google_cloud_scheduler_job" "server_crawl"');

const EXPECTED = {
  "enqueue-delta": { schedule: "0 10 * * *", mode: "server-enqueue", selection: "delta" },
  "enqueue-full": { schedule: "0 8 1,15 * *", mode: "server-enqueue", selection: "full" },
  "crawl-finalize": { schedule: "*/30 * * * *", mode: "crawl-finalize" },
  freshness: { schedule: "0 18 * * *", mode: "freshness" },
  "property-resolve": { schedule: "20 21 * * *", mode: "server-property-resolve" },
};

test("the server crawl schedules are exactly the five the design names", () => {
  for (const key of Object.keys(EXPECTED)) {
    assert.match(schedules, new RegExp(`^\\s{4}${key} = \\{`, "m"), `missing schedule ${key}`);
  }
  const keys = [...schedules.matchAll(/^\s{4}([a-z][a-z-]*) = \{/gm)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), Object.keys(EXPECTED).sort(), "an unexpected schedule was added");
});

test("each schedule runs the right mode at the designed cadence", () => {
  for (const [key, want] of Object.entries(EXPECTED)) {
    const body = block(schedules, `${key} = {`);
    assert.ok(body.includes(`schedule    = "${want.schedule}"`), `${key}: cadence must be "${want.schedule}"`);
    assert.ok(body.includes(`"-mode", "${want.mode}"`), `${key}: args must select -mode ${want.mode}`);
    if (want.selection) {
      assert.ok(body.includes(`"-selection", "${want.selection}"`), `${key}: args must select ${want.selection}`);
    }
  }
});

test("property-resolve is the only schedule that turns dry-run off, and caps its chunk at 700", () => {
  for (const key of Object.keys(EXPECTED)) {
    const body = block(schedules, `${key} = {`);
    if (key === "property-resolve") {
      assert.match(body, /CRAWL_DRY_RUN\s*=\s*"false"/);
      // 700 addresses at ~1.85 s each is ~1300 s, under the job's 1800 s timeout. 1000 would
      // need ~1850 s and exceed it. The test pins the cap and the timeout together.
      const cap = Number(body.match(/CRAWL_PROPERTY_RESOLVE_MAX\s*=\s*"(\d+)"/)?.[1]);
      assert.equal(cap, 700, "the property-resolve chunk must stay at 700 for the 1800s job timeout");
      const timeout = main.match(/timeout\s*=\s*"(\d+)s"/)?.[1];
      assert.equal(timeout, "1800", "the job timeout the cap is sized to");
    } else {
      assert.match(body, /env\s*=\s*\{\}/, `${key} must not change the environment`);
    }
  }
});

test("every server schedule is created PAUSED, through the variable whose default is true", () => {
  assert.match(serverResource, /for_each\s*=\s*local\.server_crawl_schedules/);
  assert.match(
    serverResource,
    /paused\s*=\s*var\.server_schedules_paused\b/,
    "the paused flag must come from server_schedules_paused, not a literal",
  );
  assert.doesNotMatch(serverResource, /paused\s*=\s*false/, "a server schedule must never be created unpaused");

  const variable = block(variables, 'variable "server_schedules_paused"');
  assert.match(variable, /default\s*=\s*true\b/, "server_schedules_paused must default to true");
  assert.match(variable, /type\s*=\s*bool/);
});

test("prod does not override server_schedules_paused to false", () => {
  assert.doesNotMatch(
    prodMain,
    /server_schedules_paused\s*=\s*false/,
    "prod must not unpause the server schedules outside the reviewed cutover",
  );
});

test("the server schedules run in Sydney time, and the override body is the v1 :run shape", () => {
  assert.match(serverResource, /time_zone\s*=\s*"Australia\/Sydney"/);
  assert.match(serverResource, /\/apis\/run\.googleapis\.com\/v1\/namespaces\/\$\{var\.project_id\}\/jobs\/\$\{google_cloud_run_v2_job\.collector\.name\}:run/);
  assert.match(serverResource, /container_overrides\s*=\s*\[\{\s*args\s*=\s*each\.value\.args/);
  assert.doesNotMatch(serverResource, /^\s*timeout\s*=/m, "the v2 timeout field is rejected by the v1 :run endpoint");
});

test("the job carries the server environment without changing the official ingest", () => {
  const job = block(main, 'resource "google_cloud_run_v2_job" "collector"');
  for (const name of ["BRANDBRAIN_AGENT_URL", "BRANDBRAIN_IDTOKEN_AUDIENCE", "HOUSING_INGEST_DISPATCH_TTL"]) {
    assert.match(job, new RegExp(`name\\s*=\\s*"${name}"`), `${name} must reach the job`);
  }
  // The default -mode all must still be the entrypoint's default, with no args change.
  assert.doesNotMatch(job, /\bargs\s*=/, "the job's default command must stay -mode all");
});

test("the dispatch TTL default matches the ingest service's default", () => {
  const collectorTTL = block(variables, 'variable "ingest_dispatch_ttl"').match(/default\s*=\s*"([^"]+)"/)?.[1];
  const ingestVars = readFileSync(join(repoRoot, "terraform/modules/housing-ingest/variables.tf"), "utf8");
  const ingestTTL = block(ingestVars, 'variable "dispatch_ttl"').match(/default\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(collectorTTL, "collector ingest_dispatch_ttl has a default");
  assert.equal(collectorTTL, ingestTTL, "the enqueue's expiry and the ingest's view of it must agree");
});
