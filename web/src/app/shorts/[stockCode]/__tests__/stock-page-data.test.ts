/// <reference types="jest" />

const mockGetStockOrNotFound = jest.fn();
const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
jest.mock("next/navigation", () => ({ notFound: () => mockNotFound() }));
jest.mock("~/app/actions/getStock", () => ({
  getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a),
}));

import { loadStockOrFail } from "../stock-page-data";
import { NotFoundError } from "~/app/actions/withRetry";

const stock = { name: "BHP GROUP LIMITED ORDINARY", industry: "Materials" };

describe("loadStockOrFail", () => {
  beforeEach(() => {
    mockGetStockOrNotFound.mockReset();
    mockNotFound.mockClear();
  });

  it("returns the stock the cached read resolved", async () => {
    mockGetStockOrNotFound.mockResolvedValue(stock);
    await expect(loadStockOrFail("BHP")).resolves.toBe(stock);
    expect(mockGetStockOrNotFound).toHaveBeenCalledTimes(1);
    expect(mockGetStockOrNotFound).toHaveBeenCalledWith("BHP");
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("turns a code the API does not know into notFound()", async () => {
    mockGetStockOrNotFound.mockRejectedValue(new NotFoundError("ZZZZ"));
    await expect(loadStockOrFail("ZZZZ")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it("fails the render on a transient read instead of resolving a degraded page", async () => {
    mockGetStockOrNotFound.mockResolvedValue(undefined);
    await expect(loadStockOrFail("BHP")).rejects.toThrow(
      "stock data transiently unavailable for BHP; failing ISR render instead of caching a degraded page",
    );
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("lets any other error through untouched, so framework control flow still reaches Next", async () => {
    const boom = new Error("boom");
    mockGetStockOrNotFound.mockRejectedValue(boom);
    await expect(loadStockOrFail("BHP")).rejects.toBe(boom);
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});
