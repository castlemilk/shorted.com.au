/**
 * The rate-limit GA4 funnel helper.
 *
 * Two properties matter more than the payload shape: it must be a silent no-op
 * when GA is absent (blocked, adblocked, not yet loaded), and it must never
 * throw — a broken analytics call must not be able to break a render or the
 * retry path.
 */
import {
  RATE_LIMIT_EVENTS,
  currentSurface,
  routeGroupFromPath,
  trackRateLimitEvent,
} from "../rate-limit-analytics";

type GtagWindow = { gtag?: (...args: unknown[]) => void };

function installGtag() {
  const gtag = jest.fn();
  (window as GtagWindow).gtag = gtag;
  return gtag;
}

afterEach(() => {
  delete (window as GtagWindow).gtag;
});

describe("routeGroupFromPath", () => {
  it("collapses dynamic routes to a low-cardinality group", () => {
    expect(routeGroupFromPath("/shorts/BHP")).toBe("/shorts/*");
    expect(routeGroupFromPath("/housing/nsw/bondi-2026")).toBe("/housing/*");
    expect(routeGroupFromPath("/top")).toBe("/top");
    expect(routeGroupFromPath("/")).toBe("/");
  });

  it("strips query strings and fragments", () => {
    expect(routeGroupFromPath("/top?period=6m")).toBe("/top");
    expect(routeGroupFromPath("/statistics#chart")).toBe("/statistics");
  });

  it("refuses anything that could be a high-cardinality identifier", () => {
    expect(routeGroupFromPath(null)).toBe("/other");
    expect(routeGroupFromPath(undefined)).toBe("/other");
    expect(routeGroupFromPath("/../etc/passwd")).toBe("/other");
    expect(routeGroupFromPath(`/${"a".repeat(80)}`)).toBe("/other");
  });
});

describe("trackRateLimitEvent", () => {
  it("is a no-op when gtag is absent", () => {
    expect(() =>
      trackRateLimitEvent(RATE_LIMIT_EVENTS.NOTICE_SHOWN, {
        kind: "monthly",
        tier: "free",
      }),
    ).not.toThrow();
  });

  it("sends the documented event name and params", () => {
    const gtag = installGtag();

    trackRateLimitEvent(RATE_LIMIT_EVENTS.NOTICE_SHOWN, {
      kind: "monthly",
      tier: "free",
      variant: "page",
      surface: "/shorts/*",
    });

    expect(gtag).toHaveBeenCalledTimes(1);
    expect(gtag).toHaveBeenCalledWith("event", "rate_limit_notice_shown", {
      kind: "monthly",
      tier: "free",
      variant: "page",
      surface: "/shorts/*",
      non_interaction: true,
    });
  });

  it("marks the CTA events as real interactions", () => {
    const gtag = installGtag();

    trackRateLimitEvent(RATE_LIMIT_EVENTS.UPGRADE_CLICK, {
      kind: "monthly",
      tier: "free",
      variant: "inline",
      surface: "/top",
    });
    trackRateLimitEvent(RATE_LIMIT_EVENTS.SIGNIN_CLICK, {
      kind: "monthly",
      tier: "anonymous",
    });

    expect(gtag.mock.calls[0]![1]).toBe("rate_limit_upgrade_click");
    expect(gtag.mock.calls[0]![2]).toMatchObject({ non_interaction: false });
    expect(gtag.mock.calls[1]![1]).toBe("rate_limit_signin_click");
    expect(gtag.mock.calls[1]![2]).toMatchObject({ non_interaction: false });
  });

  it("defaults unknown context rather than sending undefined", () => {
    const gtag = installGtag();

    trackRateLimitEvent(RATE_LIMIT_EVENTS.AUTO_RECOVERED, {});

    const params = gtag.mock.calls[0]![2] as Record<string, unknown>;
    expect(params.kind).toBe("unknown");
    expect(params.tier).toBe("unknown");
    expect(params.surface).toBe(currentSurface());
    expect(params).not.toHaveProperty("variant");
    expect(params.non_interaction).toBe(true);
  });

  it("swallows a throwing gtag instead of breaking the caller", () => {
    (window as GtagWindow).gtag = () => {
      throw new Error("analytics exploded");
    };

    expect(() =>
      trackRateLimitEvent(RATE_LIMIT_EVENTS.AUTO_RECOVERED, { kind: "per_minute" }),
    ).not.toThrow();
  });

  it("never sends anything beyond the enumerated low-cardinality params", () => {
    const gtag = installGtag();

    trackRateLimitEvent(RATE_LIMIT_EVENTS.NOTICE_SHOWN, {
      kind: "per_minute",
      tier: "paid",
      variant: "inline",
      surface: "/shorts/*",
    });

    expect(Object.keys(gtag.mock.calls[0]![2] as object).sort()).toEqual([
      "kind",
      "non_interaction",
      "surface",
      "tier",
      "variant",
    ]);
  });
});
