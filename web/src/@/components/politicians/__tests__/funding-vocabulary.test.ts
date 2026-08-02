/**
 * The funding layer's own vocabulary and framing gate
 * (docs/feature/politicians/donations.md §2, and the whole-influence gate in
 * docs/influence-editorial-standards.md).
 *
 * `editorial-copy.test.ts` bans accusatory verbs and magnitude across every
 * politician surface, and lifts its currency ban for exactly these files. This
 * file is the other half of that trade: money beside a named party and a named
 * payer is publishable, and the price of publishing it is that the FRAMING is
 * checked mechanically rather than by memory.
 *
 * It bans the INFLUENCE and ANOMALY registers on the funding files
 * specifically — "a payer bought access" is an imputation the AEC's returns
 * cannot evidence, and "an unusual donation" is a characterisation of a lawful,
 * disclosed transaction — and it checks COMMENTS AND ARIA LABELS TOO. A comment
 * reading "who is really buying the election" is how the next person learns the
 * wrong frame, and an aria-label is copy only a screen-reader user hears, which
 * makes it the likeliest place for a banned word to survive a visual review.
 *
 * Then it checks four structural promises the data itself imposes:
 *
 *   1. the right-censoring and 1-Jan-2027 reform notes are rendered ON the
 *      explorer, from the strings the API served;
 *   2. the receipt-type split renders wherever receipt amounts aggregate;
 *   3. the profile section carries no party-level money at all;
 *   4. the profile section presents election returns as LINKED RETURNS and
 *      never as a lodgement timeline with gaps in it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");

const EXPLORER_ISLAND = join(ROOT, "@", "components", "politicians", "donations-explorer.tsx");
const EXPLORER_PAGE = join(ROOT, "app", "politicians", "donations", "page.tsx");
const PROFILE_SECTION = join(
  ROOT,
  "@",
  "components",
  "politicians",
  "profile",
  "funding-returns.tsx",
);
const RECEIPT_SPLIT = join(ROOT, "@", "components", "politicians", "explorer", "receipt-split.tsx");
const FUNDING_BARS = join(ROOT, "@", "components", "politicians", "explorer", "funding-bars.tsx");

/**
 * EVERY file of the funding layer, including the read paths, the pure libs and
 * this suite's own fixtures.
 *
 * The action modules and the money library are in here on purpose: an identifier
 * or a fixture name is copy that outlives the person who wrote it, and a test
 * fixture called `suspiciousDonor` teaches the frame just as effectively as a
 * heading would.
 */
const FILES = [
  EXPLORER_PAGE,
  EXPLORER_ISLAND,
  FUNDING_BARS,
  RECEIPT_SPLIT,
  PROFILE_SECTION,
  join(ROOT, "app", "actions", "donationsExplorer.ts"),
  join(ROOT, "app", "actions", "getDonations.ts"),
  join(ROOT, "app", "actions", "getPoliticianFunding.ts"),
  join(ROOT, "@", "lib", "politics", "funding-money.ts"),
  join(ROOT, "@", "lib", "politics", "party-group-palette.ts"),
  join(__dirname, "donations-explorer.test.tsx"),
  join(__dirname, "profile-funding-returns.test.tsx"),
  join(ROOT, "app", "actions", "__tests__", "donationsExplorerAction.test.ts"),
  join(ROOT, "app", "actions", "__tests__", "donationsReadPath.test.ts"),
  // NOT this file. It defines the banned registers, so it necessarily contains
  // every word in them — the same exemption the activity explorer's sweep takes.
];

/**
 * The anomaly register, identical to the activity explorer's.
 *
 * "watch" is matched as a word so `watchlist` in an unrelated import trips it
 * too — deliberately: a "watchlist" of donors is precisely the thing the
 * editorial rules forbid, whatever the identifier was borrowed from.
 */
const BANNED_ANOMALY =
  /\b(anomal\w*|unusual\w*|spike[ds]?|spiking|surge[ds]?|surging|red[- ]flags?|flagged|watch(?:ing|list|ed)?|suspicious|questionable|troubling|alarming|concerning|scandal\w*)\b/i;

