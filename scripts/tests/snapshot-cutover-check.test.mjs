// The PR-11 cutover check: the diff classifies every difference the cutover
// allows and fails on every other one, and the recording reads whole lists or
// fails. The network is faked; nothing here calls the API.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertTokenBaseUrl,
  collectStrategy,
  diff,
  fundamentalsDigest,
  record,
  RecordError,
  stableStringify,
  summarisePicks,
} from "../strategies/snapshot-cutover-check.mjs";

const ids = ["zanger-breakout", "canslim", "minervini-trend-template", "crowded-short-breakout", "quality-compounders"];

// SNAPSHOT_FETCH is the fetch the snapshot's fundamentals were read from. A digest may
// move only when the views hold a later fetch than this (see viewsAfterRefetch).
const SNAPSHOT_FETCH = "2026-11-04T06:00:00Z";
const LATER_FETCH = "2026-11-05T06:00:00Z";

// viewsAfterRefetch is the views' recording with one canslim code fetched again since
// the snapshot, so its digest may move.
function viewsAfterRefetch(code, id = "canslim") {
  const before = recording();
  before.strategies[id].statuses[code].fetchedAt = LATER_FETCH;
  return before;
}

function strategy(overrides = {}) {
  return {
    sessionDate: "2026-11-04",
    shortReportDate: "2026-10-28",
    stale: false,
    totalCount: 2,
    statusCounts: { triggered: 1, setup: 1, watch: 0 },
    statuses: {
      BHP: { status: "triggered", score: 90, rank: 1, daysToCover: 2.1, digest: "aaaa", fetchedAt: SNAPSHOT_FETCH },
      CBA: { status: "setup", score: 70, rank: 2, daysToCover: 3.0, digest: "bbbb", fetchedAt: SNAPSHOT_FETCH },
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
    dataStatus: { latestSession: "2026-11-04", snapshotAsOf: "2026-11-04" },
    strategies: { ...strategies, ...overrides.strategies },
    fit: {
      sessionDate: "2026-11-04",
      stale: false,
      inUniverse: true,
      fits: {
        canslim: { status: "setup", score: 70, rank: 2 },
        "crowded-short-breakout": { status: "watch", score: 10, rank: 40 },
      },
    },
  };
}

test("identical recordings have no differences", () => {
  const r = diff(recording(), recording());
  assert.equal(r.identical, true);
  assert.deepEqual(r.unexpected, []);
  assert.deepEqual(r.allowed, []);
});

test("a status or count change is unexpected", () => {
  const after = recording({ strategies: { canslim: strategy({ statusCounts: { triggered: 0, setup: 2, watch: 0 } }) } });
  const r = diff(recording(), after);
  assert.ok(r.unexpected.some((l) => l.startsWith("canslim: status_counts")));
});

test("a code that changes status is unexpected, whatever moved with it", () => {
  const after = recording({
    strategies: {
      canslim: strategy({
        statuses: {
          BHP: { status: "setup", score: 90, rank: 1, daysToCover: 2.1, digest: "aaaa" },
          CBA: { status: "triggered", score: 70, rank: 2, daysToCover: 3.0, digest: "bbbb" },
        },
      }),
    },
  });
  const r = diff(recording(), after);
  assert.equal(r.unexpected.length, 2);
  assert.ok(r.unexpected.every((l) => l.startsWith("canslim ")));
});

test("a crowded-short code whose days to cover moved may move its score, never its status", () => {
  const before = recording();
  const moved = recording({
    strategies: {
      "crowded-short-breakout": strategy({
        statuses: {
          BHP: { status: "triggered", score: 88, rank: 1, daysToCover: 2.4, digest: "aaaa" },
          CBA: { status: "setup", score: 70, rank: 2, daysToCover: 3.0, digest: "bbbb" },
        },
      }),
    },
  });
  const r = diff(before, moved);
  assert.deepEqual(r.unexpected, []);
  assert.equal(r.allowed.length, 1);
  assert.match(r.allowed[0], /crowded-short-breakout BHP/);
});

test("a crowded-short status swap is unexpected even when days to cover moved", () => {
  const swapped = recording({
    strategies: {
      "crowded-short-breakout": strategy({
        statusCounts: { triggered: 1, setup: 1, watch: 0 },
        statuses: {
          BHP: { status: "setup", score: 60, rank: 2, daysToCover: 2.4, digest: "aaaa" },
          CBA: { status: "triggered", score: 75, rank: 1, daysToCover: 3.0, digest: "bbbb" },
        },
      }),
    },
  });
  const r = diff(recording(), swapped);
  assert.equal(r.unexpected.filter((l) => l.startsWith("crowded-short-breakout")).length, 2);
});

test("a Minervini move that changes only days to cover is not a difference (it is display only there)", () => {
  const after = recording({
    strategies: {
      "minervini-trend-template": strategy({
        statuses: {
          BHP: { status: "triggered", score: 90, rank: 1, daysToCover: 9.9, digest: "aaaa" },
          CBA: { status: "setup", score: 70, rank: 2, daysToCover: 3.0, digest: "bbbb" },
        },
      }),
    },
  });
  const r = diff(recording(), after);
  assert.deepEqual(r.unexpected, []);
  assert.deepEqual(r.allowed, []);
});

test("a fundamentals code whose digest changed is allowed, an unchanged one is not", () => {
  const after = recording({
    strategies: {
      canslim: strategy({
        statuses: {
          BHP: { status: "triggered", score: 90, rank: 1, daysToCover: 2.1, digest: "cccc", fetchedAt: SNAPSHOT_FETCH },
          CBA: { status: "setup", score: 71, rank: 2, daysToCover: 3.0, digest: "bbbb" },
        },
      }),
    },
  });
  const r = diff(viewsAfterRefetch("BHP"), after);
  assert.equal(r.allowed.length, 1);
  assert.match(r.allowed[0], /canslim BHP/);
  assert.equal(r.unexpected.length, 1, "CBA moved with an unchanged digest");
  assert.match(r.unexpected[0], /canslim CBA/);
});

test("a rank shift with unchanged status and score is not compared", () => {
  const after = recording({
    strategies: {
      canslim: strategy({
        statuses: {
          BHP: { status: "triggered", score: 90, rank: 2, daysToCover: 2.1, digest: "aaaa" },
          CBA: { status: "setup", score: 70, rank: 1, daysToCover: 3.0, digest: "bbbb" },
        },
      }),
    },
  });
  const r = diff(recording(), after);
  assert.deepEqual(r.unexpected, []);
});

test("Minervini's top ten and BHP's fit must match", () => {
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
  assert.ok(r2.unexpected.some((l) => l.includes("BHP fit canslim")));
});

test("a session_date mismatch between the recordings is unexpected", () => {
  const after = recording({ strategies: { canslim: strategy({ sessionDate: "2026-11-03" }) } });
  const r = diff(recording(), after);
  assert.ok(r.unexpected.some((l) => l.startsWith("canslim: session_date")));
});

test("the after recording must be the snapshot's own session", () => {
  const after = recording();
  after.dataStatus.snapshotAsOf = "2026-11-03";
  const r = diff(recording(), after);
  assert.ok(r.unexpected.some((l) => l.includes("is not the snapshot's 2026-11-03")));
});

test("an after recording without GetStrategyDataStatus is unexpected", () => {
  const after = recording();
  delete after.dataStatus;
  const r = diff(recording(), after);
  assert.ok(r.unexpected.some((l) => l.includes("no GetStrategyDataStatus")));
});

test("a code that leaves or enters the list is unexpected", () => {
  const after = recording({
    strategies: {
      canslim: strategy({ statuses: { BHP: { status: "triggered", score: 90, rank: 1, daysToCover: 2.1, digest: "aaaa" } } }),
    },
  });
  const r = diff(recording(), after);
  assert.ok(r.unexpected.some((l) => l.startsWith("canslim CBA: left the list")));
});

test("summarisePicks keeps status, score, rank, days to cover and a fundamentals digest", () => {
  const s = summarisePicks({
    sessionDate: "2026-11-04",
    totalCount: 2,
    statusCounts: { triggered: 1 },
    picks: [
      { stockCode: "BHP", status: "triggered", score: 91.123456789, rank: 1, hasDaysToCover: true, daysToCover: 2, fundamentals: { currency: "AUD", fetchedAt: "2026-11-05T01:00:00Z" } },
      { stockCode: "CBA", status: "watch", score: 10, rank: 2 },
    ],
  });
  assert.equal(s.statuses.BHP.score, 91.123457);
  assert.equal(s.statuses.BHP.daysToCover, 2);
  assert.equal(s.statuses.BHP.fetchedAt, "2026-11-05T01:00:00Z");
  assert.equal(s.statuses.CBA.daysToCover, null);
  assert.equal(s.statuses.CBA.digest, null);
  assert.equal(s.statuses.CBA.fetchedAt, null);
  assert.equal(s.statusCounts.setup, 0);
  assert.equal(s.totalCount, 2);
  assert.equal(s.top.length, 2);
});

test("the fundamentals digest ignores key order, provenance timestamps and changes with a figure", () => {
  assert.equal(fundamentalsDigest({ a: 1, b: { c: 2 } }), fundamentalsDigest({ b: { c: 2 }, a: 1 }));
  assert.notEqual(fundamentalsDigest({ a: 1 }), fundamentalsDigest({ a: 2 }));
  assert.equal(fundamentalsDigest({ a: 1, fetchedAt: "2026-11-04T01:00:00Z" }), fundamentalsDigest({ a: 1, fetchedAt: "2026-11-05T01:00:00Z" }));
  assert.equal(fundamentalsDigest({ a: 1, periods: [{ fetched_at: "x", npat: 3 }] }), fundamentalsDigest({ a: 1, periods: [{ fetched_at: "y", npat: 3 }] }));
  assert.equal(fundamentalsDigest(undefined), null);
  assert.equal(stableStringify({ z: [1, { y: null }], a: "x" }), '{"a":"x","z":[1,{"y":null}]}');
});

// A fake fetch that answers Connect calls from a table of handlers.
function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body, headers: init.headers });
    const r = handler(method, body, init.headers);
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 300,
      headers: { get: (k) => (r.headers ?? {})[k] ?? null },
      text: async () => JSON.stringify(r.json ?? {}),
    };
  };
  return { fetchImpl, calls };
}

