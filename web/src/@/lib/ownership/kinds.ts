/**
 * Ownership vocabulary: the institution kinds the API reports
 * (services/jobs/internal/jobs/ownership/registry.go decides them, once, by
 * hand) and how a page names, orders and colours them.
 *
 * Colours are the warm chart palette, never market red or green: a kind is a
 * category, not a direction (DESIGN.md, The Semantic Quarantine Rule).
 */

import { formatPct } from "~/@/lib/fundamentals/format";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";

export type OwnershipKind =
  | "super_fund"
  | "index_manager"
  | "hedge_fund"
  | "active_manager"
  | "bank_broker"
  | "sovereign_public"
  | "insurer"
  | "private_equity"
  | "corporate"
  | "other"
  | "unclassified";

interface KindInfo {
  label: string;
  plural: string;
  /**
   * The name a chart's small labels take (a sankey node): at most twelve characters,
   * so a gutter sized from it holds it on one line. The full label stays in the title.
   */
  short: string;
  /** One line on what the kind's substantial holdings usually are. */
  note: string;
  /**
   * Tailwind background for a bar segment or a swatch: the light hex, then the dark one. A kind's
   * colour stays categorical, but it is capped below the amber selection in both themes: every
   * kind's HSL chroma is at most 0.45, under the amber's (0.56 light, 0.70 dark), and no warm kind
   * sits within 20 degrees of the amber's hue (28 to 32) unless its chroma is at most 0.30.
   * kind-chroma.test.ts holds the cap and prints the table.
   */
  swatch: string;
  /**
   * The same two hexes as SVG fill classes, for a mark a chart draws (the sankey's kind edge). A
   * bg- class paints a box, never an SVG shape. kinds.test.ts keeps it equal to the swatch.
   */
  fill: string;
}

export const KIND_INFO: Readonly<Record<OwnershipKind, KindInfo>> = {
  // Each swatch's HSL is noted beside it: the light hex, then the dark one.
  super_fund: {
    label: "Super fund",
    plural: "Super funds",
    short: "Super",
    note: "APRA-regulated superannuation trustees investing members' retirement savings.",
    // light hsl(93 26% 54%); dark hsl(93 18% 48%)
    swatch: "bg-[#87A96B] dark:bg-[#789064]",
    fill: "fill-[#87A96B] dark:fill-[#789064]",
  },
  index_manager: {
    label: "Index manager",
    plural: "Index managers",
    short: "Index",
    note: "Managers whose assets are mostly index funds and ETFs; their stakes track index weights.",
    // light hsl(38 36% 64%); dark hsl(46 32% 46%), spread by lightness from the other dark kinds
    swatch: "bg-[#C4AC82] dark:bg-[#9B8950]",
    fill: "fill-[#C4AC82] dark:fill-[#9B8950]",
  },
  hedge_fund: {
    label: "Hedge fund",
    plural: "Hedge funds",
    short: "Hedge",
    note: "Long/short, event-driven and absolute-return managers.",
    // light hsl(15 30% 54%); dark hsl(15 32% 56%)
    swatch: "bg-[#AD7867] dark:bg-[#B37D6B]",
    fill: "fill-[#AD7867] dark:fill-[#B37D6B]",
  },
  active_manager: {
    label: "Active manager",
    plural: "Active managers",
    short: "Active",
    note: "Long-only active managers and listed investment companies.",
    // A mustard, not the amber: its hue sits outside the amber's band. light hsl(54 40% 50%); dark hsl(54 45% 62%)
    swatch: "bg-[#B3A84D] dark:bg-[#CAC172]",
    fill: "fill-[#B3A84D] dark:fill-[#CAC172]",
  },
  bank_broker: {
    label: "Bank or broker",
    plural: "Banks and brokers",
    short: "Bank/broker",
    note: "Often securities lending: shares lent to, or held as collateral from, short sellers.",
    // light hsl(20 12% 40%); dark hsl(18 10% 46%), white ink in both (monogramInkClass)
    swatch: "bg-[#72625A] dark:bg-[#81716A]",
    fill: "fill-[#72625A] dark:fill-[#81716A]",
  },
  sovereign_public: {
    label: "Sovereign or public fund",
    plural: "Sovereign and public funds",
    short: "Sovereign",
    note: "Sovereign wealth funds and public-sector investors.",
    // light hsl(97 33% 63%); dark hsl(98 14% 56%)
    swatch: "bg-[#9AC082] dark:bg-[#8B9F7F]",
    fill: "fill-[#9AC082] dark:fill-[#8B9F7F]",
  },
  insurer: {
    label: "Insurer",
    plural: "Insurers",
    short: "Insurer",
    note: "Life insurers.",
    // light hsl(48 20% 55%); dark hsl(51 15% 72%), the palest dark kind so it stays apart from the khaki group
    swatch: "bg-[#A39A75] dark:bg-[#C2BFAD]",
    fill: "fill-[#A39A75] dark:fill-[#C2BFAD]",
  },
  private_equity: {
    label: "Private equity",
    plural: "Private equity",
    short: "PE",
    note: "Private equity and infrastructure investors, often building a takeover stake.",
    // light hsl(25 30% 38%), white ink; dark hsl(28 30% 52%)
    swatch: "bg-[#7E5C44] dark:bg-[#A98260]",
    fill: "fill-[#7E5C44] dark:fill-[#A98260]",
  },
  corporate: {
    label: "Listed company",
    plural: "Listed companies",
    short: "Listed co",
    note: "Another ASX company: a strategic stake, a takeover bidder or a parent.",
    // light hsl(19 18% 24%), white ink; dark hsl(19 8% 61%), a warm grey apart from the khaki group
    swatch: "bg-[#483932] dark:bg-[#A49994]",
    fill: "fill-[#483932] dark:fill-[#A49994]",
  },
  other: {
    label: "Other",
    plural: "Other",
    short: "Other",
    note: "Institutions outside the categories above.",
    // light hsl(48 53% 81%); dark hsl(52 33% 68%): never the dark foreground's own sand, which reads as ink
    swatch: "bg-[#E8DEB5] dark:bg-[#C8C193]",
    fill: "fill-[#E8DEB5] dark:fill-[#C8C193]",
  },
  unclassified: {
    label: "Unclassified",
    plural: "Unclassified holders",
    short: "Unclassified",
    note: "Holders not on the curated map: families, founders, private companies, smaller managers.",
    // light hsl(33 15% 88%); dark hsl(48 20% 55%), the muted foreground
    swatch: "bg-[#E5E1DC] dark:bg-[#A39A75]",
    fill: "fill-[#E5E1DC] dark:fill-[#A39A75]",
  },
};

