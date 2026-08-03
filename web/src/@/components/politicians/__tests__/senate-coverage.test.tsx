/**
 * The senator coverage gap, pinned.
 *
 * Almost every senator profile carries ZERO register rows, because the
 * Registers of Senators' Interests are tabled as combined volumes and none of
 * them has been read into this site. (Measured at the ingest these tests were
 * written against: 176 people hold a Senate term, 172 carry no register row,
 * and 4 carry House rows. The file's old header said 171 of 180 with 9
 * dual-chamber; both figures were wrong, and no assertion below depends on
 * either — a count that drifts with every ingest is not a thing to test.)
 *
 * Every surface that can render one of those profiles has to say so. This file
 * is the copy-lock and the posture-lock for that:
 *
 *   1. CoverageNote's senate branch renders, and NEVER returns null for a
 *      senator with no rows — including when House coverage is complete, which
 *      is exactly the case the old early-return silently swallowed.
 *   2. It does not print the House parliament sentences over a senator, which
 *      would turn our gap into "declared nothing across three parliaments".
 *   3. The claim is made PER PARLIAMENT against the chamber that parliament was
 *      served in, so a dual-chamber member's Senate parliaments never appear in
 *      a "read in full" sentence.
 *   4. A senator with AEC funding but no register rows is SEARCHABLE here,
 *      NOINDEXED, and ABSENT FROM THE SITEMAP — one coherent posture, and
 *      funding deliberately does not flip indexability.
 *
 * Assertions are on SUBSTANCE, not phrasing, wherever a rewording would still
 * be true: the exception is the two sentences that carry the absence claim,
 * where the wording is the safeguard.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { render, screen } from "@testing-library/react";

import { CoverageNote } from "@/components/politicians/compliance";
import {
  SENATE_ABSENCE_IS_OURS,
  SENATE_REGISTER_GAP,
  SENATE_REGISTER_GAP_CORPUS,
  SENATE_REGISTER_UNREAD,
  hasRegisterEntries,
  profileIsIndexable,
  senateParliaments,
  splitCoverageByChamber,
} from "@/lib/politics/register-coverage";

/** `web/src` — this file sits at `src/@/components/politicians/__tests__`. */
const ROOT = join(__dirname, "..", "..", "..", "..");

/** A senator whose only content is a lodged AEC return. */
const FUNDING_ONLY_SENATOR = {
  slug: "pauline-hanson",
  chamber: "senate",
  declaredListedCount: 0,
  declaredPropertyCount: 0,
};

/** A dual-chamber senator who DOES carry House register rows. */
const DUAL_CHAMBER_SENATOR = {
  slug: "barnaby-joyce",
  chamber: "senate",
  declaredListedCount: 3,
  declaredPropertyCount: 1,
};

