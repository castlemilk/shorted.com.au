import { metrics, trace, SpanStatusCode } from "@opentelemetry/api";

export type FirestoreCostOperation =
  | "doc_get"
  | "query_get"
  | "set"
  | "add"
  | "update"
  | "delete"
  | "batch_commit";

export type FirestoreCostStatus = "success" | "error";

export type FirestoreCostEvent = {
  type: "firestore_operation";
  feature: string;
  collection: string;
  operation: FirestoreCostOperation;
  status: FirestoreCostStatus;
  duration_ms: number;
  documents_read: number;
  documents_written: number;
  document_count_bucket: string;
  write_count_bucket: string;
  error_name: string;
};

type CountResolver<T> = number | ((result: T) => number);

type FirestoreCostOptions<T> = {
  feature: string;
  collection: string;
  operation: FirestoreCostOperation;
  documentsRead?: CountResolver<T>;
  documentsWritten?: CountResolver<T>;
};

type FirestoreCostClock = {
  now?: () => number;
  startedAt?: () => number;
};

const meter = metrics.getMeter("shorted-web-cost");
const tracer = trace.getTracer("shorted-web-cost");

const operationCounter = meter.createCounter("shorted.firebase.firestore.operations_total", {
  description: "Firestore operations by feature, collection, operation, and status",
});
const documentReadCounter = meter.createCounter("shorted.firebase.firestore.documents_read_total", {
  description: "Estimated Firestore documents read by feature and collection",
});
const documentWriteCounter = meter.createCounter("shorted.firebase.firestore.documents_written_total", {
  description: "Estimated Firestore documents written by feature and collection",
});
const operationDuration = meter.createHistogram("shorted.firebase.firestore.operation_duration_ms", {
  description: "Firestore operation duration in milliseconds",
  unit: "ms",
});

export function bucketFirestoreCount(count: number): string {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safeCount === 0) return "0";
  if (safeCount === 1) return "1";
  if (safeCount <= 5) return "2-5";
  if (safeCount <= 10) return "6-10";
  if (safeCount <= 50) return "11-50";
  if (safeCount <= 100) return "51-100";
  if (safeCount <= 500) return "101-500";
  return "501+";
}

export function buildFirestoreCostEvent(input: {
  feature: string;
  collection: string;
  operation: FirestoreCostOperation;
  status: FirestoreCostStatus;
  durationMs: number;
  documentsRead?: number;
  documentsWritten?: number;
  errorName?: string;
}): FirestoreCostEvent {
  const documentsRead = normalizeCount(input.documentsRead ?? 0);
  const documentsWritten = normalizeCount(input.documentsWritten ?? 0);

  return {
    type: "firestore_operation",
    feature: input.feature,
    collection: input.collection,
    operation: input.operation,
    status: input.status,
    duration_ms: normalizeCount(input.durationMs),
    documents_read: documentsRead,
    documents_written: documentsWritten,
    document_count_bucket: bucketFirestoreCount(documentsRead),
    write_count_bucket: bucketFirestoreCount(documentsWritten),
    error_name: input.errorName ?? "",
  };
}

export async function withFirestoreCost<T>(
  options: FirestoreCostOptions<T>,
  operation: () => Promise<T>,
  clock: FirestoreCostClock = {},
): Promise<T> {
  const start = clock.startedAt?.() ?? Date.now();

  return tracer.startActiveSpan(
    "firestore.operation",
    {
      attributes: {
        "shorted.feature": options.feature,
        "db.system": "firestore",
        "db.collection": options.collection,
        "db.operation": options.operation,
      },
    },
    async (span) => {
      try {
        const result = await operation();
        const event = buildFirestoreCostEvent({
          feature: options.feature,
          collection: options.collection,
          operation: options.operation,
          status: "success",
          durationMs: (clock.now?.() ?? Date.now()) - start,
          documentsRead: resolveCount(options.documentsRead, result),
          documentsWritten: resolveCount(options.documentsWritten, result),
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.setAttributes(eventAttributes(event));
        emitFirestoreCostEvent(event);
        return result;
      } catch (error) {
        const event = buildFirestoreCostEvent({
          feature: options.feature,
          collection: options.collection,
          operation: options.operation,
          status: "error",
          durationMs: (clock.now?.() ?? Date.now()) - start,
          documentsRead: typeof options.documentsRead === "number" ? options.documentsRead : 0,
          documentsWritten: typeof options.documentsWritten === "number" ? options.documentsWritten : 0,
          errorName: error instanceof Error ? error.name : "Unknown",
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Error) {
          span.recordException(error);
        }
        span.setAttributes(eventAttributes(event));
        emitFirestoreCostEvent(event);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function querySnapshotReadCount(snapshot: { docs?: unknown[] }): number {
  return Array.isArray(snapshot.docs) ? snapshot.docs.length : 0;
}

export function docReadCount(): number {
  return 1;
}

function resolveCount<T>(resolver: CountResolver<T> | undefined, result: T): number {
  if (resolver === undefined) return 0;
  if (typeof resolver === "number") return resolver;
  return resolver(result);
}

function normalizeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function emitFirestoreCostEvent(event: FirestoreCostEvent) {
  const attributes = eventAttributes(event);
  operationCounter.add(1, attributes);
  if (event.documents_read > 0) {
    documentReadCounter.add(event.documents_read, attributes);
  }
  if (event.documents_written > 0) {
    documentWriteCounter.add(event.documents_written, attributes);
  }
  operationDuration.record(event.duration_ms, attributes);
  console.log(JSON.stringify(event));
}

function eventAttributes(event: FirestoreCostEvent): Record<string, string | number> {
  return {
    feature: event.feature,
    collection: event.collection,
    operation: event.operation,
    status: event.status,
    document_count_bucket: event.document_count_bucket,
    write_count_bucket: event.write_count_bucket,
  };
}
