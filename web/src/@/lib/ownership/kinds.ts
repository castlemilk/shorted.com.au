/**
 * Ownership vocabulary: the institution kinds the API reports
 * (services/jobs/internal/jobs/ownership/registry.go decides them, once, by
 * hand) and how a page names, orders and colours them.
 *
 * Colours are the warm chart palette, never market red or green: a kind is a
 * category, not a direction (DESIGN.md, The Semantic Quarantine Rule).
 */

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
    note: "Mostly securities lending: shares lent to, or held as collateral from, short sellers.",
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
    swatch: "bg-[#9E5210]",
  },
  corporate: {
    label: "Listed company",
    plural: "Listed companies",
    note: "Another ASX company: a strategic stake, a takeover bidder or a parent.",
    swatch: "bg-[#483932]",
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

/** Whether a path segment can be a registry slug, checked before any read. */
export function isInstitutionSlug(slug: string): boolean {
  return INSTITUTION_SLUG.test(slug);
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

/** A fund's name with its ASX code in front, unless the name already carries it. */
export function fundLabel(code: string | null | undefined, name: string): string {
  if (!code || name.includes(`(${code})`) || name.startsWith(`${code} `)) return name;
  return `${code}, ${name}`;
}
