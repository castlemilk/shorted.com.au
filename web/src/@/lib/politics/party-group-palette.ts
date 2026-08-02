/**
 * Colours for the AEC's PARTY GROUP key.
 *
 * A different key space from `party-palette.ts`, which maps AEC candidate
 * ABBREVIATIONS ("ALP", "GRN") as they appear on the electoral roll. The funding
 * returns carry no abbreviation: `mv_aec_party_funding` is keyed by the source's
 * own `Party Group` string, verbatim — "Australian Labor Party", "Liberal",
 * "Country Liberal Party (NT)", "Katter's Australian Party (KAP)". Mapping one
 * onto the other by hand is the only option, and it is a mapping of COLOUR ONLY:
 * the label rendered on screen is always the group's own string.
 *
 * WHY NOT DERIVE THE LABEL. The group key is what the party lodged under, and
 * two groups this file colours identically ("Liberal" and "Liberal National
 * Party" in the years both lodged) are separate rollups in the data. Renaming
 * either on screen would merge two lodgers into one name and put a figure under
 * a party that did not lodge it.
 *
 * An unmapped group gets the neutral grey, exactly as an unmapped abbreviation
 * does. Hundreds of micro-parties lodge returns and no palette will ever cover
 * them; grey is a correct answer, not a gap.
 */

import { PARTY_COLORS, PARTY_OTHER_COLOR } from "./party-palette";

/**
 * Party group key -> the palette label whose colour it borrows.
 *
 * Keys are matched case-insensitively after trimming, because the source's
 * whitespace is not reliable, but they are never fuzzy-matched: a party group
 * this file does not list is grey rather than guessed onto a neighbour.
 */
const GROUP_TO_PALETTE: Record<string, string> = {
  "australian labor party": "Labor",
  labor: "Labor",
  liberal: "Liberal",
  "liberal party of australia": "Liberal",
  "liberal national party": "Liberal National",
  "liberal national party of queensland": "Liberal National",
  "country liberal party (nt)": "Country Liberal",
  "country liberal party": "Country Liberal",
  "the nationals": "Nationals",
  "national party": "Nationals",
  "the greens": "Greens",
  greens: "Greens",
  "one nation": "One Nation",
  "pauline hanson's one nation": "One Nation",
  "katter's australian party (kap)": "Katter's",
  "katter's australian party": "Katter's",
  "centre alliance": "Centre Alliance",
  "nick xenophon team": "Nick Xenophon Team",
  "jacqui lambie network": "Jacqui Lambie Network",
  "united australia party": "United Australia",
  "palmer united party": "Palmer United",
  "liberal democratic party": "Liberal Democrats",
  "libertarian party": "Liberal Democrats",
  "animal justice party": "Animal Justice",
  "shooters, fishers and farmers party": "Shooters, Fishers and Farmers",
  "australian conservatives": "Australian Conservatives",
  "family first party australia": "Family First",
  "family first party": "Family First",
  "democratic labour party": "Democratic Labour",
};

/**
 * The colour for a party group key.
 *
 * Independents lodge under their own name ("David Pocock"), which no palette
 * entry covers — they land on the neutral grey, which is the same answer the
 * register surfaces give an unmapped party and carries no meaning of its own.
 */
export function partyGroupColor(partyGroup: string | undefined | null): string {
  const key = (partyGroup ?? "").trim().toLowerCase();
  if (!key) return PARTY_OTHER_COLOR;
  const label = GROUP_TO_PALETTE[key];
  if (!label) return PARTY_OTHER_COLOR;
  return PARTY_COLORS[label] ?? PARTY_OTHER_COLOR;
}

/**
 * The label for a party group: the group's OWN string, trimmed.
 *
 * Deliberately not a lookup. See the file header — the group key is what the
 * party lodged under, and substituting a friendlier name would attribute a
 * return to a party that did not file it.
 */
export function partyGroupLabel(partyGroup: string | undefined | null): string {
  return (partyGroup ?? "").trim();
}
