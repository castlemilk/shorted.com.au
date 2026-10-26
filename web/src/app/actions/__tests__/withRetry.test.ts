import { DynamicServerError } from "next/dist/client/components/hooks-server-context";

import {
  withRetry,
  withRetryAndNotFound,
  withRetryAndThrowNotFound,
} from "../withRetry";

// src/test/setup.ts mocks @connectrpc/connect for every suite; the real
// ConnectError.from is what wraps a failed fetch, so it is used here.
const { ConnectError } =
  jest.requireActual<typeof import("@connectrpc/connect")>("@connectrpc/connect");

/**
 * The action wrappers' default policy is 3 retries at 500, 1,000 and 2,000 ms.
 * Spent on Next's dynamic-usage signal, that was 3.5 s of every /battlegrounds
 * regeneration before Next discarded the render anyway (2026-10-21). One
 * attempt, then the wrapper's usual outcome, is the contract pinned here; the
 * defaults are used on purpose, because they are what the actions run with.
 */

// The real rejection: Next's error from a no-store read, wrapped by Connect.
const noStoreRead = () =>
  ConnectError.from(
    new DynamicServerError("no-store fetch https://api.test/GetBattlegroundStocks /battlegrounds"),
  );

describe("action wrappers and Next's dynamic-usage signal", () => {
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ["withRetryAndNotFound", withRetryAndNotFound],
    ["withRetryAndThrowNotFound", withRetryAndThrowNotFound],
  ] as const)(
    "%s makes one attempt and logs the transport, not the backend, as the cause",
    async (name, wrap) => {
      const action = jest.fn().mockRejectedValue(noStoreRead());

      await expect(wrap(action)()).resolves.toBeUndefined();

      expect(action).toHaveBeenCalledTimes(1);
      const label = String(errorLog.mock.calls[0]?.[0]);
      expect(label).toContain(`[${name}] no-store read inside a static render`);
      expect(label).not.toContain("All retries exhausted");
    },
  );

  it("withRetry rethrows it after one attempt", async () => {
    const error = noStoreRead();
    const action = jest.fn().mockRejectedValue(error);

    await expect(withRetry(action)()).rejects.toBe(error);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("still retries a transient failure", async () => {
    const unavailable = ConnectError.from(new Error("upstream connect error"), 14);
    const action = jest
      .fn()
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce("ok");

    await expect(
      withRetryAndNotFound(action, { initialDelayMs: 0, maxDelayMs: 0 })(),
    ).resolves.toBe("ok");
    expect(action).toHaveBeenCalledTimes(2);
  });
});
