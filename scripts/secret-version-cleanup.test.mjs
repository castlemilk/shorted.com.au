// Regression tests for scripts/secret-version-cleanup.sh
//
// Run: node --test scripts/secret-version-cleanup.test.mjs
//
// These pin the four structural guards that would have prevented the
// 2026-07-26 INTERNAL_SERVICE_SECRET outage:
//   1. numeric (not lexicographic) ordering across the 999 -> 1000 boundary
//   2. the numerically-highest version is never selected
//   3. versions pinned by live Cloud Run services/jobs are never selected
//   4. KEEP_COUNT newest enabled versions are kept

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "secret-version-cleanup.sh",
);

/** @param {Array<[number|string, string, string?]>} rows */
function tsv(rows) {
  return rows.map((r) => [r[0], r[1], r[2] ?? ""].join("\t")).join("\n") + "\n";
}

function run(args, stdin) {
  const out = execFileSync("bash", [SCRIPT, ...args], {
    input: stdin,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

function selectDisable(rows, { keep = 2, inUse = "" } = {}) {
  const args = ["select-disable", "--keep", String(keep)];
  if (inUse) args.push("--in-use", inUse);
  return run(args, tsv(rows));
}

function selectDestroy(
  rows,
  { cutoff, inUse = "", cap = 200, minVersion, maxVersion } = {},
) {
  const args = ["select-destroy", "--cutoff", cutoff, "--cap", String(cap)];
  if (inUse) args.push("--in-use", inUse);
  if (minVersion !== undefined) args.push("--min-version", String(minVersion));
  if (maxVersion !== undefined) args.push("--max-version", String(maxVersion));
  return run(args, tsv(rows));
}

const enabled = (n) => [n, "ENABLED", "2026-01-01T00:00:00Z"];
const disabled = (n, t = "2026-01-01T00:00:00Z") => [n, "DISABLED", t];

test("numeric ordering: 1000+ versions do not sort lexicographically", () => {
  // The exact incident shape: lexicographic "~name" made 999 the "newest",
  // so 1000/1001/1002 were disabled. Numeric ordering must keep 1002 + 1001.
  const rows = [998, 999, 1000, 1001, 1002].map(enabled);
  const got = selectDisable(rows, { keep: 2 });
  assert.deepEqual(got.sort(), ["998", "999", "1000"].sort());
  assert.ok(!got.includes("1002"), "must never disable the numeric latest");
  assert.ok(!got.includes("1001"), "1001 is the 2nd-newest and must be kept");
});

test("the numeric latest is never selected, even when keep-count is 0", () => {
  const rows = [1, 2, 3].map(enabled);
  const got = selectDisable(rows, { keep: 0 });
  assert.deepEqual(got.sort(), ["1", "2"].sort());
  assert.ok(!got.includes("3"));
});

test("the numeric latest is protected even when it is disabled", () => {
  // A disabled latest is already broken; do not compound it, and do not treat
  // an older enabled version as if it were the latest.
  const rows = [enabled(10), enabled(11), enabled(12), disabled(13)];
  const got = selectDisable(rows, { keep: 1 });
  assert.deepEqual(got.sort(), ["10", "11"].sort());
  assert.ok(!got.includes("13"));
  assert.ok(!got.includes("12"), "12 is the newest enabled and is kept by keep=1");
});

test("in-use versions pinned by Cloud Run are excluded", () => {
  const rows = [10, 11, 12, 13, 14, 15].map(enabled);
  // enabled desc: 15(latest), 14 kept by keep=2; candidates 13,12,11,10;
  // 10 and 12 are pinned by a live service -> only 13 and 11 remain.
  const got = selectDisable(rows, { keep: 2, inUse: "10,12" });
  assert.deepEqual(got.sort(), ["11", "13"].sort());
  assert.ok(!got.includes("10"));
  assert.ok(!got.includes("12"));
  assert.ok(!got.includes("15"), "numeric latest");
});

test("in-use matching is exact, not substring", () => {
  const rows = [1, 2, 100, 101, 102].map(enabled);
  // "10" must not protect "100"/"101"; "1" must not protect "100".
  const got = selectDisable(rows, { keep: 1, inUse: "10,1" });
  assert.deepEqual(got.sort(), ["2", "100", "101"].sort());
});

test("keep-count keeps the N newest ENABLED versions (disabled ones do not count)", () => {
  const rows = [enabled(1), enabled(2), enabled(3), disabled(4), disabled(5), enabled(6)];
  const got = selectDisable(rows, { keep: 2 });
  // enabled desc: 6(latest, protected), 3, 2, 1 -> keep 6 and 3, disable 2 and 1
  assert.deepEqual(got.sort(), ["1", "2"].sort());
});

test("no candidates when everything is already kept", () => {
  assert.deepEqual(selectDisable([1, 2].map(enabled), { keep: 2 }), []);
  assert.deepEqual(selectDisable([], { keep: 2 }), []);
});

test("destroy: only disabled, old, not-latest, not-in-use versions", () => {
  const rows = [
    disabled(1, "2020-01-01T00:00:00Z"), // old + disabled -> destroy
    disabled(2, "2020-01-01T00:00:00Z"), // old + disabled but in use -> keep
    disabled(3, "2026-07-01T00:00:00Z"), // too young -> keep
    enabled(4), // enabled -> keep
    disabled(5, "2020-01-01T00:00:00Z"), // numeric latest -> keep
  ];
  const got = selectDestroy(rows, {
    cutoff: "2026-04-27T00:00:00Z",
    inUse: "2",
  });
  assert.deepEqual(got, ["1"]);
});

test("destroy: unparseable creation time is never destroyed", () => {
  const rows = [disabled(1, ""), disabled(2, "unknown"), enabled(9)];
  const got = selectDestroy(rows, { cutoff: "2026-04-27T00:00:00Z" });
  assert.deepEqual(got, []);
});

test("destroy: per-secret cap bounds blast radius and destroys oldest first", () => {
  const rows = [
    disabled(1, "2020-01-01T00:00:00Z"),
    disabled(2, "2020-02-01T00:00:00Z"),
    disabled(3, "2020-03-01T00:00:00Z"),
    disabled(4, "2020-04-01T00:00:00Z"),
    enabled(99),
  ];
  const got = selectDestroy(rows, { cutoff: "2026-04-27T00:00:00Z", cap: 2 });
  assert.deepEqual(got, ["1", "2"]);
});

test("destroy: numeric ordering holds across the 999 -> 1000 boundary too", () => {
  const rows = [
    disabled(999, "2020-01-01T00:00:00Z"),
    disabled(1000, "2020-01-01T00:00:00Z"),
    disabled(1002, "2020-01-01T00:00:00Z"),
  ];
  const got = selectDestroy(rows, { cutoff: "2026-04-27T00:00:00Z" });
  assert.deepEqual(got, ["999", "1000"]);
  assert.ok(!got.includes("1002"), "1002 is the numeric latest");
});

test("destroy: an exact numeric version range bounds the candidate set", () => {
  const rows = [444, 445, 446, 574, 575].map((version) =>
    disabled(version, "2020-01-01T00:00:00Z"),
  );
  rows.push(enabled(999));

  const got = selectDestroy(rows, {
    cutoff: "2026-04-27T00:00:00Z",
    minVersion: 445,
    maxVersion: 574,
  });

  assert.deepEqual(got, ["445", "446", "574"]);
});
