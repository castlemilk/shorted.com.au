import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflowPath = fileURLToPath(new URL("./housing-freshness.yml", import.meta.url));
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";
const deployWorkflowPath = fileURLToPath(new URL("./terraform-deploy.yml", import.meta.url));
const deployWorkflow = existsSync(deployWorkflowPath)
  ? readFileSync(deployWorkflowPath, "utf8")
  : "";
const collectorModuleMainPath = fileURLToPath(
  new URL("../../terraform/modules/house-price-collector/main.tf", import.meta.url),
);
const collectorModuleVariablesPath = fileURLToPath(
  new URL("../../terraform/modules/house-price-collector/variables.tf", import.meta.url),
);
const devMainPath = fileURLToPath(
  new URL("../../terraform/environments/dev/main.tf", import.meta.url),
);
const devVariablesPath = fileURLToPath(
  new URL("../../terraform/environments/dev/variables.tf", import.meta.url),
);
const prodMainPath = fileURLToPath(
  new URL("../../terraform/environments/prod/main.tf", import.meta.url),
);
const prodVariablesPath = fileURLToPath(
  new URL("../../terraform/environments/prod/variables.tf", import.meta.url),
);

const readContractFile = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

test("housing freshness workflow enforces the read-only production sentinel contract", () => {
  assert.ok(workflow, "housing-freshness.yml must exist");

  assert.match(workflow, /on:\s*\n\s+schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(workflow, /DATABASE_URL:\s*\$\{\{\s*secrets\.DATABASE_URL_PROD\s*\}\}/);

  assert.match(workflow, /default_transaction_read_only=on/);
  assert.match(workflow, /--set=ON_ERROR_STOP=1/);
  assert.match(workflow, /\bWITH\b[\s\S]*\bSELECT\b/);

  // Scope the mutation check to the SQL heredoc, not the whole YAML. The rule is
  // "the freshness QUERY is read-only" — asserting it over the entire file also
  // forbids the word "create" anywhere in it, which made an ordinary
  // `gh issue create` alerting step look like a database mutation. Extracting the
  // heredoc keeps the guard aimed at what it is actually protecting, and makes it
  // strictly tighter: it now fails if the heredoc is missing altogether.
  // The heredoc body and its terminator are YAML-indented, so match the
  // terminator on its own (whitespace-only prefixed) line rather than at column 0.
  const sqlBlocks = [...workflow.matchAll(/<<'SQL'\n([\s\S]*?)\n[ \t]*SQL$/gm)].map((m) => m[1]);
  assert.ok(sqlBlocks.length > 0, "freshness workflow must embed its query as a quoted SQL heredoc");
  for (const sql of sqlBlocks) {
    assert.doesNotMatch(
      sql,
      /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE)\b/i,
      "freshness SQL must not mutate the database",
    );
  }
  assert.match(workflow, /house_price_ingest_runs[\s\S]*status\s*=\s*'error'/);
  assert.match(
    workflow,
    /FROM\s+house_price_ingest_runs\s+AS\s+r\s+JOIN\s+expected_fact_sources\s+AS\s+e\s+ON\s+e\.cursor_source\s*=\s*r\.source\s+WHERE\s+r\.status\s*=\s*'error'/i,
    "ingest errors must be limited to official fact-source cursors",
  );

  assert.match(
    workflow,
    /expected_fact_sources\s*\(\s*cursor_source\s*,\s*fact_source\s*,\s*fact_measure\s*\)/,
  );
  assert.match(
    workflow,
    /\('abs_derived_index'\s*,\s*'abs_derived'\s*,\s*'price_index_derived'\s*\)/,
  );
  assert.match(
    workflow,
    /\('abs_price_to_income'\s*,\s*'abs_derived'\s*,\s*'price_to_income'\s*\)/,
  );
  assert.match(workflow, /MAX\s*\(\s*period\s*\)[\s\S]*FROM\s+house_prices/i);
  assert.match(workflow, /GROUP\s+BY\s+source\s*,\s*measure/i);
  assert.match(
    workflow,
    /f\.source\s*=\s*e\.fact_source[\s\S]*f\.measure\s*=\s*e\.fact_measure/i,
  );
  assert.match(workflow, /last_period\s+IS\s+NOT\s+NULL/i);
  assert.match(workflow, /max_period\s+IS\s+NULL[\s\S]*max_period\s*<\s*r\.last_period/i);
  assert.doesNotMatch(workflow, /\('listings_(?:rea|domain)'\s*,/);

  assert.match(workflow, /MAX\s*\(\s*observed_at\s*\)[\s\S]*FROM\s+property_price_events/i);
  assert.match(workflow, /max_observed_at\s+IS\s+NULL/i);
  assert.match(workflow, /now\(\)\s*-\s*interval\s*'72 hours'/i);

  // The global max(observed_at) check cannot see a limping crawl: it stayed
  // green through the 2026-08-13 driver outage and green at a measured median
  // catalog staleness of 117h. These two checks are the ones that would have
  // gone red, so they are contract, not decoration.
  assert.match(
    workflow,
    /CATALOG_STALENESS[\s\S]*FROM\s+property_listings[\s\S]*HAVING\s+MAX\(last_seen_at\)\s*<\s*now\(\)\s*-\s*interval\s*'132 hours'/i,
    "the sentinel must check per-suburb catalog staleness, not just global event silence",
  );
  assert.match(
    workflow,
    /LIMIT\s+5\s*\)\s*AS\s+s/i,
    "a wholesale-stale catalog must be capped, not filed as a 500-row issue",
  );
  assert.match(
    workflow,
    /RIG_STATUS[\s\S]*FROM\s+crawl_run_status[\s\S]*status\s+IN\s*\(\s*'error'\s*,\s*'blocked'\s*\)[\s\S]*interval\s*'30 hours'/i,
    "the sentinel must check the rig's own run health, including a delta that never finished",
  );
  assert.match(
    workflow,
    /Thresholds:[^\n]*72h[^\n]*132h[^\n]*30h/i,
    "the step summary must state every threshold it enforces",
  );

  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(
    workflow,
    /query_error=.*query_error_file[\s\S]*cut\s+-c1-2000/,
    "psql stderr must be read and bounded before reporting",
  );
  assert.match(
    workflow,
    /CHECK_FAILURE[^\n]*read-only freshness query failed[^\n]*%s[^\n]*\\n'[\s\S]*"\$query_error"/,
    "the bounded psql diagnostic must be included in the failure report",
  );
  assert.match(workflow, /CRAWL_FRESHNESS_WEBHOOK:\s*\$\{\{\s*secrets\.CRAWL_FRESHNESS_WEBHOOK\s*\}\}/);
  assert.match(workflow, /if\s+\[\[\s+-n\s+"\$CRAWL_FRESHNESS_WEBHOOK"\s+\]\]/);
  assert.match(workflow, /curl[\s\S]*-X\s+POST/);
  assert.match(workflow, /exit\s+"\$check_rc"/);
});

