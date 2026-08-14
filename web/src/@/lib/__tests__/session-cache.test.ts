import {
  clearSessionCache,
  getSessionCached,
  setSessionCached,
} from "../session-cache";

// jsdom provides window + sessionStorage.
describe("session-cache", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("round-trips a plain object", () => {
    setSessionCached("plain", { a: 1, b: "two", c: [3, 4] });
    expect(getSessionCached("plain")).toEqual({ a: 1, b: "two", c: [3, 4] });
  });

  it("returns null for a missing key", () => {
    expect(getSessionCached("nope")).toBeNull();
  });

  // Regression: protobuf int64 / Timestamp.seconds come back as BigInt, which
  // the default JSON.stringify throws on — the throw was swallowed and the entry
  // silently never cached. The sentinel replacer/reviver must round-trip it.
  it("round-trips BigInt values losslessly", () => {
    const big = 9223372036854775807n; // int64 max — unrepresentable as a Number
    setSessionCached("series", {
      asOf: { seconds: big, nanos: 0 },
      points: [{ ts: 1_700_000_000n, value: 1.5 }],
    });

    const out = getSessionCached<{
      asOf: { seconds: bigint; nanos: number };
      points: { ts: bigint; value: number }[];
    }>("series");

    expect(out).not.toBeNull();
    expect(typeof out!.asOf.seconds).toBe("bigint");
    expect(out!.asOf.seconds).toBe(big);
    expect(out!.points[0]!.ts).toBe(1_700_000_000n);
    expect(out!.points[0]!.value).toBe(1.5);
  });

  it("expires entries past maxAgeMs", () => {
    setSessionCached("stale", { v: 1 });
    // A zero (or negative) max age means the entry is always considered stale.
    expect(getSessionCached("stale", -1)).toBeNull();
    // And the stale read purged it.
    expect(sessionStorage.getItem("shorted:cache:stale")).toBeNull();
  });

  it("clearSessionCache removes only the prefixed keys", () => {
    setSessionCached("keep", { v: 1 });
    sessionStorage.setItem("unrelated", "x");
    clearSessionCache();
    expect(getSessionCached("keep")).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("x");
  });
});
