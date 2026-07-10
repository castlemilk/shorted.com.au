/// <reference types="jest" />
import { getTooltipDataClient } from "../getTooltipData";

describe("getTooltipDataClient", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("loads tooltip stock details and history from cached edge GET endpoints", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            productCode: "LOT",
            companyName: "Lotus Resources",
            industry: "Energy",
            summary: "Cached profile",
            website: "https://example.com",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-shorted-cache": "HIT",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            productCode: "LOT",
            latestShortPosition: 12.3,
            points: [
              {
                timestamp: "2026-07-01T00:00:00Z",
                shortPosition: 11.8,
              },
              {
                timestamp: "2026-07-02T00:00:00Z",
                shortPosition: 12.3,
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-shorted-cache": "HIT",
            },
          },
        ),
      );
    global.fetch = fetchMock;

    const result = await getTooltipDataClient("lot");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/edge/v1/stock/LOT/details",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/edge/v1/stock/LOT/data?period=1M",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
        }),
      }),
    );
    expect(result.stockDetails?.companyName).toBe("Lotus Resources");
    expect(result.timeSeriesData?.points).toHaveLength(2);
  });
});
