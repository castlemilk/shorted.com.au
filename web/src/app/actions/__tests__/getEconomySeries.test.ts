/**
 * getEconomicSeries: live first, KV as the last-good fallback.
 *
 * KV used to be read BEFORE the live read, so every ISR regeneration of
 * /economy and /economy/[state] paid an Upstash round trip even when the Next
 * data cache would have answered the ISR-tagged fetch locally (perf review,
 * 2026-10-21). KV is now read only when the live read fails or comes back
 * empty, and an empty KV entry is a miss, never a hit (the /politicians
 * 2026-07-31 lesson: a zeroed entry served as a hit pinned zeros for 24h).
 */
import { create, toJson, type JsonValue } from "@bufbuild/protobuf";

import {
  GetEconomicSeriesResponseSchema,
  type GetEconomicSeriesResponse,
} from "~/gen/shorts/v1alpha1/economy_pb";

// src/test/setup.ts stubs @bufbuild/protobuf with pass-through create/fromJson
// and no toJson. The write-through and the BigInt rehydration are what this
// file tests, so it runs against the real runtime.
jest.unmock("@bufbuild/protobuf");

const createConnectTransport = jest.fn((options: unknown) => ({ options }));
const getEconomicSeriesRpc = jest.fn();
const serverFetchWithUserAgent = jest.fn();
const skipForBuild = jest.fn(() => false);
const getCached = jest.fn();
const setCached = jest.fn();

jest.mock("next/cache", () => ({
  unstable_cache: jest.fn((loader: () => Promise<unknown>) => loader),
}));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (options: unknown) => createConnectTransport(options),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    getEconomicSeries: (...args: unknown[]) => getEconomicSeriesRpc(...args),
  }),
}));
jest.mock("../config", () => ({
  SERVER_SHORTS_API_URL: "https://shorts.test",
  serverFetchWithUserAgent: (...args: unknown[]) =>
    serverFetchWithUserAgent(...args),
  skipForBuild: () => skipForBuild(),
}));
jest.mock("@/lib/kv-cache", () => ({
  CACHE_KEYS: {
    economicSeries: (sortedKeys: string) => `cache:economy:series:${sortedKeys}`,
  },
  ECONOMY_TTL: 21600,
  getCached: (...args: unknown[]) => getCached(...args),
  setCached: (...args: unknown[]) => setCached(...args),
}));

import { getEconomicSeries } from "../getEconomy";

// 2026-08-01T00:00:00Z, the August 2026 Labour Force period.
const AUG_2026 = 1_785_542_400n;

function seriesResponse(value: number): GetEconomicSeriesResponse {
  return create(GetEconomicSeriesResponseSchema, {
    series: [
      {
        info: { seriesKey: "labour.unemployment_rate.total.vic.seasadj" },
        observations: [{ period: { seconds: AUG_2026, nanos: 0 }, value }],
      },
    ],
  });
}

const emptyResponse = () => create(GetEconomicSeriesResponseSchema, {});

/** A KV entry exactly as the write-through stores it. */
const kvEntry = (value: number): JsonValue =>
  toJson(GetEconomicSeriesResponseSchema, seriesResponse(value));

// A Connect error the retry wrapper does not retry (InvalidArgument), so the
// "nothing to fall back to" path does not wait out the real backoff.
const nonRetryableError = () =>
  Object.assign(new Error("invalid series key"), {
    code: 3,
    metadata: { get: () => null },
  });

const KEYS = [
  "trade.export_value.total.vic",
  "labour.unemployment_rate.total.vic.seasadj",
];
const LATEST_ONLY_KEY =
  "cache:economy:series:labour.unemployment_rate.total.vic.seasadj,trade.export_value.total.vic@1";