test("terraform deploy workflow gates housing contracts on open pull requests", () => {
  assert.ok(deployWorkflow, "terraform-deploy.yml must exist");

  const jobStart = deployWorkflow.match(/^  housing-contract-tests:\s*$/m);
  assert.ok(jobStart, "housing-contract-tests job must exist");

  const remainingWorkflow = deployWorkflow.slice(jobStart.index);
  const nextJobOffset = remainingWorkflow.slice(jobStart[0].length).search(/^  [\w-]+:\s*$/m);
  const job =
    nextJobOffset === -1
      ? remainingWorkflow
      : remainingWorkflow.slice(0, jobStart[0].length + nextJobOffset);

  assert.match(
    job,
    /^    if: github\.event_name == 'pull_request' && github\.event\.action != 'closed'$/m,
  );
  assert.doesNotMatch(job, /^    needs:/m, "housing contract tests must be independent");
  assert.doesNotMatch(job, /\b(?:run-tests|build-docker-images|build-ko-images)\b/);

  assert.match(job, /uses: actions\/checkout@v5/);
  assert.match(job, /uses: actions\/setup-go@v6/);
  assert.match(job, /go-version: \$\{\{ env\.GO_VERSION \}\}/);
  assert.match(job, /cache-dependency-path:\s*\|\s*services\/go\.sum\s*services\/jobs\/go\.sum/);
  assert.match(
    job,
    /git config --global url\."https:\/\/x-access-token:\$\{\{ secrets\.STEALTH_PAT \}\}@github\.com\/skunkworq\/"\.insteadOf "https:\/\/github\.com\/skunkworq\/"/,
  );

  assert.match(job, /node --test \.github\/workflows\/housing-lifecycle\.test\.mjs/);
  assert.match(
    job,
    /working-directory:\s*services\s+run:\s*GOWORK=off GOPRIVATE='github\.com\/skunkworq\/\*' go test \.\/house-price-collector/,
  );
  assert.match(
    job,
    /working-directory:\s*services\/jobs\s+run:\s*GOWORK=off GOPRIVATE='github\.com\/skunkworq\/\*' go test \.\/internal\/jobs\/houseprices\/\.\.\./,
  );
  assert.match(job, /bash services\/house-price-collector\/deploy\/housing-lifecycle-exit\.test\.sh/);
  assert.match(
    job,
    /bash services\/house-price-collector\/deploy\/stage-rig\.test\.sh/,
    "the rig staging guards (drift + alerting readiness) must run somewhere in CI",
  );
  assert.doesNotMatch(job, /go test \.\/shorts\/internal\/services\/shorts/);
  assert.doesNotMatch(job, /make\s+(?:test-)?integration|test\/integration/);
});

test("terraform manages the official-source failure threshold in dev and prod", () => {
  const moduleMain = readContractFile(collectorModuleMainPath);
  const moduleVariables = readContractFile(collectorModuleVariablesPath);
  const devMain = readContractFile(devMainPath);
  const devVariables = readContractFile(devVariablesPath);
  const prodMain = readContractFile(prodMainPath);
  const prodVariables = readContractFile(prodVariablesPath);

  assert.match(moduleVariables, /variable\s+"official_max_failures"\s*\{/);
  assert.match(moduleVariables, /default\s*=\s*15/);
  assert.match(moduleVariables, /var\.official_max_failures\s*>=\s*0/);
  assert.match(
    moduleVariables,
    /floor\(var\.official_max_failures\)\s*==\s*var\.official_max_failures/,
  );
  assert.match(
    moduleMain,
    /name\s*=\s*"HOUSING_OFFICIAL_MAX_FAILURES"[\s\S]*?value\s*=\s*tostring\(var\.official_max_failures\)/,
  );

  for (const [environment, main, variables] of [
    ["dev", devMain, devVariables],
    ["prod", prodMain, prodVariables],
  ]) {
    assert.match(
      variables,
      /variable\s+"house_price_collector_official_max_failures"\s*\{/,
      `${environment} must expose the threshold`,
    );
    assert.match(
      variables,
      /floor\(var\.house_price_collector_official_max_failures\)\s*==\s*var\.house_price_collector_official_max_failures/,
      `${environment} must reject fractional thresholds that the Go env parser cannot read`,
    );
    assert.match(
      main,
      /official_max_failures\s*=\s*var\.house_price_collector_official_max_failures/,
      `${environment} must pass the threshold to the collector module`,
    );
  }
});
