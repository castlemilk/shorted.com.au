/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";

/**
 * The yearly review's robots key. Next 14.2 merges metadata with `for (key in
 * source)`, so an own `robots: undefined` replaces the root layout's robots
 * (and its googleBot max-image-preview / max-snippet directives) with nothing:
 * both published reviews emitted no robots meta (2026-10-21). Indexable means
 * no key; a review without its headline is noindexed.
 */

jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn(() => ({})) }));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
jest.mock("~/app/actions/reports/getReportData", () => ({
  getEnhancedWeeklyReportDataStrict: jest.fn(),
}));

import { getEnhancedWeeklyReportDataStrict } from "~/app/actions/reports/getReportData";
import { generateMetadata } from "../page";

const mockEnhanced = getEnhancedWeeklyReportDataStrict as jest.Mock;

const params = Promise.resolve({ slug: "2025" });

describe("yearly review metadata", () => {
  it("sets no robots key on a review with its headline", async () => {
    mockEnhanced.mockResolvedValue({
      headline: "BOE ends 2025 as the ASX's most shorted stock",
      summary: "s",
    });
    const meta = await generateMetadata({ params });
    expect(Object.keys(meta)).not.toContain("robots");
  });

  it("noindexes a review without its headline", async () => {
    mockEnhanced.mockResolvedValue({ headline: "", summary: "" });
    const meta = await generateMetadata({ params });
    expect(meta.robots).toEqual({
      index: false,
      follow: true,
      googleBot: { index: false, follow: true },
    });
  });
});
