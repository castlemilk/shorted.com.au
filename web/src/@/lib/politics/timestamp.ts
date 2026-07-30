import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";

/**
 * A proto Timestamp as a JS Date, or undefined when absent.
 *
 * protobuf-es v2 has no `Timestamp.toDate()`; the conversion is the free
 * function `timestampDate`. Wrapped here because register dates are frequently
 * ABSENT — most base statements carry no lodgement date — and every call site
 * needs the same undefined-safe handling rather than its own guard.
 */
export function toDate(ts: Timestamp | undefined): Date | undefined {
  return ts ? timestampDate(ts) : undefined;
}
