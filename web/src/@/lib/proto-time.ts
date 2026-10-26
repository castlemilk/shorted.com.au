/**
 * Plain (non-server) helpers for protobuf timestamps. Kept out of "use server" modules:
 * every export of a "use server" file must be an async server action, so a helper that
 * is not async cannot live there.
 */

/** A proto Timestamp as a Date, or null when unset. */
export function timestampToDate(
  ts: { seconds: bigint | number; nanos?: number } | null | undefined,
): Date | null {
  if (!ts) return null;
  return new Date(Number(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1_000_000));
}
