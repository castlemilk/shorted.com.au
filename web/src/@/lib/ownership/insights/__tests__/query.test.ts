import {
  clampInsightsQuery,
  isDefaultInsightsQuery,
  isInsightDate,
  parseInsightParams,
  serialiseInsightParams,
} from "../query";

const DEFAULT_WINDOW = { from: "2026-08-03", to: "2026-10-31" };

describe("the insights link", () => {
  it("reads the window, the measure and the focus, and drops what it cannot use", () => {
    expect(parseInsightParams(new URLSearchParams("from=2026-09-01&to=2026-10-01&m=disclosed&sector=Materials&stock=bhp"))).toEqual({
      query: { from: "2026-09-01", to: "2026-10-01", sector: "Materials", stock: "BHP" },
      measure: "disclosed",
    });
    expect(parseInsightParams(new URLSearchParams("from=2026-13-01&to=yesterday&m=other&stock=BHP;1"))).toEqual({
      query: { from: "", to: "", sector: null, stock: "" },
      measure: "funds",
    });
    expect(parseInsightParams(new URLSearchParams("from=2026-10-02&to=2026-10-01")).query).toMatchObject({ from: "", to: "" });
    expect(parseInsightParams(new URLSearchParams("sector=Other")).query.sector).toBe("");
    expect(parseInsightParams(new URLSearchParams(`sector=${"x".repeat(121)}`)).query.sector).toBeNull();
  });

  it("omits every default, and round-trips a link", () => {
    expect(
      serialiseInsightParams({ query: { ...DEFAULT_WINDOW, sector: null, stock: "" }, measure: "funds" }, DEFAULT_WINDOW).toString(),
    ).toBe("");
    const link = { query: { from: "2026-09-01", to: "2026-10-01", sector: "", stock: "BHP" }, measure: "disclosed" as const };
    const written = serialiseInsightParams(link, DEFAULT_WINDOW);
    expect(written.toString()).toBe("from=2026-09-01&to=2026-10-01&m=disclosed&sector=Other&stock=BHP");
    expect(parseInsightParams(written)).toEqual(link);
  });

  it("knows a real day from a date-shaped string", () => {
    expect(isInsightDate("2026-02-28")).toBe(true);
    expect(isInsightDate("2026-02-30")).toBe(false);
    expect(isInsightDate("26-02-01")).toBe(false);
  });
});

describe("the action's clamp", () => {
  it("passes a well-formed query and names the part", () => {
    expect(clampInsightsQuery({})).toEqual({ ok: true, query: { from: "", to: "", sector: null, stock: "" }, part: "all" });
    expect(clampInsightsQuery({ from: "2026-09-01", to: "2026-10-01", sector: "", part: "sector" })).toMatchObject({
      ok: true,
      part: "sector",
      query: { sector: "" },
    });
  });

  it.each([
    [{ from: "2026-9-1" }, /from must be a date/],
    [{ to: 20261001 }, /to must be a date/],
    [{ from: "2026-10-02", to: "2026-10-01" }, /from is after to/],
    [{ sector: 7 }, /sector must be a string/],
    [{ stock: "bhp" }, /stock must be an ASX code/],
    [{ part: "everything" }, /part must be/],
    [{ part: "sector" }, /needs a sector/],
    [{ part: "stock" }, /needs a stock/],
  ])("refuses %j", (input, error) => {
    const result = clampInsightsQuery(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(error);
  });

  it("names the server page's default view", () => {
    expect(isDefaultInsightsQuery({ from: "", to: "", sector: null, stock: "" }, "all")).toBe(true);
    expect(isDefaultInsightsQuery({ from: "", to: "", sector: "", stock: "" }, "all")).toBe(false);
    expect(isDefaultInsightsQuery({ from: "", to: "", sector: null, stock: "" }, "stock")).toBe(false);
  });
});
