import {
  getPortfolio,
  getWatchlist,
} from "../portfolio";
import { auth } from "@/auth";
import { adminDb } from "@/lib/firebase-admin";
import { clearLegacyEmailLookupMissCacheForTests } from "@/lib/firestore-legacy-email-lookup-cache";

jest.mock("@/lib/firebase-admin", () => ({
  adminDb: {
    collection: jest.fn(),
  },
}));

jest.mock("@/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: jest.fn(() => "server-timestamp"),
  },
}));

type Snapshot = {
  exists: boolean;
  data: () => Record<string, unknown>;
};

function missingSnapshot(): Snapshot {
  return {
    exists: false,
    data: () => ({}),
  };
}

function existingSnapshot(data: Record<string, unknown>): Snapshot {
  return {
    exists: true,
    data: () => data,
  };
}

describe("portfolio Firestore cost controls", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearLegacyEmailLookupMissCacheForTests();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("caches missing legacy portfolio email lookups per hot instance", async () => {
    const get = jest.fn().mockResolvedValue(missingSnapshot());
    const set = jest.fn().mockResolvedValue(undefined);
    const doc = jest.fn(() => ({ get, set }));
    (adminDb.collection as jest.Mock).mockReturnValue({ doc });
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user-123", email: "legacy@example.com" },
    });

    await expect(getPortfolio()).resolves.toEqual({ holdings: [] });
    await expect(getPortfolio()).resolves.toEqual({ holdings: [] });

    expect(doc.mock.calls.map(([id]) => id)).toEqual([
      "user-123",
      "legacy@example.com",
      "user-123",
    ]);
    expect(set).not.toHaveBeenCalled();
  });

  it("still migrates portfolio data when the legacy email document exists", async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce(missingSnapshot())
      .mockResolvedValueOnce(
        existingSnapshot({
          holdings: [{ symbol: "BHP", shares: 10, averagePrice: 40 }],
          updatedAt: { toDate: () => new Date("2026-07-01T00:00:00Z") },
        }),
      );
    const set = jest.fn().mockResolvedValue(undefined);
    const doc = jest.fn(() => ({ get, set }));
    (adminDb.collection as jest.Mock).mockReturnValue({ doc });
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user-123", email: "legacy@example.com" },
    });

    const portfolio = await getPortfolio();

    expect(portfolio.holdings).toEqual([
      { symbol: "BHP", shares: 10, averagePrice: 40 },
    ]);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        migratedFrom: "legacy@example.com",
      }),
    );
  });

  it("caches missing legacy watchlist email lookups per hot instance", async () => {
    const get = jest.fn().mockResolvedValue(missingSnapshot());
    const set = jest.fn().mockResolvedValue(undefined);
    const doc = jest.fn(() => ({ get, set }));
    (adminDb.collection as jest.Mock).mockReturnValue({ doc });
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "user-123", email: "legacy@example.com" },
    });

    await expect(getWatchlist()).resolves.toEqual({ items: [] });
    await expect(getWatchlist()).resolves.toEqual({ items: [] });

    expect(doc.mock.calls.map(([id]) => id)).toEqual([
      "user-123",
      "legacy@example.com",
      "user-123",
    ]);
    expect(set).not.toHaveBeenCalled();
  });
});
