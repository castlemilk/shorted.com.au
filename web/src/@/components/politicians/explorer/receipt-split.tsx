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

import { PoliticsIcon } from "@/components/politicians/politics-icon";
import { RECEIPT_TYPE_ICON } from "@/lib/politics/register-item-icons";
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
    // The bucket's own icon. THE FIVE ARE NOT INTERCHANGEABLE — a subscription
    // is not a donation, which is the whole reason this component exists — so
    // each gets its own subject and none of them is a money glyph: a parcel into
    // a tray, a receipt slip, a membership card, a ballot box, a blank sheet.
    icon: RECEIPT_TYPE_ICON[key],
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
      {/*
        ARIA-HIDDEN, BECAUSE THE `sr-only` SENTENCE BELOW SAYS THE SAME THING.
        Announced as well, a screen reader hears all five labels and all five
        amounts twice — once as a bare list with no subject, then again inside
        the sentence that names the subject and states that the five are the
        whole of the total. The sentence is the one worth hearing.
      */}
      <ul
        aria-hidden
        className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] leading-relaxed text-muted-foreground"
      >
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-1">
            {/*
              THE SWATCH STAYS BESIDE THE ICON. The swatch is what ties a row to
              its segment in the bar above; the icon is what distinguishes the
              five types at a glance. Dropping either leaves one of those two
              jobs undone.
            */}
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-[1px]"
              style={{ backgroundColor: segment.color }}
            />
            {segment.icon ? <PoliticsIcon name={segment.icon} size={12} /> : null}
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
  "to the total beside them. Public funding is election funding paid under the " +
  "Commonwealth Electoral Act on first-preference votes received — it is a receipt, " +
  "not a donation, and it is why a public body can head a list of payers.";
