/**
 * @jest-environment node
 */
/**
 * sharedRead holds one answer for every caller in its window, and nothing else.
 * unstable_cache stores what its callback returns, so a read that throws (an
 * empty or failed answer) is never held and the next caller asks again. A
 * plain POST with a `next` option was held for the whole window, empty or not.
 */
const store = new Map<string, unknown>();
const unstableCache = jest.fn();

jest.mock("next/cache", () => ({
  unstable_cache: (read: () => Promise<unknown>, keys: string[], opts: unknown) => {
    unstableCache(keys, opts);
    return async () => {
      const key = JSON.stringify(keys);
      if (store.has(key)) return store.get(key);
      const value = await read();
      store.set(key, value);
      return value;
    };
  },
}));

import { sharedRead } from "../shared-read";

describe("sharedRead", () => {
  beforeEach(() => {
    store.clear();
    unstableCache.mockClear();
  });

  it("reads through one entry under its keys and window", async () => {
    const read = jest.fn(async () => ({ stocks: [1] }));

    await sharedRead(["industry-treemap", "max"], 1800, read);

    expect(unstableCache).toHaveBeenCalledWith(["industry-treemap", "max"], {
      revalidate: 1800,
    });
  });

  it("answers the second caller in the window from the entry, without a new read", async () => {
    const read = jest.fn(async () => ({ stocks: [1] }));

    const first = await sharedRead(["k"], 1800, read);
    const second = await sharedRead(["k"], 1800, read);

    expect(second).toEqual(first);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("holds nothing from a read that throws, so the next caller asks again", async () => {
    const read = jest
      .fn<Promise<{ stocks: unknown[] }>, []>()
      .mockRejectedValueOnce(new Error("GetIndustryTreeMap max: API returned no industry rows"))
      .mockResolvedValueOnce({ stocks: [{ productCode: "MIN" }] });

    await expect(sharedRead(["k"], 1800, read)).rejects.toThrow("no industry rows");
    await expect(sharedRead(["k"], 1800, read)).resolves.toEqual({
      stocks: [{ productCode: "MIN" }],
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps separate answers under separate keys", async () => {
    const max = jest.fn(async () => "max-answer");
    const threeMonths = jest.fn(async () => "3m-answer");

    await expect(sharedRead(["treemap", "max"], 1800, max)).resolves.toBe("max-answer");
    await expect(sharedRead(["treemap", "3m"], 1800, threeMonths)).resolves.toBe("3m-answer");
    expect(max).toHaveBeenCalledTimes(1);
    expect(threeMonths).toHaveBeenCalledTimes(1);
  });
});
