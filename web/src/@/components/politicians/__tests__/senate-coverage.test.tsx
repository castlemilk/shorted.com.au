/**
 * The senator coverage gap, pinned.
 *
 * 171 senator profiles carry ZERO register rows, because the Registers of
 * Senators' Interests are tabled as combined volumes and none of them has been
 * read into this site. Every surface that can render one of those profiles has
 * to say so. This file is the copy-lock and the posture-lock for that:
 *
 *   1. CoverageNote's senate branch renders, and NEVER returns null for a
 *      senator with no rows — including when House coverage is complete, which
 *      is exactly the case the old early-return silently swallowed.
 *   2. It does not print the House parliament sentences over a senator, which
 *      would turn our gap into "declared nothing across three parliaments".
 *   3. A senator with AEC funding but no register rows is SEARCHABLE here,
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
  SENATE_REGISTER_GAP_CORPUS,
  SENATE_REGISTER_UNREAD,
  hasRegisterEntries,
  profileIsIndexable,
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
    expect(container.textContent).toContain("not read them into this site yet");
  });

  it("leaves a dual-chamber senator with House rows on the ordinary note", () => {
    const { container } = render(
      <CoverageNote
        extracted={[46, 47]}
        partial={[]}
        pending={[44, 45]}
        chamber="senate"
        hasRegisterEntries
      />,
    );
    // The branch follows the DATA, not the chamber label: this senator has rows
    // and the parliament sentences are true of them.
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

  it("says the dual-chamber case out loud in the corpus form", () => {
    // 9 of the 180 senators carry House register rows, so a blanket "senators
    // have no declared interests here" would be wrong for them.
    expect(SENATE_REGISTER_GAP_CORPUS).toMatch(/served in the House/i);
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
