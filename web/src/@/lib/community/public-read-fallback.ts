import { type CommunityOverviewSummary } from "~/@/types/community";
import { buildCommunitySummary } from "~/@/lib/community/summary";

export const COMMUNITY_PUBLIC_READ_FALLBACK_CACHE_CONTROL =
  "public, s-maxage=60, stale-while-revalidate=300";

export function emptyCommunitySummary(
  stockCode: string,
): CommunityOverviewSummary {
  return buildCommunitySummary({
    stockCode,
    threads: [],
    pulse: [],
  });
}

export function isFirestoreReadUnavailable(error: unknown): boolean {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const code = record.code;
  const details = typeof record.details === "string" ? record.details : "";
  const message = error instanceof Error ? error.message : String(error);
  const text = `${message} ${details}`.toLowerCase();

  return (
    code === 16 ||
    code === "16" ||
    code === 7 ||
    code === "7" ||
    code === 9 ||
    code === "9" ||
    text.includes("unauthenticated") ||
    text.includes("invalid authentication credentials") ||
    text.includes("permission_denied") ||
    text.includes("permission denied") ||
    text.includes("could not load the default credentials") ||
    text.includes("requires an index")
  );
}

export function warnCommunityReadFallback(input: {
  route: string;
  stockCode: string;
  error: unknown;
}) {
  const record =
    input.error && typeof input.error === "object"
      ? (input.error as Record<string, unknown>)
      : {};

  console.warn(
    JSON.stringify({
      type: "community_read_fallback",
      feature: "community",
      route: input.route,
      stock_code: input.stockCode,
      error_name: input.error instanceof Error ? input.error.name : "Unknown",
      error_code: record.code ?? "",
      error_message: sanitizeErrorMessage(input.error),
    }),
  );
}

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240);
}