function picksPage(total, start, n, clamped = false) {
  const picks = [];
  for (let i = start; i < start + n && i < total; i++) {
    picks.push({ stockCode: `C${String(i).padStart(4, "0")}`, status: "watch", score: i, rank: i + 1 });
  }
  return { sessionDate: "2026-11-04", totalCount: total, statusCounts: { triggered: 0, setup: 0, watch: total }, picks, viewer: { access: "anonymous", clamped, limit: 100 } };
}

test("collectStrategy reads every page until totalCount, by rows read", async () => {
  const { fetchImpl, calls } = fakeFetch((method, body) => ({ json: picksPage(250, body.offset, body.limit) }));
  const s = await collectStrategy("https://api.example", "canslim", { fetchImpl, sleep: async () => {} });
  assert.equal(Object.keys(s.statuses).length, 250);
  assert.deepEqual(calls.map((c) => c.body.offset), [0, 100, 200]);
  assert.ok(calls.every((c) => c.method === "GetStrategyPicks"));
});

test("collectStrategy refuses a clamped read and a short read", async () => {
  const clamped = fakeFetch(() => ({ json: picksPage(250, 0, 10, true) }));
  await assert.rejects(collectStrategy("https://api.example", "canslim", { fetchImpl: clamped.fetchImpl, sleep: async () => {} }), RecordError);

  const short = fakeFetch((m, body) => ({ json: picksPage(250, body.offset, body.offset === 0 ? 100 : 0) }));
  await assert.rejects(collectStrategy("https://api.example", "canslim", { fetchImpl: short.fetchImpl, sleep: async () => {} }), /page at offset 100 is empty/);
});

