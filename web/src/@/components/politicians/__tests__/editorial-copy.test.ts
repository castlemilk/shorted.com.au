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
const HUB_SECTIONS = [
  // politician-explorer.tsx was retired 2026-08-03: the hub's search lives
  // inside the register table island now, one window for search and roll.
  "register-heatmap.tsx",
  // The hub's register table. Same class as the two above, and it CANNOT carry
  // its own citation: it is a "use client" file, and SourceLine/ReportErrorLink
  // live in compliance.tsx, which imports the generated protobuf enum. The hub
  // page renders a SourceLine directly beneath the table for exactly this
  // reason, and the assertion below checks the page still carries one.
  "politician-register-table.tsx",
];

/**
 * The /politicians/changes activity explorer's island — the same class as
 * HUB_SECTIONS, for the same two reasons, but kept in its own list because the
 * hub does not import it and the assertion below checks each list against ITS
 * OWN host page.
 *
 * It is one page's whole body, and it CANNOT carry its own citation: it is a
 * "use client" file and SourceLine/ReportErrorLink live in compliance.tsx,
 * which imports the generated protobuf enum. The changes page renders the
 * SourceLine, the CaveatNote and the method note in its footer.
 */
const CHANGES_SECTIONS = ["register-activity-explorer.tsx"];

/**
 * The /politicians/donations funding explorer's island — the same class as
 * CHANGES_SECTIONS, for the same two reasons, and kept in its own list so the
 * assertion below checks it against ITS OWN host page.
 *
 * It is one page's whole body, and it CANNOT carry its own citation: it is a
 * "use client" file and SourceLine/ReportErrorLink live in compliance.tsx, which
 * imports the generated protobuf enum. The donations page renders the AEC
 * attribution line, the ReportErrorLink and the methodology band.
 */
const DONATIONS_SECTIONS = ["donations-explorer.tsx"];

/**
 * THE ONE PLACE MONEY IS PERMITTED next to a parliamentarian, and why.
 *
 * Every other file in this sweep renders the Registers of Members'/Senators'
 * Interests, which record WHAT is held and never how much — there is no figure
 * to format, so a currency amount in one of those files is always an invented
 * one, and the assertion below bans it outright.
 *
 * These files render the AEC Transparency Register instead. That is a different
 * source under a different licence (CC BY 4.0), lodged on forms whose entire
 * purpose is to state amounts, and the editorial standards' own worked example
 * blesses publishing them. So the currency rule is lifted HERE and nowhere else,
 * and the assertion beneath it checks the exemption is not a licence to
 * hand-roll a formatter: every amount goes through `@/lib/politics/funding-money`
 * so one rounding rule governs the whole layer.
 *
 * Adding a file to this list is an editorial decision, not a build fix. If a
 * REGISTER surface ever needs to be added here, it does not — it needs the
 * figure removed.
 */
const FUNDING_SURFACES = [
  "donations-explorer.tsx",
  join("explorer", "funding-bars.tsx"),
  join("explorer", "receipt-split.tsx"),
  join("profile", "funding-returns.tsx"),
  join("donations", "page.tsx"),
];

/**
 * Presentational primitives — the kit, not a surface. Same class as
 * compliance.tsx, which is excluded for the same reason.
 *
 * politician-avatar.tsx renders a face and a monogram. It carries the ONLY
 * attribution that actually applies to it — `PortraitCredit`, the CC BY / CC
 * BY-SA credit line — and the assertion below checks it still does. A
 * `SourceLine` inside an avatar would cite the register on a component that
 * renders no register data. The explorer directory is the same kind of
 * reusable kit: host pages own its source line and dispute affordance.
 */
const KIT_PRIMITIVES = [
  "politician-avatar.tsx",
  // The iconography kit (2026-08-02). Three files that render NO register data:
  //
  //   politics-icon.tsx             slices one cell out of the sprite
  //   politics-icons.generated.ts   the packer's coords table — no copy at all
  //   party-mark.tsx                a monogram tile drawn from a party
  //                                 abbreviation and a palette colour
  //
  // A SourceLine inside any of them would cite the register on a component that
  // renders nothing from it. They are still swept by the VOCABULARY rules below,
  // and the icon set has a gate of its own: politics-icon-subjects.test.ts reads
  // web/scripts/politics-icons/icon-set.config.mjs and enforces that no subject
  // depicts money, a warning, a gavel or scales, or a trophy — rule 1 lists
  // iconography as an imputation vector, and rule 5 forbids implying value.
  // party-mark.tsx additionally asserts it is not a party LOGO: a registered
  // trademark we hold no licence to, and an affiliation we do not claim.
  "politics-icon.tsx",
  "politics-icons.generated.ts",
  "party-mark.tsx",
];
const KIT_PRIMITIVE_DIRS = [`${sep}explorer${sep}`];

