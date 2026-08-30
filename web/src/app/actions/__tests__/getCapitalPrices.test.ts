const unstableCache = jest.fn((callback: () => Promise<unknown>) => callback);
const createConnectTransport = jest.fn(() => ({ transport: true }));
const createClient = jest.fn();
const skipForBuild = jest.fn(() => false);
const serverFetchOutsideNextCache = jest.fn();

jest.mock("next/cache", () => ({
  unstable_cache: (...args: unknown[]) => unstableCache(...args),
}));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (...args: unknown[]) =>
    createConnectTransport(...args),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: (...args: unknown[]) => createClient(...args),
}));
jest.mock("../config", () => ({
  SERVER_SHORTS_API_URL: "https://shorts.test",
  serverFetchOutsideNextCache: (...args: unknown[]) =>
    serverFetchOutsideNextCache(...args),
  skipForBuild: () => skipForBuild(),
}));

import { getCapitalPrices } from "../getCapitalPrices";

const seconds = (iso: string) => BigInt(Date.parse(iso) / 1000);

function response({
  regionCode,
  dwellingType,
  values = [800_000, 850_000],
}: {
  regionCode: string;
  dwellingType: "established_house" | "attached";
  values?: number[];
}) {
  return {
    regionCode,
    regionName: regionCode === "2RVIC" ? "Rest of Vic." : "Greater Melbourne",
    measure: "median_price",
    dwellingType,
    unit: "AUD",
    source: "abs_res_dwell",
    sourceLicence: "CC-BY-4.0",
    points: values.map((value, index) => ({
      period: {
        seconds: seconds(
          index === 0 ? "2025-12-31T00:00:00Z" : "2026-03-31T00:00:00Z",
        ),
        nanos: 0,
      },
      value,
      isPreliminary: index === values.length - 1,
    })),
  };
}

describe("getCapitalPrices", () => {
  const getHousePriceSeries = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    skipForBuild.mockReturnValue(false);
    createClient.mockReturnValue({ getHousePriceSeries });
    getHousePriceSeries.mockImplementation(
      ({
        regionCode,
        dwellingType,
      }: {
        regionCode: string;
        dwellingType: "established_house" | "attached";
      }) => Promise.resolve(response({ regionCode, dwellingType })),
    );
  });

  it("shapes one cached snapshot with serializable house, unit and regional series", async () => {
    await expect(getCapitalPrices("2GMEL", "2RVIC")).resolves.toEqual({
      regionCode: "2GMEL",
      house: expect.objectContaining({
        regionCode: "2GMEL",
        regionName: "Greater Melbourne",
        dwellingType: "established_house",
        unit: "AUD",
        source: "abs_res_dwell",
        sourceLicence: "CC-BY-4.0",
        points: [
          {
            period: "2025-12-31",
            value: 800_000,
            isPreliminary: false,
          },
          {
            period: "2026-03-31",
            value: 850_000,
            isPreliminary: true,
          },
        ],
      }),
      unit: expect.objectContaining({
        regionCode: "2GMEL",
        dwellingType: "attached",
      }),
      restOfState: expect.objectContaining({
        regionCode: "2RVIC",
        dwellingType: "established_house",
      }),
    });

    expect(getHousePriceSeries).toHaveBeenCalledTimes(3);
    expect(getHousePriceSeries).toHaveBeenCalledWith({
      regionCode: "2GMEL",
      measure: "median_price",
      dwellingType: "established_house",
    });
    expect(getHousePriceSeries).toHaveBeenCalledWith({
      regionCode: "2GMEL",
      measure: "median_price",
      dwellingType: "attached",
    });
    expect(getHousePriceSeries).toHaveBeenCalledWith({
      regionCode: "2RVIC",
      measure: "median_price",
      dwellingType: "established_house",
    });
    expect(createConnectTransport).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      baseUrl: "https://shorts.test",
    });
    expect(unstableCache).toHaveBeenCalledWith(
      expect.any(Function),
      ["housing-capital-2gmel-v1"],
      {
        tags: ["housing", "housing-capitals", "housing-capital-2gmel"],
        revalidate: 3600,
      },
    );
  });

  it("keeps the capital page usable when the rest-of-state request fails", async () => {
    getHousePriceSeries.mockImplementation(
      ({
        regionCode,
        dwellingType,
      }: {
        regionCode: string;
        dwellingType: "established_house" | "attached";
      }) =>
        regionCode === "2RVIC"
          ? Promise.reject(new Error("regional series unavailable"))
          : Promise.resolve(response({ regionCode, dwellingType })),
    );

    const result = await getCapitalPrices("2GMEL", "2RVIC");

    expect(result?.house?.points).toHaveLength(2);
    expect(result?.unit?.points).toHaveLength(2);
    expect(result?.restOfState).toBeNull();
  });

  it("does not request a fabricated rest-of-state series for the ACT", async () => {
    const result = await getCapitalPrices("8ACTE", null);

    expect(getHousePriceSeries).toHaveBeenCalledTimes(2);
    expect(result?.restOfState).toBeNull();
  });

  it("returns null when every requested series fails", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    getHousePriceSeries.mockRejectedValue(new Error("origin unavailable"));

    await expect(getCapitalPrices("2GMEL", "2RVIC")).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(
      "[getCapitalPrices] failed for 2GMEL:",
      expect.any(Error),
    );
    error.mockRestore();
  });

  it("throws on empty responses inside the cache callback so they are never cached", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    getHousePriceSeries.mockImplementation(
      ({
        regionCode,
        dwellingType,
      }: {
        regionCode: string;
        dwellingType: "established_house" | "attached";
      }) => Promise.resolve(response({ regionCode, dwellingType, values: [] })),
    );

    await expect(getCapitalPrices("2GMEL", "2RVIC")).resolves.toBeNull();

    const cacheCallback = unstableCache.mock.calls[0]?.[0];
    await expect(cacheCallback()).rejects.toThrow(
      "GetHousePriceSeries returned no data for 2GMEL",
    );
    error.mockRestore();
  });

  it("returns null without constructing a client during a skipped build", async () => {
    skipForBuild.mockReturnValue(true);

    await expect(getCapitalPrices("2GMEL", "2RVIC")).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });
});