describe("CoverageNote — the senate branch", () => {
  it("states the volumes are unread and that the gap is ours", () => {
    render(
      <CoverageNote
        extracted={[46, 47, 48]}
        partial={[]}
        pending={[44, 45]}
        chamber="senate"
        hasRegisterEntries={false}
      />,
    );
    // Both halves. The first without the second still reads as a finding.
    expect(screen.getByText(new RegExp(escape(SENATE_REGISTER_UNREAD)))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(escape(SENATE_ABSENCE_IS_OURS)))).toBeInTheDocument();
  });

  it("does not print the House parliament sentences over a senator", () => {
    const { container } = render(
      <CoverageNote
        extracted={[46, 47, 48]}
        partial={[]}
        pending={[]}
        chamber="senate"
        hasRegisterEntries={false}
      />,
    );
    // "This page covers the 46th, 47th and 48th Parliaments in full" describes
    // the HOUSE corpus. Over an empty senator page it is the exact sentence
    // that converts our gap into an absence claim.
    expect(container.textContent).not.toMatch(/covers the/i);
    expect(container.textContent).not.toMatch(/in full/i);
  });

  it("renders even when House coverage is complete and nothing is pending", () => {
    // The old early-return: no partial, no pending, so the note vanished — and
    // a senator's empty page lost its only explanation.
    const { container } = render(
      <CoverageNote
        extracted={[46, 47, 48]}
        partial={[]}
        pending={[]}
        chamber="senate"
        hasRegisterEntries={false}
      />,
    );
    expect(container.textContent?.trim()).not.toHaveLength(0);
    expect(container.textContent).toContain("we have not read into this site yet");
  });

  /*
   * THE DUAL-CHAMBER CARVE-OUT.
   *
   * This test used to assert the opposite — that a senator WITH House rows got
   * the ordinary note, whole — and that assertion enshrined the bug. Sarah
   * Henderson is the named case: member for Corangamite in the 44th and 45th,
   * senator for Victoria in the 46th, 47th and 48th, 142 register rows, all of
   * them from the House. She took the "has rows" path and her profile read
   * "This page covers the 44th, 45th and 48th Parliaments in full" — the 48th
   * being a parliament she has spent entirely in the Senate, whose volumes we
   * have never opened. That is the exact absence claim this component exists to
   * prevent, made by the component itself.
   */
  const HENDERSON_TERMS = [
    { parliament: 44, chamber: "house" },
    { parliament: 45, chamber: "house" },
    { parliament: 46, chamber: "senate" },
    { parliament: 47, chamber: "senate" },
    { parliament: 48, chamber: "senate" },
  ];

  it("keeps a dual-chamber member's HOUSE parliaments in the coverage sentence", () => {
    const { container } = render(
      <CoverageNote
        extracted={[44, 45, 48]}
        partial={[]}
        pending={[]}
        chamber="senate"
        hasRegisterEntries
        terms={HENDERSON_TERMS}
      />,
    );
    // Her House parliaments ARE read in full, and saying so is true.
    expect(container.textContent).toMatch(/covers the/i);
    expect(container.textContent).toContain("44th and 45th");
  });

  it("never claims a parliament the member spent in the Senate", () => {
    const { container } = render(
      <CoverageNote
        extracted={[44, 45, 48]}
        partial={[]}
        pending={[]}
        chamber="senate"
        hasRegisterEntries
        terms={HENDERSON_TERMS}
      />,
    );
    // The 48th must not appear in the "in full" list at all.
    const inFull = container.textContent?.slice(
      0,
      container.textContent.indexOf("in full"),
    );
    expect(inFull).not.toContain("48th");
  });

  it("says WHY those parliaments left the sentence, rather than quietly shrinking it", () => {
    const { container } = render(
      <CoverageNote
        extracted={[44, 45, 48]}
        partial={[]}
        pending={[]}
        chamber="senate"
        hasRegisterEntries
        terms={HENDERSON_TERMS}
      />,
    );
    // A narrower claim with no explanation reads as a smaller corpus. The
    // Senate sentence is what makes the removal legible.
    expect(container.textContent).toContain(SENATE_REGISTER_UNREAD);
    expect(container.textContent).toContain(SENATE_ABSENCE_IS_OURS);
  });

  it("leaves a member with no Senate terms exactly as it was", () => {
    const { container } = render(
      <CoverageNote
        extracted={[46, 47]}
        partial={[]}
        pending={[44, 45]}
        chamber="house"
        hasRegisterEntries
        terms={[
          { parliament: 46, chamber: "house" },
          { parliament: 47, chamber: "house" },
        ]}
      />,
    );
    expect(container.textContent).toMatch(/covers the/i);
    expect(container.textContent).not.toContain(SENATE_REGISTER_UNREAD);
  });

  it("is unchanged for the House", () => {
    const { container } = render(
      <CoverageNote extracted={[46, 47, 48]} partial={[]} pending={[44, 45]} chamber="house" />,
    );
    expect(container.textContent).toMatch(/covers the/i);
    expect(container.textContent).toMatch(/have not been extracted yet/i);
    expect(container.textContent).not.toContain(SENATE_REGISTER_UNREAD);
  });

  it("still renders nothing when there is no gap at all", () => {
    // A caveat that is always present stops being read.
    const { container } = render(<CoverageNote extracted={[]} partial={[]} pending={[]} />);
    expect(container.textContent).toBe("");
  });
});

