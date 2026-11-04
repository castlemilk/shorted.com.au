import { parseEntitlementDetail } from "~/@/lib/strategies/entitlement";

function errorWith(header: string | null | undefined) {
  return {
    metadata: {
      get: (key: string) => (key === "X-Entitlement-Detail" ? header : null),
    },
  };
}

describe("parseEntitlementDetail", () => {
  it("reads the full_signal_list refusal the API sends", () => {
    const detail = parseEntitlementDetail(
      errorWith(
        JSON.stringify({
          capability: "full_signal_list",
          required: "free",
          current: "anonymous",
          rpc: "GetViewerStrategyPicks",
          limit: 10,
          upgrade_url: "https://shorted.com.au/pricing",
          message: "Signed-in callers get the full list.",
        }),
      ),
    );
    expect(detail).toEqual({
      capability: "full_signal_list",
      required: "free",
      current: "anonymous",
      rpc: "GetViewerStrategyPicks",
      limit: 10,
      upgradeUrl: "https://shorted.com.au/pricing",
      message: "Signed-in callers get the full list.",
    });
  });

  it("reads the optional fields as null when absent", () => {
    const detail = parseEntitlementDetail(errorWith('{"capability":"strategy_alerts","required":"premium"}'));
    expect(detail).toMatchObject({ capability: "strategy_alerts", required: "premium", current: null, rpc: null, limit: null, upgradeUrl: null, message: null });
  });

  it("returns null when the error carries no detail", () => {
    expect(parseEntitlementDetail(errorWith(null))).toBeNull();
    expect(parseEntitlementDetail(errorWith(""))).toBeNull();
    expect(parseEntitlementDetail(new Error("network down"))).toBeNull();
    expect(parseEntitlementDetail(undefined)).toBeNull();
  });

  it("returns null for malformed or incomplete detail", () => {
    expect(parseEntitlementDetail(errorWith("{not json"))).toBeNull();
    expect(parseEntitlementDetail(errorWith("null"))).toBeNull();
    expect(parseEntitlementDetail(errorWith('{"capability":"x"}'))).toBeNull();
    expect(parseEntitlementDetail(errorWith('{"capability":"","required":"free"}'))).toBeNull();
  });

  it("ignores a non-numeric limit rather than reading it as zero", () => {
    const detail = parseEntitlementDetail(errorWith('{"capability":"cap_reached","required":"premium","limit":"20"}'));
    expect(detail?.limit).toBeNull();
  });
});
