import Link from "next/link";

import { formatPct, formatShares } from "~/@/lib/fundamentals/format";
import { institutionHref, kindInfo, registerHref } from "~/@/lib/ownership/kinds";
import {
  DISCLOSED_CAPTION,
  counted,
  formatAud,
  formatSignedAud,
  formatSignedPct,
  sectorLabel,
  windowText,
} from "~/@/lib/ownership/insights/format";
import type {
  InsightFundPositionRow,
  InsightInstitutionRow,
  InsightMeasure,
  InsightMoveRow,
  InsightStockDetailRow,
  InsightStockRow,
} from "~/@/lib/ownership/insights/types";
import { cn } from "~/@/lib/utils";

import { KindDot, MovesList, NUM, StockRows } from "./insights-parts";

// No directive: the island draws these. They hold no state, so they reach no
// hook, no generated code and no action.

const PANEL_HEAD = "text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground";

/** What a panel says while its read is in flight, or when it failed. */
export function PanelStatus({ status }: { status: "loading" | "error" }) {
  return (
    <p className="text-xs text-muted-foreground" role="status">
      {status === "loading"
        ? "Loading…"
        : "This could not be read just now. Nothing is missing from the register: this is our end."}
    </p>
  );
}

function fundChange(f: InsightFundPositionRow): string {
  if (!f.startAsAt || f.startUnits == null) return "n/a";
  if (f.units == null) return "n/a";
  if (f.startUnits === 0) return "new";
  return formatSignedPct(((f.units - f.startUnits) / f.startUnits) * 100);
}

