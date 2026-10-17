import { buildSuburbJsonLd } from "./suburb-structured-data";

const base = {
  name: "Bondi Beach",
  url: "https://shorted.com.au/housing/nsw/bondi-beach",
  stateCode: "NSW",
  centroid: { lat: -33.891234, lon: 151.274567 },
  lgaName: "Waverley",
  population: 12_000,
  medianAge: 36,
  medianWeeklyHhdIncome: 3_012.4,
};

describe("buildSuburbJsonLd", () => {
  it("emits a Place with real coordinates, its containment chain and the page's facts", () => {
    const [place] = buildSuburbJsonLd({ ...base, latestMedianPrice: 4_250_000, yoyPct: 3.25, latestPeriodIso: "2026-06-30" }) as Array<Record<string, unknown>>;
    expect(place).toMatchObject({
      "@type": "Place",
      name: "Bondi Beach",
      geo: { "@type": "GeoCoordinates", latitude: -33.89123, longitude: 151.27457 },
      containedInPlace: [
        { "@type": "AdministrativeArea", name: "Waverley" },
        { "@type": "State", name: "New South Wales" },
        { "@type": "Country", name: "Australia" },
      ],
    });
    const props = place.additionalProperty as Array<{ name: string; value: number }>;
    expect(props.map((x) => x.name)).toEqual([
      "Median house price",
      "Median house price change, 12 months",
      "Population (ABS Census 2021)",
      "Median age",
      "Median weekly household income",
    ]);
    expect(props[0]?.value).toBe(4_250_000);
  });

  it("adds a Valuer-General Dataset only when the suburb is priced", () => {
    const priced = buildSuburbJsonLd({ ...base, latestMedianPrice: 1_000_000, latestPeriodIso: "2026-06-30" });
    expect(priced.map((n) => (n as { "@type": string })["@type"])).toEqual(["Place", "BreadcrumbList", "Dataset"]);
    const dataset = priced[2] as Record<string, unknown>;
    expect(dataset.temporalCoverage).toBe("../2026-06-30");
    expect(dataset.spatialCoverage).toEqual({ "@id": "https://shorted.com.au/housing/nsw/bondi-beach#place" });

    const unpriced = buildSuburbJsonLd({ ...base, latestMedianPrice: 0 });
    expect(unpriced.map((n) => (n as { "@type": string })["@type"])).toEqual(["Place", "BreadcrumbList"]);
    expect(JSON.stringify(unpriced)).not.toContain("Median house price");
  });

  it("omits geo entirely when no boundary was available", () => {
    const [place] = buildSuburbJsonLd({ ...base, centroid: null }) as Array<Record<string, unknown>>;
    expect(place).not.toHaveProperty("geo");
  });

  it("walks the breadcrumb Home → House prices → State → Suburb", () => {
    const [, crumbs] = buildSuburbJsonLd(base) as Array<{ itemListElement: Array<{ name: string; item: string }> }>;
    expect(crumbs.itemListElement.map((c) => c.name)).toEqual(["Home", "House prices", "New South Wales", "Bondi Beach"]);
    expect(crumbs.itemListElement[2]?.item).toBe("https://shorted.com.au/housing/nsw");
  });
});
