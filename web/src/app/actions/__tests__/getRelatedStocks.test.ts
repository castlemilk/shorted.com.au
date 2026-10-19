/// <reference types="jest" />
import { describe, it, expect, beforeEach } from "@jest/globals";

jest.mock("../getStockDetails", () => ({ getStockDetails: jest.fn() }));
jest.mock("../industry/getIndustryData", () => ({ getIndustryStocks: jest.fn() }));
jest.mock("../company-logo-availability", () => ({ getVerifiedCompanyLogoUrls: jest.fn() }));

import { getRelatedStocks } from "../getRelatedStocks";
import { getStockDetails } from "../getStockDetails";
import { getIndustryStocks } from "../industry/getIndustryData";
import { getVerifiedCompanyLogoUrls } from "../company-logo-availability";

const mockDetails = getStockDetails as jest.Mock;
const mockIndustryStocks = getIndustryStocks as jest.Mock;
const mockLogoUrls = getVerifiedCompanyLogoUrls as jest.Mock;

const NONE = { stocks: [], industry: null, industrySlug: null };

describe("getRelatedStocks", () => {
  beforeEach(() => {
    mockDetails.mockReset();
    mockIndustryStocks.mockReset();
    mockLogoUrls.mockReset();
    mockLogoUrls.mockResolvedValue(new Map());
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

  // One lookup for the whole list, against the bucket's listing: a code the
  // bucket holds gets its logo, one it does not gets none (the letter avatar).
  it("carries a logo only for the codes the bucket holds", async () => {
    mockDetails.mockResolvedValue({ industry: "Capital Goods" });
    mockIndustryStocks.mockResolvedValue({
      stocks: [
        { code: "EOS", name: "EOS", shortPercent: 10.9 },
        { code: "SLX", name: "SLX", shortPercent: 8.2 },
        { code: "REH", name: "REH", shortPercent: 2.8 },
      ],
    });
    mockLogoUrls.mockResolvedValue(new Map([["SLX", "https://storage.googleapis.com/b/logos-normalized/SLX.png"]]));
    const related = await getRelatedStocks("EOS");
    expect(mockLogoUrls).toHaveBeenCalledTimes(1);
    expect(mockLogoUrls).toHaveBeenCalledWith(["SLX", "REH"]);
    expect(related.stocks.map((s) => [s.code, s.logoUrl])).toEqual([
      ["SLX", "https://storage.googleapis.com/b/logos-normalized/SLX.png"],
      ["REH", undefined],
    ]);
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
      expect(mockLogoUrls).not.toHaveBeenCalled();
    },
  );
});
