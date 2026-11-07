const listStrategyEvidence = jest.fn();
const unstableCache = jest.fn();
const skipForBuild = jest.fn(() => false);

jest.mock("@connectrpc/connect-web", () => ({ createConnectTransport: () => ({}) }));
jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({ listStrategyEvidence: (...args: unknown[]) => listStrategyEvidence(...args) }),
}));
jest.mock("next/cache", () => ({
  unstable_cache: (fn: (...a: unknown[]) => unknown, key: unknown, opts: unknown) => {
    unstableCache(key, opts);
    return fn;
  },
}));
jest.mock("../../config", () => ({
  SHORTS_API_URL: "https://api.example",
  serverFetchOutsideNextCache: jest.fn(),
  skipForBuild: () => skipForBuild(),
}));

import { getStrategyEvidence } from "../getStrategyEvidence";

const ONE = { strategies: [{ strategyId: "canslim", state: "published", annual: [] }], windowStart: "2019-05-01" };

describe("getStrategyEvidence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    skipForBuild.mockReturnValue(false);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("caches the evidence for an hour under the backtests tag and the picks tag", async () => {
    listStrategyEvidence.mockResolvedValue(ONE);
    await getStrategyEvidence();
    expect(unstableCache).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ revalidate: 3600, tags: expect.arrayContaining(["strategy-backtests", "strategy-picks"]) }),
    );
  });

  it("maps the list it reads", async () => {
    listStrategyEvidence.mockResolvedValue(ONE);
    const result = await getStrategyEvidence();
    expect(result?.strategies[0]).toMatchObject({ strategyId: "canslim", state: "published" });
    expect(result?.windowStart).toBe("2019-05-01");
  });

  it("throws on an empty answer, so it is never cached: the caller gets null", async () => {
    listStrategyEvidence.mockResolvedValue({ strategies: [] });
    await expect(getStrategyEvidence()).resolves.toBeNull();
  });

  it("returns null on an error, not a rejection", async () => {
    listStrategyEvidence.mockRejectedValue(new Error("down"));
    await expect(getStrategyEvidence()).resolves.toBeNull();
  });

  it("makes no call at build time", async () => {
    skipForBuild.mockReturnValue(true);
    await expect(getStrategyEvidence()).resolves.toBeNull();
    expect(listStrategyEvidence).not.toHaveBeenCalled();
  });
});
