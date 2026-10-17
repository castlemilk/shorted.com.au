// Run with: node --test scripts/tests/mcp-app.test.mjs
// Uses the existing web Playwright dependency and a simulated MCP host. No
// credentials, production API calls, or running Next.js server are needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "../../web/node_modules/playwright/index.mjs";

const source = await readFile(
  new URL(
    "../../services/shorts/internal/mcp/ui/overview.html",
    import.meta.url,
  ),
  "utf8",
);
const snapshot = {
  jobs: [
    {
      name: "shorted-picks",
      displayName: "Stock picks",
      category: "Market",
      type: "job",
      region: "us-central1",
      health: "warning",
      lastRunStatus: "succeeded",
      lastRunAt: "2026-10-07T01:00:00Z",
      runningExecution: "shorted-picks-old",
      runningExecutions: [
        {
          executionName: "shorted-picks-old",
          runningCount: 1,
          taskCount: 2,
          startedAt: "2026-10-06T10:00:00Z",
        },
      ],
      scheduleHuman: "Daily at 15:00",
      message: "Older execution is still active.",
    },
    {
      name: "housing-crawl-delta",
      displayName: "Housing crawl",
      type: "rig",
      health: "warning",
      lastRunStatus: "failed",
      message: "Rig heartbeat is overdue.",
    },
    {
      name: "enrichment-queue",
      displayName: "Company enrichment queue",
      type: "queue",
      health: "running",
      runningCount: 3,
      lastRunStatus: "running",
    },
  ],
  observedAt: "2026-10-07T02:00:00Z",
  stale: false,
  incomplete: true,
  warnings: ["Housing queue task detail is not available."],
  sources: [
    { name: "cloud_run", status: "available", detail: "Configured regions." },
    {
      name: "housing_crawl",
      status: "unknown",
      detail: "Last rig report only.",
    },
  ],
};
const market = {
  period: "1M",
  count: 2,
  stocks: [
    {
      code: "BHP",
      name: "BHP Group",
      industry: "Materials",
      percent_shorted: 1.24,
    },
    {
      code: "CBA",
      name: "Commonwealth Bank",
      industry: "Financials",
      percent_shorted: 0.62,
    },
  ],
};
async function mount(page, mode, { initial = true } = {}) {
  await page.setContent(
    "<style>body{margin:0}iframe{width:100%;height:100vh;border:0;display:block}</style>",
  );
  await page.evaluate(
    ({ html, mode, initial, snapshot, market }) => {
      window.calls = [];
      window.failNext = false;
      const iframe = document.createElement("iframe");
      iframe.title = "Shorted";
      window.addEventListener("message", (event) => {
        if (event.source !== iframe.contentWindow) return;
        const msg = event.data;
        window.calls.push(msg);
        const post = (value) =>
          iframe.contentWindow.postMessage({ jsonrpc: "2.0", ...value }, "*");
        if (msg.method === "ui/initialize") {
          post({
            id: msg.id,
            result: {
              hostCapabilities: {
                serverTools: {},
                message: {},
                updateModelContext: {},
              },
              hostContext: {
                theme: "light",
                availableDisplayModes: ["inline", "fullscreen"],
                displayMode: "inline",
              },
            },
          });
          if (initial)
            setTimeout(
              () =>
                post({
                  method: "ui/notifications/tool-result",
                  params: {
                    structuredContent: mode === "admin" ? snapshot : market,
                  },
                }),
              0,
            );
        } else if (msg.method === "tools/call") {
          if (window.failNext) {
            window.failNext = false;
            post({
              id: msg.id,
              result: {
                isError: true,
                content: [{ type: "text", text: "jobs:read scope required" }],
              },
            });
            return;
          }
          let data;
          switch (msg.params.name) {
            case "list_async_jobs":
              data = snapshot;
              break;
            case "list_top_shorts":
              data = market;
              break;
            case "get_stock":
              data = {
                code: msg.params.arguments.code,
                name:
                  msg.params.arguments.code === "WOW"
                    ? "Woolworths Group"
                    : "BHP Group",
                percent_shorted: 1.24,
                industry: "Materials",
              };
              break;
            case "list_job_executions":
              data = {
                executions: [
                  {
                    executionName: "shorted-picks-old",
                    status: "running",
                    startedAt: "2026-10-06T10:00:00Z",
                    logUri:
                      "https://console.cloud.google.com/logs/query?project=test",
                  },
                ],
                ...(msg.params.arguments.page_token
                  ? {}
                  : { nextPageToken: "page2" }),
              };
              break;
            case "get_job_execution":
              data = { status: "succeeded", runningCount: 0 };
              break;
            case "list_enrichment_jobs":
              data = {
                jobs: [
                  {
                    id: "e1",
                    stockCode: "BHP",
                    status: "processing",
                    startedAt: "2026-10-07T00:00:00Z",
                  },
                ],
                total: 1,
              };
              break;
            default:
              post({ id: msg.id, error: { message: "unexpected tool" } });
              return;
          }
          post({ id: msg.id, result: { structuredContent: data } });
        } else if (msg.id !== undefined)
          post({
            id: msg.id,
            result:
              msg.method === "ui/request-display-mode"
                ? { mode: msg.params.mode }
                : {},
          });
      });
      iframe.srcdoc = html.replaceAll("__SHORTED_MODE__", mode);
      document.body.append(iframe);
    },
    { html: source, mode, initial, snapshot, market },
  );
  const frame = page.frameLocator("iframe");
  await frame.locator("#rows tr").first().waitFor();
  return frame;
}

