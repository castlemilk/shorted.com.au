import { test, expect } from "@playwright/test";

const stockCode = "CBA";

test.describe("Stock community authenticated flows", () => {
  test.skip(
    !process.env.FIRESTORE_EMULATOR_HOST,
    "FIRESTORE_EMULATOR_HOST is required for stock community authenticated e2e",
  );

  test("signed-in user can create a thread, add a comment, and create a pulse", async ({
    page,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const threadTitle = `E2E conviction thread ${suffix}`;
    const threadBody = "The setup looks cleaner after the flush and this should persist.";
    const commentBody = "The downgrade looks fully priced by now.";
    const pulseBody = `Pulse update ${suffix}`;

    await page.goto(`/shorts/${stockCode}?tab=community`);

    await expect(page).not.toHaveURL(/signin/);
    await expect(
      page.getByRole("button", { name: /start a thread/i }),
    ).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: /start a thread/i }).click();
    await page.getByLabel(/thread title/i).fill(threadTitle);
    await page.getByLabel(/thread body/i).fill(threadBody);
    await page.getByRole("button", { name: /post thread/i }).click();

    await expect(page.getByText(threadTitle)).toBeVisible({ timeout: 15000 });

    await page.getByRole("link", { name: new RegExp(threadTitle) }).click();

    await expect(
      page.getByText(threadTitle, { exact: true }),
    ).toBeVisible({ timeout: 15000 });

    await page.getByLabel(/comment body/i).fill(commentBody);
    await page.getByRole("button", { name: /post comment/i }).click();
    await expect(page.getByText(commentBody)).toBeVisible({ timeout: 15000 });

    await page.goto(`/shorts/${stockCode}?tab=community`);
    await page.getByRole("button", { name: /drop a pulse/i }).click();
    await page.getByLabel(/pulse update/i).fill(pulseBody);
    await page.getByRole("button", { name: /post pulse/i }).click();
    await expect(page.getByText(pulseBody)).toBeVisible({ timeout: 15000 });
  });

  test("signed-out browser state shows the sign-in prompt", async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`${baseURL}/shorts/${stockCode}?tab=community`);
    await expect(
      page.getByRole("link", { name: /sign in to post/i }),
    ).toBeVisible({ timeout: 15000 });

    await context.close();
  });
});
