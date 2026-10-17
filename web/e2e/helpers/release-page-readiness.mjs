/**
 * Wait for streamed page content within one bounded deadline.
 * @param {import("@playwright/test").Page} page
 * @param {readonly RegExp[]} requiredText
 * @param {number} timeout
 * @returns {Promise<string>}
 */
export async function releasePageText(page, requiredText = [], timeout = 30_000) {
  await page.waitForFunction(
    (patterns) => {
      const text = document.body?.innerText ?? "";
      return patterns.every(({ source, flags }) => new RegExp(source, flags).test(text));
    },
    requiredText.map(({ source, flags }) => ({ source, flags })),
    { timeout },
  );
  return page.locator("body").innerText({ timeout });
}
