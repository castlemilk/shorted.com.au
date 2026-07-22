import assert from "node:assert/strict";
import { chromium, devices, request as playwrightRequest } from "@playwright/test";
import { checkFirebaseGoogleAuthBootstrap } from "./helpers/firebase-google-auth-bootstrap.mjs";

const baseUrl = process.env.BASE_URL || "https://shorted.com.au";
const apiBaseUrl = process.env.RELEASE_API_BASE_URL || "https://api.shorted.com.au";
const bypassSecret =
  process.env.CLOUDFLARE_TESTING_BYPASS_SECRET ||
  process.env.SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET ||
  process.env.TF_VAR_rate_limit_testing_bypass_secret ||
  "";

if (!bypassSecret) {
  throw new Error("CLOUDFLARE_TESTING_BYPASS_SECRET is required for release smoke");
}

const userAgent = `${devices["Desktop Chrome"].userAgent} Shorted-E2E/1.0`;
const headers = {
  "User-Agent": userAgent,
  "X-Shorted-Testing-Bypass": bypassSecret,
};

const appApiPattern =
  /\/(_next\/static\/|shorts\.v1alpha1\.|marketdata\.v1\.|chat\.v1\.|register\.v1\.|api\/)/;

const forbiddenPageText = [
  /Application error/i,
  /Element type is invalid/i,
  /Page changed from static to dynamic/i,
  /cf-mitigated/i,
  /Just a moment/i,
  /No data available/i,
  /NEXT_NOT_FOUND/i,
  /Page Not Found/i,
  /\b404\b/i,
];

const pageScenarios = [
  {
    path: "/shorts/LOT",
    requiredText: [/LOTUS RESOURCES|LOT/i, /Short Interest|Shorted/i],
  },
  {
    path: "/housing",
    requiredText: [
      /Australian house prices|Housing/i,
      /Sydney|Melbourne|Brisbane|Perth|Adelaide|Hobart|Canberra|Darwin/i,
    ],
  },
  {
    path: "/news",
    requiredText: [/News|Shorted Newsroom/i, /MOST SHORTED|FEATURED INVESTIGATION|Market/i],
  },
  {
    path: "/market/2024-08-21",
    requiredText: [/ASX Short Positions|Market/i, /Top 50 Most Shorted Stocks|Stocks with Short Positions/i],
  },
  {
    path: "/reports",
    requiredText: [/Short Selling Reports/i, /Week 25, 2026/i],
  },
  {
    path: "/reports/weekly/2026-W25",
    requiredText: [/Top Shorted Stocks This Week/i, /Stocks Shorted/i, /Week 25, 2026/i],
  },
  {
    path: "/reports/monthly/2026-06",
    requiredText: [/Top Shorted Stocks This Month/i, /Stocks Shorted/i, /June 2026/i],
  },
  {
    path: "/reports/yearly/2025",
    requiredText: [/Year in Review/i, /ASX Short Selling/i, /Top Shorted Stocks/i],
  },
  {
    // Guards the July 2026 all-"Other" regression: when the industry data
    // fetch silently degrades, the page renders ONLY an "Other" group and no
    // real industry name appears. At least one of the perennially-largest
    // industries must be present for the release to promote.
    path: "/industry-intelligence",
    requiredText: [
      /Industry Intelligence/i,
      /Materials|Financial Services|Energy|Health Care|Software|Pharmaceuticals|Capital Goods/i,
    ],
  },
];

function isIgnorableFailedRequest(url, errorText) {
  return (
    errorText.includes("net::ERR_ABORTED") ||
    url.includes("google-analytics.com") ||
    url.includes("googletagmanager.com") ||
    url.includes("static.cloudflareinsights.com/beacon.min.js") ||
    url.includes("/_vercel/insights/")
  );
}

function isIgnorableAppApiFailure(url, status) {
  return status === 404 && url.includes("/GetCompanyTaxProfile");
}

function isIgnorableConsoleError(text, url = "") {
  return (
    text.includes("Failed to fetch RSC payload") ||
    text.includes("https://errors.authjs.dev#autherror") ||
    (text.includes("static.cloudflareinsights.com/beacon.min.js") &&
      text.includes("x-shorted-testing-bypass")) ||
    text === "Failed to load resource: net::ERR_FAILED" ||
    (url.includes("/cdn-cgi/rum") &&
      text.includes("Failed to load resource: the server responded with a status of 404")) ||
    (url.includes("/GetCompanyTaxProfile") &&
      text.includes("Failed to load resource: the server responded with a status of 404"))
  );
}

async function bodyText(page) {
  await page.waitForTimeout(1_500);
  return page.locator("body").innerText({ timeout: 20_000 });
}

function attachPageGuards(page) {
  const apiFailures = [];
  const failedRequests = [];
  const consoleErrors = [];

  page.on("response", (response) => {
    const url = response.url();
    const status = response.status();
    if (appApiPattern.test(url) && status >= 400 && !isIgnorableAppApiFailure(url, status)) {
      apiFailures.push(`${status} ${url}`);
    }
  });

  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText || "";
    const url = request.url();
    if (!isIgnorableFailedRequest(url, failure)) {
      failedRequests.push(`${request.method()} ${url} ${failure}`);
    }
  });

  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !isIgnorableConsoleError(message.text(), message.location().url)
    ) {
      consoleErrors.push(message.text());
    }
  });

  return { apiFailures, failedRequests, consoleErrors };
}

