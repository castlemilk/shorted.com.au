import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

const prodMain = read("terraform/environments/prod/main.tf");

test("production jobs and services explicitly use production-owned buckets", () => {
  assert.match(
    prodMain,
    /module "enrichment_processor"[\s\S]*?logo_bucket\s*=\s*local\.shared_asset_buckets\.company_logos/,
  );
  assert.match(
    prodMain,
    /module "report_extractor"[\s\S]*?reports_bucket\s*=\s*local\.shared_asset_buckets\.financial_reports/,
  );

  const enrichmentVariables = read(
    "terraform/modules/enrichment-processor/variables.tf",
  );
  const enrichmentMain = read("terraform/modules/enrichment-processor/main.tf");
  assert.match(enrichmentVariables, /variable "logo_bucket"/);
  assert.match(enrichmentMain, /name\s*=\s*"GCS_LOGO_BUCKET"\s+value\s*=\s*var\.logo_bucket/);
});

test("deployed application defaults use production-owned buckets", () => {
  const expectations = new Map([
    ["services/report-sync/main.go", "shorted-financial-reports-prod"],
    ["services/report-extractor/extract.py", "shorted-financial-reports-prod"],
    [
      "services/jobs/internal/jobs/reports/sync.go",
      "shorted-financial-reports-prod",
    ],
    [
      "services/jobs/internal/jobs/reportextract/gcs.go",
      "shorted-financial-reports-prod",
    ],
    ["web/src/@/lib/logo.ts", "shorted-company-logos-prod"],
    ["web/src/app/api/admin/regen-hero/route.ts", "shorted-company-logos-prod"],
    [
      "web/src/app/actions/company-logo-availability.ts",
      "shorted-company-logos-prod",
    ],
  ]);

  for (const [path, productionBucket] of expectations) {
    assert.match(read(path), new RegExp(`\\b${productionBucket}\\b`), path);
  }
});

test("database migration rewrites every persisted dev-bucket URL surface", () => {
  const migration = read(
    "docs/operations/sql/retire-dev-bucket-urls.up.sql",
  );

  for (const table of [
    '"company-metadata"',
    "financial_report_files",
    "financial_report_extractions",
  ]) {
    assert.match(migration, new RegExp(`UPDATE ${table}`), table);
  }

  for (const column of [
    "logo_gcs_url",
    "logo_icon_gcs_url",
    "logo_svg_gcs_url",
    "key_people",
    "financial_reports",
    "gcs_url",
    "gcs_bucket",
    "raw_text_gcs_url",
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`), column);
  }

  assert.match(migration, /shorted-company-logos-prod/);
  assert.match(migration, /shorted-financial-reports-prod/);
});

test("active automation and runtime configuration cannot target the retired dev project", () => {
  const costGuardian = read(".github/workflows/cost-guardian.yml");
  assert.doesNotMatch(costGuardian, /shorted-dev-aba5688f/);
  assert.doesNotMatch(costGuardian, /cleanup-orphaned-previews/);
  assert.match(costGuardian, /rosy-clover-477102-t5/);

  const firebaseConfig = read("web/.firebaserc");
  assert.doesNotMatch(firebaseConfig, /shorted-dev-aba5688f/);
  assert.doesNotMatch(firebaseConfig, /"default"/);
  assert.match(firebaseConfig, /"production": "rosy-clover-477102-t5"/);

  const stockIngestion = read(
    "services/stock-price-ingestion/cloud_run_service.py",
  );
  assert.doesNotMatch(stockIngestion, /shorted-dev/);
  assert.match(stockIngestion, /os\.environ\.get\('GCP_PROJECT', ''\)/);

  const makefile = read("Makefile");
  assert.doesNotMatch(makefile, /^validate-secrets-dev:/m);

  const servicesMakefile = read("services/Makefile");
  assert.doesNotMatch(servicesMakefile, /postgresql:\/\//);
  assert.match(servicesMakefile, /^require\.database-url:/m);
});
