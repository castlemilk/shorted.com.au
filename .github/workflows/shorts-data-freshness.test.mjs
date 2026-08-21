// node --test .github/workflows/shorts-data-freshness.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ASX_HOLIDAYS,
  STALE_TRADING_DAYS,
  SURFACE_LAG_TRADING_DAYS,
  TOP_PAGE_URL,
  evaluate,
  evaluateSurface,
  extractRenderedAsAt,
  isTradingDay,
  run,
  sydneyToday,
  tradingDaysBetween,
} from "./shorts-data-freshness.mjs";

const workflow = readFileSync(
  fileURLToPath(new URL("./shorts-data-freshness.yml", import.meta.url)),
  "utf8",
);

test("workflow runs after the sync slot and only needs the automatic token", () => {
  assert.match(workflow, /- cron: "7 20 \* \* \*"/);
  assert.match(workflow, /issues: write/);
  // No prod credentials may leak into this layer — that is what makes it survive
  // a broken GCP/DB configuration.
  assert.doesNotMatch(workflow, /DATABASE_URL/);
  assert.doesNotMatch(workflow, /workload_identity_provider/);
  assert.match(workflow, /node \.github\/workflows\/shorts-data-freshness\.mjs/);
});

test("layer 1 (GCP alerting) is armed by default in prod and covers the whole fleet", () => {
  const prodVars = readFileSync(
    fileURLToPath(new URL("../../terraform/environments/prod/variables.tf", import.meta.url)),
    "utf8",
  );
  const block = prodVars.slice(prodVars.indexOf('variable "alert_recipient_email"'));
  // An empty default means "unset == unmonitored", which is how this layer spent
  // its first life as a no-op.
  assert.match(block.slice(0, block.indexOf("\n}")), /default\s*=\s*"[^"]+@[^"]+"/);

  const moduleMain = readFileSync(
    fileURLToPath(new URL("../../terraform/modules/job-monitoring/main.tf", import.meta.url)),
    "utf8",
  );
  // Fleet-wide by resource type, never a per-job allowlist.
  assert.match(moduleMain, /resource\.type\s*=?\s*"cloud_run_job"/);
  assert.match(moduleMain, /metric\.label\.\\"result\\" = \\"failed\\"/);
  assert.match(moduleMain, /severity>=ERROR/);
});

test("the runbook the alert issue points at exists", () => {
  const runbook = fileURLToPath(new URL("../../docs/observability/job-alerting.md", import.meta.url));
  assert.ok(readFileSync(runbook, "utf8").length > 0);
  assert.match(workflow, /docs\/observability\/job-alerting\.md/);
});

test("weekends and listed ASX holidays are not trading days", () => {
  assert.equal(isTradingDay("2026-08-21"), true); // Friday
  assert.equal(isTradingDay("2026-08-22"), false); // Saturday
  assert.equal(isTradingDay("2026-08-23"), false); // Sunday
  assert.equal(isTradingDay("2026-12-25"), false); // Christmas
  assert.ok(ASX_HOLIDAYS.has("2026-04-03")); // Good Friday
});

test("trading-day age skips the weekend", () => {
  // Fri 2026-08-14 -> Thu 2026-08-21 = Mon..Thu (4) + Mon 17 = 5 trading days.
  assert.equal(tradingDaysBetween("2026-08-14", "2026-08-21"), 5);
  // Same day and going backwards are both zero.
  assert.equal(tradingDaysBetween("2026-08-21", "2026-08-21"), 0);
  assert.equal(tradingDaysBetween("2026-08-21", "2026-08-14"), 0);
});

test("a holiday inside the window lowers the age (alerting later, never earlier)", () => {
  // Good Friday 2026-04-03 + Easter Monday 2026-04-06 fall in this span.
  const withHolidays = tradingDaysBetween("2026-04-01", "2026-04-08");
  const plainWeekdays = 5; // Thu, Fri, Mon, Tue, Wed
  assert.equal(withHolidays, plainWeekdays - 2);
});

test("T+4 lag is healthy, seven trading days is a breach", () => {
  // 4 trading days old: Fri 14 -> Thu 20.
  assert.deepEqual(evaluate(["2026-08-14"], "2026-08-20").violations, []);
  // 6 trading days old is still inside the threshold.
  const atThreshold = evaluate(["2026-08-13"], "2026-08-21");
  assert.equal(atThreshold.ageTradingDays, STALE_TRADING_DAYS);
  assert.deepEqual(atThreshold.violations, []);
  // 7 trading days old breaches.
  const breach = evaluate(["2026-08-12"], "2026-08-21");
  assert.equal(breach.ageTradingDays, 7);
  assert.equal(breach.violations.length, 1);
  assert.equal(breach.violations[0][0], "SHORTS_DATA_STALE");
});

test("the newest date wins regardless of response ordering", () => {
  const { newest } = evaluate(["2026-08-10", "2026-08-14", "2026-08-12"], "2026-08-20");
  assert.equal(newest, "2026-08-14");
});

test("an empty or unusable payload is a violation, not a silent pass", () => {
  const { violations } = evaluate([], "2026-08-21");
  assert.equal(violations[0][0], "DATA_UNAVAILABLE");
});

