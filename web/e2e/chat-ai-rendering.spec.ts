import { expect, test } from "@playwright/test";

test.describe("AI chat rendering", () => {
  test("renders markdown tables, stock cards, and short-interest charts", async ({
    page,
  }) => {
    const response = await page.goto("/e2e-chat-render", {
      waitUntil: "domcontentloaded",
    });
    if (response?.status() === 404 && process.env.BASE_URL) {
      test.skip(true, "E2E chat render harness is disabled on this deployment");
    }

    await expect(page.getByTestId("chat-render-smoke")).toBeVisible();
    await expect(page.locator("table")).toContainText("Latest short interest");
    await expect(page.locator("table")).toContainText("6.42%");
    await expect(page.getByTestId("chat-stock-card")).toBeVisible();
    await expect(page.getByTestId("chat-short-chart")).toBeVisible();
    await expect(page.getByTestId("chat-stock-card")).toContainText(
      "ZIP Co Limited",
    );
    await expect(page.getByTestId("chat-short-chart")).toContainText(
      "ZIP short interest",
    );
  });
});
