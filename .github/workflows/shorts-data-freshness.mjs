// Shorts (ASIC short-position) data freshness check.
//
// Runs from the `Shorts Data Freshness` workflow. Deliberately talks to the
// PUBLIC edge API rather than the database: the sentinel must keep working when
// the sync job, the Cloud Run service, or the GCP alerting config is broken or
// misconfigured, and it must never carry prod DB credentials into a workflow
// whose only job is to read one date.
//
// Exit code 0 = fresh, 1 = breach (or the API could not be read at all).
// Violations are printed to stdout as TAB-separated CHECK/SOURCE/DETAIL rows,
// the same shape housing-freshness.yml uses, so the issue body reads identically.

export const AVAILABLE_DATES_URL =
  "https://api.shorted.com.au/edge/v1/available-dates?limit=10";

// api.shorted.com.au sits behind Cloudflare with a bot/WAF rule in front of it.
// A bare `fetch` default UA gets challenged; a browser-ish UA is served. This is
// the same posture the OG-image fetch fix landed on (see og-image-waf-fetch).
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 (shorted-freshness-sentinel)";

// ASIC publishes short-position reports on a T+4 basis: on any given trading day
// the newest available report date is expected to be 4 TRADING days old. We alert
// only past 6 trading days, leaving two days of slack to absorb an unlisted public
// holiday, a state holiday the ASX observes, or a one-day publication slip. Change
// this and change the docs section in docs/observability/job-alerting.md.
export const STALE_TRADING_DAYS = 6;

// ASX national trading holidays. Weekends are handled separately. Over-listing a
// day here is the SAFE direction (it lowers the counted age, so the sentinel
// alerts later, never earlier); under-listing eats into the two days of slack.
// Extend this every year — `holidayCoverageEndYear` warns when it runs out.
export const ASX_HOLIDAYS = new Set([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-26", // Australia Day
  "2026-04-03", // Good Friday
  "2026-04-06", // Easter Monday
  "2026-04-27", // Anzac Day (25th falls on a Saturday)
  "2026-06-08", // King's Birthday
  "2026-12-25", // Christmas Day
  "2026-12-28", // Boxing Day (observed)
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-26", // Australia Day
  "2027-03-26", // Good Friday
  "2027-03-29", // Easter Monday
  "2027-04-26", // Anzac Day (observed)
  "2027-06-14", // King's Birthday
  "2027-12-27", // Christmas Day (observed)
  "2027-12-28", // Boxing Day (observed)
]);

export const HOLIDAY_COVERAGE_END_YEAR = 2027;

// The rendered /top page, read as a customer sees it. Deliberately the Vercel
// deployment hostname rather than shorted.com.au: it skips the Cloudflare zone
// (and its bot rules) while still exercising every application-side cache —
// Next.js ISR, the Redis page cache, and the server action's own KV entry.
export const TOP_PAGE_URL = "https://shorted-com-au.vercel.app/top";

// /top's <title> is built from the newest ASIC date actually present in the data
// it renders ("Most Shorted ASX Stocks — as at 14 Aug 2026 | Shorted"). It is
// therefore a direct read of what the page's cache layers are currently serving.
const AS_AT_RE = /as at (\d{1,2}) ([A-Za-z]{3,9}) (\d{4})/;

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

// How far the RENDERED date may lag the newest date the API is serving. One
// trading day of slack absorbs the ordinary race: the sync lands a new date and
// the revalidation sweep re-renders /top moments later.
export const SURFACE_LAG_TRADING_DAYS = 1;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's calendar date in Australia/Sydney, as YYYY-MM-DD. */
export function sydneyToday(now = new Date()) {
  // en-CA renders ISO-ish YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function toUTCDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function isTradingDay(iso) {
  const day = toUTCDate(iso).getUTCDay();
  if (day === 0 || day === 6) return false;
  return !ASX_HOLIDAYS.has(iso);
}

/**
 * Trading days strictly AFTER `fromISO` up to and including `toISO`.
 * `fromISO` (the report date) is day 0; the first trading day after it is 1.
 * Returns 0 when `toISO` <= `fromISO`.
 */
export function tradingDaysBetween(fromISO, toISO) {
  const from = toUTCDate(fromISO);
  const to = toUTCDate(toISO);
  if (to <= from) return 0;
  let count = 0;
  const cursor = new Date(from.getTime());
  while (cursor < to) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const iso = cursor.toISOString().slice(0, 10);
    if (isTradingDay(iso)) count += 1;
  }
  return count;
}

export async function fetchAvailableDates(fetchImpl = fetch) {
  const response = await fetchImpl(AVAILABLE_DATES_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim());
  }
  const payload = await response.json();
  const dates = Array.isArray(payload?.dates) ? payload.dates : [];
  return dates.filter((d) => typeof d === "string" && DATE_RE.test(d));
}

/**
 * Pull the "as at D MMM YYYY" date out of a rendered /top document.
 * Returns YYYY-MM-DD, or null when the page carries the undated fallback title
 * (or the markup changed) — which the caller reports as UNCHECKABLE, never as a
 * breach.
 */
