/// <reference types="jest" />
import { describe, it, expect, beforeEach } from "@jest/globals";

jest.mock("../getStockDetails", () => ({ getStockDetails: jest.fn() }));
jest.mock("../industry/getIndustryData", () => ({ getIndustryStocks: jest.fn() }));

import { getRelatedStocks } from "../getRelatedStocks";
import { getStockDetails } from "../getStockDetails";
import { getIndustryStocks } from "../industry/getIndustryData";

const mockDetails = getStockDetails as jest.Mock;
const mockIndustryStocks = getIndustryStocks as jest.Mock;

const NONE = { stocks: [], industry: null, industrySlug: null };

describe("getRelatedStocks", () => {
  beforeEach(() => {
    mockDetails.mockReset();
    mockIndustryStocks.mockReset();
  });

  it("finds the stocks of a real industry, without the stock itself", async () => {
    mockDetails.mockResolvedValue({ industry: "Materials" });
    mockIndustryStocks.mockResolvedValue({
      stocks: [
        { code: "BHP", name: "BHP Group", shortPercent: 1.2 },
        { code: "RIO", name: "Rio Tinto", shortPercent: 0.8 },
      ],
    });
    const related = await getRelatedStocks("BHP");
    expect(mockIndustryStocks).toHaveBeenCalledWith("materials");
    expect(related).toEqual({
      stocks: [{ code: "RIO", name: "Rio Tinto", shortPercent: 0.8, industry: "Materials" }],
      industry: "Materials",
      industrySlug: "materials",
    });
  });

  // An ETF's "Not Applic" is not an industry: no "More Not Applic Stocks", no
  // /industry-intelligence?industry=not-applic link on the Company tab, and no
  // read of an industry list that has no such industry in it.
  it.each(["Not Applic", "Class Pend", "Other", "", undefined])(
    "has no industry for the placeholder %p, and reads no industry list",
    async (industry) => {
      mockDetails.mockResolvedValue({ industry });
      await expect(getRelatedStocks("VAS")).resolves.toEqual(NONE);
      expect(mockIndustryStocks).not.toHaveBeenCalled();
    },
  );
});
