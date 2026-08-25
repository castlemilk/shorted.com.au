import type {
  ListStateCompaniesResponse,
  StateCompany,
} from "~/gen/shorts/v1alpha1/economy_pb";

import { buildStateExposureIndex } from "../getEconomy";

jest.mock("next/cache", () => ({
  unstable_cache: jest.fn((loader: () => Promise<unknown>) => loader),
}));

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({})),
}));

jest.mock("@/lib/kv-cache", () => ({
  CACHE_KEYS: { economicSeries: jest.fn() },
  ECONOMY_TTL: 3600,
  getCached: jest.fn(),
  setCached: jest.fn(),
}));

function response(
  companies: Array<Partial<StateCompany>>,
): ListStateCompaniesResponse {
  return { companies } as ListStateCompaniesResponse;
}

describe("buildStateExposureIndex", () => {
  it("keys exposures by uppercase stock code", async () => {
    const loader = jest.fn(async (state: string) =>
      state === "wa"
        ? response([
            {
              stockCode: "bhp",
              weight: 0.7,
              basis: "Pilbara iron ore operations",
              source: "llm",
            },
          ])
        : response([]),
    );

    const index = await buildStateExposureIndex(loader);

    expect(Object.keys(index)).toEqual(["BHP"]);
    expect(index.BHP).toEqual([
      {
        state: "wa",
        weight: 0.7,
        basis: "Pilbara iron ore operations",
        source: "llm",
      },
    ]);
  });

  it("drops a failed state without rejecting the whole index", async () => {
    const loader = jest.fn(async (state: string) => {
      if (state === "vic") throw new Error("service unavailable");
      if (state === "nsw") {
        return response([
          {
            stockCode: "CBA",
            weight: 0.4,
            basis: "NSW banking operations",
            source: "llm",
          },
        ]);
      }
      return response([]);
    });

    await expect(buildStateExposureIndex(loader)).resolves.toEqual({
      CBA: [
        {
          state: "nsw",
          weight: 0.4,
          basis: "NSW banking operations",
          source: "llm",
        },
      ],
    });
    expect(loader).toHaveBeenCalledTimes(8);
    expect(loader.mock.calls.every(([, limit]) => limit === 50)).toBe(true);
  });

  it("returns an empty index when every state has no companies", async () => {
    const loader = jest.fn(async () => response([]));

    await expect(buildStateExposureIndex(loader)).resolves.toEqual({});
  });
});
