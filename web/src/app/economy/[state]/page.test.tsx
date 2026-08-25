import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("economy state cross-domain links", () => {
  const source = readFileSync(resolve(__dirname, "page.tsx"), "utf8");

  it("links to the matching housing map and state-filtered price drops", () => {
    expect(source).toContain("href={`/housing/${state}`}");
    expect(source).toContain("href={`/price-drops?state=${state}`}");
  });

  it("keeps the existing chart-grid companies section instead of duplicating it", () => {
    expect(source).toContain("<StateCharts state={state} />");
    expect(source).not.toContain("StateCompanies");
  });

  it("does not read search params in the ISR server page", () => {
    expect(source).not.toContain("searchParams");
  });
});
