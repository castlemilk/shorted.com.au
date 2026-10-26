/**
 * The published rate-limit table must match what the API actually enforces.
 *
 * This test exists because it did not. Until 2026-08-23 the developer page
 * advertised anonymous 1,000/month against an enforced 500, free 2,000 against
 * an enforced 1,000, and paid per-minute "Unlimited" against a real 120/min
 * ceiling. Over-promising a quota is worse than publishing a low one.
 *
 * So this parses the Go source of truth directly rather than restating it, and it
 * looks each tier up BY NAME. A positional read would silently pick up the wrong
 * tier if the declaration order changed. It also parses the published table in the
 * key manager, so the table and the enforcement cannot drift apart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "../../../../../");
const CONFIG_GO = join(REPO, "services/pkg/ratelimit/config.go");
const KEY_MANAGER = join(__dirname, "../api-key-manager.tsx");

interface EnforcedTier {
  apiPerMinute: number;
  apiPerMonth: number;
  browserPerMinute: number;
  browserPerMonth: number;
}

/**
 * The enforced limits for one tier, from DefaultConfig. Read from the block that
 * starts at `"<name>": {` and ends at its closing brace, so the lookup is by name.
 */
function enforcedTier(source: string, name: string): EnforcedTier {
  const start = source.indexOf(`"${name}": {`);
  if (start === -1) throw new Error(`tier ${name} is not in DefaultConfig`);
  const end = source.indexOf("\n\t\t\t},", start);
  const block = source.slice(start, end === -1 ? undefined : end);
  const m = block.match(
    /RequestsPerMinute:\s*(\d+),\s*RequestsPerMonth:\s*(\d+),[\s\S]*?BrowserRequestsPerMinute:\s*(\d+),\s*BrowserRequestsPerMonth:\s*(\d+)/,
  );
  if (!m) throw new Error(`could not read the limits of ${name}`);
  return {
    apiPerMinute: Number(m[1]),
    apiPerMonth: Number(m[2]),
    browserPerMinute: Number(m[3]),
    browserPerMonth: Number(m[4]),
  };
}

/** The API rows of the published table, keyed by the name shown on the page. */
function publishedApiRows(source: string): Map<string, { perMinute: number; perMonth: number }> {
  const rows = new Map<string, { perMinute: number; perMonth: number }>();
  const api = source.slice(source.indexOf("const RATE_LIMIT_TIERS"), source.indexOf("browser: ["));
  const re = /\{ name: "([^"]+)", perMinute: "([\d,]+)", perMonth: "([\d,]+)" \}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(api)) !== null) {
    rows.set(m[1], {
      perMinute: Number(m[2].replace(/,/g, "")),
      perMonth: Number(m[3].replace(/,/g, "")),
    });
  }
  return rows;
}

describe("published rate-limit table vs enforced config", () => {
  const go = readFileSync(CONFIG_GO, "utf8");
  const keyManager = readFileSync(KEY_MANAGER, "utf8");

  const anonymous = enforcedTier(go, "anonymous");
  const free = enforcedTier(go, "free");
  const premium = enforcedTier(go, "premium");
  const apiAccess = enforcedTier(go, "api_access");
  const enterprise = enforcedTier(go, "enterprise");

  it("enforces the anonymous numbers this app publishes", () => {
    expect(anonymous).toEqual({ apiPerMinute: 30, apiPerMonth: 500, browserPerMinute: 60, browserPerMonth: 5000 });
  });

  it("enforces the free numbers this app publishes", () => {
    expect(free).toEqual({ apiPerMinute: 60, apiPerMonth: 1000, browserPerMinute: 120, browserPerMonth: 10000 });
  });

  it("enforces the Premium API numbers: Premium is sold without the API Access plan, so its API limits are the free ones", () => {
    expect(premium.apiPerMinute).toBe(60);
    expect(premium.apiPerMonth).toBe(1000);
    // Browser access is unlimited for paid customers. 0 is the sentinel for "no limit".
    expect(premium.browserPerMinute).toBe(0);
    expect(premium.browserPerMonth).toBe(0);
  });

  it("enforces the API Access numbers the docs and key manager publish", () => {
    expect(apiAccess).toEqual({ apiPerMinute: 120, apiPerMonth: 10000, browserPerMinute: 0, browserPerMonth: 0 });
  });

  it("enforces the enterprise numbers, above API Access", () => {
    expect(enterprise.apiPerMinute).toBeGreaterThan(apiAccess.apiPerMinute);
    expect(enterprise.apiPerMonth).toBeGreaterThan(apiAccess.apiPerMonth);
  });

  it("publishes exactly the enforced API numbers in the key manager table", () => {
    const rows = publishedApiRows(keyManager);
    expect(rows.get("Anonymous")).toEqual({ perMinute: anonymous.apiPerMinute, perMonth: anonymous.apiPerMonth });
    expect(rows.get("Free and Premium")).toEqual({ perMinute: free.apiPerMinute, perMonth: free.apiPerMonth });
    expect(rows.get("API Access")).toEqual({ perMinute: apiAccess.apiPerMinute, perMonth: apiAccess.apiPerMonth });
    expect(rows.get("Enterprise")).toEqual({ perMinute: enterprise.apiPerMinute, perMonth: enterprise.apiPerMonth });
  });

  it("never publishes a quota larger than the one enforced", () => {
    // The direction of drift matters more than the exact values: under-promising is
    // survivable, over-promising is a broken contract.
    for (const [, row] of publishedApiRows(keyManager)) {
      expect(row.perMonth).toBeLessThanOrEqual(enterprise.apiPerMonth);
      expect(row.perMinute).toBeLessThanOrEqual(enterprise.apiPerMinute);
    }
    const rows = publishedApiRows(keyManager);
    expect(rows.get("Free and Premium")!.perMonth).toBeLessThanOrEqual(free.apiPerMonth);
    expect(rows.get("API Access")!.perMonth).toBeLessThanOrEqual(apiAccess.apiPerMonth);
    expect(rows.get("API Access")!.perMinute).toBeLessThanOrEqual(apiAccess.apiPerMinute);
  });
});
