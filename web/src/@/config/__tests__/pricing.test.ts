/**
 * Prices are stated in ONE place: ~/@/config/pricing.
 *
 * History: /docs/api once quoted "$29/mo" while /roadmap said "$20/mo" and
 * Stripe charged neither — each surface carried its own literal copy. A page
 * that quotes a price nobody charges sets an expectation the checkout breaks.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  PLANS,
  PRICING_CURRENCY,
  PRICING_INTERVAL,
  formatPrice,
  planPricePerMonth,
} from "../pricing";
import { CHECKOUT_PLAN_CONFIG } from "~/lib/stripe-plans";

const WEB_SRC = join(__dirname, "../../..");

/**
 * Files allowed to contain a literal "$N/mo". Keep this list short — the only
 * legitimate reason is copy describing a PAST price as history.
 */
const ALLOWED = new Set([
  "@/config/pricing.ts",
  // Changelog entry recording the price at launch.
  "app/metrics/metrics-client.tsx",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "gen" || name === "__tests__" || name === "node_modules"
        ? []
        : sourceFiles(path);
    }
    return /\.(tsx?|mdx)$/.test(name) && !/\.(test|spec|stories)\./.test(name)
      ? [path]
      : [];
  });
}

/** Source with comments stripped, so explanatory notes don't count as copy. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("pricing config", () => {
  it("is what checkout validates the Stripe price against", () => {
    expect(CHECKOUT_PLAN_CONFIG.premium.expectedUnitAmount).toBe(
      PLANS.premium.amountCents,
    );
    expect(CHECKOUT_PLAN_CONFIG.api_access.expectedUnitAmount).toBe(
      PLANS.apiAccess.amountCents,
    );
    for (const plan of Object.values(CHECKOUT_PLAN_CONFIG)) {
      expect(plan.expectedCurrency).toBe(PRICING_CURRENCY);
      expect(plan.expectedInterval).toBe(PRICING_INTERVAL);
    }
  });

  it("formats prices for display", () => {
    expect(formatPrice(400)).toBe("$4");
    expect(formatPrice(450)).toBe("$4.50");
    expect(planPricePerMonth("free")).toBe("$0");
    expect(planPricePerMonth("premium")).toBe(
      `${formatPrice(PLANS.premium.amountCents)}/mo`,
    );
  });

  it("is the only place a monthly price is written as a literal", () => {
    const offenders = sourceFiles(WEB_SRC)
      .map((file) => relative(WEB_SRC, file))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) =>
        /\$\d+(?:\.\d+)?\s*(?:<[^>]*>)?\s*\/\s*(?:mo|month)\b/.test(
          code(join(WEB_SRC, rel)),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("does not link the API Access price on /docs/api to /pricing", () => {
    // /pricing is the Premium surface; an API price linked there is a dead end.
    const line = code(join(WEB_SRC, "app/docs/api/page.tsx"))
      .split("\n")
      .find((l) => l.includes('planPricePerMonth("apiAccess")'));
    expect(line).toBeDefined();
    expect(line).not.toContain('href="/pricing"');
  });
});
