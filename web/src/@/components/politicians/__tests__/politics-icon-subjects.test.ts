/**
 * The icon SUBJECTS are bound by the editorial standards, and this is the gate.
 *
 * docs/influence-editorial-standards.md rule 1 names iconography as one of the
 * four ways a page of true facts still carries a defamatory imputation, and
 * rule 5 forbids stating or implying what a declared holding is worth. These
 * icons render beside NAMED parliamentarians, so what they may depict is an
 * editorial decision — the same one `register-items.test.ts` already enforces on
 * the emoji, applied to the artwork that replaces it.
 *
 * The check reads `web/scripts/politics-icons/icon-set.config.mjs` as TEXT and
 * inspects only the `subject:` strings. Deliberately: the file's own header and
 * its `negativeConstraints` name every banned thing (that is how the ban reaches
 * the image model), so a check over the whole file would either fail on its own
 * documentation or have to be weakened until it caught nothing.
 *
 * Generating an icon costs about four cents and takes twenty seconds. There is
 * no cost argument for keeping a subject that trips this.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG = join(
  __dirname, "..", "..", "..", "..", "..",
  "scripts", "politics-icons", "icon-set.config.mjs",
);

const source = readFileSync(CONFIG, "utf8");

interface IconEntry {
  id: string;
  group: string;
  subject: string;
}

/** Every `{ id, group, subject }` literal, in file order. */
const ICONS: IconEntry[] = [
  ...source.matchAll(
    /\{\s*id:\s*"([^"]+)",\s*group:\s*"([^"]+)",\s*subject:\s*"([^"]+)"\s*\}/g,
  ),
].map((m) => ({ id: m[1]!, group: m[2]!, subject: m[3]! }));

describe("icon subject vocabulary", () => {
  it("finds the icons it means to check", () => {
    // A guard on the guard: if the parse ever returns nothing, every assertion
    // below passes vacuously and the editorial gate silently stops working.
    expect(ICONS.length).toBeGreaterThanOrEqual(30);
    expect(ICONS.every((i) => i.subject.length > 10)).toBe(true);
  });

  /**
   * Rule 5: what is held, never how much. A money glyph beside a declaration
   * invents a figure the register does not disclose — which is why item 10
   * ("other substantial sources of income") is an inbox tray.
   */
  const MONEY =
    /\b(money|moneybag|money bag|coin|coins|cash|banknote|bank note|dollar|dollars|currency|price tag|wallet|purse|piggy ?bank|vault|safe deposit|till|cheque|check book|credit card|gold bar|bullion)\b/i;

  /** Rule 2: juxtaposition, not accusation — no icon may read as a flag. */
  const ACCUSATION =
    /\b(warning|caution|alert|siren|alarm|exclamation|hazard|red flag|danger|skull|eye|eyeball|detective|spy|spyglass|binocular|binoculars|surveillance|magnifier over a person|shadowy|sinister|thumbs? down)\b/i;

  /**
   * No legal-process furniture. Every entry in these registers is a lawful,
   * disclosed fact; a gavel or a set of scales beside one stages a trial.
   */
  const VERDICT =
    /\b(gavel|mallet|scales?|scales of justice|balance scale|courtroom|courthouse|judge|jury|handcuff|handcuffs|prison|jail|police|badge|verdict|sentence)\b/i;

  /** No winner/loser imagery: ranking a disclosure is a judgement about it. */
  const CONTEST =
    /\b(trophy|medal|medallion|podium|rosette|crown|laurel|ribbon award|prize|winner|first place|star rating|thumbs? up)\b/i;

  const CASES: [string, RegExp][] = [
    ["money or value", MONEY],
    ["warning, alert or judgement", ACCUSATION],
    ["legal process or verdict", VERDICT],
    ["winner or loser", CONTEST],
  ];

  for (const [what, pattern] of CASES) {
    it(`uses no ${what} imagery`, () => {
      const offenders = ICONS.filter((i) => pattern.test(i.subject)).map(
        (i) => `${i.id}: ${i.subject.match(pattern)?.[0]}`,
      );
      expect(offenders).toEqual([]);
    });
  }

  it("states no quantity, rank or magnitude in a subject", () => {
    for (const icon of ICONS) {
      expect(icon.subject).not.toMatch(/[$€£]|\bworth\b|\bvalued\b|\bamount\b|\blargest\b|\brichest\b/i);
    }
  });

  it("keeps every subject descriptive and evaluative of nothing", () => {
    // The adjectives that would make an icon an opinion. "Plain", "simple" and
    // "small" are shape words and are fine; these are not.
    for (const icon of ICONS) {
      expect(icon.subject).not.toMatch(
        /\b(corrupt|shady|secret|hidden|suspicious|dubious|greedy|lavish|luxury|opulent)\b/i,
      );
    }
  });

  it("keeps ids kebab-case and unique, since they are the manifest keys", () => {
    for (const icon of ICONS) expect(icon.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(new Set(ICONS.map((i) => i.id)).size).toBe(ICONS.length);
  });

  it("shares the housing/economy STYLE verbatim, so the three sets read as one", () => {
    // The suffix is copied, not re-derived. If it drifts, politician surfaces
    // stop matching the housing and economy icons they sit beside.
    expect(source).toContain(
      "Minimal flat vector icon in a warm editorial duotone style. Two main colours — warm amber ",
    );
    expect(source).toContain("#FFA94D");
    expect(source).toContain("#87A96B");
    expect(source).toContain("#D16A47");
  });

  it("carries the editorial bans into the prompt itself, not just the review", () => {
    // The negatives are what stop the model decorating a parcel with a currency
    // symbol. A review catches it; a negative avoids paying for it twice.
    for (const negative of ["dollar sign", "warning sign", "gavel", "scales of justice", "trophy"]) {
      expect(source).toContain(negative);
    }
  });
});