test("a future report date is flagged rather than read as maximally fresh", () => {
  const { violations } = evaluate(["2026-09-30"], "2026-08-21");
  assert.equal(violations[0][0], "DATE_IN_FUTURE");
});

test("run() exits non-zero and reports when the API cannot be read", async () => {
  const lines = [];
  const code = await run({
    fetchImpl: async () => ({ ok: false, status: 503, statusText: "Service Unavailable" }),
    now: new Date("2026-08-21T20:07:00Z"),
    out: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.match(lines[0], /^API_UNREACHABLE\t/);
});

test("run() passes on a fresh payload", async () => {
  const lines = [];
  const code = await run({
    fetchImpl: async () => ({ ok: true, json: async () => ({ dates: ["2026-08-20"] }) }),
    now: new Date("2026-08-21T20:07:00Z"),
    out: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.match(lines[0], /^OK\t/);
});

test("the rendered as-at date is read out of the /top title", () => {
  const title = "<title>Most Shorted ASX Stocks — as at 14 Aug 2026 | Shorted</title>";
  assert.equal(extractRenderedAsAt(title), "2026-08-14");
  // Single-digit day, and the long month name en-AU can emit.
  assert.equal(extractRenderedAsAt("as at 3 September 2026"), "2026-09-03");
  // The undated fallback title carries no date at all.
  assert.equal(
    extractRenderedAsAt("<title>Most Shorted ASX Stocks — Top 100 | Shorted</title>"),
    null,
  );
  assert.equal(extractRenderedAsAt("as at 14 Foo 2026"), null);
  assert.equal(extractRenderedAsAt(undefined), null);
});

test("a rendered date matching the API is clean", () => {
  const { violations, info } = evaluateSurface("2026-08-14", "2026-08-14");
  assert.deepEqual(violations, []);
  assert.equal(info[0], "OK");
});

test("one trading day of lag is tolerated (sync/revalidate race)", () => {
  const { violations } = evaluateSurface("2026-08-13", "2026-08-14");
  assert.equal(tradingDaysBetween("2026-08-13", "2026-08-14"), SURFACE_LAG_TRADING_DAYS);
  assert.deepEqual(violations, []);
});

// The 2026-08-21 read-only-cache freeze: the API was fresh the whole time, so
// only an end-to-end comparison could have seen it.
test("a frozen page behind a fresh API is a SURFACE_STALENESS breach", () => {
  const { violations } = evaluateSurface("2026-08-07", "2026-08-14");
  assert.equal(violations.length, 1);
  assert.equal(violations[0][0], "SURFACE_STALENESS");
  assert.match(violations[0][2], /2026-08-07/);
  assert.match(violations[0][2], /2026-08-14/);
});

test("an unreadable /top is its own label, never a false breach", () => {
  const fetchFailed = evaluateSurface(null, "2026-08-14", { error: "HTTP 503" });
  assert.deepEqual(fetchFailed.violations, []);
  assert.equal(fetchFailed.info[0], "SURFACE_UNCHECKABLE");
  assert.equal(fetchFailed.info[1], TOP_PAGE_URL);

  const noDateInTitle = evaluateSurface(null, "2026-08-14");
  assert.deepEqual(noDateInTitle.violations, []);
  assert.equal(noDateInTitle.info[0], "SURFACE_UNCHECKABLE");
});

test("run() breaches when /top renders a date behind the API's newest", async () => {
  const lines = [];
  const code = await run({
    fetchImpl: async (url) =>
      url === TOP_PAGE_URL
        ? { ok: true, text: async () => "<title>… as at 7 Aug 2026 | Shorted</title>" }
        : { ok: true, json: async () => ({ dates: ["2026-08-20"] }) },
    now: new Date("2026-08-21T20:07:00Z"),
    out: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.match(lines[0], /^SURFACE_STALENESS\t/);
});

test("run() stays green (with an UNCHECKABLE note) when /top cannot be fetched", async () => {
  const lines = [];
  const code = await run({
    fetchImpl: async (url) => {
      if (url === TOP_PAGE_URL) throw new Error("ECONNRESET");
      return { ok: true, json: async () => ({ dates: ["2026-08-20"] }) };
    },
    now: new Date("2026-08-21T20:07:00Z"),
    out: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.match(lines[0], /^OK\tshorts\.DATE\t/);
  assert.match(lines.at(-1), /^SURFACE_UNCHECKABLE\t/);
});

test("run() reports both ends when /top and the API agree", async () => {
  const lines = [];
  const code = await run({
    fetchImpl: async (url) =>
      url === TOP_PAGE_URL
        ? { ok: true, text: async () => "as at 20 Aug 2026 | Shorted" }
        : { ok: true, json: async () => ({ dates: ["2026-08-20"] }) },
    now: new Date("2026-08-21T20:07:00Z"),
    out: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.match(lines.at(-1), /^OK\t\/top \(rendered\)\t/);
});

test("sydneyToday uses the Australian calendar date, not UTC's", () => {
  // 2026-08-21T20:07Z is already 2026-08-22 in Sydney (UTC+10).
  assert.equal(sydneyToday(new Date("2026-08-21T20:07:00Z")), "2026-08-22");
});
