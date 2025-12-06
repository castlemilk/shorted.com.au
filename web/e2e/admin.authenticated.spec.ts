import { test, expect } from "@playwright/test";

/**
 * Admin Dashboard Tests - Require Admin Authentication
 */

test.describe("Admin Dashboard - Authenticated Admin", () => {
  test("can access admin dashboard", async ({ page }) => {
    // Navigate with short timeout
    await page.goto("/admin", { timeout: 15000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 });

    console.log("Current URL:", page.url());

    // Quick check - are we on the right page?
    const url = page.url();
    expect(url).toContain("/admin");

    // Get page content immediately for debugging
    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 3000 })
      .catch(() => "FAILED TO GET BODY");
    console.log("Page content:", bodyText.substring(0, 1000));

    // Check for common error states
    const hasError =
      bodyText.includes("Error") || bodyText.includes("Something went wrong");
    if (hasError) {
      console.log("ERROR DETECTED ON PAGE");
    }

    // Now verify dashboard elements with short timeout
    const h1 = page.locator("h1").first();
    const h1Text = await h1
      .innerText({ timeout: 3000 })
      .catch(() => "NO H1 FOUND");
    console.log("H1 text:", h1Text);

    // Assertions
    expect(h1Text.toLowerCase()).toContain("admin");

    // Table should be present (sync history)
    await expect(page.locator("table")).toBeVisible({ timeout: 3000 });
  });
});
