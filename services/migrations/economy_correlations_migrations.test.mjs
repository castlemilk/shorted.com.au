import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function migration(name) {
  try {
    return await readFile(new URL(name, import.meta.url), "utf8");
  } catch {
    return "";
  }
}

test("000093 creates the economic correlations matrix and portable abs-r index", async () => {
  const up = await migration("./000093_add_economic_correlations.up.sql");
  const down = await migration("./000093_add_economic_correlations.down.sql");

  assert.match(up, /CREATE TABLE economic_correlations/i);
  for (const column of [
    "base_series_key",
    "overlay_series_key",
    "window_months",
    "r",
    "n",
    "last_period",
    "computed_at",
  ]) {
    assert.match(up, new RegExp(`\\b${column}\\b`, "i"));
  }
  assert.match(
    up,
    /PRIMARY KEY\s*\(\s*base_series_key\s*,\s*overlay_series_key\s*,\s*window_months\s*\)/i,
  );
  assert.match(
    up,
    /abs_r\s+DOUBLE PRECISION\s+GENERATED ALWAYS AS\s*\(\s*abs\(r\)\s*\)\s+STORED/i,
  );
  assert.match(
    up,
    /ON economic_correlations\s*\(\s*base_series_key\s*,\s*window_months\s*,\s*abs_r\s+DESC\s*\)/i,
  );
  assert.match(down, /DROP TABLE IF EXISTS economic_correlations/i);
});

test("000094 adds refresh time while preserving the exposure MV unique/index contract", async () => {
  const up = await migration("./000094_add_exposure_mv_refreshed_at.up.sql");
  const down = await migration("./000094_add_exposure_mv_refreshed_at.down.sql");

  for (const sql of [up, down]) {
    assert.match(sql, /CREATE MATERIALIZED VIEW mv_company_state_exposure AS/i);
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_company_state_exposure_stock_region\s+ON mv_company_state_exposure\s*\(\s*stock_code\s*,\s*region\s*\)/i,
    );
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS idx_mv_company_state_exposure_region_weight\s+ON mv_company_state_exposure\s*\(\s*region\s*,\s*weight DESC\s*\)/i,
    );
    for (const selectedColumn of [
      "c.stock_code",
      "c.region",
      "c.weight",
      "c.basis",
      "c.source",
      "cm.company_name",
      "cm.industry",
      "cm.logo_icon_gcs_url",
      "rs.current_percent AS short_percent",
    ]) {
      assert.match(sql, new RegExp(selectedColumn.replaceAll(".", "\\."), "i"));
    }
  }
  assert.match(up, /now\(\)\s+AS refreshed_at/i);
  assert.doesNotMatch(down, /\brefreshed_at\b/i);
});