export function extractRenderedAsAt(html) {
  if (typeof html !== "string") return null;
  const match = AS_AT_RE.exec(html);
  if (!match) return null;
  const [, day, monthName, year] = match;
  const monthIndex = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
  if (monthIndex < 0) return null;
  const iso = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(
    Number(day),
  ).padStart(2, "0")}`;
  return DATE_RE.test(iso) ? iso : null;
}

export async function fetchRenderedTopDate(fetchImpl = fetch) {
  const response = await fetchImpl(TOP_PAGE_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim());
  }
  return extractRenderedAsAt(await response.text());
}

/**
 * Compare what /top RENDERS against what the API SERVES.
 *
 * This is the only check here that sees a frozen cache. On 2026-08-21 Upstash
 * hit its monthly command cap and went read-only: reads were served, writes and
 * DELs were rejected, /api/revalidate reported success, and the page cache
 * stayed pinned to an old ASIC date for days while the API itself was perfectly
 * fresh — so every data-side check stayed green. Comparing the two ends catches
 * ANY frozen layer (Redis, ISR, the CDN) regardless of cause.
 *
 * `renderedISO === null` means we could not read a date, not that the page is
 * stale: it is reported as its own non-breaching label.
 */
export function evaluateSurface(renderedISO, apiNewestISO, { error = null } = {}) {
  if (error) {
    return {
      violations: [],
      info: [
        "SURFACE_UNCHECKABLE",
        TOP_PAGE_URL,
        `could not read the rendered /top date: ${error}`,
      ],
    };
  }
  if (!renderedISO) {
    return {
      violations: [],
      info: [
        "SURFACE_UNCHECKABLE",
        TOP_PAGE_URL,
        "no 'as at <date>' found in the rendered title — the page fell back to " +
          "its undated title, or the title format changed",
      ],
    };
  }
  if (!apiNewestISO) return { violations: [], info: null };

  const lag = tradingDaysBetween(renderedISO, apiNewestISO);
  if (lag > SURFACE_LAG_TRADING_DAYS) {
    return {
      violations: [
        [
          "SURFACE_STALENESS",
          "/top (rendered)",
          `/top renders "as at ${renderedISO}" but the API's newest date is ` +
            `${apiNewestISO} — ${lag} trading day(s) behind (threshold ` +
            `${SURFACE_LAG_TRADING_DAYS}). A cache layer is frozen: check the ` +
            `Redis/Upstash quota and the flushErrors in a POST /api/revalidate ` +
            `response before re-running the revalidation sweep.`,
        ],
      ],
      info: null,
    };
  }

  return {
    violations: [],
    info: [
      "OK",
      "/top (rendered)",
      `rendered "as at ${renderedISO}" matches the API's newest date ${apiNewestISO} ` +
        `(${lag} trading day(s) behind, threshold ${SURFACE_LAG_TRADING_DAYS})`,
    ],
  };
}

/**
 * Pure evaluation: given the dates the API returned and today's Sydney date,
 * produce the violation rows. Kept separate from I/O so it is unit-testable.
 */
export function evaluate(dates, todayISO) {
  const violations = [];

  if (dates.length === 0) {
    violations.push([
      "DATA_UNAVAILABLE",
      "available-dates",
      "the endpoint returned no usable YYYY-MM-DD dates",
    ]);
    return { violations, newest: null, ageTradingDays: null };
  }

  const newest = dates.slice().sort().at(-1);
  const ageTradingDays = tradingDaysBetween(newest, todayISO);

  if (newest > todayISO) {
    violations.push([
      "DATE_IN_FUTURE",
      "available-dates",
      `newest report date ${newest} is after today (${todayISO}) — clock skew or bad ingest`,
    ]);
  } else if (ageTradingDays > STALE_TRADING_DAYS) {
    violations.push([
      "SHORTS_DATA_STALE",
      "shorts.DATE",
      `newest ASIC report date ${newest} is ${ageTradingDays} trading day(s) old ` +
        `(threshold ${STALE_TRADING_DAYS}; ASIC publishes T+4). The daily shorts sync ` +
        `has probably not landed a new day since then.`,
    ]);
  }

  if (Number(todayISO.slice(0, 4)) > HOLIDAY_COVERAGE_END_YEAR) {
    violations.push([
      "HOLIDAY_TABLE_EXPIRED",
      "ASX_HOLIDAYS",
      `the ASX holiday table stops at ${HOLIDAY_COVERAGE_END_YEAR}; extend it in ` +
        `.github/workflows/shorts-data-freshness.mjs or the trading-day count drifts`,
    ]);
  }

  return { violations, newest, ageTradingDays };
}

export async function run({ fetchImpl = fetch, now = new Date(), out = console.log } = {}) {
  const todayISO = sydneyToday(now);
  let dates;
  try {
    dates = await fetchAvailableDates(fetchImpl);
  } catch (error) {
    out(
      ["API_UNREACHABLE", "available-dates", `${AVAILABLE_DATES_URL}: ${error.message}`].join("\t"),
    );
    return 1;
  }

  const { violations, newest, ageTradingDays } = evaluate(dates, todayISO);

  // Surface check: does the page actually SHOW what the API is serving? Reusing
  // `newest` from the fetch above keeps this zero-secret and one extra request.
  let renderedISO = null;
  let surfaceError = null;
  try {
    renderedISO = await fetchRenderedTopDate(fetchImpl);
  } catch (error) {
    surfaceError = error.message;
  }
  const surface = evaluateSurface(renderedISO, newest, { error: surfaceError });
  const allViolations = [...violations, ...surface.violations];

  for (const row of allViolations) out(row.join("\t"));

  if (allViolations.length === 0) {
    out(
      `OK\tshorts.DATE\tnewest ${newest} is ${ageTradingDays} trading day(s) old ` +
        `(threshold ${STALE_TRADING_DAYS}) as at ${todayISO} Sydney`,
    );
  }
  // Informational tail (OK / UNCHECKABLE) — never a breach on its own.
  if (surface.info) out(surface.info.join("\t"));

  return allViolations.length === 0 ? 0 : 1;
}

// `node shorts-data-freshness.mjs` runs the check; importing it does not.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  run().then((code) => {
    process.exitCode = code;
  });
}
