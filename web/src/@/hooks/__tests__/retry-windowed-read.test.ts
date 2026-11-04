import { retryWindowedRead } from "../use-stock-queries";

// Stood in so the hook module loads without the network clients.
jest.mock("@/lib/client-api", () => ({
  fetchStockDataClient: jest.fn(),
  fetchStockDataWindowClient: jest.fn(),
  fetchStockPricesClient: jest.fn(),
  fetchStockClient: jest.fn(),
  fetchStockDetailsClient: jest.fn(),
  fetchTopShortsClient: jest.fn(),
}));

const connectError = (code: number) =>
  Object.assign(new Error(`code ${code}`), {
    code,
    metadata: { get: () => null },
  });

describe("retryWindowedRead", () => {
  it("retries NotFound, which the stock service answers for a database error", () => {
    expect(retryWindowedRead(0, connectError(5))).toBe(true);
    expect(retryWindowedRead(2, connectError(5))).toBe(true);
  });

  it("stops after three tries", () => {
    expect(retryWindowedRead(3, connectError(5))).toBe(false);
    expect(retryWindowedRead(3, connectError(14))).toBe(false);
  });

  it("follows the app's rule otherwise", () => {
    expect(retryWindowedRead(0, connectError(14))).toBe(true); // Unavailable
    expect(retryWindowedRead(0, connectError(3))).toBe(false); // InvalidArgument
  });
});
