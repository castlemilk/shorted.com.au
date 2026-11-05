const mockClient = { listStrategySignalEvents: jest.fn() };

jest.mock("@connectrpc/connect", () => ({
  createClient: () => mockClient,
}));

const mockCreateTransport = jest.fn(async (_options?: unknown) => ({
  transport: {},
  email: "",
}));
jest.mock("../../auth-transport", () => ({
  createSignedInTransport: (options?: unknown) => mockCreateTransport(options),
}));

jest.mock("~/server/auth", () => ({ auth: jest.fn() }));

// The history is per viewer: no shared cache may be reached.
const mockSharedCache = jest.fn();
jest.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => {
    mockSharedCache("next/cache");
    return fn;
  },
}));

import { auth } from "~/server/auth";
import { getSignalEventsForViewer } from "../signalEvents";

const mockAuth = auth as unknown as jest.Mock;

beforeEach(() => {
  mockClient.listStrategySignalEvents.mockReset();
  mockCreateTransport.mockClear();
  mockSharedCache.mockClear();
  mockAuth.mockReset();
  mockAuth.mockResolvedValue({ user: { id: "user-a" } });
});

describe("getSignalEventsForViewer", () => {
  it("answers signed-out without any call when there is no session", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(
      getSignalEventsForViewer({ strategyId: "canslim" }),
    ).resolves.toEqual({ ok: false, reason: "signed-out" });
    expect(mockClient.listStrategySignalEvents).not.toHaveBeenCalled();
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  it("refuses a malformed input without any call", async () => {
    await expect(
      getSignalEventsForViewer({ strategyId: "Canslim; drop" }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(
      getSignalEventsForViewer({ strategyId: "canslim", stockCode: "BHP-1" }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(
      getSignalEventsForViewer({ strategyId: "canslim", pageToken: "x1" }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(mockClient.listStrategySignalEvents).not.toHaveBeenCalled();
  });

  it("reads identity only, the live version, and maps the page", async () => {
    mockClient.listStrategySignalEvents.mockResolvedValue({
      events: [
        {
          stockCode: "PFP",
          sessionDate: "2026-11-03",
          prevSessionDate: "2026-10-30",
          fromStatus: "setup",
          toStatus: "triggered",
          score: 71,
        },
      ],
      nextPageToken: "",
      version: { strategyId: "canslim", label: "v1", rulesHash: "3f9a1c2e" + "0".repeat(56) },
    });

    const result = await getSignalEventsForViewer({
      strategyId: "canslim",
      stockCode: "pfp",
    });

    expect(mockCreateTransport).toHaveBeenCalledWith({ withEmail: false });
    expect(mockClient.listStrategySignalEvents).toHaveBeenCalledWith({
      strategyId: "canslim",
      versionHash: "",
      stockCode: "PFP",
      since: "",
      pageToken: "",
      pageSize: 20,
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.page.events[0]?.toStatus).toBe("triggered");
      expect(result.page.version?.label).toBe("v1");
    }
  });

  it("clamps the page size to the API's ceiling", async () => {
    mockClient.listStrategySignalEvents.mockResolvedValue({ events: [] });
    await getSignalEventsForViewer({ strategyId: "canslim", pageSize: 5000 });
    expect(mockClient.listStrategySignalEvents.mock.calls[0]?.[0]).toMatchObject({
      pageSize: 200,
    });
  });

  it("answers unavailable when the API call fails", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockClient.listStrategySignalEvents.mockRejectedValue(new Error("down"));
    await expect(
      getSignalEventsForViewer({ strategyId: "canslim" }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
    jest.restoreAllMocks();
  });

  it("never reaches a shared cache", async () => {
    mockClient.listStrategySignalEvents.mockResolvedValue({ events: [] });
    await getSignalEventsForViewer({ strategyId: "canslim" });
    expect(mockSharedCache).not.toHaveBeenCalled();
  });
});