describe("the senate copy itself", () => {
  it("never says the senator declared nothing", () => {
    for (const copy of [
      SENATE_REGISTER_UNREAD,
      SENATE_ABSENCE_IS_OURS,
      SENATE_REGISTER_GAP_CORPUS,
    ]) {
      expect(copy).not.toMatch(/declared nothing(?!\.)|has no interests|holds nothing/i);
      // Rule 3's vocabulary, on strings that sit beside a named person.
      expect(copy).not.toMatch(/\b(hiding|concealed|failed to|undisclosed|secret)\b/i);
    }
  });

  it("attributes the absence to us, in every form", () => {
    expect(SENATE_ABSENCE_IS_OURS).toMatch(/our coverage/i);
    expect(SENATE_REGISTER_GAP_CORPUS).toMatch(/our coverage/i);
  });

  it("says the partial-coverage case out loud in the corpus form", () => {
    // The recent Senate volumes are read; the older, scanned ones are not. The
    // corpus form must say BOTH halves — claiming the registers wholesale
    // would over-promise, and claiming them unread would deny senators the
    // rows they now have.
    expect(SENATE_REGISTER_GAP_CORPUS).toMatch(/read the recent volumes/i);
    expect(SENATE_REGISTER_GAP_CORPUS).toMatch(/not read yet/i);
    expect(SENATE_REGISTER_GAP_CORPUS).toMatch(/incomplete/i);
  });

  it("carries no count, in any form", () => {
    // Every one of these numbers moves with every ingest, and a published
    // figure that drifts is a wrong fact rather than a stale one. The branches
    // are gated on a profile ACTUALLY having no rows, never on a count, so no
    // sentence needs one.
    for (const copy of [
      SENATE_REGISTER_UNREAD,
      SENATE_ABSENCE_IS_OURS,
      SENATE_REGISTER_GAP,
      SENATE_REGISTER_GAP_CORPUS,
    ]) {
      expect(copy).not.toMatch(/\b\d+\b/);
    }
  });

  it("is ONE string, so every surface says the same words", () => {
    // The comparison panel cannot import compliance.tsx (protobuf in a client
    // island kills the static build), so the words are shared instead of the
    // component. If these ever drift apart, one of two surfaces is paraphrasing
    // an absence claim.
    expect(SENATE_REGISTER_GAP).toBe(`${SENATE_REGISTER_UNREAD} ${SENATE_ABSENCE_IS_OURS}`);

    const panel = readFileSync(
      join(ROOT, "app", "politicians", "compare", "compare-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain("SENATE_REGISTER_GAP");
    // And it must not have grown its own paraphrase beside the shared one.
    expect(panel).not.toMatch(/tabled as combined Senate volumes/);
  });

  it("is rendered inside the hub's register table, not only above it", () => {
    // The hub's own paragraph sits hundreds of pixels above a table the reader
    // scrolls, sorts and re-filters, and it is server-rendered — so it cannot
    // change when the island re-renders under a Senate filter, which is exactly
    // when 173 all-zero named rows appear.
    const table = readFileSync(
      join(ROOT, "@", "components", "politicians", "politician-register-table.tsx"),
      "utf8",
    );
    expect(table).toContain("SENATE_REGISTER_GAP_CORPUS");
    expect(table).toMatch(/query\.chamber !== "house"/);
  });
});

describe("a senator with funding but no register rows", () => {
  it("is not indexable, and funding does not flip that", () => {
    expect(hasRegisterEntries(FUNDING_ONLY_SENATOR)).toBe(false);
    expect(profileIsIndexable(FUNDING_ONLY_SENATOR)).toBe(false);
    // The predicate takes ONLY the register counts — there is no funding input
    // it could be made to read by accident.
    expect(profileIsIndexable({ declaredListedCount: 0, declaredPropertyCount: 1 })).toBe(true);
    expect(profileIsIndexable(DUAL_CHAMBER_SENATOR)).toBe(true);
  });

  it("is kept out of the sitemap by that same predicate", () => {
    // The sitemap filters `hasInterests`, and getPoliticianSlugs maps it
    // through profileIsIndexable — one predicate, so the robots tag on the page
    // and the sitemap entry can never disagree.
    const sitemap = readFileSync(join(ROOT, "app", "sitemap.ts"), "utf8");
    expect(sitemap).toMatch(/\.filter\(\(s\) => s\.hasInterests\)/);

    const action = readFileSync(join(ROOT, "app", "actions", "getPoliticians.ts"), "utf8");
    expect(action).toMatch(/hasInterests:\s*profileIsIndexable\(p\)/);
  });

  it("is noindexed on its own page by that same predicate", () => {
    const profile = readFileSync(join(ROOT, "app", "politicians", "[slug]", "page.tsx"), "utf8");
    expect(profile).toMatch(/const indexable = profileIsIndexable\(p\)/);
    expect(profile).toMatch(/robots: indexable \? undefined : \{ index: false, follow: true \}/);
  });

  it("stays searchable: nothing filters the index by has_interests", () => {
    // The Algolia index carries every parliamentarian, has_interests false and
    // all — a reader looking for a senator by name must find them. The facet
    // groups are the only filters the explorer applies, and has_interests is
    // not among them.
    const explorer = readFileSync(
      join(ROOT, "@", "components", "politicians", "politician-explorer.tsx"),
      "utf8",
    );
    const groups = explorer.slice(
      explorer.indexOf("FACET_GROUPS"),
      explorer.indexOf("FACET_GROUPS") + 600,
    );
    expect(groups).not.toContain("has_interests");
    expect(explorer).not.toMatch(/filters:\s*["'`]has_interests/);
  });

  it("says WHICH gap it is in a search hit", () => {
    const explorer = readFileSync(
      join(ROOT, "@", "components", "politicians", "politician-explorer.tsx"),
      "utf8",
    );
    // "nothing matched yet in the documents read" claims we read their
    // document. For a senator we have read none.
    expect(explorer).toContain("Senate register not read yet");
  });
});

/** Escape a frozen sentence for use as a RegExp. */
function escape(copy: string): string {
  return copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*
 * The split itself, tested directly. The component tests above prove the
 * rendering; these prove the rule, including the case a fixture would not
 * naturally produce.
 */
describe("splitCoverageByChamber", () => {
  it("keeps House parliaments and removes Senate ones", () => {
    const senate = senateParliaments([
      { parliament: 44, chamber: "house" },
      { parliament: 46, chamber: "senate" },
      { parliament: 48, chamber: "senate" },
    ]);
    expect(splitCoverageByChamber([44, 46, 48], senate)).toEqual({
      house: [44],
      senate: [46, 48],
    });
  });

  it("is a no-op for a member with no Senate service", () => {
    const senate = senateParliaments([
      { parliament: 46, chamber: "house" },
      { parliament: 47, chamber: "house" },
    ]);
    expect(splitCoverageByChamber([46, 47], senate)).toEqual({ house: [46, 47], senate: [] });
  });

  it("counts a parliament served in BOTH chambers as a Senate one", () => {
    // A mid-parliament transfer. The register volume for that parliament is
    // still half unread, so "in full" is not available for it either way, and
    // the safe reading is the one that withholds the claim.
    const senate = senateParliaments([
      { parliament: 45, chamber: "house" },
      { parliament: 45, chamber: "senate" },
    ]);
    expect(splitCoverageByChamber([45], senate)).toEqual({ house: [], senate: [45] });
  });
});
