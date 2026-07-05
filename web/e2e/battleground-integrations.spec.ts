import { expect, test } from "@playwright/test";

test.describe("Battleground feature integrations", () => {
  test("rent-vs-buy calculator renders finite outputs and reacts to assumptions", async ({
    page,
  }) => {
    await page.goto("/housing/calculators?price=800000&state=NSW", {
      waitUntil: "domcontentloaded",
    });

    const heading = page.getByRole("heading", { name: "Rent vs buy" });
    const calculator = heading.locator(
      "xpath=ancestor::div[contains(@class, 'rounded-xl')][1]",
    );

    await expect(heading).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Interactive · rent vs buy")).toBeVisible();
    await expect(page.getByText("Buying after 10 yrs")).toBeVisible();
    await expect(page.getByText("Rent + invest net worth")).toBeVisible();
    await expect(
      page.getByRole("img", {
        name: "Net position over time, buying versus renting",
      }),
    ).toBeVisible();

    const before = await calculator.textContent();
    expect(before).toBeTruthy();
    expect(before!).not.toMatch(/NaN|Infinity/);

    await calculator.getByText("Assumptions").click();
    await calculator.getByRole("button", { name: "VIC" }).click();
    await expect(calculator.getByRole("button", { name: "VIC" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const after = await calculator.textContent();
    expect(after).toBeTruthy();
    expect(after!).not.toMatch(/NaN|Infinity/);
    expect(after).toContain("VIC duty");
  });
});
