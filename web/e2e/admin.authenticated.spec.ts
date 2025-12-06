import { test, expect } from "@playwright/test";

/**
 * Admin Dashboard Tests - Require Admin Authentication
 *
 * These tests verify:
 * 1. Admin users can access the dashboard
 * 2. Dashboard displays correct structure
 * 3. Sync status data is shown correctly
 */

test.describe("Admin Dashboard - Authenticated Admin", () => {
  test("can access admin dashboard", async ({ page }) => {
    await page.goto("/admin", { timeout: 15000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 });

    // Should be on admin page
    expect(page.url()).toContain("/admin");

    // Dashboard heading should be visible
    await expect(page.locator("h1").first()).toContainText("Admin", {
      timeout: 5000,
    });
  });

  test("displays system status card", async ({ page }) => {
    await page.goto("/admin", { timeout: 15000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 });

    // Should show status card with "Last Sync" heading
    await expect(page.getByRole("heading", { name: /last sync/i })).toBeVisible(
      { timeout: 5000 },
    );

    // Should show success rate card
    await expect(
      page.getByRole("heading", { name: /success rate/i }),
    ).toBeVisible({ timeout: 3000 });

    // Should show records updated card
    await expect(
      page.getByRole("heading", { name: /records updated/i }),
    ).toBeVisible({ timeout: 3000 });
  });

  test("displays sync history table", async ({ page }) => {
    await page.goto("/admin", { timeout: 15000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 });

    // Table should be present
    const table = page.locator("table");
    await expect(table).toBeVisible({ timeout: 5000 });

    // Table should have expected headers (case-insensitive text matching)
    await expect(
      page.locator("th").filter({ hasText: /Status/i }),
    ).toBeVisible();
    await expect(
      page.locator("th").filter({ hasText: /Started/i }),
    ).toBeVisible();
    await expect(
      page.locator("th").filter({ hasText: /Duration/i }),
    ).toBeVisible();
  });

  test("shows no data message when no sync history", async ({ page }) => {
    await page.goto("/admin", { timeout: 15000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 });

    // Either shows sync history rows OR "No sync history available" message
    const noDataMessage = page.getByText(/no sync history available/i);
    const tableRows = page.locator("table tbody tr");

    // One of these conditions should be true
    const hasData = (await tableRows.count()) > 0;
    const hasNoDataMessage = await noDataMessage.isVisible().catch(() => false);

    expect(hasData || hasNoDataMessage).toBeTruthy();
  });

  test("does not show error state", async ({ page }) => {
    await page.goto("/admin", { timeout: 15000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 });

    // Should not show error boundary
    await expect(page.getByText(/something went wrong/i)).not.toBeVisible({
      timeout: 1000,
    });

    // Should not show error in page content
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("Error:");
  });
});

test.describe("Admin Dashboard - Access Control", () => {
  // This test needs to run in a non-authenticated context
  // It creates its own fresh browser context without auth state
  test("redirects non-authenticated users to signin", async ({
    browser,
  }, testInfo) => {
    // Skip this test in authenticated project since it tests unauthenticated access
    if (testInfo.project.name.includes("authenticated")) {
      test.skip();
      return;
    }

    // Create a fresh context without auth state
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/admin", { timeout: 15000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 });

    // Should redirect to signin OR show signin content
    const url = page.url();
    const isSigninPage = url.includes("signin");
    const hasSigninContent = await page
      .getByText(/sign in/i)
      .isVisible()
      .catch(() => false);

    // Either redirected to signin OR seeing signin prompt
    expect(isSigninPage || hasSigninContent).toBeTruthy();

    await context.close();
  });
});