test("MCP apps render initial data, filter, inspect executions and use host messages", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let frame = await mount(page, "admin");
    assert.equal(await frame.locator("h1").innerText(), "Asynchronous jobs");
    assert.equal(await frame.locator("#rows tr").count(), 3);
    await page.waitForTimeout(1700);
    assert.equal(
      await page.evaluate(
        () => calls.filter((c) => c.method === "tools/call").length,
      ),
      0,
      "initial render must not repeat the entrypoint call",
    );
    await frame.locator("#status").selectOption("running");
    assert.equal(await frame.locator("#rows tr").count(), 2);
    await frame.locator("#query").fill("picks");
    assert.equal(await frame.locator("#rows tr").count(), 1);
    await frame
      .getByRole("button", { name: "Stock picks", exact: true })
      .click();
    await frame.getByRole("button", { name: "Load execution history" }).click();
    await frame.getByRole("button", { name: "More executions" }).waitFor();
    await frame
      .getByRole("button", { name: "Current status", exact: true })
      .click();
    await frame
      .locator("#detail")
      .getByText("succeeded · 0 tasks running — ", { exact: false })
      .waitFor();
    await frame.getByRole("button", { name: "More executions" }).click();
    assert.equal(
      await frame
        .getByRole("button", { name: "Current status", exact: true })
        .count(),
      2,
    );
    await frame.getByRole("button", { name: "Discuss this job" }).click();
    await page.waitForFunction(() =>
      calls.some((c) => c.method === "ui/message"),
    );
    assert.ok(
      await page.evaluate(() =>
        calls.some((c) => c.method === "ui/update-model-context"),
      ),
    );
    await frame.locator("#query").fill("");
    await frame.locator("#status").selectOption("");
    await frame
      .getByRole("button", { name: "Company enrichment queue", exact: true })
      .click();
    await frame
      .getByRole("button", { name: "Inspect queued jobs", exact: true })
      .click();
    await frame
      .locator("#detail")
      .getByText("1 queued jobs", { exact: true })
      .waitFor();
    assert.ok(
      await page.evaluate(() =>
        calls.some(
          (c) =>
            c.method === "tools/call" &&
            c.params.name === "list_enrichment_jobs" &&
            c.params.arguments.status === "queued",
        ),
      ),
    );
    await frame
      .getByRole("button", { name: "Stock picks", exact: true })
      .click();
    const shots = process.env.MCP_APP_SCREENSHOTS;
    if (shots) {
      await mkdir(shots, { recursive: true });
      await page.screenshot({ path: shots + "/admin-desktop.png" });
    }
    await page.evaluate(() =>
      document.querySelector("iframe").contentWindow.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: {
            theme: "dark",
            "openai/deepLink": { url: "/jobs/us-central1/shorted-picks" },
          },
        },
        "*",
      ),
    );
    await frame.locator('html[data-theme="dark"]').waitFor();
    assert.equal(await frame.locator("#query").inputValue(), "shorted-picks");
    await page.setViewportSize({ width: 390, height: 844 });
    if (shots) await page.screenshot({ path: shots + "/admin-mobile.png" });
    assert.equal(
      await frame.locator("body").evaluate((e) => e.scrollWidth <= innerWidth),
      true,
      "mobile must not overflow the document",
    );
    await page.evaluate(() => (window.failNext = true));
    await frame.getByRole("button", { name: "Refresh", exact: true }).click();
    await frame
      .getByRole("alert")
      .getByText("jobs:read scope required")
      .waitFor();
    await page.close();
    const publicPage = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    publicPage.on("pageerror", (e) => errors.push(e.message));
    frame = await mount(publicPage, "market");
    await frame.locator("#query").fill("BHP");
    assert.equal(await frame.locator("#rows tr").count(), 1);
    await frame.getByRole("button", { name: "BHP", exact: true }).click();
    await frame.getByRole("heading", { name: "BHP · BHP Group" }).waitFor();
    if (shots)
      await publicPage.screenshot({ path: shots + "/public-desktop.png" });
    await publicPage.evaluate(() =>
      document.querySelector("iframe").contentWindow.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: { "openai/deepLink": { url: "/stocks/WOW" } },
        },
        "*",
      ),
    );
    await frame
      .getByRole("heading", { name: "WOW · Woolworths Group" })
      .waitFor();
    assert.equal(
      await frame.locator("#rows tr").count(),
      0,
      "deep link can inspect a stock outside the ranking",
    );
    assert.deepEqual(errors, []);
    await publicPage.close();
  } finally {
    await browser.close();
  }
});

test("Missing initial host result recovers with exactly one read", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await mount(page, "admin", { initial: false });
    assert.equal(
      await page.evaluate(
        () => calls.filter((c) => c.method === "tools/call").length,
      ),
      1,
    );
  } finally {
    await browser.close();
  }
});
