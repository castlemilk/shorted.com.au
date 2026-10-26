import { DynamicServerError } from "next/dist/client/components/hooks-server-context";

import {
  isDynamicServerUsageError,
  retryWithBackoff,
  shouldRetryConnectError,
} from "../retry";

// src/test/setup.ts mocks @connectrpc/connect for every suite; these cases
// need the real ConnectError.from, which is what wraps a failed fetch.
const { ConnectError } =
  jest.requireActual<typeof import("@connectrpc/connect")>("@connectrpc/connect");

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

describe("Next's dynamic-usage signal", () => {
  // What a Connect client rejects with when its fetch goes out no-store inside
  // a static render: the real Next error, wrapped by the real Connect code
  // path. Built from both libraries so a renamed digest or a change in how
  // Connect wraps fetch failures fails here rather than in production.
  const noStoreRead = () =>
    ConnectError.from(
      new DynamicServerError("no-store fetch https://api.test/GetBattlegroundStocks /battlegrounds"),
    );

  it("is recognised on Next's error and through Connect's wrapper", () => {
    const wrapped = noStoreRead();
    // Unknown is a retryable code on its own: only the cause tells them apart.
    expect(wrapped.code).toBe(2);
    expect(isDynamicServerUsageError(wrapped)).toBe(true);
    expect(isDynamicServerUsageError(new DynamicServerError("cookies"))).toBe(true);
  });

  it("is not retried by the default policy, while other Unknown errors still are", () => {
    expect(shouldRetryConnectError(noStoreRead())).toBe(false);
    expect(shouldRetryConnectError(ConnectError.from(new Error("socket hang up")))).toBe(true);
  });

  it("is never retried, even when a custom policy would retry", async () => {
    const error = noStoreRead();
    const operation = jest.fn().mockRejectedValue(error);
    await expect(
      retryWithBackoff(operation, { maxRetries: 3, initialDelayMs: 0, shouldRetry: () => true }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not mistake other errors, or a cyclic cause chain, for it", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    for (const error of [
      new Error("Dynamic server usage: but no digest"),
      { digest: "NEXT_NOT_FOUND" },
      connectError(2, "unknown"),
      cyclic,
      null,
      "DYNAMIC_SERVER_USAGE",
    ]) {
      expect(isDynamicServerUsageError(error)).toBe(false);
    }
  });
});
