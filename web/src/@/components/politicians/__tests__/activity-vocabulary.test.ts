/**
 * The discovery layer's own vocabulary gate (docs/feature/politicians/
 * explorer-ui.md §7, "Editorial gates for this layer").
 *
 * The ask that produced these surfaces was anomaly-findability, and the whole
 * design answer is that an unusual pattern must become a FINDABLE FACT rather
 * than a labelled one: counts, dates and juxtapositions, with the inference left
 * entirely to the reader. That is a discipline about WORDS, and words are what
 * drift — "most active" is a count ordering and is safe; "unusually active" is
 * an imputation about a named parliamentarian and is not, and the two are one
 * careless edit apart.
 *
 * `editorial-copy.test.ts` bans accusatory verbs and magnitude across every
 * politician surface. This file is narrower and stricter: it bans the
 * RISK/ANOMALY register on the files of the activity explorer specifically, and
 * it checks ARIA LABELS AND TEST NAMES too — an aria-label is copy that only a
 * screen-reader user hears, which makes it the likeliest place for a banned word
 * to survive a visual review.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");

/** Every file of the activity explorer, including this file's own siblings. */
const FILES = [
  join(ROOT, "app", "politicians", "changes", "page.tsx"),
  join(ROOT, "@", "components", "politicians", "register-activity-explorer.tsx"),
  join(ROOT, "@", "components", "politicians", "explorer", "week-bars.tsx"),
  join(ROOT, "app", "actions", "registerActivity.ts"),
  join(__dirname, "register-activity-explorer.test.tsx"),
  join(__dirname, "week-bars.test.tsx"),
];

/**
 * The banned register.
 *
 * "watch" is matched as a word so `watchlist` in an unrelated import would trip
 * it too — deliberately: a "watchlist" of parliamentarians is precisely the
 * thing rule 2 forbids, whatever the identifier was borrowed from.
 */
const BANNED =
  /\b(anomal\w*|unusual\w*|spike[ds]?|spiking|surge[ds]?|surging|red[- ]flags?|flagged|watch(?:ing|list|ed)?|suspicious|questionable|troubling|alarming|concerning|scandal\w*)\b/i;

/**
 * Comments are stripped for the PROSE rules elsewhere in this suite, but NOT
 * here: this file exists to keep the vocabulary out of the surface entirely, and
 * a comment reading "flag the unusual ones" is how the next person learns the
 * wrong frame. The one exemption is this test's own explanation of the rule,
 * which is why it is not in the FILES list above.
 */
function scan(file: string): string | null {
  const match = readFileSync(file, "utf8").match(BANNED);
  return match?.[0] ?? null;
}

describe("register activity vocabulary", () => {
  it("checks the files it means to", () => {
    // A guard on the guard: a renamed file would otherwise make every assertion
    // below pass by reading nothing.
    for (const file of FILES) {
      expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
    }
  });

  it.each(FILES)("%s never characterises activity as anomalous", (file) => {
    expect(scan(file)).toBeNull();
  });

  it("keeps 'most active' as a COUNT ordering, and says which count", () => {
    const island = readFileSync(
      join(ROOT, "@", "components", "politicians", "register-activity-explorer.tsx"),
      "utf8",
    );
    // The permitted superlative, and it names its measure in the same breath —
    // "most active MEMBER" would be a characterisation of a person, "most dated
    // register events" is an ordering of a count.
    expect(island).toContain("Most dated register events");
    expect(island).not.toMatch(/most active member/i);
  });

  it("states the dated-only discipline and the coverage caveat on the page", () => {
    const page = readFileSync(
      join(ROOT, "app", "politicians", "changes", "page.tsx"),
      "utf8",
    );
    expect(page).toMatch(/DATED register events/);
    expect(page).toMatch(/no quantity and no value/);
    expect(page).toMatch(/coverage, not a finding/);
  });

  it("publishes the undated count rather than letting the timeline imply zero", () => {
    const island = readFileSync(
      join(ROOT, "@", "components", "politicians", "register-activity-explorer.tsx"),
      "utf8",
    );
    expect(island).toContain("undatedCurrentCount");
    expect(island).toMatch(/state no start date/);
  });

  it("never colours a register event as good or bad", () => {
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      // No green/red anywhere: not as a tailwind class, not as a hex.
      expect(source).not.toMatch(/\b(?:text|bg|border)-(?:emerald|green|red|rose)-/);
      expect(source).not.toMatch(/#(?:0f0|f00|22c55e|ef4444)\b/i);
    }
  });
});
