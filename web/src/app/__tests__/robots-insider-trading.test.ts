/// <reference types="jest" />
import { beforeEach, describe, expect, it } from "@jest/globals";

/**
 * The insider-trading page's robots key. Next 14.2 merges metadata with `for
 * (key in source)`, so an own `robots: undefined` replaces the root layout's
 * robots (and its googleBot max-image-preview / max-snippet directives) with
 * nothing: the 797 sitemapped insider pages emitted no robots meta at all
 * (2026-10-21). Indexable means no key; a thin stock's page is noindexed.
 *
 * The page is on-demand ISR, so a failed stock read fails the metadata with
 * the render (it used to fail open, which ISR would have cached for the hour),
 * and only a code the API does not know gets the noindexed not-found title.
 */

jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn(() => ({})) }));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("~/app/actions/getStock", () => ({
  getStock: jest.fn(),
  getStockOrNotFound: jest.fn(),
}));
jest.mock("~/app/actions/getDirectorTrades", () => ({
  getDirectorTrades: jest.fn(),
}));

import { getStockOrNotFound } from "~/app/actions/getStock";
import { NotFoundError } from "~/app/actions/withRetry";
import { generateMetadata } from "~/app/insider-trading/[stockCode]/page";

const mockGetStock = getStockOrNotFound as jest.Mock;

const params = Promise.resolve({ stockCode: "bhp" });

const NOINDEX = {
  index: false,
  follow: true,
  googleBot: { index: false, follow: true },
};

describe("insider-trading page metadata", () => {
  beforeEach(() => mockGetStock.mockReset());

  it("sets no robots key for an indexable stock", async () => {
    mockGetStock.mockResolvedValue({
      name: "BHP GROUP LIMITED ORDINARY",
      industry: "Materials",
      percentageShorted: 1.2,
    });
    const meta = await generateMetadata({ params });
    expect(Object.keys(meta)).not.toContain("robots");
    expect(mockGetStock).toHaveBeenCalledWith("BHP");
  });

  it("noindexes a thin stub, and still follows its links", async () => {
    // No name, no industry and a short position under the indexing floor.
    mockGetStock.mockResolvedValue({ name: "", industry: "", percentageShorted: 0.01 });
    const meta = await generateMetadata({ params });
    expect(meta.robots).toEqual(NOINDEX);
  });

  it("fails with the render while the stock read fails, never caching a robots decision", async () => {
    // getStockOrNotFound's answer for a failed read.
    mockGetStock.mockResolvedValue(undefined);
    await expect(generateMetadata({ params })).rejects.toThrow(/transiently unavailable/);
  });

  it("noindexes a code the API does not know", async () => {
    mockGetStock.mockRejectedValue(new NotFoundError("stock not found: ZZZZ"));
    const meta = await generateMetadata({ params: Promise.resolve({ stockCode: "ZZZZ" }) });
    expect(meta).toEqual({ title: "Stock not found", robots: NOINDEX });
  });

  it.each(["AB", "ABCDE", "B-H"])("noindexes %s without a read: the API rejects the code", async (stockCode) => {
    const meta = await generateMetadata({ params: Promise.resolve({ stockCode }) });
    expect(meta).toEqual({ title: "Stock not found", robots: NOINDEX });
    expect(mockGetStock).not.toHaveBeenCalled();
  });
});