test("collectStrategy refuses pages that answer for different sessions or lists", async () => {
  // Page 2 comes from a universe built the day before: same rows, another session.
  const otherSession = fakeFetch((m, body) => ({ json: { ...picksPage(250, body.offset, body.limit), sessionDate: body.offset === 0 ? "2026-11-04" : "2026-11-03" } }));
  await assert.rejects(collectStrategy("https://api.example", "canslim", { fetchImpl: otherSession.fetchImpl, sleep: async () => {} }), /answers for a different session or list than page 1/);

  // Page 3 holds a different total: the list changed between reads.
  const otherTotal = fakeFetch((m, body) => ({ json: picksPage(body.offset === 200 ? 240 : 250, body.offset, body.limit) }));
  await assert.rejects(collectStrategy("https://api.example", "canslim", { fetchImpl: otherTotal.fetchImpl, sleep: async () => {} }), /different session or list/);

  // Page 2's status counts differ from page 1's.
  const otherCounts = fakeFetch((m, body) => {
    const p = picksPage(250, body.offset, body.limit);
    if (body.offset === 100) p.statusCounts = { triggered: 1, setup: 0, watch: 249 };
    return { json: p };
  });
  await assert.rejects(collectStrategy("https://api.example", "canslim", { fetchImpl: otherCounts.fetchImpl, sleep: async () => {} }), /different session or list/);
});

