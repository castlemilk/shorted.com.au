import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const prodMain = readFileSync(
  new URL("../../terraform/environments/prod/main.tf", import.meta.url),
  "utf8",
);

test("production owns the replacement logo and financial-report buckets before cutover", () => {
  assert.match(prodMain, /company_logos\s*=\s*"shorted-company-logos-prod"/);
  assert.match(
    prodMain,
    /financial_reports\s*=\s*"shorted-financial-reports-prod"/,
  );
  assert.match(
    prodMain,
    /resource\s+"google_storage_bucket"\s+"shared_assets"/,
  );
  assert.match(prodMain, /for_each\s*=\s*local\.shared_asset_buckets/);
  assert.match(prodMain, /force_destroy\s*=\s*false/);
  assert.match(prodMain, /uniform_bucket_level_access\s*=\s*true/);
  assert.match(prodMain, /"storage\.googleapis\.com"/);
});

test("replacement buckets preserve public reads and grant only their producer write access", () => {
  assert.match(
    prodMain,
    /resource\s+"google_storage_bucket_iam_member"\s+"shared_assets_public_reader"/,
  );
  assert.match(prodMain, /member\s*=\s*"allUsers"/);
  assert.match(
    prodMain,
    /resource\s+"google_storage_bucket_iam_member"\s+"company_logos_writer"/,
  );
  assert.match(
    prodMain,
    /member\s*=\s*"serviceAccount:\${module\.enrichment_processor\.service_account_email}"/,
  );
  assert.match(
    prodMain,
    /resource\s+"google_storage_bucket_iam_member"\s+"financial_reports_writer"/,
  );
  assert.match(
    prodMain,
    /member\s*=\s*"serviceAccount:\${module\.report_extractor\.service_account_email}"/,
  );
});
