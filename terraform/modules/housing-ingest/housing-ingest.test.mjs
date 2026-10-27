// node --test terraform/modules/housing-ingest/housing-ingest.test.mjs
//
// The housing crawl ingest ships INERT and is bounded. Its allowlist and org are empty,
// so it accepts no rig. It has probes, at most two instances, and its own small pool.
// These tests pin those properties in the Terraform source.
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

// The literal value of an env var set in the container, or undefined when unset.
function envValue(name) {
  const m = main.match(new RegExp(`name\\s*=\\s*"${name}"\\s*value\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : undefined;
}

const service = block(main, 'resource "google_cloud_run_v2_service" "ingest"');

// The chat-service lesson (bffa7bdf0): the service account and its new secret grant are created in
// the same apply as the revision that mounts the secret. Cloud Run refuses the revision until the
// grant propagates, so the service must wait for a sleep that follows the grant.
test("the ingest revision waits for its DATABASE_URL grant to propagate", () => {
  const sleep = block(main, 'resource "time_sleep" "database_url_grant"');
  assert.match(sleep, /create_duration\s*=\s*"30s"/);
  assert.match(sleep, /depends_on\s*=\s*\[\s*google_secret_manager_secret_iam_member\.database_url\s*\]/);
  assert.match(service, /depends_on\s*=\s*\[[\s\S]*?time_sleep\.database_url_grant[\s\S]*?\]/);
  assert.match(main, /source\s*=\s*"hashicorp\/time"/, "the time provider is declared by the module");
});

test("the service is inert: its org and rig allowlist default to empty", () => {
  for (const name of ["ingest_org", "ingest_allow_subjects"]) {
    const variable = block(variables, `variable "${name}"`);
    assert.match(variable, /default\s*=\s*""/, `${name} must default to the empty string`);
  }
  assert.equal(envValue("HOUSING_INGEST_ORG"), undefined, "the org is passed through a variable, not literal");
});

test("prod leaves the inert ingest variables unset, so no rig is admitted by a deploy", () => {
  const wiring = block(prodMain, 'module "housing_ingest"');
  assert.doesNotMatch(wiring, /ingest_org\s*=/, "prod must not set ingest_org at this stage");
  assert.doesNotMatch(wiring, /ingest_allow_subjects\s*=/, "prod must not set ingest_allow_subjects at this stage");
});

test("the service runs the ingest mode, enabled, on its own pool", () => {
  assert.equal(envValue("SHORTS_SERVE_MODE"), "ingest");
  assert.equal(envValue("HOUSING_INGEST_ENABLED"), "true");
  assert.match(main, /name\s*=\s*"HOUSING_INGEST_DB_MAX_CONNS"\s*value\s*=\s*tostring\(var\.db_max_conns\)/);
  assert.match(main, /name\s*=\s*"DATABASE_URL"[\s\S]*?secret\s*=\s*"DATABASE_URL"/);
});

test("the allowlist and org reach the service only through their variables", () => {
  const assigned = [...main.matchAll(/HOUSING_INGEST_(?:ORG|ALLOW_SUBJECTS)"\s*value\s*=\s*([^\n]*)/g)].map((m) =>
    m[1].trim(),
  );
  assert.deepEqual(assigned.sort(), ["var.ingest_allow_subjects", "var.ingest_org"]);
});

test("the service has startup and liveness probes on /health", () => {
  assert.match(service, /startup_probe\s*\{\s*http_get\s*\{\s*path\s*=\s*"\/health"/);
  assert.match(service, /liveness_probe\s*\{\s*http_get\s*\{\s*path\s*=\s*"\/health"/);
});

test("the service is bounded to at most two instances and scales from zero", () => {
  assert.match(service, /min_instance_count\s*=\s*0\b/);
  assert.match(service, /max_instance_count\s*=\s*var\.max_instances\b/);
  const maxInstances = block(variables, 'variable "max_instances"');
  assert.match(maxInstances, /default\s*=\s*2\b/, "max_instances defaults to 2");
  assert.match(maxInstances, /var\.max_instances\s*<=\s*2\b/, "the validation rejects more than 2");
});

test("the connection budget holds: at most 4 connections per instance", () => {
  const dbMax = block(variables, 'variable "db_max_conns"');
  assert.match(dbMax, /default\s*=\s*4\b/);
  assert.match(dbMax, /var\.db_max_conns\s*<=\s*4\b/);
});

test("the service is publicly invokable, because rigs authenticate with BrandBrain tokens", () => {
  assert.match(main, /resource "google_cloud_run_v2_service_iam_member" "public_invoker"[\s\S]*?role\s*=\s*"roles\/run\.invoker"[\s\S]*?member\s*=\s*"allUsers"/);
});

test("the service is not routed through the public API or the Cloudflare edge", () => {
  // Comments explain the design and name the public API on purpose, so check the code only.
  const code = main.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(code, /google_cloud_run_domain_mapping|cloudflare|api\.shorted\.com\.au/);
  assert.match(code, /ingress\s*=\s*"INGRESS_TRAFFIC_ALL"/);
});

test("the prod environment wires the module with the shared shorts image", () => {
  const wiring = block(prodMain, 'module "housing_ingest"');
  assert.match(wiring, /source\s*=\s*"\.\.\/\.\.\/modules\/housing-ingest"/);
  assert.match(wiring, /image_url\s*=\s*var\.shorts_api_image/);
});
