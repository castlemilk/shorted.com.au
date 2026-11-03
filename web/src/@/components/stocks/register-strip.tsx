import { Fragment } from "react";
import Link from "next/link";
import { Landmark } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Dated } from "~/@/components/ownership/ownership-provenance";
import { asAtRange, registerHref } from "~/@/lib/ownership/kinds";
import { REPORT_ERROR_EMAIL } from "~/@/lib/report-error";
import type {
  StockRegisterStrip,
  StockRegisterStripRow,
} from "~/app/actions/getStockRegisterStrip";

// The Overview's register strip: who holds the stock, as its substantial
// holding notices state it. It is one sentence, with the largest holders named
// inside it, so their links are in the HTML without a table; the register page
// is the full reading. Props-only: the action's types are imported for their
// shape, and nothing at run time reaches protobuf or Connect.

/** The copy names three holders at most, so the summary stays one sentence. */
const NAMED_HOLDERS = 3;

/** A count and its noun, plural for anything but one: "1 holder", "12 interests". */
function countOf(n: number, one: string): string {
  return `${n.toLocaleString("en-AU")} ${n === 1 ? one : `${one}s`}`;
}

function HolderClause({ row }: { row: StockRegisterStripRow }) {
  const name = row.href ? (
    <Link href={row.href} prefetch={false} className="text-primary hover:underline">
      {row.name}
    </Link>
  ) : (
    row.name
  );
  return (
    <>
      {name} {row.votingPower}
      {/* A figure older than the age rule carries its notice date, so a stale
          holding is never read as the current one. */}
      {row.age ? (
        <>
          {" as at "}
          <time dateTime={row.asAt}>{row.asAt}</time> ({row.age})
        </>
      ) : null}
    </>
  );
}

export function RegisterStrip({ strip }: { strip: StockRegisterStrip }) {
  const named = strip.rows.slice(0, NAMED_HOLDERS);
  if (named.length === 0) return null;
  const code = strip.stockCode;
  return (
    <Card role="region" aria-labelledby="register-strip-heading">
      <CardHeader className="pb-2">
        <CardTitle
          id="register-strip-heading"
          className="flex items-center gap-2 text-lg"
        >
          <Landmark className="h-5 w-5" aria-hidden />
          Substantial holders
        </CardTitle>
        <CardDescription className="text-xs">
          Who holds {code}, as its notices state it
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs tabular-nums">
          {`${countOf(strip.holders, "holder")}, ${countOf(strip.interests, "interest")} counted once, disclose ${strip.disclosed} between them; largest: `}
          {named.map((row, index) => (
            <Fragment key={index}>
              {index > 0 ? ", " : null}
              <HolderClause row={row} />
            </Fragment>
          ))}
          {strip.indexPct !== null ? (
            <>
              {`; index funds tracked hold ${strip.indexPct}% of shares on issue`}
              {/* A file date the API does not hold is left out, never "as at n/a". */}
              {strip.indexAsAtFrom || strip.indexAsAtTo ? (
                <>
                  {" (files "}
                  <Dated text={asAtRange(strip.indexAsAtFrom, strip.indexAsAtTo)} />
                  {")"}
                </>
              ) : null}
            </>
          ) : null}
        </p>
        <p className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            {strip.asOf ? (
              <>
                Notices read to <time dateTime={strip.asOf}>{strip.asOf}</time> ·{" "}
              </>
            ) : null}
            what the notices disclose, not a share of the company ·{" "}
            <Link
              href="/disclaimer"
              prefetch={false}
              className="underline underline-offset-4 hover:text-foreground"
            >
              Not financial advice
            </Link>
            {" · "}
            <a
              href={`mailto:${REPORT_ERROR_EMAIL}?subject=${encodeURIComponent(`Ownership data: ${code} register`)}`}
              className="underline underline-offset-4 hover:text-foreground"
            >
              Report an error
            </a>
          </span>
          <Link
            href={registerHref(code)}
            prefetch={false}
            className="text-xs text-primary hover:underline"
          >
            Full register →
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
