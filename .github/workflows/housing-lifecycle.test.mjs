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

  // The read-only guard is the transaction itself. It used to be
  // PGOPTIONS="-c default_transaction_read_only=on", which Supabase's pooler
  // drops, so the session read back `off` (measured 2026-09-23). A guard must
  // live in the SQL: BEGIN READ ONLY, SET LOCAL, and a check that raises
  // before the query runs.
  assert.doesNotMatch(workflow, /PGOPTIONS\s*[:=]\s*["']?-c/, "PGOPTIONS is dropped by the pooler; it guards nothing");
  assert.match(workflow, /--set=ON_ERROR_STOP=1/);
  assert.match(workflow, /\bWITH\b[\s\S]*\bSELECT\b/);
  const guardedSql = workflow.match(/<<'SQL'\n([\s\S]*?)\n[ \t]*SQL$/m)?.[1] ?? "";
  assert.match(
    guardedSql,
    /^\s*BEGIN READ ONLY;\s*\n\s*SET LOCAL statement_timeout = '60s';\s*\n\s*DO \$guard\$[\s\S]*?current_setting\('transaction_read_only'\) <> 'on'[\s\S]*?RAISE EXCEPTION[\s\S]*?\$guard\$;\s*\n\s*WITH /,
    "the query must open with BEGIN READ ONLY, SET LOCAL statement_timeout and a raising guard, in that order",
  );
  assert.match(guardedSql, /ROLLBACK;\s*$/, "the transaction must be closed without keeping anything");
  assert.doesNotMatch(guardedSql, /^\s*(COMMIT|END)\s*;/m, "nothing may end the read-only transaction early");

  // The sentinel is the alarm for a dead rig, so it must not run on the rig.
  // The self-hosted Cuttlefish runners are containers on the rig laptop; when
  // the rig went down they went down too and the sentinel never ran
  // (2026-09-21/22 cancelled in the queue).
  const freshnessJob = workflow.slice(workflow.indexOf("\n  freshness:\n"));
  assert.match(freshnessJob, /^ {4}runs-on:\s*ubuntu-latest\s*$/m, "the sentinel must run on a GitHub-hosted runner");
  assert.doesNotMatch(freshnessJob, /runs-on:.*self-hosted/, "the sentinel must not share the rig's failure domain");
  assert.match(freshnessJob, /docker run --rm -i postgres:15-alpine/, "psql comes from a pinned image, not the runner's");

  // MV refresh age. housing_mv_refresh (000124) may not exist yet, and a query
  // that names a missing table fails at parse time and takes every other check
  // with it, so it is read dynamically, and absence falls back to the newest
  // event (the collector refreshes after every crawl write).
  assert.match(
    workflow,
    /mv_refresh\s+AS\s*\([\s\S]*?to_regclass\('public\.housing_mv_refresh'\)\s+IS\s+NULL\s+THEN\s+ARRAY\[\]::xml\[\][\s\S]*?query_to_xml\(\s*'SELECT mv_name, refreshed_at FROM public\.housing_mv_refresh'/,
    "housing_mv_refresh must be read only when to_regclass finds it",
  );
  assert.doesNotMatch(
    guardedSql.replace(/'[^']*'/g, "''"),
    /\bFROM\s+housing_mv_refresh\b/i,
    "a static reference to housing_mv_refresh would fail the whole query where 000124 is not applied",
  );
  assert.match(
    workflow,
    /'MV_REFRESH_AGE'[\s\S]*?FROM\s+mv_refresh\s+AS\s+m\s+WHERE\s+m\.refreshed_at\s*<\s*now\(\)\s*-\s*interval\s*'72 hours'/i,
    "a view not refreshed within 72h must be reported",
  );
  assert.match(
    workflow,
    /'MV_REFRESH_AGE'\s*,\s*'property_price_events \(fallback\)'[\s\S]*?FROM\s+event_maximum\s+AS\s+e\s+WHERE\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+mv_refresh\s*\)[\s\S]*?max_observed_at\s*<\s*now\(\)\s*-\s*interval\s*'72 hours'/i,
    "without housing_mv_refresh, MV age must fall back to max(observed_at)",
  );
  // The INFO row is split off before a report decides pass/fail.
  assert.match(workflow, /grep \$'\^INFO\\t' "\$raw_file" >"\$info_file"/);
  assert.match(workflow, /grep -v \$'\^INFO\\t' "\$raw_file" >"\$report_file"/);

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
    /stale_suburbs\s+AS\s*\([\s\S]*FROM\s+property_listings[\s\S]*HAVING\s+MAX\(last_seen_at\)\s*<\s*now\(\)\s*-\s*interval\s*'132 hours'[\s\S]*'CATALOG_STALENESS'/i,
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

  // A HEALTHY fortnightly full pass takes over a day, and the daily delta
  // cleanly SKIPS on the single-drainer lock while it runs — without upserting.
  // So delta.finished_at legitimately ages past 30h twice a month, and the
  // unsuppressed check filed a false issue every time. Suppress the delta-age
  // alarm only while the SAME HOST's full row is itself fresh (i.e. the rig is
  // demonstrably alive and mid-pass); if the full pass dies, its row goes stale
  // and the delta alarm comes back on its own.
  assert.match(
    workflow,
    /NOT\s+EXISTS\s*\([\s\S]*?FROM\s+crawl_run_status\s+AS\s+f[\s\S]*?f\.host\s*=\s*c\.host[\s\S]*?f\.run_type\s*=\s*'full'[\s\S]*?f\.finished_at\s*>\s*now\(\)\s*-\s*interval\s*'30 hours'/i,
    "an in-flight full pass on the same host must suppress the delta-age alarm",
  );
  assert.match(
    workflow,
    /--[^\n]*single-drainer lock/i,
    "the suppression bound must be justified in a SQL comment",
  );

  // LIMIT 5 without a total made a 200-suburb outage read as a 5-suburb one.
  assert.match(
    workflow,
    /stale_suburb_total\s+AS\s*\(\s*SELECT\s+COUNT\(\*\)\s+AS\s+stale_total\s+FROM\s+stale_suburbs\s*\)[\s\S]*'CATALOG_STALENESS'\s*,\s*\n\s*'TOTAL'\s*,[\s\S]*stale_total[\s\S]*FROM\s+stale_suburb_total/i,
    "the capped worst-5 list must be accompanied by the true stale-suburb total",
  );
  assert.match(
    workflow,
    /Thresholds:[^\n]*72h[^\n]*MV refresh age \*\*72h\*\*[^\n]*132h[^\n]*30h/i,
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
  // setup-go's cache save hangs on the self-hosted runners; the module and
  // build caches persist on the runner's disk instead.
  assert.match(job, /^\s+cache: false$/m);
  assert.doesNotMatch(job, /cache-dependency-path:/);
  assert.match(
    job,
    /git config --global url\."https:\/\/x-access-token:\$\{\{ secrets\.STEALTH_PAT \}\}@github\.com\/skunkworq\/"\.insteadOf "https:\/\/github\.com\/skunkworq\/"/,
  );

  assert.match(job, /node --test \.github\/workflows\/housing-lifecycle\.test\.mjs/);
  assert.match(
    job,
    /working-directory:\s*services\s+run:\s*GOWORK=off GOPRIVATE='github\.com\/skunkworq\/\*' go test \.\/house-price-collector/,
  );
  // The services/jobs houseprices mirror was retired (nothing scheduled it; the
  // rig and the Cloud Run job both run house-price-collector). A test step for
  // it would point at a package that no longer exists.
  assert.doesNotMatch(job, /internal\/jobs\/houseprices/);
  assert.match(job, /bash services\/house-price-collector\/deploy\/housing-lifecycle-exit\.test\.sh/);
  assert.match(
    job,
    /bash services\/house-price-collector\/deploy\/stage-rig\.test\.sh/,
    "the rig staging guards (drift + alerting readiness) must run somewhere in CI",
  );
  assert.doesNotMatch(job, /go test \.\/shorts\/internal\/services\/shorts/);
  assert.doesNotMatch(job, /make\s+(?:test-)?integration|test\/integration/);
});

test("terraform manages the production official-source failure threshold", () => {
  const moduleMain = readContractFile(collectorModuleMainPath);
  const moduleVariables = readContractFile(collectorModuleVariablesPath);
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
