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

test("housing freshness workflow enforces the read-only production sentinel contract", () => {
  assert.ok(workflow, "housing-freshness.yml must exist");

  assert.match(workflow, /on:\s*\n\s+schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(workflow, /DATABASE_URL:\s*\$\{\{\s*secrets\.DATABASE_URL_PROD\s*\}\}/);

  assert.match(workflow, /default_transaction_read_only=on/);
  assert.match(workflow, /--set=ON_ERROR_STOP=1/);
  assert.match(workflow, /\bWITH\b[\s\S]*\bSELECT\b/);
  assert.doesNotMatch(
    workflow,
    /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE)\b/i,
    "freshness SQL must not mutate the database",
  );
  assert.match(workflow, /house_price_ingest_runs[\s\S]*status\s*=\s*'error'/);

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
  assert.match(workflow, /Default event silence threshold[^\n]*72 hours/i);

  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
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
  assert.match(job, /cache-dependency-path: services\/go\.sum/);
  assert.match(
    job,
    /git config --global url\."https:\/\/x-access-token:\$\{\{ secrets\.STEALTH_PAT \}\}@github\.com\/skunkworq\/"\.insteadOf "https:\/\/github\.com\/skunkworq\/"/,
  );

  assert.match(job, /node --test \.github\/workflows\/housing-lifecycle\.test\.mjs/);
  assert.match(job, /working-directory: services/);
  assert.match(
    job,
    /GOWORK=off GOPRIVATE='github\.com\/skunkworq\/\*' go test \.\/shorts\/internal\/services\/shorts/,
  );
  assert.doesNotMatch(job, /make\s+(?:test-)?integration|test\/integration/);
});
