import { buildProductEvent, bucketCount, recordProductEvent } from "../product-events";

describe("product event instrumentation", () => {
  const originalLog = console.log;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-04T01:00:00Z"));
    console.log = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    console.log = originalLog;
  });

  it("builds low-cardinality product events without user or query identifiers", () => {
    const event = buildProductEvent({
      feature: "search",
      action: "query",
      status: "success",
      properties: {
        route_group: "/api/search/*",
        query_length_bucket: "2-3",
        result_count_bucket: bucketCount(10),
        user_id: "must-not-appear",
        raw_query: "BHP",
      },
    });

    expect(event).toEqual({
      type: "product_event",
      feature: "search",
      action: "query",
      status: "success",
      route_group: "/api/search/*",
      query_length_bucket: "2-3",
      result_count_bucket: "6-10",
    });
    expect(JSON.stringify(event)).not.toContain("must-not-appear");
    expect(JSON.stringify(event)).not.toContain("BHP");
  });

  it("logs queryable product events", () => {
    recordProductEvent({
      feature: "payment",
      action: "checkout_create",
      status: "attempt",
      properties: {
        tier: "premium",
      },
    });

    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        type: "product_event",
        feature: "payment",
        action: "checkout_create",
        status: "attempt",
        tier: "premium",
      }),
    );
  });

  it("emits the rate-limited shape the edge stream joins against", () => {
    recordProductEvent({
      feature: "market_data",
      action: "historical_prices",
      status: "rate_limited",
      properties: {
        route_group: "/api/market-data/*",
        limit_kind: "per_minute",
        tier: "anonymous",
      },
    });

    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        type: "product_event",
        feature: "market_data",
        action: "historical_prices",
        status: "rate_limited",
        route_group: "/api/market-data/*",
        limit_kind: "per_minute",
        tier: "anonymous",
      }),
    );
  });

  it("keeps limit_kind to its closed value set", () => {
    expect(
      buildProductEvent({
        feature: "search",
        action: "query",
        status: "rate_limited",
        properties: { limit_kind: "monthly" },
      }),
    ).toMatchObject({ limit_kind: "monthly" });

    // Anything outside per_minute|monthly|unknown collapses rather than
    // opening a cardinality hole in the metric.
    expect(
      buildProductEvent({
        feature: "search",
        action: "query",
        status: "rate_limited",
        properties: { limit_kind: "edge-burst-bucket-a:1.2.3.4" },
      }),
    ).toMatchObject({ limit_kind: "unknown" });
  });

  it("bounds user-controlled property values before logging", () => {
    const event = buildProductEvent({
      feature: "payment",
      action: "checkout_create",
      status: "attempt",
      properties: {
        tier: "Enterprise<script>",
        route_group: "/pricing?customer=abc123",
        event_type: "checkout.session.completed",
        error_type: "Stripe Invalid Request",
        duration_ms: 14.8,
      },
    });

    expect(event).toMatchObject({
      tier: "unknown",
      route_group: "unknown",
      event_type: "checkout.session.completed",
      error_type: "stripe_invalid_request",
      duration_ms: 14,
    });

    const encoded = JSON.stringify(event);
    expect(encoded).not.toContain("Enterprise");
    expect(encoded).not.toContain("customer=abc123");
  });
});
