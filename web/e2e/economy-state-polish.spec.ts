import { expect, test } from "@playwright/test";

test.describe("economy state polish", () => {
  test("surfaces the new state indicators and finance references", async ({ page }) => {
    await page.goto("/economy/nsw");

    await expect(page.getByRole("heading", { name: "Retail turnover" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Dwelling approvals" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Estimated resident population" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Finances breakdown" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Taxation revenue" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Current grants" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Employee expenses" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Interest expenses" })).toBeVisible();

    const sources = page.getByRole("heading", { name: "Sources & further reading" }).locator("..");
    const links = sources.getByRole("link");
    await expect(links).toHaveCount(3);
    await expect(links.first()).toHaveAttribute("href", /budget\.nsw\.gov\.au/);
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  test("offers retail and population-growth map metrics", async ({ page }) => {
    await page.goto("/economy");

    await expect(page.getByRole("button", { name: "Retail turnover" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Population growth (YoY)" })).toBeVisible();
  });
});
