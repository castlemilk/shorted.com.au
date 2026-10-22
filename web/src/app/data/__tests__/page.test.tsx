/// <reference types="jest" />
import { describe, expect, it, beforeEach } from "@jest/globals";
import { render } from "@testing-library/react";

/**
 * /data's site-level Dataset carries the ASIC report date the data runs to.
 * The page passed no date at all, so DatasetStructuredData stamped the render
 * time as dateModified. The date comes from the homepage's top-shorts read
 * (same arguments, so the same cache entries); without it the field is left
 * out.
 */

jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn(() => ({})) }));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("~/app/actions/getTopShorts", () => ({ getTopShortsData: jest.fn() }));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { getTopShortsData } from "~/app/actions/getTopShorts";
import DataHubPage from "../page";

const mockTopShorts = getTopShortsData as jest.Mock;

/** The page-level Dataset (the per-dataset entries live at /data#<slug>). */
async function pageDataset(): Promise<Record<string, unknown>> {
  const { container } = render(await DataHubPage());
  const found = Array.from(
    container.querySelectorAll('script[type="application/ld+json"]'),
  )
    .map((script) => JSON.parse(script.innerHTML) as Record<string, unknown>)
    .find((json) => json["@type"] === "Dataset" && json.url === "https://shorted.com.au/data");
  if (!found) throw new Error("/data renders no page-level Dataset");
  return found;
}

describe("/data Dataset JSON-LD", () => {
  beforeEach(() => mockTopShorts.mockReset());

  it("dates dateModified to the latest ASIC report", async () => {
    mockTopShorts.mockResolvedValue({
      timeSeries: [
        { productCode: "BOE", points: [{ timestamp: "2026-10-15T00:00:00Z" }] },
        { productCode: "DRO", points: [{ timestamp: "2026-10-14T00:00:00Z" }] },
      ],
    });
    const json = await pageDataset();
    expect(json.dateModified).toBe("2026-10-15T00:00:00.000Z");
    expect(mockTopShorts).toHaveBeenCalledWith("3m", 10, 0);
  });

  it("omits dateModified when the read fails", async () => {
    mockTopShorts.mockRejectedValue(new Error("unavailable"));
    const json = await pageDataset();
    expect(json).not.toHaveProperty("dateModified");
  });
});
