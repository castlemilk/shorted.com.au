import Link from "next/link";

import { registerHref } from "~/@/lib/ownership/kinds";
import {
  DISCLOSED_CAPTION,
  formatAud,
  formatSignedAud,
  formatSignedPct,
  windowText,
} from "~/@/lib/ownership/insights/format";
import { OTHER_SECTOR_PARAM } from "~/@/lib/ownership/insights/query";
import type { InsightsPage } from "~/@/lib/ownership/insights/types";
import { formatPct } from "~/@/lib/fundamentals/format";
import { cn } from "~/@/lib/utils";

import { NUM } from "./insights-parts";

// A server component: the desk at the top of /ownership/insights, read from the
// default window the page renders, so every figure is in the HTML a crawler
// reads. Each card names the dates it reads.

interface DeskRow {
  key: string;
  href: string;
  code: string;
  name: string;
  value: string;
  note?: string;
  /** A filtered list's link: followed by readers, not crawled. */
  nofollow?: boolean;
}

function DeskCard({
  title,
  rows,
  empty,
  dated,
}: {
  title: string;
  rows: DeskRow[];
  empty: string;
  dated: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ol className="space-y-1.5 text-xs">
          {rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
              <span className="min-w-0 truncate">
                <Link
                  href={r.href}
                  prefetch={false}
                  rel={r.nofollow ? "nofollow" : undefined}
                  className="font-medium text-primary hover:underline"
                >
                  {r.code}
                </Link>{" "}
                <span className="text-muted-foreground">{r.name}</span>
              </span>
              <span className={cn(NUM, "font-medium")}>
                {r.value}
                {r.note ? <span className="block text-[10px] font-normal text-muted-foreground">{r.note}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-auto text-[10px] leading-relaxed text-muted-foreground">{dated}</p>
    </section>
  );
}

function Range({ from, to }: { from: string; to: string }) {
  if (!from && !to) return <>n/a</>;
  if (!from || !to || from === to) {
    const d = from || to;
    return <time dateTime={d}>{d}</time>;
  }
  return (
    <>
      <time dateTime={from}>{from}</time> to <time dateTime={to}>{to}</time>
    </>
  );
}

/** The desk: the window's biggest moves, the most crowded sectors and the biggest index fund ownership. */
export function InsightCards({ page }: { page: InsightsPage }) {
  const w = page.window;
  const compared = w.fundsCompared > 0;
  const flows = page.stocks.filter((s) => s.fundFlow != null && s.fundFlow !== 0);
  const rises = [...flows].sort((a, b) => (b.fundFlow ?? 0) - (a.fundFlow ?? 0)).filter((s) => (s.fundFlow ?? 0) > 0);
  const falls = [...flows].sort((a, b) => (a.fundFlow ?? 0) - (b.fundFlow ?? 0)).filter((s) => (s.fundFlow ?? 0) < 0);
  const flowRow = (s: (typeof flows)[number]): DeskRow => ({
    key: s.code,
    href: registerHref(s.code),
    code: s.code,
    name: s.name,
    value: formatSignedAud(s.fundFlow),
    note: s.fundChangePct == null ? "new position" : `${formatSignedPct(s.fundChangePct)} shares`,
  });
  const crowded = [...page.sectors].filter((s) => s.investorInterests > 0).sort(
    (a, b) => b.investorInterests - a.investorInterests || (b.disclosedValue ?? 0) - (a.disclosedValue ?? 0),
  );
  const owned = page.stocks.filter((s) => s.indexPct != null).sort((a, b) => (b.indexPct ?? 0) - (a.indexPct ?? 0));
  const noCompare = "n/a: no index fund has two files in this window.";
  const filesDated = (
    <>
      Index funds compared with their own files: <Range from={w.startFilesFrom} to={w.startFilesTo} /> against{" "}
      <Range from={w.endFilesFrom} to={w.endFilesTo} />. Valued at the later file&apos;s price.
    </>
  );

  return (
    <section aria-labelledby="desk" className="space-y-3">
      <h2 id="desk" className="sr-only">
        The window at a glance
      </h2>
      <p className="text-xs text-muted-foreground">
        The window {windowText(w.from, w.to)}, the default view. The explorer below moves it.
      </p>
      <div className="grid divide-y divide-border rounded-lg border border-border bg-card md:grid-cols-2 md:divide-y-0 xl:grid-cols-5 xl:divide-x [&>*]:border-border md:[&>*:nth-child(n+3)]:border-t xl:[&>*:nth-child(n+3)]:border-t-0">
        <DeskCard
          title="Largest rises in index fund shares"
          rows={compared ? rises.slice(0, 5).map(flowRow) : []}
          empty={compared ? "No compared fund added shares in this window." : noCompare}
          dated={filesDated}
        />
        <DeskCard
          title="Largest falls in index fund shares"
          rows={compared ? falls.slice(0, 5).map(flowRow) : []}
          empty={compared ? "No compared fund held fewer shares in this window." : noCompare}
          dated={filesDated}
        />
        <DeskCard
          title="Most crowded sectors"
          rows={crowded.slice(0, 5).map((s) => ({
            key: s.sector,
            href: `/ownership/insights?sector=${encodeURIComponent(s.sector || OTHER_SECTOR_PARAM)}#map`,
            code: s.label,
            name: "",
            value: `${s.investorInterests.toLocaleString("en-AU")} interests`,
            note: formatAud(s.disclosedValue),
            nofollow: true,
          }))}
          empty="No current investor interest read."
          dated={
            <>
              Investors&apos; interests counted once (banks and brokers, often securities lending, are not counted), as
              the newest notices read state them, read to <Range from="" to={w.noticesAsOf} />. Values are disclosed
              voting power times market cap: {DISCLOSED_CAPTION}.
            </>
          }
        />
        <DeskCard
          title="Most owned by index funds"
          rows={owned.slice(0, 5).map((s) => ({
            key: s.code,
            href: registerHref(s.code),
            code: s.code,
            name: s.name,
            value: formatPct(s.indexPct, { digits: 2 }),
            note: formatAud(s.fundValue),
          }))}
          empty="No index fund file on record at the window's end."
          dated={
            <>
              Shares the index funds tracked hold as a share of shares on issue, files <Range from={w.endFilesFrom} to={w.endFilesTo} />;
              shares on issue from ASIC&apos;s latest short position report.
            </>
          }
        />
        <DeskCard
          title="Largest moves notices state"
          rows={page.moves.slice(0, 5).map((m) => ({
            key: m.url,
            href: registerHref(m.code),
            code: m.code,
            name: m.holder,
            value: m.change || "n/a",
            note: m.date,
          }))}
          empty="No notice in this window states both figures."
          dated={
            <>
              Present less previous voting power, as each notice dated <Range from={w.from} to={w.to} /> states it. A
              fall is a fall, not a disposal.
            </>
          }
        />
      </div>
    </section>
  );
}
