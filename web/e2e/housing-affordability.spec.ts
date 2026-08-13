import { expect, test, type Request } from "@playwright/test";

const AFFORDABILITY_MEASURES = [
  "cash_rate",
  "mortgage_rate_oo",
  "mortgage_rate_investor",
  "housing_credit_growth",
  "housing_credit_growth_oo",
  "housing_credit_growth_investor",
  "rents_index",
  "wage_index",
  "price_to_income",
  "investor_loan_share",
  "household_dwelling_assets",
  "household_net_worth",
  "household_liabilities",
] as const;

function affordabilityMeasure(request: Request): string | undefined {
  if (!request.url().includes("HousingService/GetHousePriceSeries")) {
    return undefined;
  }

  const body = request.postDataBuffer()?.toString("utf8") ?? "";
  return AFFORDABILITY_MEASURES.find((measure) => body.includes(measure));
}

test("derived index and affordability series stay attributed and viewport-lazy", async ({
  page,
}) => {
  const requestedMeasures = new Set<string>();
  page.on("request", (request) => {
    const measure = affordabilityMeasure(request);
    if (measure) requestedMeasures.add(measure);
  });

  try {
    await page.goto("/housing", { waitUntil: "domcontentloaded" });
  } catch (error) {
    test.skip(
      true,
      `Housing E2E server unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (await page.getByText(/House-price data is loading/i).isVisible()) {
    test.skip(true, "Housing overview API fixture is unavailable");
  }

  await expect(
    page.getByText(
      "Shorted rebase of ABS national mean dwelling prices · first quarter = 100",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Shorted-derived from ABS RES_DWELL_ST · earliest quarter = 100 · CC BY 4.0",
    ),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/RPPI|8-capital|to 2021/i);

  await page.waitForTimeout(750);
  expect([...requestedMeasures]).toEqual([]);

  const sectionHeading = page.getByRole("heading", {
    name: "Affordability & credit",
  });
  await sectionHeading.scrollIntoViewIfNeeded();
  await expect(sectionHeading).toBeVisible();

  await expect
    .poll(
      () =>
        ["cash_rate", "mortgage_rate_investor", "mortgage_rate_oo"].every(
          (measure) => requestedMeasures.has(measure),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);

  const ratesCard = page
    .getByRole("heading", { name: "Cash and mortgage rates" })
    .locator("..")
    .locator("..");
  const noData = ratesCard.getByText("No data available");
  const cashRateLegend = ratesCard.getByText("Cash rate", { exact: true });
  await expect
    .poll(
      async () => (await noData.isVisible()) || (await cashRateLegend.isVisible()),
      { timeout: 15_000 },
    )
    .toBe(true);
  if (await noData.isVisible()) {
    test.skip(true, "Housing rates series fixture returned no chartable data");
  }

  await expect(cashRateLegend).toBeVisible();
  await expect(
    ratesCard.getByText("Owner-occupier mortgage rate", { exact: true }),
  ).toBeVisible();
  await expect(
    ratesCard.getByText("Investor mortgage rate", { exact: true }),
  ).toBeVisible();
  await expect(
    ratesCard.getByText("Source: RBA Tables F1.1 & F6 · CC BY 4.0"),
  ).toBeVisible();
});