test("collectStrategy surfaces a refused offset rather than reading a partial list", async () => {
  const refused = fakeFetch(() => ({ status: 403, json: { code: "permission_denied" } }));
  await assert.rejects(collectStrategy("https://api.example", "canslim", { fetchImpl: refused.fetchImpl, sleep: async () => {} }), /HTTP 403/);
});

test("collectStrategy waits for Retry-After on a 429, then reads", async () => {
  let first = true;
  const waits = [];
  const { fetchImpl } = fakeFetch((m, body) => {
    if (first) {
      first = false;
      return { status: 429, headers: { "retry-after": "7" }, json: {} };
    }
    return { json: picksPage(3, body.offset, body.limit) };
  });
  const s = await collectStrategy("https://api.example", "canslim", { fetchImpl, sleep: async (ms) => waits.push(ms) });
  assert.equal(Object.keys(s.statuses).length, 3);
  assert.deepEqual(waits, [7000]);
});

test("record with a token reads the viewer list and never writes the token into the recording", async () => {
  const token = "tok-secret-value";
  const { fetchImpl, calls } = fakeFetch((method, body) => {
    if (method === "GetStrategyDataStatus") return { json: { latestSession: "2026-11-04", snapshotAsOf: "2026-11-04" } };
    if (method === "GetStockStrategyFit") return { json: { sessionDate: "2026-11-04", fits: [] } };
    return { json: picksPage(2, body.offset, body.limit) };
  });
  const rec = await record("https://api.example", { fetchImpl, token, sleep: async () => {}, delayMs: 0 });
  assert.ok(calls.filter((c) => c.method.startsWith("GetStrategy") && c.method !== "GetStrategyDataStatus").every((c) => c.headers.authorization === `Bearer ${token}`));
  assert.ok(calls.some((c) => c.method === "GetViewerStrategyPicks"));
  assert.equal(rec.authenticated, true);
  assert.equal(rec.dataStatus.snapshotAsOf, "2026-11-04");
  assert.ok(!JSON.stringify(rec).includes(token), "the token is never recorded");
});

// A crowded-short code whose days to cover is its only stock-specific pass: the pick
// exists only through that rule, so a change to the window can list or unlist it.
const dtcOnly = (daysToCover) => ({ status: "watch", score: 12, rank: 3, daysToCover, digest: null, passing: ["days_to_cover"] });

test("summarisePicks records the stock-specific passing rules, never the regime", () => {
  const s = summarisePicks({
    picks: [
      {
        stockCode: "SRN",
        status: "watch",
        rules: [
          { ruleId: "regime", status: "pass" },
          { ruleId: "days_to_cover", status: "pass" },
          { ruleId: "short_interest", status: "fail" },
          { ruleId: "rs", status: "pass" },
        ],
      },
    ],
  });
  assert.deepEqual(s.statuses.SRN.passing, ["days_to_cover", "rs"]);
});

test("a crowded-short code that enters the list on days to cover alone is allowed", () => {
  const after = recording({
    strategies: {
      "crowded-short-breakout": strategy({
        totalCount: 3,
        statusCounts: { triggered: 1, setup: 1, watch: 1 },
        statuses: {
          ...strategy().statuses,
          SRN: dtcOnly(5.11),
        },
      }),
    },
  });
  const r = diff(recording(), after);
  assert.deepEqual(r.unexpected, []);
  assert.equal(r.allowed.length, 1);
  assert.match(r.allowed[0], /crowded-short-breakout SRN: entered the list .*only passing rule/);
});

