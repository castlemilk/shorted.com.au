import { expect, test, type APIResponse, type Page } from "@playwright/test";
import {
  cloudflareTestingBypassHeaders,
  cloudflareTestingDefaultUserAgent,
} from "./helpers/cloudflare-testing-bypass";

test.setTimeout(90_000);

const apiBaseUrl =
  process.env.RELEASE_API_BASE_URL ||
  process.env.API_BASE_URL ||
  "https://api.shorted.com.au";

test.use({
  userAgent: cloudflareTestingDefaultUserAgent,
  extraHTTPHeaders: cloudflareTestingBypassHeaders(),
});

const appApiPattern =
  /\/(_next\/static\/|shorts\.v1alpha1\.|marketdata\.v1\.|chat\.v1\.|register\.v1\.|api\/)/;

const expectManualCloudflareRum = process.env.EXPECT_MANUAL_CLOUDFLARE_RUM === "1";

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
    requiredText: [/Australian house prices|Housing/i, /Sydney|Melbourne|Brisbane|Perth|Adelaide|Hobart|Canberra|Darwin/i],
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
] as const;

function releaseHeaders(): Record<string, string> {
  return cloudflareTestingBypassHeaders({ includeUserAgent: true });
}

function isIgnorableFailedRequest(url: string, errorText: string): boolean {
  return (
    errorText.includes("net::ERR_ABORTED") ||
    url.includes("google-analytics.com") ||
    url.includes("googletagmanager.com") ||
    url.includes("static.cloudflareinsights.com/beacon.min.js") ||
    url.includes("/_vercel/insights/")
  );
}

function isIgnorableConsoleError(text: string, url = ""): boolean {
  return (
    text.includes("Failed to fetch RSC payload") ||
    text.includes("https://errors.authjs.dev#autherror") ||
    (text.includes("static.cloudflareinsights.com/beacon.min.js") &&
      text.includes("x-shorted-testing-bypass")) ||
    text === "Failed to load resource: net::ERR_FAILED" ||
    (url.includes("/cdn-cgi/rum") &&
      text.includes("Failed to load resource: the server responded with a status of 404")) ||
    (url.includes("/shorts.v1alpha1.ShortedStocksService/GetCompanyTaxProfile") &&
      text.includes("Failed to load resource: the server responded with a status of 404"))
  );
}

function isIgnorableAppApiFailure(url: string, status: number): boolean {
  return status === 404 && url.includes("/shorts.v1alpha1.ShortedStocksService/GetCompanyTaxProfile");
}

async function assertNoCloudflareChallenge(response: APIResponse): Promise<string> {
  expect(response.headers()["cf-mitigated"] ?? "").not.toBe("challenge");
  const text = await response.text();
  expect(text).not.toContain("Just a moment");
  return text;
}

async function pageText(page: Page): Promise<string> {
  await page.waitForTimeout(1_500);
  return page.locator("body").innerText({ timeout: 20_000 });
}

async function assertManualCloudflareRumBeacon(page: Page, path: string): Promise<void> {
  if (!expectManualCloudflareRum) {
    return;
  }

  const script = page.locator(
    'script[src="https://static.cloudflareinsights.com/beacon.min.js"][data-cf-beacon]',
  );
  await expect(script, `${path} missing Cloudflare Web Analytics beacon`).toHaveCount(1);

  const config = JSON.parse((await script.first().getAttribute("data-cf-beacon")) || "{}") as {
    send?: { to?: unknown };
    token?: string;
    spa?: unknown;
  };
  expect(config.token, `${path} has invalid Cloudflare Web Analytics token`).toMatch(
    /^[a-z0-9]{32}$/i,
  );
  expect(config.send?.to, `${path} should post RUM to the same-origin Cloudflare endpoint`).toBe(
    "/cdn-cgi/rum",
  );
  expect(config.spa, `${path} should use Cloudflare's default SPA tracking`).toBeUndefined();
}

for (const scenario of pageScenarios) {
  test(`${scenario.path} renders real data without runtime/API regressions`, async ({ page }) => {
    const apiFailures: string[] = [];
    const failedRequests: string[] = [];
    const consoleErrors: string[] = [];

    await page.setExtraHTTPHeaders(releaseHeaders());

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

    const response = await page.goto(scenario.path, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });

    expect(response?.status(), `${scenario.path} HTTP status`).toBeLessThan(400);

    const text = await pageText(page);
    for (const required of scenario.requiredText) {
      expect(text, `${scenario.path} missing required text ${required}`).toMatch(required);
    }
    for (const forbidden of forbiddenPageText) {
      expect(text, `${scenario.path} contains forbidden text ${forbidden}`).not.toMatch(forbidden);
    }

    await assertManualCloudflareRumBeacon(page, scenario.path);

    expect(apiFailures, `${scenario.path} had failing app API/RPC responses`).toEqual([]);
    expect(failedRequests, `${scenario.path} had non-ignorable failed requests`).toEqual([]);
    expect(consoleErrors, `${scenario.path} had console errors`).toEqual([]);
  });
}

test("housing suburb navigation to top shorted does not load stale app chunks", async ({ page }) => {
  const apiFailures: string[] = [];
  const failedRequests: string[] = [];
  const consoleErrors: string[] = [];

  await page.setExtraHTTPHeaders(releaseHeaders());

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

  const response = await page.goto("/housing/vic/balwyn?sal=20123", {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });

  expect(response?.status(), "/housing/vic/balwyn HTTP status").toBeLessThan(400);

  await page.getByRole("link", { name: /top shorted/i }).first().click();
  await page.waitForURL("**/top", { timeout: 30_000 });

  const text = await pageText(page);
  expect(text, "/top missing top-shorted content after client navigation").toMatch(
    /Top Shorted|Short Interest|Stocks/i,
  );

  expect(apiFailures, "client navigation had failing app API/RPC/static responses").toEqual([]);
  expect(failedRequests, "client navigation had non-ignorable failed requests").toEqual([]);
  expect(consoleErrors, "client navigation had console errors").toEqual([]);
});

test("Cloudflare API edge returns data without bot challenges", async ({ request }) => {
  const health = await request.get(`${apiBaseUrl}/health`, {
    headers: releaseHeaders(),
  });
  expect(health.status()).toBe(200);
  await assertNoCloudflareChallenge(health);

  const stockData = await request.post(
    `${apiBaseUrl}/shorts.v1alpha1.ShortedStocksService/GetStockData`,
    {
      headers: {
        ...releaseHeaders(),
        "Content-Type": "application/json",
      },
      data: { productCode: "BHP" },
    },
  );
  expect(stockData.status()).toBe(200);
  const stockText = await assertNoCloudflareChallenge(stockData);
  const stockJson = JSON.parse(stockText) as {
    productCode?: string;
    points?: unknown[];
  };
  expect(stockJson.productCode).toBe("BHP");
  expect(Array.isArray(stockJson.points)).toBe(true);
  expect(stockJson.points?.length ?? 0).toBeGreaterThan(0);

  const topShorts = await request.post(
    `${apiBaseUrl}/shorts.v1alpha1.ShortedStocksService/GetTopShorts`,
    {
      headers: {
        ...releaseHeaders(),
        "Content-Type": "application/json",
      },
      data: { limit: 7 },
    },
  );
  expect(topShorts.status()).toBe(200);
  const topText = await assertNoCloudflareChallenge(topShorts);
  const topJson = JSON.parse(topText) as {
    timeSeries?: unknown[];
  };
  expect(Array.isArray(topJson.timeSeries)).toBe(true);
  expect(topJson.timeSeries?.length ?? 0).toBeGreaterThan(0);
});
