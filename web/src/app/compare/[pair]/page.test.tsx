import { render, screen } from "@testing-library/react";

import ComparePage, * as segment from "./page";
import { NotFoundError } from "~/app/actions/withRetry";

const getStockOrNotFound = jest.fn();

jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
jest.mock("~/app/actions/getStock", () => ({
  getStockOrNotFound: (...args: unknown[]) => getStockOrNotFound(...args),
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
  BreadcrumbStructuredData: () => null,
}));

const STOCKS: Record<string, { name: string; industry: string; percentageShorted: number; reportedShortPositions: number }> = {
  DRO: { name: "DroneShield", industry: "Capital Goods", percentageShorted: 9.42, reportedShortPositions: 80_000_000 },
  LOT: { name: "Lotus Resources", industry: "Energy", percentageShorted: 7.1, reportedShortPositions: 150_000_000 },
};

const page = (pair: string) => ComparePage({ params: Promise.resolve({ pair }) });

describe("/compare/[pair]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    getStockOrNotFound.mockImplementation(async (code: string) => STOCKS[code]);
  });
  afterEach(() => jest.restoreAllMocks());

  // Without generateStaticParams every pair rendered per request and the
  // revalidate export was inert (`private, no-store`, 2026-10-21).
  it("is on-demand ISR: an empty generateStaticParams beside its revalidate", () => {
    expect(segment.revalidate).toBe(86400);
    expect(segment.dynamicParams).toBe(true);
    expect(segment.generateStaticParams()).toEqual([]);
  });

  it("renders both sides of a canonical pair", async () => {
    render(await page("DRO-vs-LOT"));

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "DRO vs LOT — ASX Short Interest Comparison",
    );
    expect(screen.getByText("9.42%", { selector: "dd" })).toBeInTheDocument();
  });

  it("404s a pair with a code the API does not know", async () => {
    getStockOrNotFound.mockImplementation(async (code: string) => {
      if (code === "LOT") throw new NotFoundError();
      return STOCKS[code];
    });

    await expect(page("DRO-vs-LOT")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  // Under ISR a 404 is cached like a page: answering a blip with notFound()
  // would hide a live pair for up to a day. Failing the render caches nothing.
  it("fails the render, rather than caching a 404, when a read is transiently unavailable", async () => {
    getStockOrNotFound.mockImplementation(async (code: string) =>
      code === "LOT" ? undefined : STOCKS[code],
    );

    await expect(page("DRO-vs-LOT")).rejects.toThrow(/transiently unavailable/);
  });

  // GetStock answers a code outside three or four alphanumerics
  // InvalidArgument, and the read swallows that into undefined (the mock's
  // answer for an unknown code here). Read, it failed the render on every
  // request: on-demand ISR caches nothing for a failed render.
  it.each([["AB-vs-BHP"], ["A-vs-BHP"], ["BHP-vs-X1"]])(
    "404s %s before any read: a code GetStock cannot accept",
    async (pair) => {
      await expect(page(pair)).rejects.toThrow("NEXT_NOT_FOUND");
      expect(getStockOrNotFound).not.toHaveBeenCalled();
    },
  );

  it("gives such a pair the not-found metadata, with no canonical", async () => {
    const meta = await segment.generateMetadata({ params: Promise.resolve({ pair: "AB-vs-BHP" }) });

    expect(meta).toEqual({ title: "Comparison Not Found" });
  });

  it("redirects a non-canonical ordering", async () => {
    await expect(page("LOT-vs-DRO")).rejects.toThrow("NEXT_REDIRECT /compare/DRO-vs-LOT");
    expect(getStockOrNotFound).not.toHaveBeenCalled();
  });
});
