/**
 * The ownership tables' rows as the strings they print.
 *
 * The server formats each row here and a table island
 * (components/ownership/ownership-tables.tsx) holds the rows as data, so the
 * island formats nothing and a row costs ~0.2 KB of RSC payload. A server
 * table serialised every row as an element tree (~1.8 KB) beside its HTML
 * (~1.5 KB), which is what made /ownership/vanguard 946 KB: 88 stakes, 100
 * holdings-file rows and 100 notices, each drawn twice.
 */

import type {
  FundHolding,
  SubstantialHolding,
  SubstantialNotice,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import { formatAmount, formatPct } from "~/@/lib/fundamentals/format";
import { ageLabel } from "./age";
import {
  formLabel,
  formatFundWeight,
  formatPointChange,
  formatVotingPower,
  fundCodeAndName,
  holderHref,
} from "./kinds";

/** One current substantial holding, on its holder's page. */
export interface HoldingRow {
  code: string;
  company: string;
  votingPower: string;
  change: string;
  asAt: string;
  /** How long the holding has gone unread, or "" while it is recent. */
  age: string;
  form: string;
  url: string;
}

/**
 * `asOf` is the date the age counts to. The one-argument form stays because
 * `rows.map(holdingRow)` passes the index as a second argument, which a string
 * parameter would refuse. An index is not a date, so that row carries no age.
 */
export function holdingRow(p: SubstantialHolding): HoldingRow;
export function holdingRow(p: SubstantialHolding, asOf: string): HoldingRow;
export function holdingRow(p: SubstantialHolding, asOf = ""): HoldingRow {
  // No event date on the notice: the release date stands in.
  const asAt = p.eventDate || p.announcedOn;
  return {
    code: p.stockCode,
    company: p.companyName,
    votingPower: formatVotingPower(p.votingPowerPct),
    change: p.hasPrevious ? formatPointChange(p.previousPct, p.votingPowerPct) : "",
    asAt,
    age: ageLabel(asAt, asOf),
    form: formLabel(p.form, false),
    url: p.announcementUrl,
  };
}

/** One stock in one of an institution's holdings files. */
export interface FileHoldingRow {
  code: string;
  fund: string;
  value: string;
  ofFund: string;
  ofShares: string;
  asAt: string;
}

export function fileHoldingRow(h: FundHolding): FileHoldingRow {
  return {
    code: h.stockCode,
    fund: fundCodeAndName(h.fundCode, h.fundName),
    value: h.hasValue ? formatAmount(h.valueAud, "AUD") : "n/a",
    // The stock card's rule (StockOwnershipView): a super fund's stated 0.00
    // beside a real value is "<0.01%", never a holding of nothing.
    ofFund: formatFundWeight(h.weightPct, h.hasWeight, h.hasValue ? h.valueAud : null),
    ofShares: h.hasPctOfIssued ? formatPct(h.pctOfIssued, { digits: 2 }) : "n/a",
    asAt: h.asAt,
  };
}

/** One notice as released. `holder` only where the table names holders. */
export interface NoticeRow {
  released: string;
  code: string;
  holder?: { name: string; href: string | null };
  form: string;
  votingPower: string;
  change: string;
  url: string;
  /** "model" when a model read the notice after the parser withheld it (read_by); absent otherwise. */
  readBy?: string;
}

export function noticeRow(n: SubstantialNotice, withHolder: boolean): NoticeRow {
  return {
    released: n.announcedOn,
    code: n.stockCode,
    ...(withHolder
      ? { holder: { name: n.holderName || "Unnamed holder", href: holderHref(n.institutionSlug, n.holderKey) } }
      : {}),
    form: formLabel(n.form, n.ceased),
    votingPower: n.ceased ? "under 5%" : n.hasPresent ? formatVotingPower(n.presentPct) : "n/a",
    change: n.hasPrevious && n.hasPresent ? formatPointChange(n.previousPct, n.presentPct) : "",
    url: n.announcementUrl,
    ...(n.readBy === "model" ? { readBy: "model" } : {}),
  };
}
