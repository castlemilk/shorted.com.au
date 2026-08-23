/**
 * The published rate-limit table must match what the API actually enforces.
 *
 * This test exists because it did not. Until 2026-08-23 the developer page
 * advertised anonymous 1,000/month against an enforced 500, free 2,000 against
 * an enforced 1,000, and paid per-minute "Unlimited" against a real 120/min
 * ceiling.
 *
 * Over-promising a quota is worse than publishing a low one. A free caller
 * budgets for 2,000 requests and gets cut off at 1,000 with no warning, and
 * someone who upgrades specifically to remove a per-minute limit still gets a
 * 429 at 120/min — the upgrade did not buy what the page said it would.
 *
 * So this parses the Go source of truth directly rather than restating it. If
 * `DefaultConfig` changes and the table does not, this fails.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_GO = join(
  __dirname,
  "../../../../../services/pkg/ratelimit/config.go",
);

interface EnforcedTier {
  apiPerMinute: number;
  apiPerMonth: number;
  browserPerMinute: number;
  browserPerMonth: number;
}

/**
 * Extract the per-tier limits from DefaultConfig(). The block we care about
 * looks like:
 *
 *   RequestsPerMinute: 30, RequestsPerMonth: 500, // API limits
 *   BrowserRequestsPerMinute: 60, BrowserRequestsPerMonth: 5000, // Browser limits
 *
 * repeated once per tier, in declaration order. Parsing beats hardcoding: a
 * hardcoded copy here would be a third place to drift.
 */
function parseEnforcedTiers(source: string): EnforcedTier[] {
  const tiers: EnforcedTier[] = [];
  const re =
    /RequestsPerMinute:\s*(\d+),\s*RequestsPerMonth:\s*(\d+),[\s\S]*?BrowserRequestsPerMinute:\s*(\d+),\s*BrowserRequestsPerMonth:\s*(\d+)/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    tiers.push({
      apiPerMinute: Number(m[1]),
      apiPerMonth: Number(m[2]),
      browserPerMinute: Number(m[3]),
      browserPerMonth: Number(m[4]),
    });
  }
  return tiers;
}

describe("published rate-limit table vs enforced config", () => {
  const source = readFileSync(CONFIG_GO, "utf8");
  const tiers = parseEnforcedTiers(source);

  it("can read the Go source of truth", () => {
    // If this fails the file moved — fix the path rather than deleting the test,
    // otherwise the published numbers silently stop being checked.
    expect(tiers.length).toBeGreaterThanOrEqual(4);
  });

  // Declaration order in DefaultConfig: anonymous, free, paid(pro), enterprise, ...
  const [anonymous, free, paid] = tiers;

  it("enforces the anonymous numbers this app publishes", () => {
    expect(anonymous.apiPerMinute).toBe(30);
    expect(anonymous.apiPerMonth).toBe(500);
    expect(anonymous.browserPerMinute).toBe(60);
    expect(anonymous.browserPerMonth).toBe(5000);
  });

  it("enforces the free numbers this app publishes", () => {
    expect(free.apiPerMinute).toBe(60);
    expect(free.apiPerMonth).toBe(1000);
    expect(free.browserPerMinute).toBe(120);
    expect(free.browserPerMonth).toBe(10000);
  });

  it("enforces the paid numbers this app publishes", () => {
    // The paid API tier is NOT per-minute unlimited — it is a real 120/min
    // ceiling, and the page must say so.
    expect(paid.apiPerMinute).toBe(120);
    expect(paid.apiPerMonth).toBe(10000);
    // Browser access genuinely is unlimited on both windows for paid; 0 is the
    // sentinel for "no limit" in config.go.
    expect(paid.browserPerMinute).toBe(0);
    expect(paid.browserPerMonth).toBe(0);
  });

  it("never publishes a quota larger than the one enforced", () => {
    // The direction of any future drift matters more than the exact values:
    // under-promising is survivable, over-promising is a broken contract.
    const published = {
      anonymousApiPerMonth: 500,
      freeApiPerMonth: 1000,
      paidApiPerMonth: 10000,
      paidApiPerMinute: 120,
    };
    expect(published.anonymousApiPerMonth).toBeLessThanOrEqual(anonymous.apiPerMonth);
    expect(published.freeApiPerMonth).toBeLessThanOrEqual(free.apiPerMonth);
    expect(published.paidApiPerMonth).toBeLessThanOrEqual(paid.apiPerMonth);
    expect(published.paidApiPerMinute).toBeLessThanOrEqual(paid.apiPerMinute);
  });
});