/**
 * The INFLUENCE register, which is specific to this layer.
 *
 * A disclosed political donation is lawful and the return says only that it
 * happened. Every phrase here asserts an effect, a motive or a relationship the
 * AEC's data cannot evidence — which is rule 6 of donations.md and rule 3 of the
 * standards doc. "Access", "sway", "backer" and "beholden" are imputations;
 * "war chest" and "buying" are the tabloid register the whole feature is built
 * to avoid.
 */
const BANNED_INFLUENCE =
  /\b(buy(?:s|ing)? (?:influence|access|votes?)|bought (?:influence|access)|pay[- ]?to[- ]?play|war ?chest|beholden|in the pocket|sway(?:ed|ing)?|backers?|paymasters?|quid pro quo|lobby(?:ing|ist)? cash|dark money|secret donors?|donor class|captured by)\b/i;

/**
 * The register-wide verb ban, repeated here so the funding files are checked
 * against it INCLUDING their comments (the sweep in editorial-copy.test.ts
 * strips comments, because comments there legitimately quote the rules).
 */
const BANNED_VERBS =
  /\b(bribed?|bought influence|rigged|corrupt\w*|rorted|kickback|cash for|bet against|self-?enrich\w*|feathering)\b/i;

function scan(file: string, pattern: RegExp): string | null {
  const match = readFileSync(file, "utf8").match(pattern);
  return match?.[0] ?? null;
}

/**
 * Strip comments, for the two rules below that are about RENDERED COPY.
 *
 * The vocabulary rules above deliberately keep comments in scope — a comment is
 * how the next person learns the frame. These two are different: they check that
 * a file does not restate a served caveat and does not render an AEC mark, and
 * the docblocks explaining exactly those rules necessarily quote them.
 */
