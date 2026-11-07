/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react";
import {
  DatasetStructuredData,
  EnhancedOrganizationSchema,
} from "./enhanced-structured-data";

/**
 * dateModified is the data date, which only the caller knows. The component
 * used to fall back to `new Date()`, so the homepage told Google its data was
 * modified at render time (2026-10-21T00:34:49Z against data that ran to
 * 2026-10-15).
 */

type DatasetInfo = Parameters<typeof DatasetStructuredData>[0]["datasetInfo"];

function datasetJson(datasetInfo: DatasetInfo): Record<string, unknown> {
  const { container } = render(<DatasetStructuredData datasetInfo={datasetInfo} />);
  const script = container.querySelector('script[type="application/ld+json"]');
  return JSON.parse(script?.innerHTML ?? "{}") as Record<string, unknown>;
}

const base = { name: "ASIC Short Position Data", description: "Daily ASIC data." };

describe("DatasetStructuredData", () => {
  it.each([
    ["no data date", undefined],
    ["an empty data date", ""],
  ])("omits dateModified with %s", (_label, dateModified) => {
    const json = datasetJson({ ...base, dateModified });
    expect(json).not.toHaveProperty("dateModified");
    expect(json.datePublished).toBe("2024-01-01T00:00:00.000Z");
  });

  it("carries the caller's data date", () => {
    const json = datasetJson({ ...base, dateModified: "2026-10-15T00:00:00.000Z" });
    expect(json.dateModified).toBe("2026-10-15T00:00:00.000Z");
    expect(json.datePublished).toBe("2024-01-01T00:00:00.000Z");
  });

  it("never publishes after the data date", () => {
    const json = datasetJson({ ...base, dateModified: "2023-06-30T00:00:00.000Z" });
    expect(json.datePublished).toBe("2023-06-30T00:00:00.000Z");
  });
});

// Google showed the founder's headshot beside the homepage result
// (2026-11-07): the Organization's nested Person carried the only `image` on
// the page. The Organization names its own images now, and the Person none.
describe("EnhancedOrganizationSchema images", () => {
  function organizationJson(): Record<string, unknown> {
    const { container } = render(<EnhancedOrganizationSchema />);
    const script = container.querySelector('script[type="application/ld+json"]');
    return JSON.parse(script?.innerHTML ?? "{}") as Record<string, unknown>;
  }

  it("names the logo and the share card as the Organization's images", () => {
    const org = organizationJson();
    const images = org.image as Array<Record<string, unknown>>;
    expect(images.map((i) => i.url)).toEqual([
      "https://shorted.com.au/icon-512.png",
      "https://shorted.com.au/opengraph-image",
    ]);
    expect(images[0]).toMatchObject({ "@type": "ImageObject", width: 512, height: 512 });
    expect(images[1]).toMatchObject({ "@type": "ImageObject", width: 1200, height: 630 });
    expect(org.logo).toMatchObject({ url: "https://shorted.com.au/icon-512.png" });
  });

  it("gives the founder no image on the homepage", () => {
    const founder = organizationJson().founder as Record<string, unknown>;
    expect(founder.name).toBe("Ben Ebsworth");
    expect(founder).not.toHaveProperty("image");
    expect(founder.sameAs).toContain("https://x.com/sycli");
  });
});
