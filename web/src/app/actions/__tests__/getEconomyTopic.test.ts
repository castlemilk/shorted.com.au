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

import { getEconomyTopicSnapshot } from "../getEconomyTopic";

const catalogSeries = (seriesKey: string, metric: string) => ({
  seriesKey,
  topic: "wages",
  metric,
  product: "total",
  regionType: "state",
  regionCode: "wa",
  regionName: "Western Australia",
  unit: metric.includes("yoy") ? "percent" : "index",
  frequency: "quarterly",
  adjustment: "seasadj",
  sourceKey: "abs_wpi",
  sourceLicence: "Creative Commons Attribution 4.0",
  latestPeriod: { seconds: 1_751_328_000n, nanos: 0 },
});

const observations = (seriesKey: string, values = [100, 102]) => ({
  series: [
    {
      info: { seriesKey },
      observations: values.map((value, index) => ({
        period: {
          seconds: BigInt(1_735_689_600 + index * 7_776_000),
          nanos: 0,
        },
        value,
      })),
    },
  ],
});

describe("getEconomyTopicSnapshot", () => {
  const listEconomicSeries = jest.fn();
  const getEconomicSeries = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    skipForBuild.mockReturnValue(false);
    createClient.mockReturnValue({ listEconomicSeries, getEconomicSeries });
    listEconomicSeries.mockResolvedValue({
      series: [
        catalogSeries("wages.wpi.wa", "wpi"),
        catalogSeries("wages.wpi_yoy.wa", "wpi_yoy"),
      ],
    });
    getEconomicSeries.mockImplementation(
      ({ seriesKeys }: { seriesKeys: string[] }) =>
        Promise.resolve(observations(seriesKeys[0]!)),
    );
  });

  it("shapes one cached, serializable snapshot for a state and topic", async () => {
    await expect(getEconomyTopicSnapshot("wa", "wages")).resolves.toEqual({
      state: "wa",
      topic: "wages",
      series: [
        expect.objectContaining({
          seriesKey: "wages.wpi.wa",
          metric: "wpi",
          unit: "index",
          frequency: "quarterly",
          adjustment: "seasadj",
          sourceKey: "abs_wpi",
          sourceLicence: "Creative Commons Attribution 4.0",
          latestPeriod: "2025-07-01",
          observations: [
            { period: "2025-01-01", value: 100 },
            { period: "2025-04-01", value: 102 },
          ],
        }),
        expect.objectContaining({ seriesKey: "wages.wpi_yoy.wa" }),
      ],
    });

    expect(listEconomicSeries).toHaveBeenCalledWith({
      topic: "wages",
      metric: "",
      regionType: "state",
      regionCode: "wa",
      product: "",
      limit: 500,
    });
    expect(getEconomicSeries).toHaveBeenCalledTimes(2);
    expect(getEconomicSeries).toHaveBeenCalledWith({
      seriesKeys: ["wages.wpi.wa"],
      maxObservations: 600,
    });
    expect(createConnectTransport).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      baseUrl: "https://shorts.test",
    });
    expect(unstableCache).toHaveBeenCalledWith(
      expect.any(Function),
      ["economy-topic-wa-wages-v1"],
      {
        tags: ["economy", "economy-topics", "economy-topic-wa-wages"],
        revalidate: 3600,
      },
    );
  });

  it("keeps successful series when an individual observation fetch fails", async () => {
    getEconomicSeries.mockImplementation(
      ({ seriesKeys }: { seriesKeys: string[] }) =>
        seriesKeys[0] === "wages.wpi.wa"
          ? Promise.resolve(observations(seriesKeys[0]))
          : Promise.reject(new Error("one series unavailable")),
    );

    const result = await getEconomyTopicSnapshot("wa", "wages");

    expect(result?.series.map((series) => series.seriesKey)).toEqual([
      "wages.wpi.wa",
    ]);
  });

  it("returns null when every discovered series fails", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    getEconomicSeries.mockRejectedValue(new Error("origin unavailable"));

    await expect(getEconomyTopicSnapshot("wa", "wages")).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(
      "[getEconomyTopicSnapshot] failed for wa/wages:",
      expect.any(Error),
    );
    error.mockRestore();
  });

  it("throws inside the cache callback so an empty catalog is never cached", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    listEconomicSeries.mockResolvedValue({ series: [] });

    await expect(getEconomyTopicSnapshot("wa", "wages")).resolves.toBeNull();
    expect(getEconomicSeries).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "[getEconomyTopicSnapshot] failed for wa/wages:",
      expect.objectContaining({
        message: "ListEconomicSeries returned no series for wa/wages",
      }),
    );
    error.mockRestore();
  });

  it("returns null without constructing a client during a skipped build", async () => {
    skipForBuild.mockReturnValue(true);

    await expect(getEconomyTopicSnapshot("wa", "wages")).resolves.toBeNull();
    expect(createConnectTransport).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });
});
