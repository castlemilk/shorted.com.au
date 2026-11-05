// The PR-11 cutover check: the diff classifies every difference the cutover
// allows, and fails on every other one. The network calls are not exercised.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  diff,
  fundamentalsDigest,
  stableStringify,
  summarisePicks,
} from "../strategies/snapshot-cutover-check.mjs";

const ids = ["zanger-breakout", "canslim", "minervini-trend-template", "crowded-short-breakout", "quality-compounders"];

function strategy(overrides = {}) {
  return {
    sessionDate: "2026-11-04",
    shortReportDate: "2026-10-28",
    stale: false,
    statusCounts: { triggered: 1, setup: 1, watch: 1 },
    statuses: {
      BHP: { status: "triggered", score: 90, rank: 1, daysToCover: 2.1, digest: "aaaa" },
      CBA: { status: "setup", score: 70, rank: 2, daysToCover: 3.0, digest: "bbbb" },
    },
    top: [
      { rank: 1, stockCode: "BHP", status: "triggered" },
      { rank: 2, stockCode: "CBA", status: "setup" },
    ],
    ...overrides,
  };
}

function recording(overrides = {}) {
  const strategies = Object.fromEntries(ids.map((id) => [id, strategy()]));
  return {
    strategies: { ...strategies, ...overrides.strategies },
    fit: { sessionDate: "2026-11-04", stale: false, inUniverse: true, fits: { canslim: { status: "setup", score: 70, rank: 2 } } },
  };
}

test("identical recordings have no differences", () => {
  const r = diff(recording(), recording());
  assert.equal(r.identical, true);
  assert.deepEqual(r.unexpected, []);
  assert.deepEqual(r.allowed, []);
});

test("a status or count change is unexpected", () => {
  const after = recording({
    strategies: {
      "canslim": strategy({ statusCounts: { triggered: 0, setup: 2, watch: 1 } }),
    },
  });
  const r = diff(recording(), after);
  assert.ok(r.unexpected.some((l) => l.startsWith("canslim: status_counts")));
});

test("a crowded-short code whose days-to-cover moved is allowed", () => {
  const before = recording();
  const after = recording({
    strategies: {
      "crowded-short-breakout": strategy({
        statuses: {
          BHP: { status: "triggered", score: 88, rank: 1, daysToCover: 2.4, digest: "aaaa" },
          CBA: { status: "setup", score: 70, rank: 2, daysToCover: 3.0, digest: "bbbb" },
        },
      }),
    },
  });
  const r = diff(before, after);
  assert.deepEqual(r.unexpected, []);
  assert.equal(r.allowed.length, 1);
  assert.match(r.allowed[0], /crowded-short-breakout BHP/);
});

test("a fundamentals code whose digest changed is allowed, an unchanged one is not", () => {
  const after = recording({
    strategies: {
      canslim: strategy({
        statuses: {
          BHP: { status: "triggered", score: 90, rank: 1, daysToCover: 2.1, digest: "cccc" },
          CBA: { status: "setup", score: 71, rank: 2, daysToCover: 3.0, digest: "bbbb" },
        },
      }),
    },
  });
  const r = diff(recording(), after);
  assert.equal(r.allowed.length, 1);
  assert.match(r.allowed[0], /canslim BHP/);
  assert.equal(r.unexpected.length, 1, "CBA moved with an unchanged digest");
  assert.match(r.unexpected[0], /canslim CBA/);
});

test("Minervini's top ten and BHP's fit must match exactly", () => {
  const after = recording({
    strategies: {
      "minervini-trend-template": strategy({ top: [{ rank: 1, stockCode: "CBA", status: "setup" }] }),
    },
  });
  const r = diff(recording(), after);
  assert.ok(r.unexpected.some((l) => l.includes("top 10 changed")));

  const fitChanged = recording();
  fitChanged.fit.fits.canslim.score = 75;
  const r2 = diff(recording(), fitChanged);
  assert.ok(r2.unexpected.some((l) => l.includes("BHP fit changed")));
});

test("a session_date move is information, not a failure", () => {
  const after = recording({ strategies: { canslim: strategy({ sessionDate: "2026-11-03" }) } });
  const r = diff(recording(), after);
  assert.deepEqual(r.unexpected, []);
  assert.ok(r.info.some((l) => l.includes("canslim: session_date")));
});

test("summarisePicks keeps status, score, rank, days to cover and a fundamentals digest", () => {
  const s = summarisePicks({
    sessionDate: "2026-11-04",
    statusCounts: { triggered: 1 },
    picks: [
      { stockCode: "BHP", status: "triggered", score: 91.123456789, rank: 1, hasDaysToCover: true, daysToCover: 2, fundamentals: { currency: "AUD" } },
      { stockCode: "CBA", status: "watch", score: 10, rank: 2 },
    ],
  });
  assert.equal(s.statuses.BHP.score, 91.123457);
  assert.equal(s.statuses.BHP.daysToCover, 2);
  assert.equal(s.statuses.CBA.daysToCover, null);
  assert.equal(s.statuses.CBA.digest, null);
  assert.equal(s.statusCounts.setup, 0);
  assert.equal(s.top.length, 2);
});

test("the fundamentals digest ignores key order and changes with a figure", () => {
  assert.equal(fundamentalsDigest({ a: 1, b: { c: 2 } }), fundamentalsDigest({ b: { c: 2 }, a: 1 }));
  assert.notEqual(fundamentalsDigest({ a: 1 }), fundamentalsDigest({ a: 2 }));
  assert.equal(fundamentalsDigest(undefined), null);
  assert.equal(stableStringify({ z: [1, { y: null }], a: "x" }), '{"a":"x","z":[1,{"y":null}]}');
});
