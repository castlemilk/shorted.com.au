/**
 * Turns docs/influence-editorial-standards.md rules 2, 3 and 5 into a BUILD GATE
 * rather than a review habit.
 *
 * Australia is the most plaintiff-friendly defamation jurisdiction in the
 * English-speaking world, and the risk is imputation — what a reasonable reader
 * takes the material to insinuate. A single careless verb next to a named
 * parliamentarian is the failure mode, and it is exactly the kind of thing that
 * survives review when someone adds "just one more card" months later.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");

/** Every file that renders register data. */
const SURFACES = [
  join(ROOT, "@", "components", "politicians"),
  join(ROOT, "app", "politicians"),
  join(ROOT, "@", "components", "company", "politician-interests-card.tsx"),
  join(ROOT, "@", "components", "economy", "state-politician-holdings.tsx"),
];

function collect(target: string): string[] {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(target);
  } catch {
    return [];
  }
  if (stat.isFile()) return /\.tsx?$/.test(target) ? [target] : [];
  return readdirSync(target).flatMap((entry) => {
    if (entry === "__tests__" || entry === "__snapshots__") return [];
    return collect(join(target, entry));
  });
}

const FILES = SURFACES.flatMap(collect);

/**
 * Rule 3: banned verbs next to a named entity. Also bans "profit", "insider" and
 * "bet against", which impute trading behaviour the registers cannot evidence.
 */
const BANNED_VERBS =
  /\b(bribed?|bought influence|rigged|corrupt\w*|rorted|kickback|profit(?:ed|ing|s)?|insider|cash for|bet against|portfolio size|self-?enrich\w*|feathering)\b/i;

/** Rule 5: no surface may state or imply a holding's magnitude. */
const BANNED_MAGNITUDE = /\b(worth|valued at \$|portfolio value|holdings? worth|stake worth|net worth)\b/i;

/** Strip code so an identifier like `shortPercent` cannot trip a prose rule. */
function proseOnly(source: string): string {
  return source
    // JSX text and string literals are where prose lives; comments explain the
    // rules themselves and legitimately quote the banned words.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("politician surface copy", () => {
  it("covers the surfaces it claims to", () => {
    expect(FILES.length).toBeGreaterThan(4);
  });

  it.each(FILES)("%s uses no accusatory verb", (file) => {
    const prose = proseOnly(readFileSync(file, "utf8"));
    const match = prose.match(BANNED_VERBS);
    expect(match?.[0] ?? null).toBeNull();
  });

  it.each(FILES)("%s never implies a holding's value", (file) => {
    const prose = proseOnly(readFileSync(file, "utf8"));
    const match = prose.match(BANNED_MAGNITUDE);
    expect(match?.[0] ?? null).toBeNull();
  });

  it.each(FILES)("%s renders no currency amount for a holding", (file) => {
    const prose = proseOnly(readFileSync(file, "utf8"));
    // A "$" followed by a digit or a formatter in politician copy would be a
    // holding value. The registers record none, so there is nothing to format.
    const match = prose.match(/\$\{?\s*\d|toLocaleString\([^)]*currency/i);
    expect(match?.[0] ?? null).toBeNull();
  });

  it("states the what-not-how-much constraint somewhere in the kit", () => {
    const compliance = readFileSync(
      join(ROOT, "@", "components", "politicians", "compliance.tsx"),
      "utf8",
    );
    expect(compliance).toMatch(/never.{0,20}quantity|not.{0,20}record quantity/i);
  });

  it("locks the exact holder labels", () => {
    const compliance = readFileSync(
      join(ROOT, "@", "components", "politicians", "compliance.tsx"),
      "utf8",
    );
    expect(compliance).toContain('label: "Self"');
    expect(compliance).toContain('label: "Spouse/partner"');
    expect(compliance).toContain('label: "Dependent child"');

    // Concealment-imputing PHRASES, not bare words: "hidden" alone matches the
    // aria-hidden accessibility attribute, and a false positive there would
    // teach the next person to delete the guard.
    const CONCEALMENT =
      /\b(hidden (?:holding|interest|asset|stake)s?|undisclosed|indirectly? (?:held|holds|owned)|secret(?:ly)? (?:held|owned)|linked to a? ?(?:company|holding)|via (?:their )?spouse)\b/i;
    const match = proseOnly(compliance).match(CONCEALMENT);
    expect(match?.[0] ?? null).toBeNull();
  });

  it("keeps a report-an-error affordance and an attribution line", () => {
    const compliance = readFileSync(
      join(ROOT, "@", "components", "politicians", "compliance.tsx"),
      "utf8",
    );
    expect(compliance).toContain("Report an error");
    expect(compliance).toMatch(/Parliament of\s*\n?\s*Australia|Parliament of Australia/);
  });
});
