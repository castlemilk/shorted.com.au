import { metrics } from "@opentelemetry/api";

type ProductEventStatus =
  | "attempt"
  | "success"
  | "error"
  | "rate_limited"
  | "unauthenticated";

type ProductEventInput = {
  feature: string;
  action: string;
  status: ProductEventStatus;
  properties?: Record<string, unknown>;
};

type ProductEvent = {
  type: "product_event";
  feature: string;
  action: string;
  status: ProductEventStatus;
} & Record<string, string | number | boolean>;

const meter = metrics.getMeter("shorted-web-product-events");
const productEventCounter = meter.createCounter("shorted.product.events_total", {
  description: "Low-cardinality product flow events by feature, action, and status",
});

const ALLOWED_PROPERTY_KEYS = new Set([
  "duration_ms",
  "event_type",
  "error_name",
  "error_type",
  // Which limit a `rate_limited` event tripped. Deliberately added to the
  // allow-list with a closed value set (see LIMIT_KINDS): it is the join key
  // between the web `product_event` stream and the edge rate-limit events, and
  // it is what separates "a burst that healed itself" from "an exhausted
  // quota" — the second is the upgrade moment, the first is noise.
  "limit_kind",
  "query_length_bucket",
  "result_count_bucket",
  "route_group",
  "tier",
]);

const KNOWN_TIERS = new Set([
  "anonymous",
  "api_access",
  "authenticated",
  "free",
  "paid",
  "premium",
  "pro",
  "unknown",
]);

/**
 * Closed value set. `per_minute` / `monthly` / `unknown` mirror `RateLimitKind`
 * in `retry.ts` — the client classifier's vocabulary, and the join key against
 * the edge rate-limit events.
 *
 * `daily` is the one deliberate divergence: the chat send buckets cap per day
 * as well as per minute and per month, and that window exists only server-side,
 * so the client type never needs it. Calling a daily cap `per_minute` would be
 * wrong and calling it `unknown` would erase the only interesting thing about
 * it. Still closed, so cardinality is unchanged in kind.
 */
const LIMIT_KINDS = new Set(["per_minute", "daily", "monthly", "unknown"]);

const QUERY_LENGTH_BUCKETS = new Set(["0", "1", "2-3", "4-8", "9-20", "21-50", "51+"]);
const RESULT_COUNT_BUCKETS = new Set(["0", "1", "2-5", "6-10", "11-50", "51-100", "101-500", "501+"]);

export function bucketCount(count: number): string {
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

export function bucketStringLength(value: string): string {
  const length = value.trim().length;
  if (length === 0) return "0";
  if (length === 1) return "1";
  if (length <= 3) return "2-3";
  if (length <= 8) return "4-8";
  if (length <= 20) return "9-20";
  if (length <= 50) return "21-50";
  return "51+";
}

export function buildProductEvent(input: ProductEventInput): ProductEvent {
  const event: ProductEvent = {
    type: "product_event",
    feature: normalizeLabel(input.feature, "unknown"),
    action: normalizeLabel(input.action, "unknown"),
    status: input.status,
  };

  for (const [key, value] of Object.entries(input.properties ?? {})) {
    if (!ALLOWED_PROPERTY_KEYS.has(key) || value === undefined || value === null) {
      continue;
    }

    const sanitized = sanitizeProductEventProperty(key, value);
    if (sanitized !== undefined) {
      event[key] = sanitized;
    }
  }

  return event;
}

export function recordProductEvent(input: ProductEventInput) {
  const event = buildProductEvent(input);
  productEventCounter.add(1, {
    feature: event.feature,
    action: event.action,
    status: event.status,
  });
  console.log(JSON.stringify(event));
}

function normalizeLabel(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_");
  return normalized || fallback;
}

function sanitizeProductEventProperty(
  key: string,
  value: unknown,
): string | number | boolean | undefined {
  switch (key) {
    case "duration_ms":
      return sanitizeDuration(value);
    case "event_type":
    case "error_name":
    case "error_type":
      return typeof value === "string" ? normalizeLabel(value, "unknown").slice(0, 80) : undefined;
    case "limit_kind":
      return typeof value === "string" &&
        LIMIT_KINDS.has(normalizeLabel(value, "unknown"))
        ? normalizeLabel(value, "unknown")
        : "unknown";
    case "query_length_bucket":
      return typeof value === "string" && QUERY_LENGTH_BUCKETS.has(value) ? value : "unknown";
    case "result_count_bucket":
      return typeof value === "string" && RESULT_COUNT_BUCKETS.has(value) ? value : "unknown";
    case "route_group":
      return sanitizeRouteGroup(value);
    case "tier":
      return sanitizeTier(value);
    default:
      return undefined;
  }
}

function sanitizeDuration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

function sanitizeRouteGroup(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const route = value.trim();
  if (
    route.length === 0 ||
    route.length > 120 ||
    !route.startsWith("/") ||
    route.includes("?") ||
    route.includes("#") ||
    !/^\/[A-Za-z0-9_./:*{}[\]-]*$/.test(route)
  ) {
    return "unknown";
  }
  return route;
}

function sanitizeTier(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const tier = normalizeLabel(value, "unknown").slice(0, 40);
  return KNOWN_TIERS.has(tier) ? tier : "unknown";
}