describe("getEconomicSeries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    skipForBuild.mockReturnValue(false);
    getCached.mockResolvedValue(null);
    setCached.mockResolvedValue(true);
  });

  it("answers from the live read without touching KV, then writes it through", async () => {
    getEconomicSeriesRpc.mockResolvedValue(seriesResponse(5.2));

    const result = await getEconomicSeries(KEYS, 1);

    expect(result?.series[0]?.observations[0]?.value).toBe(5.2);
    expect(getEconomicSeriesRpc).toHaveBeenCalledWith({
      seriesKeys: KEYS,
      maxObservations: 1,
    });
    expect(getCached).not.toHaveBeenCalled();
    expect(setCached).toHaveBeenCalledWith(LATEST_ONLY_KEY, kvEntry(5.2), 21600);
  });

  it("keeps the uncapped entry under its original key", async () => {
    getEconomicSeriesRpc.mockResolvedValue(seriesResponse(5.2));

    await getEconomicSeries(KEYS);

    expect(getEconomicSeriesRpc).toHaveBeenCalledWith({
      seriesKeys: KEYS,
      maxObservations: 0,
    });
    expect(setCached).toHaveBeenCalledWith(
      "cache:economy:series:labour.unemployment_rate.total.vic.seasadj,trade.export_value.total.vic",
      kvEntry(5.2),
      21600,
    );
  });

  it("tags the transport's fetch for ISR (the load-bearing next.revalidate)", async () => {
    getEconomicSeriesRpc.mockResolvedValue(seriesResponse(5.2));
    await getEconomicSeries(KEYS, 1);

    const [options] = createConnectTransport.mock.calls[0] as [
      { fetch: typeof fetch; baseUrl: string },
    ];
    expect(options.baseUrl).toBe("https://shorts.test");
    await options.fetch("https://shorts.test/rpc", { method: "POST" });
    expect(serverFetchWithUserAgent).toHaveBeenCalledWith(
      "https://shorts.test/rpc",
      expect.objectContaining({ method: "POST", next: { revalidate: 3600 } }),
    );
  });

  it("serves last-good when the live read fails, rehydrating BigInt periods", async () => {
    getEconomicSeriesRpc.mockRejectedValue(new Error("upstream reset"));
    getCached.mockResolvedValue(kvEntry(4.9));

    const result = await getEconomicSeries(KEYS, 1);

    expect(getCached).toHaveBeenCalledWith(LATEST_ONLY_KEY);
    expect(result?.series[0]?.observations[0]?.value).toBe(4.9);
    expect(result?.series[0]?.observations[0]?.period?.seconds).toBe(AUG_2026);
    // Last-good answered at once: no retry against the failing API.
    expect(getEconomicSeriesRpc).toHaveBeenCalledTimes(1);
    expect(setCached).not.toHaveBeenCalled();
  });

  it("serves last-good when the live read comes back empty, and never caches the empty", async () => {
    getEconomicSeriesRpc.mockResolvedValue(emptyResponse());
    getCached.mockResolvedValue(kvEntry(4.9));

    const result = await getEconomicSeries(KEYS, 1);

    expect(result?.series[0]?.observations[0]?.value).toBe(4.9);
    expect(setCached).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty entry", {}],
    ["an entry with no series", { series: [] }],
    ["an entry from an older schema", { series: "not-a-list" }],
  ])("treats %s as a miss", async (_label, entry) => {
    const live = emptyResponse();
    getEconomicSeriesRpc.mockResolvedValue(live);
    getCached.mockResolvedValue(entry);

    const result = await getEconomicSeries(KEYS, 1);

    // The live answer stands; the parsed entry is never served in its place.
    expect(result).toBe(live);
    expect(setCached).not.toHaveBeenCalled();
  });

  it("rethrows to the retry wrapper when a failed read has no last-good", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    getEconomicSeriesRpc.mockRejectedValue(nonRetryableError());
    getCached.mockResolvedValue({});

    await expect(getEconomicSeries(KEYS, 1)).resolves.toBeUndefined();
    expect(getCached).toHaveBeenCalledWith(LATEST_ONLY_KEY);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[withRetryAndNotFound]"),
      "invalid series key",
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it("makes no live read and no KV read during the build", async () => {
    skipForBuild.mockReturnValue(true);

    await expect(getEconomicSeries(KEYS, 1)).resolves.toBeUndefined();
    expect(getEconomicSeriesRpc).not.toHaveBeenCalled();
    expect(getCached).not.toHaveBeenCalled();
  });
});
