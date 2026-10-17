import { test, expect, type Locator, type Page } from "./helpers/test";

/**
 * WCAG 2.2 SC 2.4.11, Focus Not Obscured, under the site header. The header is
 * stuck to the top of every page, translucent and blurred, so a control the
 * keyboard reaches in its band (0 to 65px) would be an unreadable smear. Once
 * the page has hydrated the header scrolls such a control clear of itself. On a
 * stock page the docked tab bar does the same below it (stock-tabs.spec.ts).
 *
 * A page without the tab bar, so what moves the link is the header alone, and
 * one whose content is not read from the API: a local build cannot prove itself
 * first-party to the edge, so its prerender of a data page (/top) can bake in
 * an empty list. Run against a local production build, as stock-tabs.spec.ts
 * is; no workflow runs it.
 */

const DESKTOP = { width: 1280, height: 900 };
const PAGE = "/blog";

const COLD = { timeout: 30_000 };

const siteHeader = (page: Page) => page.locator("header").first();

async function boxOf(locator: Locator): Promise<{ top: number; bottom: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("expected the element to have a box");
  return { top: box.y, bottom: box.y + box.height };
}

const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

// React marks a node once it has hydrated it, and the header's focus listener
// is attached by the effect that runs straight after.
async function headerHydrated(page: Page) {
  await page.waitForFunction(
    () => {
      const header = document.querySelector("header");
      return !!header && Object.keys(header).some((key) => key.startsWith("__reactFiber$"));
    },
    undefined,
    COLD,
  );
}

test.describe("focus under the site header", () => {
  test.use({ viewport: DESKTOP });

  test("a link the keyboard reaches under the header is scrolled clear of it", async ({ page }) => {
    await page.goto(PAGE);
    await headerHydrated(page);
    const header = siteHeader(page);
    // The first link in the content well down the page, so the page can scroll
    // it up under the header.
    const links = page.locator("main a[href]");
    await expect(links.first()).toBeVisible(COLD);
    const index = await links.evaluateAll((els) =>
      els.findIndex((el) => el.getBoundingClientRect().top + window.scrollY > 900),
    );
    expect(index, "a link far enough down to scroll up under the header").toBeGreaterThanOrEqual(0);
    const link = links.nth(index);

    // A key press, so the focus that follows is a keyboard's (:focus-visible).
    // Tab moves focus to the first control and the page to the top, so the
    // page is placed after it.
    await page.keyboard.press("Tab");
    await link.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 20));
    const head = await boxOf(header);
    expect(head.top, "the header is stuck at the top").toBeLessThanOrEqual(1);
    expect((await boxOf(link)).top, "the link starts under the header").toBeLessThan(head.bottom);

    await link.focus();
    await expect(link).toBeFocused();
    await expect
      .poll(async () => (await boxOf(link)).top, {
        message: "the focused link is scrolled out from under the header",
      })
      .toBeGreaterThanOrEqual(head.bottom);
    expect((await boxOf(link)).top, "and lands 8px under it, no further").toBeLessThanOrEqual(head.bottom + 9);
  });

  test("Tab across the header's own controls does not move the page", async ({ page }) => {
    await page.goto(PAGE);
    await headerHydrated(page);
    await page.evaluate(() => window.scrollTo(0, 1200));
    const before = await scrollY(page);
    expect(before, "the page is scrolled").toBeGreaterThan(0);

    await siteHeader(page).getByRole("link").first().focus();
    let steps = 0;
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const inHeader = await page.evaluate(() => document.activeElement?.closest("header") !== null);
      if (!inHeader) break;
      steps += 1;
      expect(await scrollY(page), `Tab onto header control ${steps + 1} moved the page`).toBe(before);
    }
    expect(steps, "Tab crossed at least two of the header's controls").toBeGreaterThanOrEqual(2);
  });
});