/**
 * Sections of the `/politicians/[slug]` profile — the same class as
 * HUB_SECTIONS, for the same reason.
 *
 * `profile/` holds the pieces of ONE page: the row renderer, the filter island,
 * the rail sections and the key-facts copy generator. That page carries the
 * SourceLine and the report-an-error affordance in its footer, so a second
 * citation inside each section would put four of them on one screen. The
 * assertion below checks the host page still carries it.
 *
 * The filter island additionally CANNOT carry one: it is a "use client" file,
 * and SourceLine/ReportErrorLink live in compliance.tsx, which imports the
 * generated protobuf enum — importing it from a client component is the
 * prerender failure client-boundary.test.ts exists to prevent.
 */
const PROFILE_SECTION_DIRS = [`${sep}profile${sep}`];

const RENDERING_SURFACES = FILES.filter(
  (f) =>
    !f.endsWith("compliance.tsx") &&
    !f.endsWith("-loader.tsx") &&
    !f.endsWith("opengraph-image.tsx") &&
    !f.includes("__tests__") &&
    !HUB_SECTIONS.some((s) => f.endsWith(s)) &&
    !CHANGES_SECTIONS.some((s) => f.endsWith(s)) &&
    !DONATIONS_SECTIONS.some((s) => f.endsWith(s)) &&
    !KIT_PRIMITIVES.some((s) => f.endsWith(s)) &&
    !KIT_PRIMITIVE_DIRS.some((s) => f.includes(s)) &&
    !PROFILE_SECTION_DIRS.some((s) => f.includes(s)) &&
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
  // docs/feature/politicians/architecture.md.
  it("covers exactly the surfaces it claims to", () => {
    // 18 existing files + 8 reusable explorer-kit files. The explorer kit is
    // excluded from RENDERING_SURFACES above because host pages carry its
    // citation/dispute footer. The remaining inventory includes the explorer,
    // the heatmap, the avatar kit, and 5 operator-console files (securities
    // review + its page, the politician CRM + its index and detail pages).
    //
    // The CRM renders a named person's photograph, their terms and their
    // profile facts on an internal screen — bound by the vocabulary rules for
    // the same reason the securities console is, and excluded from
    // RENDERING_SURFACES for the same reason too.
    //
    // 26 -> 35 on 2026-08-01, the explorer build (docs/feature/politicians/
    // explorer-ui.md §5): +1 hub table, +4 `profile/` sections, +4 `compare/`
    // files. The profile sections are excluded from RENDERING_SURFACES above —
    // they are one page's sections and that page carries the citation. §6.2
    // editorial re-review triggered for the new templates.
    //
    // THIS NUMBER IS THE COORDINATION POINT for the three explorer waves, which
    // are landing in parallel. If it fails after a merge, count the tree, re-pin
    // it deliberately, and re-read the new copy — do not relax the assertion.
    //
    // RENDERING_SURFACES 10 -> 9 with the hub table added to HUB_SECTIONS: it
    // is one page's section, that page carries the SourceLine directly beneath
    // it, and a client island cannot import the citation kit at all.
    //
    // 35 -> 36: `profile/aggregates.ts`, which decides WHICH numbers the profile
    // publishes (the analytics rpc's, or the ones derivable from the rows on the
    // page) and which date its "register last updated" tile may carry. It lived
    // inline in the page, where the fallback silently never fired and a refresh
    // clock was published as a filing date; it is counted here because it is
    // register logic beside a named person, and excluded from
    // RENDERING_SURFACES as a `profile/` section like the four beside it. It
    // renders nothing and carries no copy — the labels it returns come from the
    // register's own taxonomy in `@/lib/politics/register-items`.
    //
    // 36 -> 37: `profile/distinctive-holdings.tsx`, the "Declared by no other
    // member" rail (explorer-ui.md §7b). It publishes a COUNT OF MEMBERS and
    // the company's own market-wide short interest beside a named member, which
    // is exactly the copy this file governs — the heading is the whole claim,
    // and the word "distinctive" (the rpc's name) appears in no reader-facing
    // string. Excluded from RENDERING_SURFACES as a `profile/` section like the
    // five beside it: it is one page's rail and that page carries the citation
    // and the dispute affordance. §6.2 editorial re-review triggered for the new
    // heading, the long-tail line and the short-interest chip.
    //
    // 37 -> 39: the activity explorer (explorer-ui.md §7a) —
    // `register-activity-explorer.tsx`, the /politicians/changes island, and
    // `explorer/week-bars.tsx`, the weekly paired-bar strip it renders. The
    // island names members beside dated counts and is excluded from
    // RENDERING_SURFACES as a HUB_SECTIONS-class file (a client island cannot
    // import the citation kit; its page carries the SourceLine, the CaveatNote
    // and the method note). The strip is kit, excluded by KIT_PRIMITIVE_DIRS
    // like the eight files beside it. §6.2 editorial re-review triggered for
    // the filter copy, the two outage paragraphs, the count line and the three
    // rail headings — "most dated register events" is the strongest
    // characterisation any of them makes, and it is a count ordering.
    //
    // 39 -> 44, the AEC funding layer (docs/feature/politicians/donations.md
    // §5): `donations-explorer.tsx` (the /politicians/donations island),
    // `explorer/funding-bars.tsx` and `explorer/receipt-split.tsx` (its kit),
    // `profile/funding-returns.tsx` (the profile section) and the donations
    // page. These are the FIRST politician surfaces permitted to render a
    // currency amount — a different source under a different licence, see
    // FUNDING_SURFACES above — so the §6.2 editorial re-review covered the money
    // formatting, the three-measure separation, the receipt-type split and the
    // linked-returns framing on the profile section as well as the copy.
    //
    // RENDERING_SURFACES 9 -> 10: the donations page, which carries the AEC
    // attribution line and the ReportErrorLink for its island. The island, the
    // kit files and the profile section are excluded exactly as their
    // equivalents in the three waves before this one are.
    //
    // 44 -> 46, the responsiveness pass (2026-08-02): two new kit primitives
    // under `explorer/`, both excluded from RENDERING_SURFACES by
    // KIT_PRIMITIVE_DIRS like the ten files beside them.
    //
    //   - `explorer/screen-reader-table.tsx` carries NO reader-facing copy at
    //     all. It is the `<div class="sr-only"><table>` wrapper that stops a
    //     `display:table` box from escaping the 1 px clip and dragging the
    //     document sideways (+1352 px at 375 px on /donations). The strings it
    //     renders are its callers' captions, unchanged, so §6.2 has nothing new
    //     to review here.
    //   - `explorer/typeahead-status.tsx` DOES carry copy — "Searching
    //     members…" — and §6.2 review covers it. It says only that a lookup is
    //     in flight. It makes no claim about the register, about a member, or
    //     about whether anyone matches: the "No members match" line is now
    //     explicitly suppressed while this one shows, precisely so a reader is
    //     never told an absence that is really a wait.
    //
    // 46 -> 49, the iconography wave (web/scripts/politics-icons): the sprite
    // component, its generated coords table, and <PartyMark>. All three are kit
    // — see KIT_PRIMITIVES above for why they carry no citation of their own —
    // so RENDERING_SURFACES stays 10. They render no register data at all, but
    // they are counted here BECAUSE THE ARTWORK IS COPY: rule 1 lists
    // iconography as an imputation vector, so an icon subject is governed the
    // same way a sentence is. The §6.2 editorial re-review covered the 31
    // subjects (no money, no warning, no gavel or scales, no trophy — item 10 is
    // an inbox tray for the same reason it is 📥 today) and the decision that a
    // party is a monogram we draw, never the party's own logo.
    //
    // The two waves land on the same tree: 44 + 2 responsiveness primitives + 3
    // iconography kit files = 49; minus politician-explorer.tsx, retired
    // 2026-08-03 when the hub's search moved inside the register table = 48.
    expect(FILES.length).toBe(48);
    expect(RENDERING_SURFACES.length).toBe(10);
  });

  // The donations island's exclusion above is conditional on this, exactly as
  // the changes island's is. The island renders every figure on the page beside
  // a named party and a named payer and cites nothing on its own.
  it("the /politicians/donations page carries the citation its island relies on", () => {
    const donations = readFileSync(
      join(ROOT, "app", "politicians", "donations", "page.tsx"),
      "utf8",
    );
    expect(donations).toMatch(/<ReportErrorLink/);
    for (const section of DONATIONS_SECTIONS) {
      expect(donations).toContain(section.replace(/\.tsx$/, ""));
    }
    // The licence obligations: the Crown-copyright credit CC BY 4.0 requires,
    // and the no-endorsement posture the AEC's own terms require. Both are
    // conditions of using this data at all.
    expect(donations).toMatch(/Commonwealth of Australia/);
    expect(donations).toMatch(/does not endorse/);
  });

  /**
   * The currency exemption is NOT a licence to hand-roll a formatter.
   *
   * One rounding rule for the whole funding layer, in one module: two formatters
   * disagreeing by a dollar on the same figure, on two surfaces about the same
   * party, is the kind of inconsistency a reader reasonably reads as an error in
   * the underlying data rather than in ours.
   */
  it.each(FUNDING_SURFACES)("%s formats money through the one shared formatter", (name) => {
    const file = FILES.find((f) => f.endsWith(name));
    expect(file).toBeDefined();
    const src = readFileSync(file!, "utf8");
    // Either it formats amounts (via the shared module) or it renders none at
    // all and merely passes them through.
    if (/formatCents/.test(src)) {
      expect(src).toMatch(/from "@\/lib\/politics\/funding-money"/);
    }
    // And never its own currency formatter, whichever way it is spelled.
    expect(src).not.toMatch(/style:\s*["']currency["']/);
  });

  // The activity explorer's exclusion above is conditional on this, exactly as
  // the hub's and the profile's are. The island renders every dated event on the
  // page beside a named member and cites nothing on its own.
  it("the /politicians/changes page carries the citation its island relies on", () => {
    const changes = readFileSync(
      join(ROOT, "app", "politicians", "changes", "page.tsx"),
      "utf8",
    );
    expect(changes).toMatch(/<SourceLine/);
    expect(changes).toMatch(/<CaveatNote/);
    for (const section of CHANGES_SECTIONS) {
      expect(changes).toContain(section.replace(/\.tsx$/, ""));
    }
    // The method note is what makes every count on the page readable: dated
    // events only, undated entries excluded, and activity reflecting extraction
    // coverage as much as lodgement.
    expect(changes).toMatch(/DATED register events/);
    expect(changes).toMatch(/coverage, not a finding/);
  });

  // The avatar's exclusion above is conditional on it carrying the credit that
  // its own licences require. CC BY and CC BY-SA permit publication only WITH
  // attribution, so if PortraitCredit ever leaves this file, every portrait on
  // the site becomes an unattributed use.
  it("the avatar kit still carries the portrait attribution it is excused for", () => {
    const avatar = readFileSync(
      join(ROOT, "@", "components", "politicians", "politician-avatar.tsx"),
      "utf8",
    );
    expect(avatar).toMatch(/export function PortraitCredit/);
    expect(avatar).toMatch(/photoSourceUrl/);
    expect(avatar).toMatch(/Wikimedia Commons/);
    // And it must refuse to render an image it cannot attribute.
    expect(avatar).toMatch(/photoLicence && !!photo\.photoSourceUrl/);
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

  // The profile-section exclusion above is conditional on this, exactly as the
  // hub's is. `profile/` holds four files that render a named member's declared
  // entries and none of them cite anything on their own.
  it("the /politicians/[slug] profile carries the citation its sections rely on", () => {
    const profile = readFileSync(
      join(ROOT, "app", "politicians", "[slug]", "page.tsx"),
      "utf8",
    );
    expect(profile).toMatch(/<SourceLine/);
    expect(profile).toMatch(/<CaveatNote/);
    // And the coverage note that carries every absence claim on the page.
    expect(profile).toMatch(/<CoverageNote/);
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

  // The AEC funding files are exempt BY NAME, not by accident. See
  // FUNDING_SURFACES above for why the exemption exists and what it costs.
  const REGISTER_ONLY_FILES = FILES.filter(
    (f) => !FUNDING_SURFACES.some((name) => f.endsWith(name)),
  );

  it("the currency exemption covers exactly the funding layer", () => {
    // A guard on the exemption: a renamed or moved funding file would otherwise
    // silently rejoin the ban (a visible failure) or, worse, a register file
    // could be quietly added to the list. Both lists are pinned.
    expect(FILES.length - REGISTER_ONLY_FILES.length).toBe(FUNDING_SURFACES.length);
  });

  it.each(REGISTER_ONLY_FILES)("%s renders no currency amount for a holding", (file) => {
    const prose = proseOnly(readFileSync(file, "utf8"));
    // A "$" followed by a digit or a formatter in register copy would be a
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
