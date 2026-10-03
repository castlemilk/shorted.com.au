/// <reference types="jest" />

const mockSnapshot = jest.fn();
jest.mock("~/app/actions/market/getMarketByDate", () => ({
  ...jest.requireActual("~/app/actions/market/getMarketByDate"),
  getMarketByDateStrict: (...args: unknown[]) => mockSnapshot(...args),
}));
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

import * as route from "../page";

const props = (date: string) => ({ params: Promise.resolve({ date }) });

describe("market date ISR generation", () => {
  beforeEach(() => {
    mockSnapshot.mockReset();
  });

  it("generates historical dates on demand with a 24h safety interval", () => {
    expect(route.generateStaticParams()).toEqual([]);
    expect(route.dynamicParams).toBe(true);
    expect(route.revalidate).toBe(86400);
  });

  it.each([null, {}, { stocks: [], totalCount: 0 }])("404s a successfully empty snapshot (%j)", async (data) => {
    mockSnapshot.mockResolvedValue(data);
    await expect(route.generateMetadata(props("2026-05-16"))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(route.default(props("2026-05-16"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("does not cache an API outage as a missing date", async () => {
    mockSnapshot.mockRejectedValue(new Error("snapshot unavailable"));
    await expect(route.generateMetadata(props("2026-05-15"))).rejects.toThrow("snapshot unavailable");
    await expect(route.default(props("2026-05-15"))).rejects.toThrow("snapshot unavailable");
  });

  it.each(["2026-02-30", "2026-13-01", "not-a-date"])("rejects invalid date %s before fetching", async (date) => {
    await expect(route.generateMetadata(props(date))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it("renders a real snapshot with canonical metadata", async () => {
    mockSnapshot.mockResolvedValue({
      stocks: [{ productCode: "BHP", name: "BHP", percentageShorted: 2, reportedShortPositions: 1234, industry: "Materials" }],
      totalCount: 1,
    });
    const metadata = await route.generateMetadata(props("2026-05-15"));
    expect(metadata.alternates?.canonical).toBe("https://shorted.com.au/market/2026-05-15");
    await expect(route.default(props("2026-05-15"))).resolves.toBeTruthy();
  });
});
