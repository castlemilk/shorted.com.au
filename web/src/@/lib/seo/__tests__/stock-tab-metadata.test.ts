const getStock = jest.fn();
jest.mock("~/app/actions/getStock", () => ({ getStock: (...a: unknown[]) => getStock(...a) }));

import { stockOgImage, stockTabMetadata } from "../stock-tab-metadata";

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
    expect(Object.keys(md)).not.toContain("robots");
  });

  // Next 14.2's mergeMetadata iterates `for (key in source)`, so an own `robots`
  // key holding undefined runs resolveRobots(undefined) and REPLACES the root
  // layout's robots (index/follow plus the googleBot max-image-preview,
  // max-snippet and max-video-preview directives) with nothing. An indexable
  // tab must therefore carry no robots key at all, to inherit them.
  it("sets no robots key at all on an indexable tab, so the root layout's directives are inherited", async () => {
    getStock.mockResolvedValue({ name: "BHP GROUP LIMITED ORDINARY", industry: "Materials", percentageShorted: 1.58 });
    const md = await stockTabMetadata({ code: "BHP", tab: "company", title: (c) => c, description: (c) => c });
    expect(Object.keys(md)).not.toContain("robots");
    expect("robots" in md).toBe(false);
  });

  it("inherits the stock's noindex gate and fails open on a transient read", async () => {
    getStock.mockResolvedValue({ name: "", industry: "", percentageShorted: 0 });
    const thin = await stockTabMetadata({ code: "ZZZ", tab: "company", title: (c) => c, description: (c) => c });
    expect(thin.robots).toEqual({ index: false, follow: true, googleBot: { index: false, follow: true } });

    getStock.mockRejectedValue(new Error("boom"));
    const open = await stockTabMetadata({ code: "BHP", tab: "company", title: (c) => c, description: (c) => c });
    expect(Object.keys(open)).not.toContain("robots");
    expect(open.title).toBe("BHP");
  });

  it("forceNoindex wins regardless of the stock", async () => {
    getStock.mockResolvedValue({ name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 });
    const md = await stockTabMetadata({ code: "BHP", tab: "community", title: (c) => c, description: (c) => c, forceNoindex: true });
    expect(md.robots).toEqual({ index: false, follow: true, googleBot: { index: false, follow: true } });
  });

  // A reason to noindex that needs the stock record (the Short interest tab: no
  // reported short position). It is a predicate rather than a flag because the
  // builder is the one place that knows whether the stock was READ: a flag
  // computed from "no short position" before the read would noindex every stock
  // while getStock is failing, which contradicts the fail-open rule.
  describe("noindexWhen", () => {
    const thin = (stock: { percentageShorted: number }) => !(stock.percentageShorted > 0);
    const NOINDEX = { index: false, follow: true, googleBot: { index: false, follow: true } };
    const base = { code: "BHP", tab: "short-interest", title: (c: string) => c, description: (c: string) => c } as const;

    it("noindexes a resolved stock the predicate rejects, though the stock itself is indexable", async () => {
      // Named and enriched, so isStockIndexable alone would index it.
      getStock.mockResolvedValue({ name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 0 });
      const md = await stockTabMetadata({ ...base, noindexWhen: thin });
      expect(md.robots).toEqual(NOINDEX);
    });

    it("leaves a resolved stock the predicate accepts indexable", async () => {
      getStock.mockResolvedValue({ name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 });
      const md = await stockTabMetadata({ ...base, noindexWhen: thin });
      expect(Object.keys(md)).not.toContain("robots");
    });

    it("hands the predicate the stock record the metadata is built from", async () => {
      const record = { name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 };
      getStock.mockResolvedValue(record);
      const noindexWhen = jest.fn().mockReturnValue(false);
      await stockTabMetadata({ ...base, noindexWhen });
      expect(noindexWhen).toHaveBeenCalledTimes(1);
      expect(noindexWhen).toHaveBeenCalledWith(record);
    });

    it("is never asked, and fails open, when the read resolves undefined", async () => {
      getStock.mockResolvedValue(undefined);
      const noindexWhen = jest.fn().mockReturnValue(true);
      const md = await stockTabMetadata({ ...base, noindexWhen });
      expect(noindexWhen).not.toHaveBeenCalled();
      expect(Object.keys(md)).not.toContain("robots");
    });

    it("is never asked, and fails open, when the read throws", async () => {
      getStock.mockRejectedValue(new Error("boom"));
      const noindexWhen = jest.fn().mockReturnValue(true);
      const md = await stockTabMetadata({ ...base, noindexWhen });
      expect(noindexWhen).not.toHaveBeenCalled();
      expect(Object.keys(md)).not.toContain("robots");
    });

    it("does not override forceNoindex or the stock's own gate", async () => {
      getStock.mockResolvedValue({ name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 });
      const forced = await stockTabMetadata({ ...base, forceNoindex: true, noindexWhen: () => false });
      expect(forced.robots).toEqual(NOINDEX);
      getStock.mockResolvedValue({ name: "", industry: "", percentageShorted: 0 });
      const thinStock = await stockTabMetadata({ ...base, noindexWhen: () => false });
      expect(thinStock.robots).toEqual(NOINDEX);
    });
  });

  // getStock is wrapped in withRetryAndNotFound, which never rejects: a missing
  // code and a transient failure both resolve undefined. This is the path the
  // fail-open rule actually takes in production.
  it("fails open when the read resolves undefined (not found or retries exhausted)", async () => {
    getStock.mockResolvedValue(undefined);
    const md = await stockTabMetadata({ code: "BHP", tab: "news", title: (c) => c, description: (c) => c });
    expect(Object.keys(md)).not.toContain("robots");
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

  // A page that sets openGraph replaces the segment's file-based opengraph-image,
  // so every tab has to name the stock's card itself, as the Overview does
  // (ledger ruling, Defect C).
  it("puts the stock's card on both the Open Graph and the Twitter metadata", async () => {
    getStock.mockResolvedValue({ name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 });
    const md = await stockTabMetadata({ code: "BHP", tab: "company", title: (c) => c, description: (c) => c });
    const card = {
      url: "https://shorted.com.au/shorts/BHP/opengraph-image?p=1.58",
      width: 1200,
      height: 630,
      alt: "BHP short position — Shorted",
    };
    expect(md.openGraph?.images).toEqual([card]);
    expect(md.twitter?.images).toEqual([card]);
  });

  it("still names a card, with the default version, when the read yields nothing", async () => {
    getStock.mockResolvedValue(undefined);
    const md = await stockTabMetadata({ code: "BHP", tab: "company", title: (c) => c, description: (c) => c });
    const url = "https://shorted.com.au/shorts/BHP/opengraph-image?p=default";
    expect(md.openGraph?.images).toEqual([expect.objectContaining({ url, width: 1200, height: 630 })]);
    expect(md.twitter?.images).toEqual([expect.objectContaining({ url, width: 1200, height: 630 })]);
  });
});

describe("stockOgImage", () => {
  it("is the Overview's card: 1200x630, versioned by the short percentage", () => {
    expect(stockOgImage("BHP", 1.58)).toEqual({
      url: "https://shorted.com.au/shorts/BHP/opengraph-image?p=1.58",
      width: 1200,
      height: 630,
      alt: "BHP short position — Shorted",
    });
    expect(stockOgImage("CBA", 0.456).url).toBe("https://shorted.com.au/shorts/CBA/opengraph-image?p=0.46");
  });

  it("versions as default when there is no positive short percentage", () => {
    for (const pct of [0, -1, null, undefined, Number.NaN]) {
      expect(stockOgImage("BHP", pct).url).toBe("https://shorted.com.au/shorts/BHP/opengraph-image?p=default");
    }
  });
});
