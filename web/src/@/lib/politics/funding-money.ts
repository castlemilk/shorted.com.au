/**
 * The ONE money formatter for the AEC funding surfaces.
 *
 * WHY MONEY EXISTS HERE AT ALL, when every register surface is forbidden from
 * rendering an amount. The two data sets are different things under different
 * licences: the Registers of Members'/Senators' Interests record WHAT is held
 * and never how much (so there is no figure to format, and
 * `editorial-copy.test.ts` bans one), while the AEC Transparency Register
 * publishes lodged FUNDING FIGURES under CC BY 4.0 and the editorial standards'
 * own worked example blesses printing them. Amounts belong to the funding layer
 * only, and this module is the boundary — nothing in the register subsystem
 * imports it.
 *
 * CENTS IN, DOLLARS OUT. Every amount on the wire is an integer number of cents
 * (int64 in the proto, `number` by the time it crosses the RSC boundary, because
 * BigInt cannot be serialised into a client island). Dividing at the render site
 * is how one surface ends up printing cents as dollars, so the division happens
 * here and only here.
 *
 * NO ROUNDING THAT CHANGES A CLAIM. `formatCents` prints whole dollars, which is
 * the grain the AEC's own returns are read at, and it is the ONLY formatter here:
 * every amount in this layer sits beside a named party or a named payer, so
 * there is no place an abbreviated figure would be the honest rendering.
 */

/**
 * en-AU currency, whole dollars. `$205,442,684`.
 *
 * Built once: `Intl.NumberFormat` construction is the expensive part, and these
 * run over hundreds of table cells.
 */
const DOLLARS = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Plain integers, for counts of payers, returns and donors. */
const COUNT = new Intl.NumberFormat("en-AU");

/**
 * Cents to a whole-dollar string.
 *
 * A non-finite input formats as zero rather than `NaN`: a table cell reading
 * "$NaN" beside a party's name is worse than a figure that is visibly nothing,
 * and the caller's own emptiness checks decide whether the row renders at all.
 */
export function formatCents(cents: number | undefined | null): string {
  const value = Number(cents ?? 0);
  if (!Number.isFinite(value)) return DOLLARS.format(0);
  return DOLLARS.format(Math.round(value) / 100);
}

/*
 * THERE IS NO COMPACT FORMATTER, deliberately.
 *
 * One lived here for chart labels and no surface ever called it: every amount in
 * this layer is rendered beside a named party or a named payer, where the exact
 * figure is the point. It also rounded wrongly at two boundaries ($999,500 came
 * out as "$1000k", and nothing above a billion had a suffix at all), which is
 * how an abbreviation of an AEC figure becomes a figure the AEC never published.
 * If a chart ever needs axis ticks, write it then and test the boundaries.
 */

/** A plain count, grouped. Counts of people, payers, returns — never money. */
export function formatCount(value: number | undefined | null): string {
  const count = Number(value ?? 0);
  if (!Number.isFinite(count)) return "0";
  return COUNT.format(Math.trunc(count));
}

/**
 * The five receipt-type buckets, in the order every surface renders them.
 *
 * EXHAUSTIVE OVER THE SOURCE VOCABULARY and therefore summable to the total —
 * the store folds 'Unspecified' and blank into one bucket, so the five provably
 * add up. They are kept apart because the AEC itself keeps them apart: a
 * subscription or a conference fee is not a donation, and a surface that sums
 * them into one "donations" figure publishes a claim the return does not make.
 */
export const RECEIPT_TYPE_ORDER = [
  "donation",
  "otherReceipt",
  "subscription",
  "publicFunding",
  "unspecified",
] as const;

export type ReceiptTypeKey = (typeof RECEIPT_TYPE_ORDER)[number];

/**
 * The label for each bucket, in the source's own vocabulary.
 *
 * "Unspecified" is the AEC's own term for a receipt whose type the return left
 * blank. It is NOT folded into "other receipt": the two mean different things
 * (one is a stated category, the other is a silence) and collapsing them would
 * attribute a category to a return that stated none.
 */
export const RECEIPT_TYPE_LABEL: Record<ReceiptTypeKey, string> = {
  donation: "Donation received",
  otherReceipt: "Other receipt",
  subscription: "Subscription",
  publicFunding: "Public funding",
  unspecified: "Type not stated",
};

/**
 * A muted five-step ramp, warm to cool. Amber-family only — no green and no red.
 *
 * Colour here separates categories; it never grades them. A red "donation"
 * segment beside a party's name would be a judgement about a lawful, disclosed
 * receipt, which is exactly what the editorial rules forbid.
 */
export const RECEIPT_TYPE_COLOR: Record<ReceiptTypeKey, string> = {
  donation: "#d9a13a",
  otherReceipt: "#b58a4a",
  subscription: "#8f7a5c",
  publicFunding: "#6f7d86",
  unspecified: "#9a958c",
};

/** One payer's or party's split, as it crosses the RSC boundary. */
export interface ReceiptSplitCents {
  donation: number;
  otherReceipt: number;
  subscription: number;
  publicFunding: number;
  unspecified: number;
}

export const EMPTY_RECEIPT_SPLIT: ReceiptSplitCents = {
  donation: 0,
  otherReceipt: 0,
  subscription: 0,
  publicFunding: 0,
  unspecified: 0,
};

/** The five buckets summed. Equal to the payer's total, by construction. */
export function receiptSplitTotal(split: ReceiptSplitCents): number {
  return RECEIPT_TYPE_ORDER.reduce((sum, key) => sum + (split[key] || 0), 0);
}

/** Add two splits bucket-wise. Used only to combine the SAME measure. */
export function addReceiptSplits(
  a: ReceiptSplitCents,
  b: ReceiptSplitCents,
): ReceiptSplitCents {
  return {
    donation: a.donation + b.donation,
    otherReceipt: a.otherReceipt + b.otherReceipt,
    subscription: a.subscription + b.subscription,
    publicFunding: a.publicFunding + b.publicFunding,
    unspecified: a.unspecified + b.unspecified,
  };
}
