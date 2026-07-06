import { retryWithBackoff } from "../retry";

function connectError(code: number, message = "connect error") {
  return {
    code,
    message,
    metadata: {
      get: () => null,
    },
  };
}

describe("retryWithBackoff", () => {
  it("does not retry deterministic Connect errors by default", async () => {
    const error = connectError(5, "not found");
    const fn = jest.fn().mockRejectedValue(error);

    await expect(
      retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
      }),
    ).rejects.toBe(error);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient Connect errors by default", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(connectError(14, "unavailable"))
      .mockResolvedValueOnce("ok");

    await expect(
      retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
      }),
    ).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(2);
  });
});
