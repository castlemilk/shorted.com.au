import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { DatedText } from "./ownership-provenance";

// Server-safe: no "use client", no Connect import. The plate is the nameplate
// under a page's H1: one <p> that reads as a sentence to a screen reader and
// to a crawler, with the facts separated by " · ". It always ends with the
// disclaimer, because "Not financial advice" is load-bearing (DESIGN.md).

// The plate's dates read as its facts: the picks plate's date classes.
const PLATE_DATE = "font-medium text-foreground tabular-nums";

export interface PlateItem {
  text: string;
  /** The date a text that states no date of its own stands for. A date in the text is set as a <time> whatever this is. */
  dateTime?: string;
  href?: string;
}

function PlateFact({ item }: { item: PlateItem }) {
  const text = <DatedText text={item.text} dateTime={item.dateTime} timeClassName={PLATE_DATE} />;
  if (!item.href) return text;
  return (
    <Link href={item.href} prefetch={false} className="text-foreground hover:underline">
      {text}
    </Link>
  );
}

export function OwnershipPlate({ items }: { items: readonly PlateItem[] }) {
  const facts: ReactNode[] = items
    .filter((item) => item.text.trim() !== "")
    .map((item, index) => <PlateFact key={index} item={item} />);
  facts.push(
    <Link key="disclaimer" href="/disclaimer" prefetch={false} className="font-medium text-foreground hover:underline">
      Not financial advice
    </Link>,
  );
  return (
    <p className="inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md border border-border/60 bg-card px-3 py-1.5 text-xs text-muted-foreground">
      {facts.map((fact, index) => (
        <Fragment key={index}>
          {index > 0 ? " · " : null}
          {fact}
        </Fragment>
      ))}
    </p>
  );
}
