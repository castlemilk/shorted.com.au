const getStock = jest.fn();
jest.mock("~/app/actions/getStock", () => ({ getStock: (...a: unknown[]) => getStock(...a) }));

import { stockTabMetadata } from "../stock-tab-metadata";

describe("stockTabMetadata", () => {
  beforeEach(() => getStock.mockReset());

  it("builds title, canonical, alternates and cards from the cleaned company name", async () => {
    getStock.mockResolvedValue({ name: "BHP GROUP LIMITED ORDINARY", industry: "Materials", percentageShorted: 1.58 });
    const md = await stockTabMetadata({
      code: "BHP", tab: "financials",
      title: (c) => `BHP Financials: Results, Ratios & Statements | ${c}`,
      description: (c) => `${c} results.`,
    });
    expect(md.title).toBe("BHP Financials: Results, Ratios & Statements | BHP Group");
    expect(md.alternates?.canonical).toBe("https://shorted.com.au/shorts/BHP/financials");
    expect(md.openGraph?.url).toBe("https://shorted.com.au/shorts/BHP/financials");
    expect(md.robots).toBeUndefined();
  });

  it("inherits the stock's noindex gate and fails open on a transient read", async () => {
    getStock.mockResolvedValue({ name: "", industry: "", percentageShorted: 0 });
    const thin = await stockTabMetadata({ code: "ZZZ", tab: "company", title: (c) => c, description: (c) => c });
    expect(thin.robots).toEqual({ index: false, follow: true, googleBot: { index: false, follow: true } });

    getStock.mockRejectedValue(new Error("boom"));
    const open = await stockTabMetadata({ code: "BHP", tab: "company", title: (c) => c, description: (c) => c });
    expect(open.robots).toBeUndefined();
    expect(open.title).toBe("BHP");
  });

  it("forceNoindex wins regardless of the stock", async () => {
    getStock.mockResolvedValue({ name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 });
    const md = await stockTabMetadata({ code: "BHP", tab: "community", title: (c) => c, description: (c) => c, forceNoindex: true });
    expect(md.robots).toEqual({ index: false, follow: true, googleBot: { index: false, follow: true } });
  });

  // getStock is wrapped in withRetryAndNotFound, which never rejects: a missing
  // code and a transient failure both resolve undefined. This is the path the
  // fail-open rule actually takes in production.
  it("fails open when the read resolves undefined (not found or retries exhausted)", async () => {
    getStock.mockResolvedValue(undefined);
    const md = await stockTabMetadata({ code: "BHP", tab: "news", title: (c) => c, description: (c) => c });
    expect(md.robots).toBeUndefined();
    expect(md.title).toBe("BHP");
  });

  it("upper-cases the code, repeats the canonical across alternates and brands the card titles", async () => {
    getStock.mockResolvedValue({ name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 });
    const url = "https://shorted.com.au/shorts/BHP/short-interest";
    const md = await stockTabMetadata({
      code: "bhp", tab: "short-interest",
      title: (c) => `BHP Short Interest | ${c}`,
      description: (c) => `About ${c}.`,
      keywords: ["bhp short interest"],
    });
    expect(getStock).toHaveBeenCalledWith("BHP");
    expect(md.title).toBe("BHP Short Interest | BHP Group");
    expect(md.description).toBe("About BHP Group.");
    expect(md.keywords).toEqual(["bhp short interest"]);
    expect(md.alternates).toEqual({ canonical: url, languages: { "en-AU": url, en: url, "x-default": url } });
    // The layout's "%s | Shorted" template does not reach the cards, so they carry the suffix themselves.
    expect(md.openGraph).toMatchObject({
      title: "BHP Short Interest | BHP Group | Shorted",
      description: "About BHP Group.",
      url, siteName: "Shorted", type: "website", locale: "en_AU",
    });
    expect(md.twitter).toMatchObject({
      site: "@shorted___", creator: "@shorted___", card: "summary_large_image",
      title: "BHP Short Interest | BHP Group | Shorted",
      description: "About BHP Group.",
    });
  });
});
