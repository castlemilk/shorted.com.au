import {
  buildFirestoreCostEvent,
  bucketFirestoreCount,
  withFirestoreCost,
} from "@/lib/firestore-cost";

describe("firestore-cost instrumentation", () => {
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-04T01:00:00Z"));
    console.log = jest.fn();
    console.error = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    console.log = originalLog;
    console.error = originalError;
  });

  it("buckets read and write counts into low-cardinality labels", () => {
    expect(bucketFirestoreCount(0)).toBe("0");
    expect(bucketFirestoreCount(1)).toBe("1");
    expect(bucketFirestoreCount(4)).toBe("2-5");
    expect(bucketFirestoreCount(10)).toBe("6-10");
    expect(bucketFirestoreCount(42)).toBe("11-50");
    expect(bucketFirestoreCount(88)).toBe("51-100");
    expect(bucketFirestoreCount(250)).toBe("101-500");
    expect(bucketFirestoreCount(999)).toBe("501+");
  });

  it("builds a queryable success event without high-cardinality identifiers", () => {
    const event = buildFirestoreCostEvent({
      feature: "community",
      collection: "stock_communities/threads",
      operation: "query_get",
      status: "success",
      durationMs: 27,
      documentsRead: 12,
      documentsWritten: 0,
    });

    expect(event).toEqual({
      type: "firestore_operation",
      feature: "community",
      collection: "stock_communities/threads",
      operation: "query_get",
      status: "success",
      duration_ms: 27,
      documents_read: 12,
      documents_written: 0,
      document_count_bucket: "11-50",
      write_count_bucket: "0",
      error_name: "",
    });
    expect(JSON.stringify(event)).not.toContain("BHP");
    expect(JSON.stringify(event)).not.toContain("user");
  });

  it("logs success events and returns the wrapped operation result", async () => {
    const result = await withFirestoreCost(
      {
        feature: "dashboard",
        collection: "dashboards",
        operation: "query_get",
        documentsRead: (snapshot: { docs: unknown[] }) => snapshot.docs.length,
      },
      async () => ({ docs: [{ id: "a" }, { id: "b" }] }),
      { now: () => 1_050, startedAt: () => 1_000 },
    );

    expect(result.docs).toHaveLength(2);
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        type: "firestore_operation",
        feature: "dashboard",
        collection: "dashboards",
        operation: "query_get",
        status: "success",
        duration_ms: 50,
        documents_read: 2,
        documents_written: 0,
        document_count_bucket: "2-5",
        write_count_bucket: "0",
        error_name: "",
      }),
    );
  });

  it("logs error events and rethrows the original error", async () => {
    const error = new Error("firestore unavailable");

    await expect(
      withFirestoreCost(
        {
          feature: "portfolio",
          collection: "portfolios",
          operation: "doc_get",
          documentsRead: 1,
        },
        async () => {
          throw error;
        },
        { now: () => 2_125, startedAt: () => 2_000 },
      ),
    ).rejects.toBe(error);

    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        type: "firestore_operation",
        feature: "portfolio",
        collection: "portfolios",
        operation: "doc_get",
        status: "error",
        duration_ms: 125,
        documents_read: 1,
        documents_written: 0,
        document_count_bucket: "1",
        write_count_bucket: "0",
        error_name: "Error",
      }),
    );
  });
});