async function checkPage(context, scenario) {
  console.log(`check page ${scenario.path}`);
  const page = await context.newPage();
  const guards = attachPageGuards(page);

  try {
    const response = await page.goto(scenario.path, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    assert(response, `${scenario.path} did not return a response`);
    assert(response.status() < 400, `${scenario.path} returned HTTP ${response.status()}`);

    const text = await bodyText(page);
    for (const required of scenario.requiredText) {
      assert.match(text, required, `${scenario.path} missing required text ${required}`);
    }
    for (const forbidden of forbiddenPageText) {
      assert.doesNotMatch(text, forbidden, `${scenario.path} contains forbidden text ${forbidden}`);
    }

    assert.deepEqual(guards.apiFailures, [], `${scenario.path} had failing app API/RPC responses`);
    assert.deepEqual(guards.failedRequests, [], `${scenario.path} had non-ignorable failed requests`);
    assert.deepEqual(guards.consoleErrors, [], `${scenario.path} had console errors`);
  } finally {
    await page.close();
  }
}

async function checkNavigation(context) {
  console.log("check navigation /housing/vic/balwyn -> /top");
  const page = await context.newPage();
  const guards = attachPageGuards(page);

  try {
    const response = await page.goto("/housing/vic/balwyn?sal=20123", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    assert(response, "/housing/vic/balwyn did not return a response");
    assert(response.status() < 400, `/housing/vic/balwyn returned HTTP ${response.status()}`);

    await page.getByRole("link", { name: /top shorted/i }).first().click();
    await page.waitForURL("**/top", { timeout: 30_000 });

    const text = await bodyText(page);
    assert.match(text, /Top Shorted|Short Interest|Stocks/i, "/top missing top-shorted content");
    assert.deepEqual(guards.apiFailures, [], "client navigation had failing app API/RPC/static responses");
    assert.deepEqual(guards.failedRequests, [], "client navigation had non-ignorable failed requests");
    assert.deepEqual(guards.consoleErrors, [], "client navigation had console errors");
  } finally {
    await page.close();
  }
}

async function assertNoCloudflareChallenge(response, label) {
  assert.notEqual(response.headers()["cf-mitigated"] || "", "challenge", `${label} was challenged`);
  const text = await response.text();
  assert(!text.includes("Just a moment"), `${label} returned Cloudflare challenge HTML`);
  return text;
}

async function checkApiEdge() {
  console.log("check Cloudflare API edge");
  const api = await playwrightRequest.newContext({ extraHTTPHeaders: headers });

  try {
    const health = await api.get(`${apiBaseUrl}/health`);
    assert.equal(health.status(), 200, "/health status");
    await assertNoCloudflareChallenge(health, "/health");

    const stockData = await api.post(
      `${apiBaseUrl}/shorts.v1alpha1.ShortedStocksService/GetStockData`,
      {
        headers: { "Content-Type": "application/json" },
        data: { productCode: "BHP" },
      },
    );
    assert.equal(stockData.status(), 200, "GetStockData status");
    const stockJson = JSON.parse(await assertNoCloudflareChallenge(stockData, "GetStockData"));
    assert.equal(stockJson.productCode, "BHP");
    assert(Array.isArray(stockJson.points), "GetStockData points should be an array");
    assert(stockJson.points.length > 0, "GetStockData should return points");

    const topShorts = await api.post(
      `${apiBaseUrl}/shorts.v1alpha1.ShortedStocksService/GetTopShorts`,
      {
        headers: { "Content-Type": "application/json" },
        data: { limit: 7 },
      },
    );
    assert.equal(topShorts.status(), 200, "GetTopShorts status");
    const topJson = JSON.parse(await assertNoCloudflareChallenge(topShorts, "GetTopShorts"));
    assert(Array.isArray(topJson.timeSeries), "GetTopShorts timeSeries should be an array");
    assert(topJson.timeSeries.length > 0, "GetTopShorts should return timeSeries");
  } finally {
    await api.dispose();
  }
}

async function checkAuthBootstrap(browser) {
  console.log("check Firebase Google auth bootstrap");
  await checkFirebaseGoogleAuthBootstrap({
    browser,
    baseUrl,
    bypassSecret,
    userAgent,
  });
}

// Guards the July 2026 sitemap regression: runtime data-fetch failures
// (SKIP_STATIC_GENERATION at runtime, no-store fetches inside the ISR route)
// silently collapsed the sitemap to a ~1.5k-URL fallback with only 20 stock
// pages. The full sitemap carries ~800 /shorts/ URLs; require a healthy floor.
async function checkSitemap() {
  console.log("check sitemap coverage");
  const api = await playwrightRequest.newContext({ extraHTTPHeaders: headers });
  try {
    // First hit after a deploy regenerates at runtime (~15s fan-out).
    const resp = await api.get(`${baseUrl}/sitemap.xml`, { timeout: 60_000 });
    assert.equal(resp.status(), 200, "sitemap.xml status");
    const xml = await resp.text();
    const urlCount = (xml.match(/<loc>/g) ?? []).length;
    const stockCount = (xml.match(/\/shorts\/[A-Z0-9]+<\/loc>/g) ?? []).length;
    assert(
      urlCount >= 2500,
      `sitemap.xml has ${urlCount} URLs (expected >= 2500 — runtime data fetches are failing)`,
    );
    assert(
      stockCount >= 400,
      `sitemap.xml has ${stockCount} stock URLs (expected >= 400 — stock list fell back to the hardcoded fallback)`,
    );
  } finally {
    await api.dispose();
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices["Desktop Chrome"],
  baseURL: baseUrl,
  userAgent,
  extraHTTPHeaders: headers,
});

try {
  for (const scenario of pageScenarios) {
    await checkPage(context, scenario);
  }
  await checkNavigation(context);
  await checkApiEdge();
  await checkSitemap();
  await checkAuthBootstrap(browser);
  console.log("release smoke passed");
} finally {
  await context.close();
  await browser.close();
}
