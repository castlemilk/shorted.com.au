import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "./000073_stock_price_coverage_and_news_image_index.up.sql",
    import.meta.url,
  ),
  "utf8",
);

const alertMonitorsMigration = readFileSync(
  new URL("./000074_add_alert_monitors.up.sql", import.meta.url),
  "utf8",
);

const industryIntelligenceMigration = readFileSync(
  new URL(
    "./000075_add_industry_intelligence_sources.up.sql",
    import.meta.url,
  ),
  "utf8",
);

test("stock price coverage migration materializes per-symbol price coverage", () => {
  assert.match(
    migration,
    /CREATE MATERIALIZED VIEW IF NOT EXISTS mv_stock_price_coverage/i,
  );
  assert.match(migration, /GROUP BY stock_code/i);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_stock_price_coverage_stock_code/i,
  );
  assert.match(migration, /latest_date/i);
});

test("stock price coverage migration exposes a targeted concurrent refresh function", () => {
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION refresh_stock_price_coverage\(\)/i,
  );
  assert.match(
    migration,
    /REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stock_price_coverage/i,
  );
});

test("news image migration adds a covering partial index for missing image backfills", () => {
  assert.match(migration, /idx_news_articles_missing_image_covering/i);
  assert.match(migration, /INCLUDE \(id, url, source\)/i);
  assert.match(migration, /WHERE image_url IS NULL/i);
});

test("alert monitors migration adds constrained postgres storage", () => {
  assert.match(
    alertMonitorsMigration,
    /CREATE TABLE IF NOT EXISTS alert_monitors/i,
  );
  assert.match(alertMonitorsMigration, /alert_monitors_scope_check/i);
  assert.match(alertMonitorsMigration, /alert_monitors_condition_check/i);
  assert.match(alertMonitorsMigration, /alert_monitors_threshold_check/i);
  assert.match(alertMonitorsMigration, /timestamptz NOT NULL DEFAULT now\(\)/i);
});

test("alert monitors migration indexes user listing and active duplicate prevention", () => {
  assert.match(alertMonitorsMigration, /idx_alert_monitors_user_created/i);
  assert.match(
    alertMonitorsMigration,
    /idx_alert_monitors_user_status_created/i,
  );
  assert.match(alertMonitorsMigration, /idx_alert_monitors_user_scope_target/i);
  assert.match(alertMonitorsMigration, /idx_alert_monitors_active_unique/i);
  assert.match(alertMonitorsMigration, /WHERE status = 'active'/i);
});

test("industry intelligence migration creates source registry and collection facts", () => {
  assert.match(
    industryIntelligenceMigration,
    /CREATE TABLE IF NOT EXISTS industry_intelligence_sources/i,
  );
  assert.match(
    industryIntelligenceMigration,
    /CREATE TABLE IF NOT EXISTS industry_intelligence_collection_runs/i,
  );
  assert.match(
    industryIntelligenceMigration,
    /CREATE TABLE IF NOT EXISTS industry_intelligence_records/i,
  );
  assert.match(
    industryIntelligenceMigration,
    /CREATE TABLE IF NOT EXISTS industry_intelligence_industry_sources/i,
  );
  assert.match(industryIntelligenceMigration, /public_enabled/i);
  assert.match(industryIntelligenceMigration, /exact_entity_required/i);
});

test("industry intelligence migration adds query-focused indexes", () => {
  assert.match(
    industryIntelligenceMigration,
    /idx_industry_intelligence_records_industry_kind_asof/i,
  );
  assert.match(
    industryIntelligenceMigration,
    /idx_industry_intelligence_records_source_record/i,
  );
  assert.match(
    industryIntelligenceMigration,
    /idx_industry_intelligence_runs_source_started/i,
  );
  assert.match(
    industryIntelligenceMigration,
    /USING GIN \(metadata jsonb_path_ops\)/i,
  );
});

test("industry intelligence migration seeds official public data sources", () => {
  for (const source of [
    "asic-short-interest",
    "ato-corporate-tax-transparency",
    "abs-international-trade-goods",
    "abs-input-output-tables",
    "austender-contract-notices",
    "grantconnect-awards",
    "aec-transparency-register",
    "agd-register-lobbyists",
    "agd-fits-register",
    "cer-nger-corporate-emissions",
  ]) {
    assert.match(industryIntelligenceMigration, new RegExp(source, "i"));
  }
});
