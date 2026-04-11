import {
  getCommunityThread,
  getStockCommunitySummary,
  listCommunityPulseItems,
  listCommunityThreads,
} from "~/@/lib/community/firestore-community";
import { adminDb } from "~/@/lib/firebase-admin";

jest.mock("~/@/lib/firebase-admin", () => ({
  adminDb: {
    collection: jest.fn(),
  },
}));

type MockDocData = Record<string, unknown> & {
  createdAt?: Date;
  updatedAt?: Date;
  lastActivityAt?: Date;
};

function createDocSnapshot(id: string, data: MockDocData) {
  return {
    id,
    exists: true,
    data: () => data,
  };
}

function createCollectionHarness() {
  const summaryGet = jest.fn();
  const threadListGet = jest.fn();
  const threadDetailGet = jest.fn();
  const pulseListGet = jest.fn();

  const threadsQuery = {
    where: jest.fn(),
    get: threadListGet,
  };
  threadsQuery.where.mockReturnValue(threadsQuery);

  const pulseQuery = {
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    get: pulseListGet,
  };
  pulseQuery.where.mockReturnValue(pulseQuery);
  pulseQuery.orderBy.mockReturnValue(pulseQuery);
  pulseQuery.limit.mockReturnValue(pulseQuery);

  const threadsCollection = {
    where: jest.fn(() => threadsQuery),
    doc: jest.fn(() => ({
      get: threadDetailGet,
    })),
  };

  const pulseCollection = {
    where: jest.fn(() => pulseQuery),
  };

  (adminDb.collection as jest.Mock).mockReturnValue({
    doc: jest.fn(() => ({
      get: summaryGet,
      collection: jest.fn((name: string) => {
        if (name === "threads") {
          return threadsCollection;
        }

        if (name === "pulse") {
          return pulseCollection;
        }

        throw new Error(`Unexpected collection ${name}`);
      }),
    })),
  });

  return {
    summaryGet,
    threadListGet,
    threadDetailGet,
    pulseListGet,
  };
}

describe("firestore-community repository", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads the stock community summary document", async () => {
    const { summaryGet } = createCollectionHarness();
    summaryGet.mockResolvedValue(
      createDocSnapshot("BHP", {
        headline: "Most active thread right now",
        subheadline: "6 threads and 14 pulse updates live now",
        ctaLabel: "Open community",
        threadCount: 6,
        pulseCount: 14,
      }),
    );

    const summary = await getStockCommunitySummary("BHP");

    expect(summary?.headline).toBe("Most active thread right now");
    expect(summary?.pulseCount).toBe(14);
  });

  it("reads and ranks active community threads", async () => {
    const { threadListGet } = createCollectionHarness();
    threadListGet.mockResolvedValue({
      docs: [
        createDocSnapshot("unsupported", {
          stockCode: "BHP",
          type: "question",
          title: "What am I missing?",
          body: "Not seeing the thesis yet.",
          score: 12,
          commentCount: 1,
          sourceCount: 0,
          highSignal: false,
          createdAt: new Date("2026-04-10T08:00:00Z"),
          updatedAt: new Date("2026-04-10T08:00:00Z"),
          lastActivityAt: new Date("2026-04-10T08:00:00Z"),
          status: "active",
        }),
        createDocSnapshot("supported", {
          stockCode: "BHP",
          type: "bull",
          title: "The capex case is tightening",
          body: "Three broker notes line up on the same catalyst.",
          score: 8,
          commentCount: 4,
          sourceCount: 3,
          highSignal: true,
          createdAt: new Date("2026-04-10T08:00:00Z"),
          updatedAt: new Date("2026-04-10T08:00:00Z"),
          lastActivityAt: new Date("2026-04-10T08:00:00Z"),
          status: "active",
        }),
      ],
    });

    const threads = await listCommunityThreads("BHP");

    expect(threads[0]?.id).toBe("supported");
    expect(threads).toHaveLength(2);
  });

  it("reads a single community thread detail", async () => {
    const { threadDetailGet } = createCollectionHarness();
    threadDetailGet.mockResolvedValue(
      createDocSnapshot("thread-123", {
        stockCode: "BHP",
        type: "catalyst",
        title: "Friday delivery numbers matter",
        body: "This is the line item the room is watching.",
        score: 5,
        commentCount: 2,
        sourceCount: 1,
        highSignal: false,
        createdAt: new Date("2026-04-10T08:00:00Z"),
        updatedAt: new Date("2026-04-10T09:00:00Z"),
        lastActivityAt: new Date("2026-04-10T09:00:00Z"),
        status: "active",
      }),
    );

    const thread = await getCommunityThread("BHP", "thread-123");

    expect(thread?.id).toBe("thread-123");
    expect(thread?.title).toBe("Friday delivery numbers matter");
  });

  it("reads pulse items with recency-first ordering", async () => {
    const { pulseListGet } = createCollectionHarness();
    pulseListGet.mockResolvedValue({
      docs: [
        createDocSnapshot("older", {
          stockCode: "BHP",
          body: "The desk was already positioned for this.",
          score: 12,
          replyCount: 4,
          createdAt: new Date("2026-04-10T08:00:00Z"),
          updatedAt: new Date("2026-04-10T08:00:00Z"),
          status: "active",
        }),
        createDocSnapshot("newer", {
          stockCode: "BHP",
          body: "Fresh broker downgrade out five minutes ago.",
          score: 1,
          replyCount: 0,
          createdAt: new Date("2026-04-11T08:00:00Z"),
          updatedAt: new Date("2026-04-11T08:00:00Z"),
          status: "active",
        }),
      ],
    });

    const pulse = await listCommunityPulseItems("BHP");

    expect(pulse[0]?.id).toBe("newer");
    expect(pulse).toHaveLength(2);
  });
});
