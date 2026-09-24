import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const up = read("./000128_repoint_stripped_sal_links.up.sql");
const down = read("./000128_repoint_stripped_sal_links.down.sql");
const store = read("../house-price-collector/store.go");

const squash = (s) => s.replace(/\s+/g, " ");
const upSq = squash(up);
// Strip `--` comments before looking for statements.
const code = up.replace(/--[^\n]*/g, "");

// The behaviour itself (who moves, who is held, replay) is exercised against a
// real Postgres by house-price-collector/sal_repoint_migration_integration_test.go.

test("000128 is one transaction with the pooler's timeout disarmed in-session", () => {
  assert.match(up, /^BEGIN;$/m);
  assert.match(up, /^COMMIT;$/m);
  assert.match(up, /^SET LOCAL statement_timeout = 0;$/m);
  assert.match(up, /CREATE TEMP TABLE sal_relink ON COMMIT DROP AS/);
});

test("the target is linkStrippedSalSQL's pick, verbatim", () => {
  const link = store.match(/const linkStrippedSalSQL = `([\s\S]*?)`/)?.[1];
  assert.ok(link, "linkStrippedSalSQL must exist in store.go");
  const strip = squash(link).match(/upper\(trim\(regexp_replace\(d\.sal_name, '([^']+)', ''\)\)\)/)?.[1];
  assert.ok(strip, "store.go's stripping pattern");
  assert.ok(
    up.includes(`regexp_replace(d.sal_name, '${strip}', '')`),
    "000128 must strip the qualifier exactly as linkStrippedSalSQL does",
  );
  assert.match(squash(link), /ORDER BY u\.region_code, COALESCE\(d\.population, 0\) DESC, d\.sal_code \) pick/);
  assert.match(upSq, /SELECT DISTINCT ON \(k\.region_code\)/);
  assert.match(upSq, /ORDER BY k\.region_code, COALESCE\(d\.population, 0\) DESC, d\.sal_code \), mates AS/);
  assert.match(upSq, /ON d\.state_code = k\.state_code AND upper\(trim\(k\.region_name\)\)/, "same state only");
});

test("only stripped-pass links are candidates; an exact-name link is never re-pointed", () => {
  const linked = upSq.match(/WITH linked AS \((.*?)\), pick AS \(/)?.[1];
  assert.ok(linked, "linked CTE");
  assert.match(linked, /r\.region_type = 'suburb'/);
  assert.match(linked, /JOIN suburb_demographics d ON d\.sal_code = r\.sal_code AND d\.state_code = r\.state_code/);
  assert.match(linked, /upper\(trim\(r\.region_name\)\) <> upper\(trim\(d\.sal_name\)\)/);
  assert.match(
    linked,
    /AND NOT EXISTS \( SELECT 1 FROM suburb_demographics e WHERE e\.state_code = r\.state_code AND upper\(trim\(e\.sal_name\)\) = upper\(trim\(r\.region_name\)\)\)/,
  );
});

test("a link moves only on postcode evidence or a decisive population gap", () => {
  assert.match(upSq, /WHERE p\.new_sal <> k\.old_sal AND p\.new_pop > k\.old_pop/);
  // Evidence = councils of other same-postcode regions whose OWN link is exact.
  const mates = upSq.match(/mates AS \((.*?)\), scored AS \(/)?.[1] ?? "";
  assert.match(mates, /o\.postcode = k\.postcode/);
  assert.match(mates, /o\.region_code <> k\.region_code/);
  assert.match(mates, /upper\(trim\(od\.sal_name\)\) = upper\(trim\(o\.region_name\)\)/);
  assert.match(
    upSq,
    /WHERE new_votes > old_votes OR \(old_votes = 0 AND new_votes = 0 AND new_pop >= 2 \* old_pop\)/,
  );
});

test("every write is keyed on the old link, so a replay cannot apply twice", () => {
  const updates = code.match(/UPDATE [\s\S]*?;/g) ?? [];
  assert.deepEqual(
    updates.map((u) => u.match(/^UPDATE (\w+)/)[1]),
    ["house_price_regions", "property_listings", "property_price_events", "housing_drop_index_daily"],
  );
  assert.match(updates[0], /r\.sal_code = x\.old_sal/);
  assert.match(updates[1], /pl\.region_code = x\.region_code\s+AND pl\.sal_code = x\.old_sal/);
  assert.match(updates[2], /e\.sal_code = x\.old_sal/);
  assert.match(updates[3], /i\.grain = 'suburb'\s+AND i\.grain_key = x\.old_sal/);
  // The index is re-keyed only when it is unambiguous and cannot collide.
  assert.match(updates[3], /NOT EXISTS \(SELECT 1 FROM house_price_regions r WHERE r\.sal_code = x\.old_sal\)/);
  assert.match(updates[3], /t\.grain_key = x\.new_sal/);
  assert.doesNotMatch(
    code.replace("ON COMMIT DROP", ""),
    /\b(DELETE|INSERT|DROP|ALTER|TRUNCATE)\b/i,
    "a data repair touches nothing else",
  );
});

test("down is an explicit no-op", () => {
  assert.doesNotMatch(down.replace(/--[^\n]*/g, ""), /\b(UPDATE|DELETE|INSERT)\b/i);
  assert.match(down, /no-op/);
});
