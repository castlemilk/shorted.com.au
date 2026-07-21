/**
 * LLMMeta provenance regression guard.
 *
 * ASIC short-selling surfaces must keep the original regulatory structured data
 * byte-for-byte; non-ASIC surfaces (housing/economy/news) must derive honest
 * provenance from `dataSource` instead of claiming a false ASIC/regulatory
 * origin (the false-provenance bug that had /price-drops drop LLMMeta entirely).
 */
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LLMMeta } from "./llm-meta";

function renderLd(props: ComponentProps<typeof LLMMeta>): {
  raw: string;
  data: Record<string, unknown>;
} {
  const html = renderToStaticMarkup(<LLMMeta {...props} />);
  const match = html.match(
    /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("LLMMeta emitted no JSON-LD script");
  return { raw: match[1], data: JSON.parse(match[1]) as Record<string, unknown> };
}

describe("LLMMeta provenance", () => {
  it("emits the legacy ASIC regulatory provenance for ASIC data (byte-for-byte)", () => {
    const { raw, data } = renderLd({
      title: "Top Shorted ASX Stocks",
      description: "Daily short positions",
      keywords: ["short selling", "ASX"],
      dataSource: "ASIC",
      dataFrequency: "daily",
      lastUpdated: "2026-07-21",
    });

    // Exact legacy shape + key order — pins the byte-for-byte output so the
    // ASIC surfaces (stock pages, top shorts, reports, etc.) never regress.
    const expected = {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: "Top Shorted ASX Stocks",
      description: "Daily short positions",
      keywords: "short selling, ASX",
      sourceOrganization: {
        "@type": "GovernmentOrganization",
        name: "Australian Securities and Investments Commission",
        alternateName: "ASIC",
        url: "https://asic.gov.au",
      },
      inLanguage: "en-AU",
      audience: {
        "@type": "Audience",
        audienceType: ["Investors", "Financial Analysts", "Researchers"],
      },
      datePublished: "2026-07-21",
      dateModified: "2026-07-21",
      license: "https://shorted.com.au/terms",
      isAccessibleForFree: true,
      about: [
        {
          "@type": "Thing",
          name: "ASX Securities Short Positions",
          description:
            "Short selling data for Australian Securities Exchange listed companies",
          sameAs:
            "https://asic.gov.au/regulatory-resources/markets/short-selling/",
        },
      ],
      additionalProperty: [
        { "@type": "PropertyValue", name: "dataSource", value: "ASIC" },
        { "@type": "PropertyValue", name: "updateFrequency", value: "daily" },
        { "@type": "PropertyValue", name: "dataAccuracy", value: "regulatory" },
        {
          "@type": "PropertyValue",
          name: "contentType",
          value: "financial-data",
        },
      ],
    };

    expect(raw).toBe(JSON.stringify(expected));
    expect(data).toEqual(expected);
  });

  it("keeps ASIC provenance when dataSource names ASIC among other sources", () => {
    const { raw } = renderLd({
      title: "Data & API",
      description: "d",
      dataSource: "ASIC short position reports + ASX Appendix 3Y filings",
    });
    expect(raw).toContain("https://asic.gov.au");
    expect(raw).toContain('"dataAccuracy"');
    expect(raw).toContain('"regulatory"');
  });

  it("derives honest provenance from a non-ASIC dataSource (no false ASIC claim)", () => {
    const { raw, data } = renderLd({
      title: "Australian House Prices",
      description: "Housing tracker",
      dataSource: "ABS, RBA",
      dataFrequency: "quarterly",
    });

    // No ASIC/regulatory provenance leaks onto non-ASIC surfaces.
    expect(raw).not.toContain("asic.gov.au");
    expect(raw).not.toContain(
      "Australian Securities and Investments Commission",
    );
    expect(raw).not.toContain("regulatory");
    expect(data.about).toBeUndefined();

    // One sourceOrganization per source name; ABS/RBA → GovernmentOrganization.
    const orgs = data.sourceOrganization as Array<Record<string, unknown>>;
    expect(Array.isArray(orgs)).toBe(true);
    expect(orgs).toEqual([
      {
        "@type": "GovernmentOrganization",
        name: "Australian Bureau of Statistics",
        alternateName: "ABS",
        url: "https://abs.gov.au",
      },
      {
        "@type": "GovernmentOrganization",
        name: "Reserve Bank of Australia",
        alternateName: "RBA",
        url: "https://rba.gov.au",
      },
    ]);

    // dataAccuracy:"regulatory" is dropped; the rest of additionalProperty stays.
    const props = data.additionalProperty as Array<Record<string, unknown>>;
    expect(props.find((p) => p.name === "dataAccuracy")).toBeUndefined();
    expect(props.map((p) => p.name)).toEqual([
      "dataSource",
      "updateFrequency",
      "contentType",
    ]);
  });

  it("maps commercial portals to plain Organizations with homepages", () => {
    const { data } = renderLd({
      title: "Australian House Price Drops",
      description: "d",
      dataSource: "realestate.com.au, domain.com.au",
    });
    expect(data.sourceOrganization).toEqual([
      {
        "@type": "Organization",
        name: "realestate.com.au",
        url: "https://www.realestate.com.au",
      },
      {
        "@type": "Organization",
        name: "domain.com.au",
        url: "https://www.domain.com.au",
      },
    ]);
  });

  it("falls back to a bare-name Organization for unknown sources", () => {
    const { data } = renderLd({
      title: "Market news",
      description: "d",
      dataSource: "RSS feeds + Gemini sentiment",
    });
    expect(data.sourceOrganization).toEqual([
      { "@type": "Organization", name: "RSS feeds + Gemini sentiment" },
    ]);
  });
});
