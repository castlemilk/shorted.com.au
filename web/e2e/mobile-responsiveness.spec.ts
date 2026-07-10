import { test, expect, type Page } from "@playwright/test";

/**
 * Mobile responsiveness regression net for the chart-bearing surfaces.
 *
 * Guards against the two classes of defect found in July 2026:
 *  1. Fixed-width control rows (w-48 selects, non-wrapping button clusters)
 *     forcing page-level horizontal scroll on phones.
 *  2. Chart toolbars whose controls get clipped by card overflow, leaving
 *     period buttons unreachable on mobile.
 */

const MOBILE = { width: 390, height: 844 };
const SMALL_MOBILE = { width: 360, height: 780 };

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

test.describe("mobile responsiveness — homepage", () => {
  for (const viewport of [MOBILE, SMALL_MOBILE]) {
    test(`no horizontal page overflow at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      // Let the client-only dashboard widgets (TopShorts, treemap) hydrate.
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await page.waitForTimeout(2000);

      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("mobile responsiveness — stock page", () => {
  test("no horizontal overflow and chart period controls reachable at 390px", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/shorts/PLS");
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(2000);

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

    // The chart toolbar's period buttons must all be visible INSIDE the
    // viewport width (previously the non-wrapping cluster was clipped by the
    // card's overflow-hidden, hiding 1Y/2Y/MAX).
    const periodGroup = page.getByRole("group", { name: "Period" });
    await periodGroup.scrollIntoViewIfNeeded();
    for (const label of ["1M", "3M", "6M", "1Y", "2Y", "MAX"]) {
      const button = periodGroup.getByRole("button", { name: label });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box, `period button ${label} has a box`).toBeTruthy();
      expect(
        box!.x + box!.width,
        `period button ${label} fits in the viewport`,
      ).toBeLessThanOrEqual(MOBILE.width + 1);
      expect(box!.x, `period button ${label} not clipped left`).toBeGreaterThanOrEqual(-1);
    }
  });
});
