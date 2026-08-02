/**
 * The Senate coverage gap, in one place, and the rule for what may be indexed.
 *
 * WHY THIS FILE EXISTS. The identity layer now holds every senator — name,
 * chamber, state, party, service, portrait, and in some cases an AEC funding
 * return — while the **Registers of Senators' Interests have not been read into
 * this site at all**. The Senate tables its registers as combined volumes
 * (35 of them, all unfetched), so 171 senator profiles carry zero register
 * rows. Rendering that as an empty list under a "Declared interests" heading is
 * an absence claim about a named person, and it is FALSE: they may well have
 * declared a great deal, and we simply have not read the document.
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
 * The corpus-level form, for a surface that speaks about the roll rather than
 * about one person (the hub, the activity feed's chamber filter).
 *
 * It says "unless they also served in the House" because that is exactly the
 * shape of the data: 9 of the 180 senators are dual-chamber and carry House
 * register rows, so a blanket "senators have no declared interests" would be
 * wrong for them.
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
