/**
 * The receipt-type split, rendered wherever receipt amounts aggregate.
 *
 * THE SOURCE'S OWN DISTINCTION, AND IT IS NOT DECORATIVE. The AEC's itemised
 * receipts carry a type — 'Donation Received', 'Other Receipt', 'Subscription',
 * 'Public Funding', or nothing at all — and a party's largest payer in a year is
 * frequently a subscription or a conference fee. Summing the five into one
 * figure and calling it a donation would label a lawful membership subscription
 * as a political donation beside a named payer and a named party. So every
 * surface that aggregates receipts renders this, and a test asserts it.
 *
 * ALL FIVE BUCKETS ALWAYS RENDER, including the zero ones. The five are
 * exhaustive over the source vocabulary (the store folds blank and 'Unspecified'
 * into one bucket), so they provably sum to the total beside them — and a reader
 * can only check that if the zeroes are visible. A split that hides its empty
 * buckets reads as "these are the types present", which is a different claim.
 *
 * PROPS-ONLY KIT: no fetching, no generated protobuf, no compliance import.
 */

import {
  RECEIPT_TYPE_COLOR,
  RECEIPT_TYPE_LABEL,
  RECEIPT_TYPE_ORDER,
  formatCents,
  receiptSplitTotal,
  type ReceiptSplitCents,
} from "@/lib/politics/funding-money";

export interface ReceiptSplitProps {
  split: ReceiptSplitCents;
  /**
   * What the five buckets belong to, for the accessible caption: a payer's
   * verbatim name, or a company's. Never a characterisation.
   */
  subject: string;
  /** Compact renders the bar and the amounts on one wrapped line. */
  compact?: boolean;
}

export function ReceiptSplit({ split, subject, compact = false }: ReceiptSplitProps) {
  const total = receiptSplitTotal(split);
  const segments = RECEIPT_TYPE_ORDER.map((key) => ({
    key,
    label: RECEIPT_TYPE_LABEL[key],
    color: RECEIPT_TYPE_COLOR[key],
    cents: Math.max(0, Number(split[key] ?? 0)),
  }));

  return (
    <div className={compact ? "space-y-1" : "space-y-1.5"}>
      {/*
        The bar is aria-hidden and the list below carries the same numbers: five
        segments described in one aria-label is a sentence nobody can navigate,
        and the amounts matter more than the proportions here.
      */}
      <span aria-hidden className="flex h-1.5 w-full overflow-hidden rounded-sm bg-muted">
        {segments.map((segment) => (
          <span
            key={segment.key}
            data-receipt-segment={segment.key}
            className="block h-1.5"
            style={{
              width: `${total > 0 ? (segment.cents / total) * 100 : 0}%`,
              backgroundColor: segment.color,
            }}
          />
        ))}
      </span>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] leading-relaxed text-muted-foreground">
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-1">
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-[1px]"
              style={{ backgroundColor: segment.color }}
            />
            <span>{segment.label}</span>
            <span className="tabular-nums">{formatCents(segment.cents)}</span>
          </li>
        ))}
      </ul>
      <span className="sr-only">
        Receipt types recorded for {subject}, as lodged: {segments
          .map((segment) => `${segment.label} ${formatCents(segment.cents)}`)
          .join(", ")}
        . These five types are the whole of the {formatCents(total)} recorded.
      </span>
    </div>
  );
}

/**
 * The one-line explanation that must accompany any aggregated receipt figure.
 *
 * Kept here, beside the component, so a surface cannot render the split without
 * the sentence that says why it is split.
 */
export const RECEIPT_SPLIT_NOTE =
  "Receipt types are the AEC's own: a subscription, a conference fee or another " +
  "receipt is recorded separately from a donation, and the five types shown add up " +
  "to the total beside them.";
