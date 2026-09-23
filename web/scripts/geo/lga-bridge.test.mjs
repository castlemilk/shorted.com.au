// Guards the COMMITTED council artifacts that join-lga-mb.py writes and
// `house-price-collector -mode lga` loads. The named suburbs are the ones the
// old centroid-in-polygon join put in the wrong council (or in none); each
// expectation is ABS's own mesh-block allocation, population-weighted.
//
//   node --test web/scripts/geo/lga-bridge.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const insights = path.join(import.meta.dirname, "../../public/geo/insights");
const bridge = JSON.parse(fs.readFileSync(path.join(insights, "suburb-lga.json"), "utf8"));
const facts = JSON.parse(fs.readFileSync(path.join(insights, "lga-facts.json"), "utf8"));

test("suburbs the centroid join misplaced now sit in their ABS council", () => {
  const expected = {
    10589: ["11250", "Broken Hill"], // was Unincorporated NSW
    11239: ["12730", "Edward River"], // Deniliquin, was Murray River
    22582: ["27260", "Wyndham"], // Truganina, was Melton
    20779: ["27070", "Whittlesea"], // Doreen, was Nillumbik
    20496: ["27350", "Yarra"], // Carlton North, was Melbourne
    50245: ["53780", "Gosnells"], // Canning Vale, was Canning
    12166: ["11570", "Canterbury-Bankstown"], // Kingsgrove, was unbridged
    12462: ["16550", "Randwick"], // Malabar, was unbridged
  };
  for (const [sal, [code, name]] of Object.entries(expected)) {
    assert.equal(bridge[sal]?.lga, code, `SAL ${sal} should be in ${name}`);
    assert.equal(facts[code].name, name);
  }
});

test("a straddling suburb keeps every council it spans", () => {
  // Kingsgrove splits three ways; the dominant council is listed first.
  const k = bridge["12166"];
  assert.ok(k.share < 0.95);
  assert.deepEqual(k.overlaps.map((o) => o.lga), ["11570", "12930", "10500"]);
});

test("every bridge entry is well formed", () => {
  const sals = Object.keys(bridge);
  assert.ok(sals.length > 15000, `only ${sals.length} suburbs bridged`);
  assert.deepEqual(sals, [...sals].sort(), "keys are sorted so the artifact diffs cleanly");
  for (const [sal, e] of Object.entries(bridge)) {
    assert.ok(facts[e.lga], `${sal} points at unknown council ${e.lga}`);
    assert.notEqual(facts[e.lga].kind, "pseudo", `${sal} is bridged to a pseudo-area`);
    assert.ok(e.share > 0 && e.share <= 1, `${sal} share ${e.share}`);
    if (!e.overlaps) continue;
    assert.ok(e.overlaps.length > 1, `${sal} lists a single overlap; it should be omitted`);
    assert.deepEqual(e.overlaps[0], { lga: e.lga, share: e.share }, `${sal} dominant must lead`);
    const total = e.overlaps.reduce((acc, o) => acc + o.share, 0);
    assert.ok(total > 0.95 && total <= 1.0001, `${sal} overlap shares sum to ${total}`);
    for (let i = 1; i < e.overlaps.length; i++) {
      assert.ok(e.overlaps[i].share >= 0.01, `${sal} keeps a sub-1% overlap`);
      assert.ok(e.overlaps[i - 1].share >= e.overlaps[i].share, `${sal} overlaps not sorted`);
    }
  }
});

test("council facts carry identity: kind, display name, state code", () => {
  const byKind = { council: 0, unincorporated: 0, pseudo: 0 };
  for (const [code, f] of Object.entries(facts)) {
    byKind[f.kind] += 1;
    assert.doesNotMatch(f.displayName, /\((NSW|Vic\.|Qld|SA|WA|Tas\.|NT|ACT|OT)\)$/, code);
    if (code === "ZZZZZ") assert.equal(f.stateCode, "", "Outside Australia has no state");
    else assert.match(f.stateCode, /^(NSW|VIC|QLD|SA|WA|TAS|NT|ACT|OT)$/, `${code} ${f.name}`);
    if (f.kind === "pseudo") {
      assert.equal(f.areaSqkm, null);
      assert.equal(f.dwellings, null);
    } else {
      assert.ok(f.areaSqkm > 0, `${code} area`);
      assert.ok(f.centroidLat < -9 && f.centroidLat > -55, `${code} centroid lat ${f.centroidLat}`);
      assert.ok(f.centroidLon > 72 && f.centroidLon < 168, `${code} centroid lon ${f.centroidLon}`);
    }
  }
  assert.deepEqual(byKind, { council: 541, unincorporated: 6, pseudo: 19 });
  assert.equal(facts["51710"].stateCode, "OT"); // Christmas Island
  // The same display name in two states is fine: slugs are unique per state.
  assert.equal(facts["11500"].displayName, "Campbelltown");
  assert.equal(facts["40910"].displayName, "Campbelltown");
});
