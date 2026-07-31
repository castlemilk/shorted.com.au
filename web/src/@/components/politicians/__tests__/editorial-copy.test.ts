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
import { join, sep } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");

/** Every file that renders register data. */
const SURFACES = [
  join(ROOT, "@", "components", "politicians"),
  join(ROOT, "app", "politicians"),
  join(ROOT, "@", "components", "company", "politician-interests-card.tsx"),
  join(ROOT, "@", "components", "economy", "state-politician-holdings.tsx"),
  // The OPERATOR console. It is not published to readers, but it renders
  // declared text beside named parliamentarians on an internal screen, and the
  // language rules are about what gets WRITTEN next to a person's name — the
  // audience does not change whether "profited" is an imputation. It is excluded
  // from RENDERING_SURFACES below (an admin tool owes an operator no
  // reader-facing dispute link) but not from the vocabulary rules.
  join(ROOT, "@", "components", "admin", "register-review"),
  join(ROOT, "app", "admin", "register"),
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

/**
 * Files that RENDER register data, as opposed to the kit they render it with or
 * the shims that load it.
 *
 *   compliance.tsx        DEFINES SourceLine/ReportErrorLink; it never calls them
 *   *-loader.tsx          a `dynamic(ssr:false)` import shim — no copy at all
 *   opengraph-image.tsx   a PNG. It CANNOT carry a clickable dispute path, so
 *                         rule 8 is unsatisfiable there. The trade is that a
 *                         share card must therefore never render an individual's
 *                         data: the card is generic hub copy naming nobody, and
 *                         it cites the register in its footer. If you ever put a
 *                         parliamentarian's name or holding on a card, this
 *                         exemption stops being defensible — put the data behind
 *                         a page that can cite and be disputed instead.
 *
 * Everything else names parliamentarians and must cite and be disputable.
 */
/**
 * Sections of the /politicians hub, as opposed to independently embeddable
 * cards. They are rendered by exactly one page, which carries the citation and
 * the dispute link in its footer — so requiring a SECOND SourceLine inside them
 * would put two citations on one screen.
 *
 * This exclusion is only safe while that remains true, so the test below asserts
 * the host page still carries it. state-politician-holdings.tsx is the
 * counter-example and is NOT excluded: it is a card dropped onto the economy
 * state page, and it shipped with no attribution of its own.
 */
const HUB_SECTIONS = ["politician-explorer.tsx", "register-heatmap.tsx"];

const RENDERING_SURFACES = FILES.filter(
  (f) =>
    !f.endsWith("compliance.tsx") &&
    !f.endsWith("-loader.tsx") &&
    !f.endsWith("opengraph-image.tsx") &&
    !f.includes("__tests__") &&
    !HUB_SECTIONS.some((s) => f.endsWith(s)) &&
    // The operator console: rule 1 (cite the source) and rule 8 (offer a dispute
    // path) are promises to a READER. The reviewer here IS the dispute path, and
    // every candidate card already links the APH PDF per declaration — which is
    // the citation, just not via the reader-facing SourceLine kit.
    !f.includes(`${sep}admin${sep}`),
);

describe("politician surface copy", () => {
  // A pinned count, not a floor. `toBeGreaterThan(4)` let a new surface be added
  // outside the four hand-listed paths in SURFACES[] without anyone noticing —
  // which is exactly how state-politician-holdings.tsx shipped with no
  // attribution. Update this number deliberately when adding a surface, and
  // re-run the editorial review when you do.
  //
  // 9 -> 11 on 2026-07-31: the operator console (securities-review.tsx and its
  // page) renders declared text beside named parliamentarians, so it is bound by
  // the vocabulary rules. RENDERING_SURFACES stays 7 — an admin tool owes an
  // operator no reader-facing citation kit, and each candidate card already
  // links the APH PDF per declaration. §6.2 re-review triggered and recorded in
  // docs/politician-register-architecture.md.
  it("covers exactly the surfaces it claims to", () => {
    // 10 (incl. politicians/opengraph-image.tsx, the share card) + 2 operator
    // console files + the explorer and the heatmap.
    expect(FILES.length).toBe(14);
    expect(RENDERING_SURFACES.length).toBe(7);
  });

  // The exclusion above is conditional on this. If the hub page ever loses its
  // SourceLine, two surfaces that name parliamentarians lose their citation at
  // the same moment and nothing else would notice.
  it("the /politicians hub carries the citation its sections rely on", () => {
    const hub = readFileSync(join(ROOT, "app", "politicians", "page.tsx"), "utf8");
    expect(hub).toMatch(/<SourceLine/);
    for (const section of HUB_SECTIONS) {
      const importName = section.replace(/\.tsx$/, "");
      expect(hub).toContain(importName);
    }
  });

  /**
   * Rule 1 (every figure traceable to a source with an as-at date) and rule 8
   * (a report-an-error affordance on every surface) are REQUIREMENTS, not
   * prohibitions. The rest of this file bans words; without this test a surface
   * can name parliamentarians, cite nothing, offer no dispute path, and still
   * pass every other assertion. state-politician-holdings.tsx did exactly that.
   */
  it.each(RENDERING_SURFACES)("%s cites its source and offers a dispute path", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toMatch(/<SourceLine|<ReportErrorLink/);
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
