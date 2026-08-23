/**
 * The API Access price must agree wherever it is stated.
 *
 * It did not. `/docs/api` quoted "$29/mo" while `/roadmap` said "$20/mo" and
 * Stripe charges the price behind STRIPE_API_ACCESS_PRICE_ID. A docs page that
 * quotes a price nobody charges is worse than one that quotes none — it sets
 * an expectation the checkout then breaks.
 *
 * There is no shared pricing constant to import (the app states prices as
 * literal copy in each surface), so this test does the next best thing: it
 * asserts the surfaces agree with each other and that the known-stale figure
 * has not come back. If a real pricing module ever lands, delete this and
 * assert against that instead.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB_SRC = join(__dirname, "../../../..");

const DOCS_API_PAGE = join(WEB_SRC, "app/docs/api/page.tsx");
const ROADMAP_PAGE = join(WEB_SRC, "app/roadmap/page.tsx");

/**
 * Every "$N/mo" or "$N/month" figure in a file's RENDERED copy.
 *
 * JSX comments are stripped first. Without that, a price mentioned only in an
 * explanatory comment would satisfy the assertions while the table itself said
 * something else — the test would pass on a page that lies to the reader.
 */
function pricesIn(file: string): string[] {
  const source = readFileSync(file, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "") // JSX comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/.*$/gm, ""); // line comments
  return Array.from(
    source.matchAll(/\$(\d+(?:\.\d+)?)\s*\/\s*(?:mo|month)/g),
    (m) => m[1],
  );
}

/** The file with comments stripped, for assertions about rendered markup. */
function renderedSource(file: string): string {
  return readFileSync(file, "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("API Access price consistency", () => {
  const EXPECTED_API_PRICE = "20";
  const STALE_API_PRICE = "29";

  it("states the API Access price on the API docs page", () => {
    // A developer deciding whether to pay should not have to leave the page —
    // and must not be sent to /pricing, which covers Premium only and says
    // nothing about API access.
    expect(pricesIn(DOCS_API_PAGE)).toContain(EXPECTED_API_PRICE);
  });

  it("never reintroduces the stale $29 figure", () => {
    expect(pricesIn(DOCS_API_PAGE)).not.toContain(STALE_API_PRICE);
  });

  it("agrees with the price stated on /roadmap", () => {
    // These are the only two surfaces that name the API tier's price. If they
    // ever disagree again, one of them is lying to a customer.
    expect(pricesIn(ROADMAP_PAGE)).toContain(EXPECTED_API_PRICE);
  });

  it("does not link the API price to /pricing", () => {
    // /pricing is the Premium ($4/mo) surface. Linking an API price there is a
    // dead end, which is what the previous fix accidentally shipped.
    const source = renderedSource(DOCS_API_PAGE);
    const apiPriceLine = source
      .split("\n")
      .find((line) => line.includes("$20/mo"));
    expect(apiPriceLine).toBeDefined();
    expect(apiPriceLine).not.toContain('href="/pricing"');
  });
});
