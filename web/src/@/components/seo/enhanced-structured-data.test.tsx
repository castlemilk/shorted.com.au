/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react";
import { DatasetStructuredData } from "./enhanced-structured-data";

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
