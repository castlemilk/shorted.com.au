import { expect, test } from "@playwright/test";

test("legacy suburb explorer redirects to the housing hub", async ({ page }) => {
  const response = await page.goto("/housing/suburbs");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/housing$/);
  await expect(page.getByRole("heading", { name: "Australian house prices" })).toBeVisible();
});

test("Widow-Maker links into the live housing surfaces", async ({ page }) => {
  await page.goto("/features/the-widow-maker");

  await expect(page.getByRole("link", { name: "House prices →" })).toHaveAttribute("href", "/housing");
  await expect(page.getByRole("link", { name: "Price drops →" })).toHaveAttribute("href", "/price-drops");
  await expect(page.getByRole("link", { name: "Calculators →" })).toHaveAttribute("href", "/housing/calculators");
});

test("housing hub links back to the featured investigation", async ({ page }) => {
  await page.goto("/housing");

  await expect(page.getByRole("link", { name: /Read the investigation/ })).toHaveAttribute(
    "href",
    "/features/the-widow-maker",
  );
});

test("economy state pages link to their matching housing explorer", async ({ page }) => {
  await page.goto("/economy/vic");

  await expect(page.getByRole("link", { name: /Open Victoria housing/ })).toHaveAttribute(
    "href",
    "/housing/vic",
  );
});

test("clean suburb URLs render and old trailing-hyphen URLs canonicalize", async ({ page }) => {
  const cleanResponse = await page.goto("/housing/vic/abbotsford-vic");
  expect(cleanResponse?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /abbotsford/i })).toBeVisible();

  const legacyResponse = await page.goto("/housing/vic/abbotsford-vic-");
  expect(legacyResponse?.status()).toBe(200);
  await expect(page).toHaveURL(/\/housing\/vic\/abbotsford-vic$/);
});