test("a crowded-short code that leaves the list on days to cover alone is allowed", () => {
  const before = recording({
    strategies: {
      "crowded-short-breakout": strategy({
        totalCount: 3,
        statusCounts: { triggered: 1, setup: 1, watch: 1 },
        statuses: { ...strategy().statuses, SRN: dtcOnly(4.99) },
      }),
    },
  });
  const r = diff(before, recording());
  assert.deepEqual(r.unexpected, []);
  assert.match(r.allowed[0], /crowded-short-breakout SRN: left the list/);
});

test("a crowded-short code that enters with another passing rule is unexpected", () => {
  const after = recording({
    strategies: {
      "crowded-short-breakout": strategy({
        totalCount: 3,
        statusCounts: { triggered: 1, setup: 1, watch: 1 },
        statuses: { ...strategy().statuses, SRN: { ...dtcOnly(5.11), passing: ["days_to_cover", "rs"] } },
      }),
    },
  });
  const r = diff(recording(), after);
  assert.ok(r.unexpected.some((l) => l.startsWith("crowded-short-breakout SRN: entered the list")));
});

test("a crowded-short days to cover that becomes unknown is unexpected, one that becomes a value is not", () => {
  const lost = recording({
    strategies: {
      "crowded-short-breakout": strategy({
        statuses: {
          BHP: { status: "triggered", score: 88, rank: 1, daysToCover: null, digest: null, passing: ["breakout"] },
          CBA: strategy().statuses.CBA,
        },
      }),
    },
  });
  const r = diff(recording(), lost);
  assert.ok(r.unexpected.some((l) => l.includes("crowded-short-breakout BHP") && l.includes("days_to_cover lost its value")));

  const gained = recording({
    strategies: {
      "crowded-short-breakout": strategy({
        statuses: {
          BHP: { status: "triggered", score: 88, rank: 1, daysToCover: 2.4, digest: null, passing: ["breakout"] },
          CBA: strategy().statuses.CBA,
        },
      }),
    },
  });
  const base = recording({
    strategies: {
      "crowded-short-breakout": strategy({
        statuses: {
          BHP: { status: "triggered", score: 88, rank: 1, daysToCover: null, digest: null, passing: ["breakout"] },
          CBA: strategy().statuses.CBA,
        },
      }),
    },
  });
  assert.deepEqual(diff(base, gained).unexpected, []);
});

