import {
  isChartCode,
  parseChartShareParams,
  parseEmbedChartParams,
} from "../params";

const p = (query: string) => parseEmbedChartParams(new URLSearchParams(query));

describe("parseEmbedChartParams", () => {
  it("defaults to BHP short interest over 1y", () => {
    expect(p("")).toEqual({ code: "BHP", view: "short", period: "1y" });
    expect(parseEmbedChartParams(null)).toEqual({
      code: "BHP",
      view: "short",
      period: "1y",
    });
  });

  it("keeps a legacy code-only snippet on the short view (backwards compatible)", () => {
    expect(p("code=PLS")).toEqual({ code: "PLS", view: "short", period: "1y" });
  });

  it("reads view and period", () => {
    expect(p("code=BHP&view=combined&period=6m")).toEqual({
      code: "BHP",
      view: "combined",
      period: "6m",
    });
    expect(p("code=cba&view=price&period=max")).toEqual({
      code: "CBA",
      view: "price",
      period: "max",
    });
  });

  it("upper-cases and trims the code", () => {
    expect(p("code=%20bhp%20").code).toBe("BHP");
    expect(p("code=1ae").code).toBe("1AE");
  });

  it("falls back on an invalid code", () => {
    for (const bad of ["B", "TOOLONGX", "BH-P", "<script>", "BHP%00"]) {
      expect(p(`code=${bad}`).code).toBe("BHP");
    }
  });

  it("falls back on an invalid view or period", () => {
    expect(p("view=candles").view).toBe("short");
    expect(p("period=5y").period).toBe("1y");
    expect(p("view=&period=").view).toBe("short");
  });

  it("accepts view/period case-insensitively", () => {
    expect(p("view=Combined&period=3M")).toMatchObject({
      view: "combined",
      period: "3m",
    });
  });
});

describe("parseChartShareParams", () => {
  it("takes the code from the path and the rest from the query", () => {
    expect(
      parseChartShareParams("wbt", { view: "combined", period: "1m" }),
    ).toEqual({ code: "WBT", view: "combined", period: "1m" });
  });

  it("falls back exactly as the embed does", () => {
    expect(parseChartShareParams("BHP", {})).toEqual({
      code: "BHP",
      view: "short",
      period: "1y",
    });
    expect(
      parseChartShareParams("BHP", { view: "nope", period: "10y" }),
    ).toEqual({ code: "BHP", view: "short", period: "1y" });
    expect(parseChartShareParams("BHP", undefined).view).toBe("short");
  });

  it("reads the first of a repeated param", () => {
    expect(parseChartShareParams("BHP", { period: ["6m", "1m"] }).period).toBe(
      "6m",
    );
  });
});

describe("isChartCode", () => {
  it("accepts ASX-shaped codes in any case", () => {
    expect(isChartCode("WBT")).toBe(true);
    expect(isChartCode("bhp")).toBe(true);
    expect(isChartCode("XJO1")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isChartCode("")).toBe(false);
    expect(isChartCode(undefined)).toBe(false);
    expect(isChartCode("TOOLONGCODE")).toBe(false);
    expect(isChartCode("BH-P")).toBe(false);
  });
});