function proseOnly(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("AEC funding vocabulary", () => {
  it("checks the files it means to", () => {
    // A guard on the guard: a renamed file would otherwise make every assertion
    // below pass by reading nothing.
    for (const file of FILES) {
      expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
    }
  });

  it.each(FILES)("%s never characterises a disclosed figure as anomalous", (file) => {
    expect(scan(file, BANNED_ANOMALY)).toBeNull();
  });

  it.each(FILES)("%s asserts no influence, motive or effect", (file) => {
    expect(scan(file, BANNED_INFLUENCE)).toBeNull();
  });

  it.each(FILES)("%s uses no accusatory verb, in copy or in comments", (file) => {
    expect(scan(file, BANNED_VERBS)).toBeNull();
  });

  it.each(FILES)("%s never colours a lawful receipt as good or bad", (file) => {
    const source = readFileSync(file, "utf8");
    // No green/red anywhere: not as a tailwind class, not as a hex. A red
    // segment beside a named payer is a judgement, not a category.
    expect(source).not.toMatch(/\b(?:text|bg|border)-(?:emerald|green|red|rose)-/);
    expect(source).not.toMatch(/#(?:0f0|f00|22c55e|ef4444)\b/i);
  });

  /* --------------------------------------------------- the four structures */

  it("renders the right-censoring and reform notes on the explorer itself", () => {
    const island = readFileSync(EXPLORER_ISLAND, "utf8");
    // From the API's served strings, never restated in our own words — that is
    // what stops a caveat drifting into a claim on one surface out of four.
    expect(island).toMatch(/page\.notes\.censoring/);
    expect(island).toMatch(/page\.notes\.reform/);

    const page = readFileSync(EXPLORER_PAGE, "utf8");
    expect(page).toMatch(/page\.notes\.censoring/);
    expect(page).toMatch(/page\.notes\.reform/);
    // And the coverage note, which is where the Senate limitation is stated:
    // no senator's funding return is linked to a member page here.
    expect(page).toMatch(/page\.notes\.coverage/);
    expect(page).toMatch(/page\.notes\.verbatim/);
  });

  it("never restates a served note in its own words", () => {
    for (const file of [EXPLORER_ISLAND, EXPLORER_PAGE, PROFILE_SECTION]) {
      const prose = proseOnly(file);
      // The API's own sentences, hard-coded, would fork the wording the moment
      // one of the two changed. Two fragments are enough to catch a paste.
      expect(prose).not.toMatch(/below the disclosure threshold in force/i);
      expect(prose).not.toMatch(/commences on 1 January 2027/i);
    }
  });

  it("shows the receipt-type split wherever receipt amounts aggregate", () => {
    const island = readFileSync(EXPLORER_ISLAND, "utf8");
    // Both places receipts are totalled per payer: the payer table AND the
    // listed-company rail. A subscription summed into a "donations" figure is
    // the failure this prevents.
    expect((island.match(/<ReceiptSplit/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(island).toMatch(/RECEIPT_SPLIT_NOTE/);
  });

  it("renders all five receipt buckets, including the empty ones", () => {
    const split = readFileSync(RECEIPT_SPLIT, "utf8");
    // The five are exhaustive over the source vocabulary and therefore sum to
    // the total. A reader can only check that if the zeroes are visible, so the
    // component maps the fixed ORDER rather than filtering to nonzero buckets.
    expect(split).toMatch(/RECEIPT_TYPE_ORDER\.map/);
    expect(split).not.toMatch(/filter\([^)]*cents\s*>\s*0/);

    const money = readFileSync(
      join(ROOT, "@", "lib", "politics", "funding-money.ts"),
      "utf8",
    );
    for (const key of [
      "donation",
      "otherReceipt",
      "subscription",
      "publicFunding",
      "unspecified",
    ]) {
      expect(money).toContain(key);
    }
  });

  it("keeps the three ledger measures in three charts, never stacked", () => {
    const island = readFileSync(EXPLORER_ISLAND, "utf8");
    // One <FundingBars> per measure. A single chart with three series would be
    // the stack the data cannot support.
    expect((island.match(/<FundingBars/g) ?? []).length).toBe(3);
    expect(island).toMatch(/never added together or stacked/i);

    const bars = readFileSync(FUNDING_BARS, "utf8");
    // The kit itself takes ONE measure per chart. A second amount per row is
    // what would make a stacked or grouped bar possible from the outside, so the
    // row shape must carry exactly one.
    expect(bars).toMatch(/measureLabel/);
    expect(bars).not.toMatch(/valueBCents|secondaryCents|values:\s*number\[\]/);
    expect((bars.match(/valueCents/g) ?? []).length).toBeGreaterThan(0);
  });

  it("keeps every party-level figure off the member profile section", () => {
    const section = readFileSync(PROFILE_SECTION, "utf8");
    // Money given to a party is not money given to a member. The rpc behind this
    // section does not serve a party figure; this asserts the component could not
    // render one even if it did.
    for (const field of [
      "totalReceiptsCents",
      "itemisedReceiptsCents",
      "declaredDonationsCents",
      "distinctPayerCount",
      "listedPayerCents",
      "partyGroup",
      "PartyFunding",
    ]) {
      expect(section).not.toContain(field);
    }
  });

  it("presents election returns as linked returns, not as a lodgement timeline", () => {
    const section = readFileSync(PROFILE_SECTION, "utf8");
    // Candidate resolution is per return and conservative: pre-2013 events
    // resolve to nobody, and a return does not link when the member did not hold
    // that division. So an unlisted election is a fact about our linking, and
    // rendering it as absence — a "no return" row, a gap in a year list — would
    // publish a claim about a named person that the corpus cannot support.
    expect(section).toContain("Election returns linked to this member");
    expect(section).toMatch(/has not been shown to lack one/i);
    expect(section).not.toMatch(/no return (?:lodged|for)/i);
    // A nil return is the one absence that IS a fact, and it is worded as the
    // return's own statement rather than as missing data.
    expect(section).toContain("Lodged a return declaring no gifts");
    // The coverage sentence is always rendered, whatever else is on the section.
    expect(section).toMatch(/coverageNote \? <p/);
  });

  it("states the no-endorsement posture and never renders an AEC mark", () => {
    const page = readFileSync(EXPLORER_PAGE, "utf8");
    expect(page).toMatch(/does not endorse/);
    // The AEC's terms permit reuse with attribution and forbid implying its
    // endorsement. A mark beside our own charts is exactly that implication, so
    // nothing here may render an image sourced from the AEC.
    const prose = proseOnly(EXPLORER_PAGE);
    expect(prose).not.toMatch(/<(?:img|Image)\b/);
    expect(prose).not.toMatch(/aec\.gov\.au\/[^"']*\.(?:png|jpg|jpeg|svg|gif)/i);
  });
});
