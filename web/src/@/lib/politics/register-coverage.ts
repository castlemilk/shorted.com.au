/**
 * The Senate coverage gap, in one place, and the rule for what may be indexed.
 *
 * WHY THIS FILE EXISTS. The identity layer now holds every senator — name,
 * chamber, state, party, service, portrait, and in some cases an AEC funding
 * return — while the **Registers of Senators' Interests have not been read into
 * this site at all**. The Senate tables its registers as combined volumes
 * (35 of them, all unfetched), so almost every senator profile carries zero
 * register rows. Rendering that as an empty list under a "Declared interests"
 * heading is an absence claim about a named person, and it is FALSE: they may
 * well have declared a great deal, and we simply have not read the document.
 *
 * THE MEASURED SHAPE, as at the ingest these numbers were counted from: 176
 * people hold a Senate term; 172 of them carry no register row at all, and 4
 * carry rows from HOUSE service (david-smith, sarah-henderson, anne-urquhart,
 * ben-small). The earlier comments here said 171 of 180 and "9 dual-chamber",
 * which were wrong in both directions.
 *
 * NONE OF THOSE NUMBERS APPEARS IN COPY, deliberately. They move with every
 * ingest, a published figure that drifts is a wrong fact rather than a stale
 * one, and every sentence below is true at any of them — the branches are gated
 * on a profile ACTUALLY having no rows, not on a count.
 *
 * So the copy is frozen here, as plain strings, and every surface renders these
 * rather than its own paraphrase. Plain strings and no protobuf import, on
 * purpose: the client islands (the activity explorer, the register table) can
 * import this, which compliance.tsx can never be — it pulls in the generated
 * enum and kills the static build from a "use client" module.
 *
 * WHEN THE SENATE VOLUMES ARE READ, none of this becomes a lie by itself: the
 * senate branches are all gated on a profile ACTUALLY having no register rows,
 * so a senator whose volume has been read stops seeing them without a copy
 * change. The last thing to remove is the hub's chamber-level line, which is
 * the only one that speaks about the corpus rather than about one row.
 */

/**
 * Why a senator's register is empty here. Never "this senator declared
 * nothing" — the two sentences are always rendered together, because the first
 * without the second still reads as a finding about the person.
 */
export const SENATE_REGISTER_UNREAD =
  "The Registers of Senators’ Interests are tabled as combined Senate volumes, and we have not read them into this site yet.";

/** Whose gap it is. This sentence is the whole point of the branch. */
export const SENATE_ABSENCE_IS_OURS =
  "An empty register here is our coverage gap — not a record that this senator declared nothing.";

/**
 * The two sentences as ONE string, because they are never rendered apart.
 *
 * Every surface that speaks about a single senator's empty register renders
 * this: the profile's CoverageNote, the profile's empty declarations section,
 * the link-preview description, and the comparison panel's per-side coverage
 * card. The comparison panel is a client island that cannot import
 * `compliance.tsx` (it pulls the generated protobuf enum in and kills the static
 * build), so before this constant existed the panel had no way to say the same
 * thing and said nothing at all — five zero tiles under "Read in full: the 45th
 * and 48th Parliaments". A shared string is what makes "the same words
 * everywhere" enforceable rather than aspirational.
 */
export const SENATE_REGISTER_GAP = `${SENATE_REGISTER_UNREAD} ${SENATE_ABSENCE_IS_OURS}`;

/**
 * The corpus-level form, for a surface that speaks about the roll rather than
 * about one person (the hub, the activity feed's chamber filter).
 *
 * It says "only where they also served in the House" because that is exactly
 * the shape of the data: a handful of senators are dual-chamber and carry House
 * register rows, so a blanket "senators have no declared interests" would be
 * wrong for them. The clause carries no number, for the reason at the top of
 * this file.
 */
export const SENATE_REGISTER_GAP_CORPUS =
  "The Registers of Senators’ Interests are tabled as combined Senate volumes and have not been read into this site yet, so a senator’s declared interests appear here only where they also served in the House. What is missing is our coverage, not their declarations.";

/**
 * Whether a profile has anything from the register behind it.
 *
 * The counts, not the chamber: a dual-chamber senator with House rows is not in
 * the gap, and a House member whose documents are still unread is — the branch
 * follows the data rather than a label.
 */
export function hasRegisterEntries(counts: {
  declaredListedCount: number;
  declaredPropertyCount: number;
}): boolean {
  return counts.declaredListedCount > 0 || counts.declaredPropertyCount > 0;
}

/** One parliamentary term, reduced to the two fields the coverage split needs. */
export interface CoverageTerm {
  parliament: number;
  /** 'house' | 'senate', as politician_terms records it. */
  chamber: string;
}

/**
 * The parliaments this person sat in the SENATE for.
 *
 * A person is not one chamber. Sarah Henderson was the member for Corangamite
 * in the 44th and 45th and has been a senator for Victoria ever since, so
 * "chamber" on her profile is a label for her CURRENT seat and says nothing
 * about the 44th. Any claim about what we have read has to be made per
 * parliament, against the chamber she actually sat in for it.
 */
export function senateParliaments(terms: readonly CoverageTerm[]): Set<number> {
  return new Set(terms.filter((t) => t.chamber === "senate").map((t) => t.parliament));
}

/**
 * Split a coverage bucket into the parliaments we may speak about and the
 * Senate parliaments we may not.
 *
 * THE BUG THIS EXISTS FOR. The three buckets — extracted / partial / pending —
 * describe the HOUSE register corpus, because that is the only corpus there is.
 * Rendered unfiltered over a dual-chamber member they made a claim about
 * parliaments that member spent in the Senate: Sarah Henderson's profile read
 * "This page covers the 44th, 45th and 48th Parliaments in full", and the 48th
 * is a parliament she has spent entirely in the Senate, whose volumes we have
 * never opened. "In full" there is precisely the absence claim the whole
 * CoverageNote exists to prevent, made by the note itself.
 *
 * So the House parliaments keep the bucket and the Senate ones are removed from
 * it. `senate` is returned rather than discarded because the removal is not
 * silent: the caller renders the Senate gap sentence whenever it is non-empty,
 * so the reader is told the page is quiet about those parliaments and why.
 */
export function splitCoverageByChamber(
  parliaments: readonly number[],
  senateSet: ReadonlySet<number>,
): { house: number[]; senate: number[] } {
  const house: number[] = [];
  const senate: number[] = [];
  for (const parliament of parliaments) {
    (senateSet.has(parliament) ? senate : house).push(parliament);
  }
  return { house, senate };
}

/**
 * Whether a profile may be indexed and listed in the sitemap.
 *
 * REGISTER ROWS ONLY. **AEC funding does NOT flip this**, deliberately: a
 * senator with a lodged return but no register rows is a page whose main
 * heading has nothing under it, and putting that in the index invites a crawler
 * — and a reader arriving from search — onto a page about a named individual
 * that reads as "declared nothing". They stay searchable ON THIS SITE (the
 * Algolia index carries every parliamentarian, `has_interests` false and all,
 * because a reader looking for a senator by name must find them), and they stay
 * reachable from the hub roll. Reconsidering that is a deliberate later call,
 * to be made when either the Senate volumes are read or the funding layer is
 * substantial enough to be the page's subject in its own right.
 */
export function profileIsIndexable(counts: {
  declaredListedCount: number;
  declaredPropertyCount: number;
}): boolean {
  return hasRegisterEntries(counts);
}
