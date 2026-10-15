/// <reference types="jest" />
import { STOCK_CODE_PATTERN } from "../stock-page-shared";

describe("STOCK_CODE_PATTERN", () => {
  it.each(["BHP", "A2M", "Z", "ABCD", "4DX"])("accepts %s", (code) => {
    expect(STOCK_CODE_PATTERN.test(code)).toBe(true);
  });

  it.each(["", "ABCDE", "BH-P", "BHP ", " BHP", "../X", "B.P"])("rejects %j", (code) => {
    expect(STOCK_CODE_PATTERN.test(code)).toBe(false);
  });
});
