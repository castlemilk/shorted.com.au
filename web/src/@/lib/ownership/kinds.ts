/**
 * Ownership vocabulary: the institution kinds the API reports
 * (services/jobs/internal/jobs/ownership/registry.go decides them, once, by
 * hand) and how a page names, orders and colours them.
 *
 * Colours are the warm chart palette, never market red or green: a kind is a
 * category, not a direction (DESIGN.md, The Semantic Quarantine Rule).
 */

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
  /** One line on what the kind's substantial holdings usually are. */
  note: string;
  /** Tailwind background for a bar segment or a swatch. */
  swatch: string;
}

export const KIND_INFO: Readonly<Record<OwnershipKind, KindInfo>> = {
  super_fund: {
    label: "Super fund",
    plural: "Super funds",
    note: "APRA-regulated superannuation trustees investing members' retirement savings.",
    swatch: "bg-[#87A96B]",
  },
  index_manager: {
    label: "Index manager",
    plural: "Index managers",
    note: "Managers whose assets are mostly index funds and ETFs; their stakes track index weights.",
    swatch: "bg-[#C9A66B]",
  },
  hedge_fund: {
    label: "Hedge fund",
    plural: "Hedge funds",
    note: "Long/short, event-driven and absolute-return managers.",
    swatch: "bg-[#D16A47]",
  },
  active_manager: {
    label: "Active manager",
    plural: "Active managers",
    note: "Long-only active managers and listed investment companies.",
    swatch: "bg-[#FFA94D]",
  },
  bank_broker: {
    label: "Bank or broker",
    plural: "Banks and brokers",
    note: "Often securities lending: shares lent to, or held as collateral from, short sellers.",
    swatch: "bg-[#72625A]",
  },
  sovereign_public: {
    label: "Sovereign or public fund",
    plural: "Sovereign and public funds",
    note: "Sovereign wealth funds and public-sector investors.",
    swatch: "bg-[#9AC082]",
  },
  insurer: {
    label: "Insurer",
    plural: "Insurers",
    note: "Life insurers.",
    swatch: "bg-[#A39A75]",
  },
  private_equity: {
    label: "Private equity",
    plural: "Private equity",
    note: "Private equity and infrastructure investors, often building a takeover stake.",
    swatch: "bg-[#9E5210] dark:bg-[#C77A2A]",
  },
  corporate: {
    label: "Listed company",
    plural: "Listed companies",
    note: "Another ASX company: a strategic stake, a takeover bidder or a parent.",
    swatch: "bg-[#483932] dark:bg-[#B5A48C]",
  },
  other: {
    label: "Other",
    plural: "Other",
    note: "Institutions outside the categories above.",
    swatch: "bg-[#E8DEB5]",
  },
  unclassified: {
    label: "Unclassified",
    plural: "Unclassified holders",
    note: "Holders not on the curated map: families, founders, private companies, smaller managers.",
    swatch: "bg-[#E5E1DC]",
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
