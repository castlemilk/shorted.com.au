import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { bucketFirestoreCount } from "./firestore-cost";

export type PostgresCostOperation = "select" | "insert" | "upsert";
export type PostgresCostStatus = "success" | "error";

export type PostgresCostEvent = {
  type: "postgres_operation";
  feature: string;
  relation: string;
  operation: PostgresCostOperation;
  status: PostgresCostStatus;
  duration_ms: number;
  rows_read: number;
  rows_written: number;
  row_count_bucket: string;
  write_count_bucket: string;
  error_name: string;
};

type CountResolver<T> = number | ((result: T) => number);

type PostgresCostOptions<T> = {
  feature: string;
  relation: string;
  operation: PostgresCostOperation;
  rowsRead?: CountResolver<T>;
  rowsWritten?: CountResolver<T>;
};

const meter = metrics.getMeter("shorted-web-cost");
const tracer = trace.getTracer("shorted-web-cost");

const operationCounter = meter.createCounter("shorted.postgres.operations_total", {
  description: "Postgres operations by feature, relation, operation, and status",
});
const rowReadCounter = meter.createCounter("shorted.postgres.rows_read_total", {
  description: "Estimated Postgres rows read by feature and relation",
});
const rowWriteCounter = meter.createCounter("shorted.postgres.rows_written_total", {
  description: "Estimated Postgres rows written by feature and relation",
});
const operationDuration = meter.createHistogram(
  "shorted.postgres.operation_duration_ms",
  {
    description: "Postgres operation duration in milliseconds",
    unit: "ms",
  },
);

export async function withPostgresCost<T>(
  options: PostgresCostOptions<T>,
  operation: () => Promise<T>,
): Promise<T> {
  const start = Date.now();

  return tracer.startActiveSpan(
    "postgres.operation",
    {
      attributes: {
        "shorted.feature": options.feature,
        "db.system": "postgresql",
        "db.sql.table": options.relation,
        "db.operation": options.operation,
      },
    },
    async (span) => {
      try {
        const result = await operation();
        const event = buildPostgresCostEvent({
          ...options,
          status: "success",
          durationMs: Date.now() - start,
          rowsRead: resolveCount(options.rowsRead, result),
          rowsWritten: resolveCount(options.rowsWritten, result),
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.setAttributes(eventAttributes(event));
        emitPostgresCostEvent(event);
        return result;
      } catch (error) {
        const event = buildPostgresCostEvent({
          ...options,
          status: "error",
          durationMs: Date.now() - start,
          rowsRead: typeof options.rowsRead === "number" ? options.rowsRead : 0,
          rowsWritten:
            typeof options.rowsWritten === "number" ? options.rowsWritten : 0,
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
        emitPostgresCostEvent(event);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

function buildPostgresCostEvent(input: {
  feature: string;
  relation: string;
  operation: PostgresCostOperation;
  status: PostgresCostStatus;
  durationMs: number;
  rowsRead?: number;
  rowsWritten?: number;
  errorName?: string;
}): PostgresCostEvent {
  const rowsRead = normalizeCount(input.rowsRead ?? 0);
  const rowsWritten = normalizeCount(input.rowsWritten ?? 0);

  return {
    type: "postgres_operation",
    feature: input.feature,
    relation: input.relation,
    operation: input.operation,
    status: input.status,
    duration_ms: normalizeCount(input.durationMs),
    rows_read: rowsRead,
    rows_written: rowsWritten,
    row_count_bucket: bucketFirestoreCount(rowsRead),
    write_count_bucket: bucketFirestoreCount(rowsWritten),
    error_name: input.errorName ?? "",
  };
}

function resolveCount<T>(resolver: CountResolver<T> | undefined, result: T) {
  if (resolver === undefined) return 0;
  if (typeof resolver === "number") return resolver;
  return resolver(result);
}

function normalizeCount(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function emitPostgresCostEvent(event: PostgresCostEvent) {
  const attributes = eventAttributes(event);
  operationCounter.add(1, attributes);
  if (event.rows_read > 0) {
    rowReadCounter.add(event.rows_read, attributes);
  }
  if (event.rows_written > 0) {
    rowWriteCounter.add(event.rows_written, attributes);
  }
  operationDuration.record(event.duration_ms, attributes);
  console.log(JSON.stringify(event));
}

function eventAttributes(event: PostgresCostEvent): Record<string, string | number> {
  return {
    feature: event.feature,
    relation: event.relation,
    operation: event.operation,
    status: event.status,
    row_count_bucket: event.row_count_bucket,
    write_count_bucket: event.write_count_bucket,
  };
}
