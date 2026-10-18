/**
 * Wait for streamed page content within one bounded deadline.
 * @param {import("@playwright/test").Page} page
 * @param {readonly RegExp[]} requiredText
 * @param {number} timeout
 * @returns {Promise<string>}
 */
export async function releasePageText(page, requiredText = [], timeout = 30_000) {
  const patterns = requiredText.map(({ source, flags }) => ({ source, flags }));
  const deadline = performance.now() + timeout;
  const remaining = () => {
    const time = deadline - performance.now();
    if (time <= 0) throw new Error("Timed out waiting for required page text");
    return time;
  };

  for (;;) {
    await page.waitForFunction(
      (patterns) => {
        const text = document.body?.innerText ?? "";
        return patterns.every(({ source, flags }) => new RegExp(source, flags).test(text));
      },
      patterns,
      { timeout: remaining() },
    );
    const text = await page.locator("body").innerText({ timeout: remaining() });
    // Streaming/hydration can replace ready content between these two reads.
    if (patterns.every(({ source, flags }) => new RegExp(source, flags).test(text))) return text;
  }
}
