import { describe, it, expect } from "vitest";
import { zoomWindow, reportLine, searchNews, type Queryable } from "./drilldowns.js";

function fakePg(capture: { sql: string; params: unknown[] }[], rows: unknown[]): Queryable {
  return {
    async query(sql: string, params?: unknown[]) {
      capture.push({ sql, params: params ?? [] });
      return { rows } as { rows: unknown[] };
    },
  };
}

describe("zoomWindow", () => {
  it("queries shorts+prices+news in a +/- day window around a date", async () => {
    const cap: { sql: string; params: unknown[] }[] = [];
    const pg = fakePg(cap, []);
    await zoomWindow(pg, "BHP", "2026-05-01", 3);
    // 3 queries: shorts, prices, news — all parameterised with the code.
    expect(cap.length).toBe(3);
    expect(cap.every((c) => c.params.includes("BHP"))).toBe(true);
    expect(cap.every((c) => c.params.some((p) => String(p).includes("2026-05-01")))).toBe(true);
  });
});

describe("reportLine", () => {
  it("returns the metric value + source record for a stock", async () => {
    const cap: { sql: string; params: unknown[] }[] = [];
    const pg = fakePg(cap, [{
      report_url: "https://x/r.pdf", report_type: "annual_results",
      report_title: "FY25", report_date: "2026-02-01",
      metrics: { revenue: "A$1.2bn", ebitda: "A$300m" },
    }]);
    const out = await reportLine(pg, "BHP", "revenue");
    expect(out?.value).toBe("A$1.2bn");
    expect(out?.source.type).toBe("report");
    expect(out?.source.url).toBe("https://x/r.pdf");
  });

  it("returns null when the metric is absent", async () => {
    const pg = fakePg([], [{ report_url: "u", report_type: null, report_title: null, report_date: null, metrics: {} }]);
    expect(await reportLine(pg, "BHP", "revenue")).toBeNull();
  });
});

describe("searchNews", () => {
  it("parameterises the query string and optional code", async () => {
    const cap: { sql: string; params: unknown[] }[] = [];
    const pg = fakePg(cap, []);
    await searchNews(pg, "probe", "DRO");
    expect(cap[0]!.params).toContain("DRO");
    expect(cap[0]!.params.some((p) => String(p).includes("probe"))).toBe(true);
  });
});
