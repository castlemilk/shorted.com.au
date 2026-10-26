import { STOCK_TAB_TITLE_MAX, stockTabTitle } from "../stock-tab-title";

// The code and topic lead; the company follows only when the whole title fits
// the 60 characters before " | Shorted".
describe("stockTabTitle", () => {
  const topic = "Company Profile: Directors & Insiders";

  it("appends a company that fits", () => {
    expect(stockTabTitle("DRO", topic, "Droneshield")).toBe(
      "DRO Company Profile: Directors & Insiders | Droneshield",
    );
  });

  it("leaves out a company that would push the title past the budget", () => {
    const title = stockTabTitle("CBA", topic, "Commonwealth Bank of Australia");
    expect(title).toBe("CBA Company Profile: Directors & Insiders");
    expect(title.length).toBeLessThanOrEqual(STOCK_TAB_TITLE_MAX);
  });

  it("does not repeat the code when it stands in for the company name", () => {
    expect(stockTabTitle("DRO", topic, "DRO")).toBe("DRO Company Profile: Directors & Insiders");
    expect(stockTabTitle("DRO", topic, "")).toBe("DRO Company Profile: Directors & Insiders");
  });
});
