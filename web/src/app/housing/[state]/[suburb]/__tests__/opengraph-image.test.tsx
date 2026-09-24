import { render, screen } from "@testing-library/react";

const getOgLogo = jest.fn(async () => "data:image/png;base64,logo");
const resolveSuburbSalCode = jest.fn();
const getSuburbProfile = jest.fn();
const getSuburbGeometry = jest.fn();

jest.mock("next/og", () => ({
  ImageResponse: class MockImageResponse {
    element: React.ReactElement;
    options: unknown;
    constructor(element: React.ReactElement, options: unknown) {
      this.element = element;
      this.options = options;
    }
  },
}));
jest.mock("~/app/actions/getHousing", () => ({
  resolveSuburbSalCode: (...args: unknown[]) => resolveSuburbSalCode(...args),
  getSuburbProfile: (...args: unknown[]) => getSuburbProfile(...args),
}));
jest.mock("@/lib/housing/suburb-geometry.server", () => ({
  getSuburbGeometry: (...args: unknown[]) => getSuburbGeometry(...args),
}));
jest.mock("@/lib/og/card", () => ({
  OG_SIZE: { width: 1200, height: 630 },
  OG_CONTENT_TYPE: "image/png",
  getOgLogo: () => getOgLogo(),
  OgSceneCard: ({
    eyebrow, title, subtitle, stats, silhouette, sceneSrc,
  }: {
    eyebrow: string; title: string; subtitle?: string;
    stats?: Array<{ label: string; value: string }>;
    silhouette?: { targetPath: string } | null; sceneSrc?: string;
  }) => (
    <div>
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      <ul>{(stats ?? []).map((s) => <li key={s.label}>{s.label}: {s.value}</li>)}</ul>
      <span data-testid="silhouette">{silhouette?.targetPath ?? "none"}</span>
      <span data-testid="scene">{sceneSrc ? "scene" : "plain"}</span>
    </div>
  ),
}));

import Image from "../opengraph-image";

describe("suburb Open Graph image", () => {
  beforeEach(() => jest.clearAllMocks());

  it("draws the page's own boundary and figures onto the scene card", async () => {
    resolveSuburbSalCode.mockResolvedValue("22121");
    getSuburbProfile.mockResolvedValue({
      summary: { salName: "PRESTON (VIC.)", latestMedianPrice: 1_200_000, yoyPct: 3.2, seifa: { irsad: { decileAus: 7 } } },
      demographics: { population: 33_790, medianWeeklyHhdIncome: 1_980, medianAge: 36 },
      banner: { archetype: "inner-terraces", blurb: "" },
      council: { lgaName: "Darebin" },
    });
    getSuburbGeometry.mockReturnValue({
      locator: { size: 200, targetPath: "M1,1L2,2Z", neighbourPaths: [] },
      centroid: { lon: 145, lat: -37.7 },
      bounds: [[144.9, -37.8], [145.1, -37.6]],
      stateLocator: null,
    });

    const response = (await Image({
      params: Promise.resolve({ state: "vic", suburb: "preston-vic" }),
    })) as unknown as { element: React.ReactElement };
    render(response.element);

    expect(screen.getByRole("heading", { name: "Preston (Vic.)" })).toBeInTheDocument();
    expect(screen.getByText("House prices · Victoria")).toBeInTheDocument();
    expect(screen.getByText("Victoria · Inner Terraces · Darebin")).toBeInTheDocument();
    expect(screen.getByText("Median house: $1.2M")).toBeInTheDocument();
    expect(screen.getByText("Past year: +3.2%")).toBeInTheDocument();
    expect(screen.getByText("Population: 33,790")).toBeInTheDocument();
    expect(screen.getByTestId("silhouette")).toHaveTextContent("M1,1L2,2Z");
    expect(getSuburbGeometry).toHaveBeenCalledWith("VIC", "22121");
  });

  it("never states a price for an unpriced suburb, and never throws", async () => {
    resolveSuburbSalCode.mockResolvedValue("30001");
    getSuburbProfile.mockResolvedValue({
      summary: { salName: "NOOSA HEADS", latestMedianPrice: 0, yoyPct: 0 },
      demographics: { population: 4_400, medianWeeklyHhdIncome: 1_500, medianAge: 51 },
      banner: { archetype: "coastal-beach", blurb: "Surf town at the tip of the Sunshine Coast." },
    });
    getSuburbGeometry.mockReturnValue(null);

    const response = (await Image({
      params: Promise.resolve({ state: "qld", suburb: "noosa-heads" }),
    })) as unknown as { element: React.ReactElement };
    render(response.element);

    expect(screen.getByRole("heading", { name: "Noosa Heads" })).toBeInTheDocument();
    expect(screen.getByText("Surf town at the tip of the Sunshine Coast.")).toBeInTheDocument();
    expect(screen.queryByText(/Median house/)).not.toBeInTheDocument();
    expect(screen.getByText("Population: 4,400")).toBeInTheDocument();
    expect(screen.getByText("Household income: $1,500/wk")).toBeInTheDocument();
    expect(screen.getByTestId("silhouette")).toHaveTextContent("none");
  });

  it("falls back to the slug when every upstream fails", async () => {
    resolveSuburbSalCode.mockRejectedValue(new Error("rpc down"));
    const response = (await Image({
      params: Promise.resolve({ state: "nsw", suburb: "bondi-beach-2026" }),
    })) as unknown as { element: React.ReactElement };
    render(response.element);
    expect(screen.getByRole("heading", { name: "Bondi Beach" })).toBeInTheDocument();
    expect(screen.getByText("House prices · New South Wales")).toBeInTheDocument();
  });
});