/**
 * A kind's name in a toolbar select (spec 14.9): short enough that the row holds its selects on one
 * line at 1440. The full names stay in the legend, the inspector and the page's prose.
 */
const KIND_SELECT_LABELS: Readonly<Record<OwnershipKind, string>> = {
  super_fund: "Super funds",
  index_manager: "Index managers",
  active_manager: "Active managers",
  hedge_fund: "Hedge funds",
  bank_broker: "Banks, brokers",
  sovereign_public: "Sovereign",
  insurer: "Insurers",
  private_equity: "Private equity",
  corporate: "Companies",
  other: "Other",
  unclassified: "Unclassified",
};

export function kindSelectLabel(kind: string): string {
  return KIND_SELECT_LABELS[kind as OwnershipKind] ?? KIND_SELECT_LABELS.unclassified;
}

/** Display order: who invests for others first, then strategic holders. */
export const KIND_ORDER: readonly OwnershipKind[] = [
  "super_fund",
  "index_manager",
  "active_manager",
  "hedge_fund",
  "bank_broker",
  "sovereign_public",
  "insurer",
  "private_equity",
  "corporate",
  "other",
  "unclassified",
];

/**
 * The investors a crowded register counts: what super funds, index and active
 * managers, hedge funds, sovereign funds and insurers disclose. Banks and
 * brokers are left out, because their notices are often securities lending.
 */
export const INVESTOR_KINDS: ReadonlySet<string> = new Set<string>([
  "super_fund",
  "index_manager",
  "active_manager",
  "hedge_fund",
  "sovereign_public",
  "insurer",
]);

export function kindInfo(kind: string): KindInfo {
  return KIND_INFO[kind as OwnershipKind] ?? KIND_INFO.unclassified;
}

/**
 * A kind's short name for a chart's small labels (spec B6). An unknown kind reads
 * "Unclassified", as kindInfo does; the own-property check keeps a name such as
 * "constructor" from reaching Object's members.
 */
