/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";

/**
 * The insider-trading page's robots key. Next 14.2 merges metadata with `for
 * (key in source)`, so an own `robots: undefined` replaces the root layout's
 * robots (and its googleBot max-image-preview / max-snippet directives) with
 * nothing: the 797 sitemapped insider pages emitted no robots meta at all
 * (2026-10-21). Indexable means no key; a thin stock's page is noindexed, and a
 * failed stock read fails open.
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

import { getStock } from "~/app/actions/getStock";
import { generateMetadata } from "~/app/insider-trading/[stockCode]/page";

const mockGetStock = getStock as jest.Mock;

const params = Promise.resolve({ stockCode: "bhp" });

describe("insider-trading page metadata", () => {
  it("sets no robots key for an indexable stock", async () => {
    mockGetStock.mockResolvedValue({
      name: "BHP GROUP LIMITED ORDINARY",
      industry: "Materials",
      percentageShorted: 1.2,
    });
    const meta = await generateMetadata({ params });
    expect(Object.keys(meta)).not.toContain("robots");
  });

  it("noindexes a thin stub, and still follows its links", async () => {
    // No name, no industry and a short position under the indexing floor.
    mockGetStock.mockResolvedValue({ name: "", industry: "", percentageShorted: 0.01 });
    const meta = await generateMetadata({ params });
    expect(meta.robots).toEqual({
      index: false,
      follow: true,
      googleBot: { index: false, follow: true },
    });
  });

  it("sets no robots key while the stock read fails (fail open)", async () => {
    mockGetStock.mockRejectedValue(new Error("unavailable"));
    const meta = await generateMetadata({ params });
    expect(Object.keys(meta)).not.toContain("robots");
  });
});
