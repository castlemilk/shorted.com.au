import { test, expect } from "@playwright/test";

test.describe("roadmap tree (public)", () => {
  test("shows tooltip on hover and zoom +/- works", async ({ page }) => {
    await page.goto("/roadmap", { waitUntil: "domcontentloaded" });

    // Ensure the title is visible
    await expect(page.getByRole("heading", { name: "Roadmap Tree" })).toBeVisible();

    const companyNode = page.getByTestId("node-company");
    const companyHitTarget = companyNode.locator("[data-hit-target='true']");
    await expect(companyNode).toBeVisible({ timeout: 5000 });

    // Hover the explicit node hit target; the SVG group bbox also includes labels.
    await companyHitTarget.hover();

    // Assert the interaction actually registered in React state.
    await expect(page.getByTestId("roadmap-tooltip-debug")).toHaveText("company", { timeout: 5000 });

    const tooltip = page.getByTestId("roadmap-tooltip");
    await expect(tooltip).toBeVisible({ timeout: 5000 });
    await expect(tooltip).toContainText("Company Intel");
    await expect(tooltip).toContainText("AI-powered company insights");

    // Capture current transform from the SVG stage group
    const stage = page.getByTestId("roadmap-stage");
    const before = await stage.getAttribute("transform");

    // Zoom in/out buttons should update transform scale
    await page.getByTestId("roadmap-zoom-in").click();
    await expect
      .poll(async () => stage.getAttribute("transform"))
      .not.toBe(before);
    const afterIn = await stage.getAttribute("transform");

    await page.getByTestId("roadmap-zoom-out").click();
    await expect
      .poll(async () => stage.getAttribute("transform"))
      .not.toBe(afterIn);
    const afterOut = await stage.getAttribute("transform");
    expect(afterOut).not.toEqual(afterIn);
  });

  test("marks Premium and API Access roadmap items", async ({ page }) => {
    await page.goto("/roadmap", { waitUntil: "domcontentloaded" });

    const accessKey = page.getByTestId("roadmap-access-key");
    await expect(accessKey.getByRole("heading", { name: "ACCESS" })).toBeVisible();
    await expect(accessKey.getByTestId("roadmap-access-premium")).toBeVisible();
    await expect(accessKey.getByTestId("roadmap-access-api_access")).toBeVisible();

    await expect(page.getByTestId("node-alerts")).toHaveAttribute(
      "data-entitlement",
      "premium",
    );
    await expect(page.getByTestId("node-rest-api")).toHaveAttribute(
      "data-entitlement",
      "api_access",
    );
    await expect(page.getByTestId("node-data-licensing")).toHaveAttribute(
      "data-entitlement",
      "enterprise",
    );
  });
});
