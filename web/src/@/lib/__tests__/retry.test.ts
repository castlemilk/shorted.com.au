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

describe("retry cancellation", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("does not start an operation whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = jest.fn().mockResolvedValue("unused");
    await expect(retryWithBackoff(operation, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("cancels and removes a pending backoff without another attempt", async () => {
    const controller = new AbortController();
    const operation = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const pending = retryWithBackoff(operation, { signal: controller.signal, initialDelayMs: 1000 });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await jest.advanceTimersByTimeAsync(0);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    controller.abort();
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each([new DOMException("Aborted", "AbortError"), connectError(1, "cancelled")])(
    "never retries cancellation even when a custom policy would retry",
    async (error) => {
      const operation = jest.fn().mockRejectedValue(error);
      await expect(retryWithBackoff(operation, { shouldRetry: () => true })).rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(1);
    },
  );
});