/** The by-kind stack: each kind's disclosed share as a segment, no 100% track (a register is never a whole company). */
function KindStack({ detail }: { detail: InsightStockDetailRow }) {
  const total = detail.byKind.reduce((sum, k) => sum + k.pct, 0);
  if (total <= 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex h-2.5 w-full gap-[2px]" aria-hidden>
        {detail.byKind.map((k) => (
          <span
            key={k.kind}
            className={cn("h-full rounded-[2px]", kindInfo(k.kind).swatch)}
            style={{ width: `${(k.pct / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="space-y-0.5 text-xs">
        {detail.byKind.map((k) => (
          <li key={k.kind} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <KindDot kind={k.kind} />
              <span className="truncate">{kindInfo(k.kind).plural}</span>
            </span>
            <span className={cn(NUM, "text-muted-foreground")}>{k.holders}</span>
            <span className={NUM}>{formatPct(k.pct, { digits: 2 })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A stock's panel: its register by kind, its fund holders over the window, and the window's notices. */
export function StockPanel({
  code,
  stock,
  detail,
  status,
  from,
  to,
  onClose,
}: {
  code: string;
  stock: InsightStockRow | undefined;
  detail: InsightStockDetailRow | null;
  status: "idle" | "loading" | "error";
  from: string;
  to: string;
  onClose: () => void;
}) {
  const name = [detail?.name, stock?.name].find((n) => n !== undefined && n !== "") ?? "";
  return (
    <section aria-labelledby="insights-stock-title" className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="insights-stock-title" className="truncate text-base font-semibold">
            {code} <span className="font-normal text-muted-foreground">{name}</span>
          </h3>
          <p className="text-xs text-muted-foreground">{sectorLabel(detail?.sector ?? stock?.sector ?? "")}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="hit-target shrink-0 rounded px-1.5 text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Close
        </button>
      </header>
      <Link href={registerHref(code)} prefetch={false} className="inline-block text-xs text-primary hover:underline">
        {code}&apos;s full register
      </Link>

      {status !== "idle" && !detail ? <PanelStatus status={status === "loading" ? "loading" : "error"} /> : null}

      {detail ? (
        <>
          <div className="space-y-2">
            <p className={PANEL_HEAD}>Substantial holders by kind</p>
            {detail.byKind.length > 0 ? (
              <>
                <p className="text-sm tabular-nums">
                  <span className="font-semibold">{formatPct(detail.disclosedPct, { digits: 2 })}</span>{" "}
                  <span className="text-muted-foreground">
                    disclosed by {counted(detail.holders, "holder", "holders")}, {DISCLOSED_CAPTION}
                  </span>
                </p>
                <KindStack detail={detail} />
                <p className="text-[10px] text-muted-foreground">
                  As the newest notices read state it
                  {detail.latestNoticeDate ? (
                    <>
                      , latest <time dateTime={detail.latestNoticeDate}>{detail.latestNoticeDate}</time>
                    </>
                  ) : null}
                  .
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No current substantial holder read.</p>
            )}
          </div>

          <div className="space-y-2">
            <p className={PANEL_HEAD}>Index funds and super options</p>
            {detail.funds.length === 0 ? (
              <p className="text-xs text-muted-foreground">No fund file on record holds it at {to}.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead className="border-b border-border text-[10px] text-muted-foreground">
                    <tr>
                      <th scope="col" className="py-1 pr-2 text-left font-normal">
                        Fund, file date
                      </th>
                      <th scope="col" className="py-1 pr-2 text-right font-normal">
                        Shares
                      </th>
                      <th scope="col" className="py-1 pr-2 text-right font-normal">
                        Value
                      </th>
                      <th scope="col" className="py-1 text-right font-normal">
                        Change
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {detail.funds.slice(0, 12).map((f) => (
                      <tr key={`${f.slug}|${f.fund}`}>
                        <th scope="row" className="py-1 pr-2 text-left font-normal">
                          <span className="inline-flex items-center gap-1.5">
                            <KindDot kind={f.kind} />
                            {institutionHref(f.slug) ? (
                              <Link href={institutionHref(f.slug)!} prefetch={false} className="hover:underline">
                                {f.fund}
                              </Link>
                            ) : (
                              f.fund
                            )}
                          </span>
                          <span className="block text-[10px] text-muted-foreground">
                            {f.sourceKind === "super_phd" ? "super option, " : ""}
                            {f.startAsAt ? (
                              <>
                                <time dateTime={f.startAsAt}>{f.startAsAt}</time> to{" "}
                              </>
                            ) : null}
                            <time dateTime={f.asAt}>{f.asAt}</time>
                          </span>
                        </th>
                        <td className={cn(NUM, "py-1 pr-2")}>{formatShares(f.units)}</td>
                        <td className={cn(NUM, "py-1 pr-2")}>{formatAud(f.value)}</td>
                        <td className={cn(NUM, "py-1")}>{fundChange(f)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">
              Each fund compared with its own earlier file. Vanguard&apos;s files are the pooled fund behind each ETF; a
              super option is one investment option, not the whole fund.
            </p>
          </div>

          <div className="space-y-2">
            <p className={PANEL_HEAD}>Notices in the window</p>
            <MovesList moves={detail.notices} empty={`No notice for ${code} dated ${windowText(from, to)}.`} />
          </div>
        </>
      ) : null}
    </section>
  );
}

/** Institutions whose funds hold the sector, by the size of their index funds' change. */
export function InstitutionList({ institutions }: { institutions: readonly InsightInstitutionRow[] }) {
  if (institutions.length === 0) {
    return <p className="text-xs text-muted-foreground">No fund file on record here.</p>;
  }
  return (
    <ol className="divide-y divide-border/60 text-xs">
      {institutions.slice(0, 10).map((i) => (
        <li key={i.slug} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 py-1">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <KindDot kind={i.kind} />
            <Link href={`/ownership/${i.slug}`} prefetch={false} className="truncate hover:underline">
              {i.name}
            </Link>
          </span>
          <span className={cn(NUM, "text-muted-foreground")}>{formatAud(i.value)}</span>
          <span className={NUM}>{formatSignedAud(i.flow)}</span>
        </li>
      ))}
    </ol>
  );
}

/** A sector's or a heatmap cell's drill: the stocks, the institutions and the notices behind it. */
export function DrillPanel({
  title,
  measure,
  stocks,
  institutions,
  moves,
  status,
  onClose,
}: {
  title: React.ReactNode;
  measure: InsightMeasure;
  stocks: readonly InsightStockRow[];
  institutions: readonly InsightInstitutionRow[];
  moves: readonly InsightMoveRow[];
  status: "idle" | "loading" | "error";
  onClose?: () => void;
}) {
  const ranked = [...stocks].sort((a, b) =>
    measure === "funds"
      ? Math.abs(b.fundFlow ?? 0) - Math.abs(a.fundFlow ?? 0) || (b.fundValue ?? 0) - (a.fundValue ?? 0)
      : b.notices - a.notices || Math.abs(b.noticeNetPp) - Math.abs(a.noticeNetPp),
  );
  const moved = ranked.filter((s) => (measure === "funds" ? s.fundFlow != null && s.fundFlow !== 0 : s.notices > 0));
  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <header className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="hit-target shrink-0 rounded px-1.5 text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Close
          </button>
        ) : null}
      </header>
      {status !== "idle" ? <PanelStatus status={status} /> : null}
      {status === "idle" ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="space-y-2">
            <p className={PANEL_HEAD}>Stocks</p>
            {moved.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {measure === "funds" ? "No index fund position moved here." : "No notice dated here."}
              </p>
            ) : (
              <StockRows stocks={moved} measure={measure} limit={15} />
            )}
          </div>
          <div className="space-y-4">
            {measure === "funds" ? (
              <div className="space-y-2">
                <p className={PANEL_HEAD}>Institutions</p>
                <InstitutionList institutions={institutions} />
              </div>
            ) : null}
            <div className="space-y-2">
              <p className={PANEL_HEAD}>Largest stated moves</p>
              <MovesList moves={moves.slice(0, 8)} empty="No notice here states both figures." />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