test("a digest-moved status change is allowed, and the counts are compared net of it", () => {
  const after = recording({
    strategies: {
      canslim: strategy({
        statusCounts: { triggered: 0, setup: 2, watch: 0 },
        statuses: {
          BHP: { status: "setup", score: 90, rank: 1, daysToCover: 2.1, digest: "cccc", fetchedAt: SNAPSHOT_FETCH },
          CBA: { status: "setup", score: 70, rank: 2, daysToCover: 3.0, digest: "bbbb" },
        },
      }),
    },
  });
  const r = diff(viewsAfterRefetch("BHP"), after);
  assert.deepEqual(r.unexpected, []);
  assert.equal(r.allowed.length, 1);
  assert.match(r.allowed[0], /canslim BHP: \{"status":"triggered".*"setup".*fundamentals digest changed/);
});

test("a digest that appears or vanishes within one session is not a digest change", () => {
  const after = recording({
    strategies: {
      canslim: strategy({
        statuses: {
          BHP: { status: "setup", score: 90, rank: 1, daysToCover: 2.1, digest: null },
          CBA: { status: "setup", score: 70, rank: 2, daysToCover: 3.0, digest: "bbbb" },
        },
      }),
    },
  });
  const r = diff(recording(), after);
  assert.ok(r.unexpected.some((l) => l.startsWith("canslim BHP")), "a status change with a vanished digest is not allowed");
  assert.deepEqual(r.allowed, []);
});

test("the counts still have to match once the allowed codes are left out", () => {
  const after = recording({
    strategies: {
      canslim: strategy({
        statusCounts: { triggered: 0, setup: 2, watch: 0 },
        statuses: {
          BHP: { status: "setup", score: 90, rank: 1, daysToCover: 2.1, digest: "cccc", fetchedAt: SNAPSHOT_FETCH },
          CBA: { status: "setup", score: 70, rank: 2, daysToCover: 3.0, digest: "bbbb" },
        },
      }),
    },
  });
  // The digest-moved code is allowed to change status, but a count the allowed codes do not explain is not.
  after.strategies.canslim.statusCounts = { triggered: 0, setup: 2, watch: 1 };
  after.strategies.canslim.totalCount = 3;
  const r = diff(viewsAfterRefetch("BHP"), after);
  assert.ok(r.unexpected.some((l) => l.startsWith("canslim: status_counts")));
  assert.ok(r.unexpected.some((l) => l.startsWith("canslim: total_count")));
});

// A digest that moved on the same fetch is the two sources disagreeing: the cutover
// must not excuse it, whatever the status and score do.
test("a digest that moves with no later fetch is unexpected, whatever the status does", () => {
  const sameFetch = recording({
    strategies: {
      canslim: strategy({
        statuses: {
          BHP: { status: "triggered", score: 90, rank: 1, daysToCover: 2.1, digest: "cccc", fetchedAt: SNAPSHOT_FETCH },
          CBA: { status: "setup", score: 70, rank: 2, daysToCover: 3.0, digest: "bbbb", fetchedAt: SNAPSHOT_FETCH },
        },
      }),
    },
  });
  const r = diff(recording(), sameFetch);
  assert.deepEqual(r.allowed, []);
  assert.equal(r.unexpected.length, 1);
  assert.match(r.unexpected[0], /canslim BHP.*disagree on the same fetch/);

  const statusMoved = recording({
    strategies: {
      canslim: strategy({
        statuses: {
          BHP: { status: "setup", score: 90, rank: 1, daysToCover: 2.1, digest: "cccc", fetchedAt: SNAPSHOT_FETCH },
          CBA: { status: "setup", score: 70, rank: 2, daysToCover: 3.0, digest: "bbbb", fetchedAt: SNAPSHOT_FETCH },
        },
        statusCounts: { triggered: 0, setup: 2, watch: 0 },
      }),
    },
  });
  const r2 = diff(recording(), statusMoved);
  assert.deepEqual(r2.allowed, []);
  assert.ok(r2.unexpected.some((l) => l.startsWith("canslim BHP") && l.includes("disagree")));
});

// The views holding an earlier fetch than the snapshot is not a refresh either.
test("a digest move with the views' fetch earlier than the snapshot's is unexpected", () => {
  const before = recording();
  before.strategies.canslim.statuses.BHP.fetchedAt = "2026-11-03T06:00:00Z";
  const after = recording({
    strategies: {
      canslim: strategy({
        statuses: {
          BHP: { status: "setup", score: 90, rank: 1, daysToCover: 2.1, digest: "cccc", fetchedAt: SNAPSHOT_FETCH },
          CBA: { status: "setup", score: 70, rank: 2, daysToCover: 3.0, digest: "bbbb", fetchedAt: SNAPSHOT_FETCH },
        },
      }),
    },
  });
  const r = diff(before, after);
  assert.deepEqual(r.allowed, []);
  assert.ok(r.unexpected.some((l) => l.startsWith("canslim BHP")));
});

test("assertTokenBaseUrl sends a token only over https, or over http on this machine", () => {
  assert.doesNotThrow(() => assertTokenBaseUrl("https://api.shorted.com.au"));
  assert.doesNotThrow(() => assertTokenBaseUrl("https://shorts-api-abc.a.run.app/"));
  assert.doesNotThrow(() => assertTokenBaseUrl("http://localhost:9091"));
  assert.doesNotThrow(() => assertTokenBaseUrl("http://127.0.0.1:9091"));
  assert.throws(() => assertTokenBaseUrl("http://api.shorted.com.au"), RecordError);
  assert.throws(() => assertTokenBaseUrl("http://192.168.1.10:9091"), RecordError);
  assert.throws(() => assertTokenBaseUrl("https.example"), RecordError);
});

test("record refuses a token for a plain http or foreign base URL before any fetch is made", async () => {
  for (const baseUrl of ["http://api.shorted.com.au", "http://preview.example.com"]) {
    const { fetchImpl, calls } = fakeFetch(() => ({ json: {} }));
    await assert.rejects(record(baseUrl, { fetchImpl, token: "tok", sleep: async () => {}, delayMs: 0 }), RecordError, baseUrl);
    assert.equal(calls.length, 0, `${baseUrl}: no request carries the token`);
  }
});
