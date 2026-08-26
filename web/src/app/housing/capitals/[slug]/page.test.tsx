import { render, screen } from "@testing-library/react";

import CapitalDetailPage, {
  generateMetadata,
  generateStaticParams,
} from "./page";
import { CAPITAL_SLUGS, getCapital } from "~/@/lib/housing/capitals";
import { siteConfig } from "~/@/config/site";

const getCapitalPrices = jest.fn();
const bailOnEmptyRender = jest.fn();
const capitalPriceChart = jest.fn(() => <div />);
const notFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

jest.mock("next/navigation", () => ({
  notFound: () => notFound(),
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
}));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({
  BreadcrumbListSchema: () => null,
}));
jest.mock("../_components/capital-price-charts", () => ({
  CapitalPriceChart: (props: unknown) => {
    capitalPriceChart(props);
    return <div />;
  },
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/getCapitalPrices", () => ({
  getCapitalPrices: (...args: unknown[]) => getCapitalPrices(...args),
}));

const points = (
  values: Array<[period: string, value: number]>,
  preliminary = false,
) =>
  values.map(([period, value], index) => ({
    period,
    value,
    isPreliminary: preliminary && index === values.length - 1,
  }));

function series(
  regionCode: string,
  regionName: string,
  dwellingType: string,
  values: Array<[string, number]>,
  preliminary = false,
) {
  return {
    regionCode,
    regionName,
    dwellingType,
    unit: "AUD",
    source: "abs_res_dwell",
    sourceLicence: "CC-BY-4.0",
    points: points(values, preliminary),
  };
}

const melbourneSnapshot = {
  regionCode: "2GMEL",
  house: series(
    "2GMEL",
    "Greater Melbourne",
    "established_house",
    [
      ["2025-03-31", 700_000],
      ["2025-06-30", 720_000],
      ["2025-09-30", 740_000],
      ["2025-12-31", 800_000],
      ["2026-03-31", 850_000],
    ],
    true,
  ),
  unit: series("2GMEL", "Greater Melbourne", "attached", [
    ["2025-12-31", 540_000],
    ["2026-03-31", 550_000],
  ]),
  restOfState: series("2RVIC", "Rest of Vic.", "established_house", [
    ["2025-12-31", 610_000],
    ["2026-03-31", 625_000],
  ]),
};

const params = (slug: string) => Promise.resolve({ slug });

describe("CapitalDetailPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getCapitalPrices.mockResolvedValue(melbourneSnapshot);
  });

  it("prerenders exactly the registry-owned capital routes", () => {
    expect(generateStaticParams()).toEqual(
      CAPITAL_SLUGS.map((slug) => ({ slug })),
    );
  });

  it("404s an unknown slug before fetching data", async () => {
    await expect(
      CapitalDetailPage({ params: params("not-a-capital") }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getCapitalPrices).not.toHaveBeenCalled();
  });

  it("renders history, changes and all three supported comparisons", async () => {
    const capital = getCapital("greater-melbourne")!;
    const page = await CapitalDetailPage({ params: params(capital.slug) });
    const { container } = render(page);

    expect(getCapitalPrices).toHaveBeenCalledWith("2GMEL", "2RVIC");
    expect(
      screen.getByRole("heading", { level: 1, name: capital.h1 }),
    ).toBeInTheDocument();
    expect(screen.getByText("$850,000")).toBeInTheDocument();
    expect(screen.getByText("+6.3%")).toBeInTheDocument();
    expect(screen.getByText("+21.4%")).toBeInTheDocument();
    expect(
      screen.getByText(/latest ABS observation is preliminary/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "House versus unit prices" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Greater Melbourne versus Rest of Victoria",
      }),
    ).toBeInTheDocument();

    expect(capitalPriceChart).toHaveBeenCalledTimes(3);
    expect(capitalPriceChart).toHaveBeenCalledWith(
      expect.objectContaining({
        ariaLabel: "Greater Melbourne established house price history",
        format: "aud",
        series: [
          expect.objectContaining({
            label: "Established houses",
            points: melbourneSnapshot.house.points,
          }),
        ],
      }),
    );
    expect(capitalPriceChart).toHaveBeenCalledWith(
      expect.objectContaining({
        ariaLabel: "Greater Melbourne house and unit price comparison",
        series: [
          expect.objectContaining({ label: "Established houses" }),
          expect.objectContaining({ label: "Attached dwellings" }),
        ],
      }),
    );
    expect(capitalPriceChart).toHaveBeenCalledWith(
      expect.objectContaining({
        ariaLabel:
          "Greater Melbourne and Rest of Victoria house price comparison",
        series: [
          expect.objectContaining({ label: "Greater Melbourne" }),
          expect.objectContaining({ label: "Rest of Victoria" }),
        ],
      }),
    );
    expect(() => JSON.stringify(capitalPriceChart.mock.calls)).not.toThrow();

    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/housing/vic");
    expect(hrefs).toContain("/economy/vic");
    expect(hrefs).toContain("/housing/capitals/greater-sydney");
    expect(
      hrefs.some((href) => href?.startsWith("/housing/rankings/") ?? false),
    ).toBe(true);

    const schemas = Array.from(
      container.querySelectorAll('script[type="application/ld+json"]'),
    ).map((script) => script.textContent ?? "");
    expect(schemas.some((schema) => schema.includes('"@type":"Dataset"'))).toBe(
      true,
    );
    expect(
      schemas.some((schema) =>
        schema.includes("Australian Bureau of Statistics"),
      ),
    ).toBe(true);
    expect(
      schemas.some((schema) =>
        schema.includes("creativecommons.org/licenses/by/4.0"),
      ),
    ).toBe(true);
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("renders an uncached fallback without throwing for an empty snapshot", async () => {
    getCapitalPrices.mockResolvedValue(null);

    const page = await CapitalDetailPage({
      params: params("greater-melbourne"),
    });
    expect(() => render(page)).not.toThrow();
    expect(
      screen.getByText(/Capital price history is temporarily unavailable/),
    ).toBeInTheDocument();
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });

  it("keeps ACT territory-wide without regional or suburb-ranking links", async () => {
    getCapitalPrices.mockResolvedValue({
      regionCode: "8ACTE",
      house: series(
        "8ACTE",
        "Australian Capital Territory",
        "established_house",
        [
          ["2025-12-31", 1_050_000],
          ["2026-03-31", 1_071_300],
        ],
      ),
      unit: series("8ACTE", "Australian Capital Territory", "attached", [
        ["2025-12-31", 620_000],
        ["2026-03-31", 630_000],
      ]),
      restOfState: null,
    });

    render(
      await CapitalDetailPage({
        params: params("australian-capital-territory"),
      }),
    );

    expect(getCapitalPrices).toHaveBeenCalledWith("8ACTE", null);
    expect(
      screen.getByText(/no separate rest-of-territory series/i),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("link")
        .some((link) =>
          link.getAttribute("href")?.startsWith("/housing/rankings/"),
        ),
    ).toBe(false);
    expect(capitalPriceChart).toHaveBeenCalledTimes(2);
  });

  it("publishes canonical and Open Graph metadata from the registry", async () => {
    const capital = getCapital("greater-melbourne")!;
    const metadata = await generateMetadata({ params: params(capital.slug) });
    const url = `${siteConfig.url}/housing/capitals/${capital.slug}`;

    expect(metadata.title).toBe(capital.title);
    expect(metadata.alternates).toEqual(
      expect.objectContaining({ canonical: url }),
    );
    expect(metadata.openGraph).toEqual(
      expect.objectContaining({ url, description: capital.description }),
    );
  });
});