export function kindShortLabel(kind: string): string {
  return Object.prototype.hasOwnProperty.call(KIND_INFO, kind)
    ? KIND_INFO[kind as OwnershipKind].short
    : KIND_INFO.unclassified.short;
}

export function kindRank(kind: string): number {
  const i = KIND_ORDER.indexOf(kind as OwnershipKind);
  return i < 0 ? KIND_ORDER.length : i;
}

/** What a notice's form says happened. */
export function formLabel(form: string, ceased: boolean): string {
  if (ceased || form === "605") return "Ceased";
  if (form === "603") return "Became substantial";
  if (form === "604") return "Changed";
  if (form === "nz") return "NZ disclosure";
  return form;
}

/**
 * A voting power as the notice states it: notices write 5.045% and 5.2988%,
 * so up to four decimals are kept (trailing zeros dropped), at least two.
 */
export function formatVotingPower(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "n/a";
  const [whole, frac = ""] = pct.toFixed(4).split(".");
  const trimmed = frac.replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${trimmed}%`;
}

/**
 * A headline figure or a sum of voting powers: two decimals, so the rail reads
 * "19.43%" where the notice states 19.4336%. A measured zero prints "0.00%"; a
 * figure the page does not hold is "n/a", never 0 (spec A4). This is the rule of
 * formatSum in ownership-parts.tsx, defined here because a lib cannot import a
 * component module; the two must stay the same. A single notice's figure, in a
 * list of notices or a register row, keeps formatVotingPower.
 */
export function formatHeadlinePct(pct: number | null | undefined): string {
  return formatPct(pct, { digits: 2 });
}

/**
 * A holding's weight in its fund. Super funds' disclosures state weights to
 * two decimals, so a small holding of real value is stated as 0.00: that is
 * "<0.01%", never a holding of nothing.
 */
export function formatFundWeight(
  pct: number | null | undefined,
  hasWeight: boolean,
  valueAud: number | null | undefined,
): string {
  if (!hasWeight || pct == null || !Number.isFinite(pct)) return "n/a";
  if (pct < 0.005 && valueAud != null && valueAud > 0) return "<0.01%";
  return `${pct.toFixed(2)}%`;
}

/** A change in percentage points with a true minus: "+1.14 pp", "−0.31 pp". */
export function formatPointChange(from: number, to: number): string {
  const d = to - from;
  if (Math.abs(d) < 0.005) return "0.00 pp";
  return `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(2)} pp`;
}

/** The URL of an institution's page; holders off the map have none. */
export function institutionHref(slug: string | null | undefined): string | null {
  return slug ? `/ownership/${slug}` : null;
}

const INSTITUTION_SLUG = /^[a-z0-9-]{2,64}$/;

/** Ownership paths that are not institutions. A slug that took one would shadow its page. */
export const RESERVED_SLUGS: readonly string[] = ["stocks", "notices", "insights"];

/** Whether a path segment can be a registry slug, checked before any read. */
export function isInstitutionSlug(slug: string): boolean {
  return INSTITUTION_SLUG.test(slug) && !RESERVED_SLUGS.includes(slug);
}

const LISTED_HOLDER = /^asx:([A-Z0-9]{2,6})$/;

/**
 * Where a holder's name links: its institution page when it has one, or its
 * own stock page when the holder is a listed company (key `asx:CODE`). Null
 * for a holder off the map.
 */
export function holderHref(slug: string | null | undefined, holderKey?: string): string | null {
  const listed = holderKey ? LISTED_HOLDER.exec(holderKey)?.[1] : undefined;
  return institutionHref(slug) ?? (listed ? stockTabHref(listed, "company") : null);
}

/**
 * A fund's page, keyed by the API's fund key (spec 14.7): the key is one path
 * segment, encoded, so a super option's slash and spaces survive the route.
 * Every inspector, page, link and the sitemap builds its fund URL here.
 */
export function fundHref(key: string): string {
  return `/ownership/funds/${encodeURIComponent(key)}`;
}

/** A stock's ASX code as the register path takes it. */
export const REGISTER_CODE_PATTERN = /^[A-Z0-9]{1,6}$/;

/**
 * A stock's register page. Every stock link on an ownership surface points
 * here; a listed holder's own name stays with its Company tab (holderHref).
 */
export function registerHref(code: string): string {
  return `/ownership/stocks/${code.toUpperCase()}`;
}

/** A fund's name with its ASX code in front, unless the name already carries it. */
export function fundCodeAndName(code: string | null | undefined, name: string): string {
  if (!code || name.includes(`(${code})`) || name.startsWith(`${code} `)) return name;
  return `${code}, ${name}`;
}

/**
 * Vanguard's index fund files cover the pooled wholesale fund behind each ETF,
 * not the ETF alone, so their rows carry the P mark.
 */
export function isPooledFile(f: { sourceKind: string; institutionSlug: string }): boolean {
  return f.sourceKind === "etf" && f.institutionSlug === "vanguard";
}

/**
 * Why a document was withheld. The first six are withholding outcomes: a
 * substantial holding notice whose figure we could not read unambiguously, so
 * the register shows nothing for it. The last two are not withheld at all: a
 * document that is not a holding form, or one not downloaded yet. They are
 * reported apart, never as withheld notices.
 */
export const WITHHOLDING_OUTCOMES: readonly string[] = [
  "no_text",
  "no_voting_power",
  "implausible",
  "ambiguous_target",
  "no_holder",
  "inconsistent_votes",
];

/** What each outcome says on the page. An outcome not listed here prints its raw name. */
export const OUTCOME_COPY: Readonly<Record<string, string>> = {
  no_text: "no text layer (a scan)",
  no_voting_power: "voting power not stated, or only in an annexure",
  implausible: "figures that do not reconcile",
  ambiguous_target: "company not identified",
  no_holder: "holder not named",
  inconsistent_votes: "votes do not fit the share count",
  not_a_notice: "not a substantial holding form",
  fetch_error: "not yet downloaded (retried)",
};

/**
 * A source's dating: one date when its files share it, else the span they
 * cover. "n/a" only when no date is known, never a blank.
 */
export function asAtRange(from: string, to: string): string {
  const dates = [from, to].filter((d) => d !== "").sort();
  const first = dates[0];
  const last = dates.at(-1);
  if (first === undefined || last === undefined) return "as at n/a";
  return first === last ? `as at ${first}` : `as at ${first} to ${last}`;
}

/**
 * A GICS industry group's short name for a chart's small labels (spec 14.9): a
 * map band, a sankey node, a heatmap row, a fund column, an inspector line. The
 * full name stays in the element's title. Keys are lower-case, as the API names
 * them, and so are the placeholder industries (which read as "Other").
 */
const SHORT_SECTORS: Readonly<Record<string, string>> = {
  "equity real estate investment trusts (reits)": "REITs",
  "real estate investment trusts (reits)": "REITs",
  "health care equipment & services": "Health care",
  healthcare: "Health care",
  "pharmaceuticals, biotechnology & life sciences": "Pharma & biotech",
  "consumer discretionary distribution & retail": "Discretionary retail",
  retail: "Discretionary retail",
  "consumer staples distribution & retail": "Staples retail",
  "commercial & professional services": "Professional services",
  "technology hardware & equipment": "Tech hardware",
  "semiconductors & semiconductor equipment": "Semiconductors",
  "real estate management & development": "Real estate",
  property: "Real estate",
  "telecommunication services": "Telecoms",
  telecom: "Telecoms",
  "household & personal products": "Household products",
  "consumer durables & apparel": "Durables & apparel",
  "automobiles & components": "Automobiles",
  "food, beverage & tobacco": "Food & beverage",
  "food & bev": "Food & beverage",
  "media & entertainment": "Media",
  "software & services": "Software",
  software: "Software",
  technology: "Software",
  "financial services": "Financial services",
  "diversified financials": "Financial services",
  "capital goods": "Capital goods",
  industrials: "Capital goods",
  "consumer services": "Consumer services",
  materials: "Materials",
  mining: "Materials",
  energy: "Energy",
  banks: "Banks",
  insurance: "Insurance",
  utilities: "Utilities",
  transportation: "Transportation",
  other: "Other",
};

/** The fold's bucket for every sector past the six largest (spec 14.9). */
export const FOLDED_SECTOR_LABEL = "Other sectors";

/**
 * The short name of an industry. A placeholder or an empty industry is "Other";
 * a name the table does not know is returned as the API states it, never cut.
 */
export function shortSector(industry: string | null | undefined): string {
  const name = industryLabel(industry).trim();
  if (name === "") return "Other";
  return SHORT_SECTORS[name.toLowerCase()] ?? name;
}
