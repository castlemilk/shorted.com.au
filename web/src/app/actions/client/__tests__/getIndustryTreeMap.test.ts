/// <reference types="jest" />
import { getIndustryTreeMapClient } from "../getIndustryTreeMap";
import { ViewMode } from "~/gen/shorts/v1alpha1/market_pb";

describe("getIndustryTreeMapClient", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("loads browser heatmap data through the cached edge GET facade", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          industries: ["Materials"],
          stocks: [
            {
              industry: "Materials",
              productCode: "LOT",
              shortPosition: 12.3,
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-shorted-cache": "HIT",
            "x-shorted-edge": "cloudflare",
          },
        },
      ),
    );
    global.fetch = fetchMock;

    const result = await getIndustryTreeMapClient(
      "3m",
      8,
      ViewMode.CURRENT_CHANGE,
      true,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/edge/v1/industry-treemap?period=3M&limit=8&viewMode=0",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
        }),
      }),
    );
    expect(result.stocks[0]?.productCode).toBe("LOT");
    expect(result.stocks[0]?.shortPosition).toBe(12.3);
  });
});
