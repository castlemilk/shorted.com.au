// Report handling is separate from Chrome so incomplete runs can be tested offline.
export const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
export const METRICS = [
  "first-contentful-paint", "largest-contentful-paint", "total-blocking-time",
  "cumulative-layout-shift", "speed-index", "interactive",
];
// Lighthouse no longer emits time-to-interactive in every version.
const REQUIRED_METRICS = METRICS.filter((metric) => metric !== "interactive");
const ERROR_CODES = new Set([
  "NO_FCP", "NO_LCP", "ERRORED_DOCUMENT_REQUEST", "PROTOCOL_TIMEOUT",
  "PAGE_HUNG", "CHROME_INTERSTITIAL_ERROR", "RUN_FAILED",
]);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function summarizeLhr(lhr) {
  return {
    scores: Object.fromEntries(CATEGORIES.map((key) => [key, lhr?.categories?.[key]?.score ?? null])),
    metrics: Object.fromEntries(METRICS.map((key) => [key, lhr?.audits?.[key]?.numericValue ?? null])),
    ...(lhr?.runtimeError ? {
      runtimeError: { code: ERROR_CODES.has(lhr.runtimeError.code) ? lhr.runtimeError.code : "UNKNOWN_RUNTIME_ERROR" },
    } : {}),
  };
}

function missingMeasurements(run) {
  return [
    ...CATEGORIES.filter((key) => !finite(run.scores?.[key]) || run.scores[key] < 0 || run.scores[key] > 1),
    ...REQUIRED_METRICS.filter((key) => !finite(run.metrics?.[key]) || run.metrics[key] < 0),
  ];
}

function median(values) {
  const nums = values.filter(finite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}
const round = (value, digits) => finite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;

export function aggregateRuns(runs, expectedRuns) {
  const errors = runs.flatMap((run, index) => {
    const missing = missingMeasurements(run);
    return run.runtimeError || missing.length ? [{
      run: index + 1,
      ...(run.runtimeError ? { code: run.runtimeError.code } : {}),
      missing,
    }] : [];
  });
  return {
    runs: runs.length,
    expectedRuns,
    status: runs.length === expectedRuns && !errors.length ? "complete" : "incomplete",
    errors,
    scores: Object.fromEntries(CATEGORIES.map((key) => [key, round(median(runs.map((run) => run.scores?.[key])), 3)])),
    metrics: Object.fromEntries(METRICS.map((key) => [key, round(median(runs.map((run) => run.metrics?.[key])), key === "cumulative-layout-shift" ? 3 : 0)])),
  };
}

export function measurementFailures(report) {
  const paths = report.requestedPages ?? Object.keys(report.pages);
  return paths.flatMap((path) => {
    const page = report.pages[path];
    if (!page) return [`${path}  no measurements`];
    const missing = missingMeasurements(page);
    if (page.status === "incomplete" || missing.length || page.runtimeError || page.errors?.length) {
      const codes = [...new Set((page.errors ?? []).map((error) => error.code).filter(Boolean))];
      return [`${path}  incomplete measurements (${page.runs ?? 0}/${page.expectedRuns ?? report.runs} runs${codes.length ? `; ${codes.join(", ")}` : ""}${missing.length ? `; missing ${missing.join(", ")}` : ""})`];
    }
    return [];
  });
}

export function checkBudgets(report, budget) {
  const failures = measurementFailures(report);
  for (const [path, page] of Object.entries(report.pages)) {
    for (const [category, min] of Object.entries(budget.scores)) {
      const value = page.scores?.[category];
      if (finite(value) && value < min) failures.push(`${path}  ${category} ${value} < ${min}`);
    }
    for (const [metric, max] of Object.entries(budget.metrics)) {
      const value = page.metrics?.[metric];
      if (finite(value) && value > max) failures.push(`${path}  ${metric} ${value} > ${max}`);
    }
  }
  return failures;
}
