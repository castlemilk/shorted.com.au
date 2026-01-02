import { test, expect } from "@playwright/test";

test.describe("roadmap tree (public)", () => {
  test("shows tooltip on hover and zoom +/- works", async ({ page }) => {
    await page.goto("/roadmap", { waitUntil: "domcontentloaded" });

    // Ensure the title is visible
    await expect(page.getByRole("heading", { name: "Roadmap Tree" })).toBeVisible();

    const analyticsNode = page.getByTestId("node-analytics");
    await expect(analyticsNode).toBeVisible({ timeout: 5000 });

    // Hover directly on the node element
    await analyticsNode.hover();

    // Assert the interaction actually registered in React state.
    await expect(page.getByTestId("roadmap-tooltip-debug")).toHaveText("analytics", { timeout: 5000 });

    const tooltip = page.getByTestId("roadmap-tooltip");
    await expect(tooltip).toBeVisible({ timeout: 5000 });
    await expect(tooltip).toContainText("Analytics");
    await expect(tooltip).toContainText("Comprehensive charting and analytics tools");

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
});


