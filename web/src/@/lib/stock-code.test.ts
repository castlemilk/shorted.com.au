import { hasStockPage } from "./stock-code";

describe("hasStockPage", () => {
  it.each(["BHP", "A2M", "360", "CBA", "gyg"])("accepts %s", (code) => {
    expect(hasStockPage(code)).toBe(true);
  });
  it.each(["SGLLV", "ATBHQ", "AB", "", "BH P", "BHP.AX"])("rejects %j", (code) => {
    expect(hasStockPage(code)).toBe(false);
  });
});
