import Link from "next/link";

import { Disclosure } from "~/@/components/ui/disclosure";
import { kindInfo, registerHref } from "~/@/lib/ownership/kinds";
import {
  DISCLOSED_CAPTION,
  bucketLabel,
  formatAud,
  formatPp,
  formatSignedAud,
  formatSignedPct,
} from "~/@/lib/ownership/insights/format";
import { BINS, BIN_STYLES, NA_STYLE, binRange, type DivergingBin } from "~/@/lib/ownership/insights/scale";
import type {
  InsightFlowRow,
  InsightHeatmapRow,
  InsightMeasure,
  InsightMoveRow,
  InsightSectorRow,
  InsightStockRow,
} from "~/@/lib/ownership/insights/types";
import { cn } from "~/@/lib/utils";

// Server-safe: no "use client", no generated code, no action. The server page
// draws these as the text and table form of every chart, so the HTML a crawler
// reads holds every figure the charts draw; the island draws the same parts
// for the window on screen.

export const NUM = "text-right tabular-nums whitespace-nowrap";
const TH = "px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground";
const TD = "px-2 py-1.5 align-top";

/** A kind's colour, as a small square beside its name. Category, never direction. */
export function KindDot({ kind }: { kind: string }) {
  return <span aria-hidden className={cn("inline-block h-2 w-2 shrink-0 rounded-sm", kindInfo(kind).swatch)} />;
}

/** The change a measure colours by, printed: a percentage of shares, or points of voting power. */
export function changeText(measure: InsightMeasure, value: number | null): string {
  return measure === "funds" ? formatSignedPct(value) : formatPp(value);
}

/** One bin's range as the legend states it. */
function binText(bin: DivergingBin, domain: number, measure: InsightMeasure): string {
  if (bin === 0) return measure === "funds" ? "no change" : "no stated change";
  const [lo, hi] = binRange(bin, domain);
  const fmt = (v: number) => (measure === "funds" ? formatSignedPct(v) : formatPp(v));
  if (!Number.isFinite(hi)) return `${fmt(lo)} or more`;
  if (!Number.isFinite(lo)) return `${fmt(hi)} or less`;
  return bin > 0 ? `up to ${fmt(hi)}` : `down to ${fmt(lo)}`;
}

/**
 * The diverging scale's key: every step with the range it covers, the midpoint,
 * and the hatched n/a. A visible key, so the colour never carries a value alone.
 */
export function ChangeLegend({
  measure,
  domain,
  title,
  naText,
  formatValue,
  naOnly = false,
}: {
  measure: InsightMeasure;
  domain: number;
  title: string;
  naText?: string;
  /** A custom printer for each step's bound (the heatmap's AUD flows). */
  formatValue?: (value: number) => string;
  /** No figure in view states a change: the steps would key nothing, so only n/a is shown. */
  naOnly?: boolean;
}) {
  const label = (bin: DivergingBin) => {
    if (!formatValue) return binText(bin, domain, measure);
    if (bin === 0) return "no change";
    const [lo, hi] = binRange(bin, domain);
    if (!Number.isFinite(hi)) return `${formatValue(lo)} or more`;
    if (!Number.isFinite(lo)) return `${formatValue(hi)} or less`;
    return bin > 0 ? `up to ${formatValue(hi)}` : `down to ${formatValue(lo)}`;
  };
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">{title}</p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {(naOnly ? [] : BINS).map((bin) => (
          <li key={bin} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn("inline-block h-3 w-3 rounded-sm", BIN_STYLES[bin].swatch)} />
            <span className="tabular-nums">{label(bin)}</span>
          </li>
        ))}
        {naText ? (
          <li className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn("inline-block h-3 w-3 rounded-sm", NA_STYLE.swatch)}
              style={{
                backgroundImage:
                  "repeating-linear-gradient(135deg, transparent 0 2px, hsl(var(--muted-foreground) / 0.45) 2px 3px)",
              }}
            />
            <span>{naText}</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** The market map as a table: every sector, both measures. */
export function SectorTable({ sectors, caption }: { sectors: readonly InsightSectorRow[]; caption: string }) {
  if (sectors.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-xs">
        <caption className="pb-2 text-left text-[11px] text-muted-foreground">{caption}</caption>
        <thead className="border-b border-border">
          <tr>
            <th scope="col" className={TH}>
              Sector
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Index funds hold
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Change in shares
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Change, AUD
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Disclosed stakes
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Notices, net
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {sectors.map((s) => (
            <tr key={s.sector}>
              <th scope="row" className={cn(TD, "text-left font-normal")}>
                {s.label}
                <span className="block text-[10px] text-muted-foreground">{s.stocks.toLocaleString("en-AU")} stocks</span>
              </th>
              <td className={cn(TD, NUM)}>{formatAud(s.fundValue)}</td>
              <td className={cn(TD, NUM)}>{formatSignedPct(s.fundChangePct)}</td>
              <td className={cn(TD, NUM)}>{formatSignedAud(s.fundFlow)}</td>
              <td className={cn(TD, NUM)}>{formatAud(s.disclosedValue)}</td>
              <td className={cn(TD, NUM)}>
                {s.notices > 0 ? formatPp(s.noticeNetPp) : "n/a"}
                <span className="block text-[10px] text-muted-foreground">
                  {s.notices.toLocaleString("en-AU")} notices
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A stock list: the market map's tiles as rows, for a sector or a drill. */
export function StockRows({
  stocks,
  measure,
  limit = 25,
}: {
  stocks: readonly InsightStockRow[];
  measure: InsightMeasure;
  limit?: number;
}) {
  if (stocks.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-xs">
        <thead className="border-b border-border">
          <tr>
            <th scope="col" className={TH}>
              Stock
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              {measure === "funds" ? "Index funds hold" : "Disclosed"}
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              {measure === "funds" ? "Change in shares" : "Notices, net"}
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              {measure === "funds" ? "Change, AUD" : "Notices"}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {stocks.slice(0, limit).map((s) => (
            <tr key={s.code}>
              <th scope="row" className={cn(TD, "text-left font-normal")}>
                <Link href={registerHref(s.code)} prefetch={false} className="font-medium text-primary hover:underline">
                  {s.code}
                </Link>{" "}
                <span className="text-muted-foreground">{s.name}</span>
              </th>
              <td className={cn(TD, NUM)}>
                {measure === "funds" ? formatAud(s.fundValue) : formatAud(s.disclosedValue)}
              </td>
              <td className={cn(TD, NUM)}>
                {measure === "funds" ? formatSignedPct(s.fundChangePct) : s.notices > 0 ? formatPp(s.noticeNetPp) : "n/a"}
              </td>
              <td className={cn(TD, NUM)}>
                {measure === "funds" ? formatSignedAud(s.fundFlow) : s.notices.toLocaleString("en-AU")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The money flow as a table: each institution with its kind and value, and each sector. */
export function FlowTable({ flow, caption }: { flow: InsightFlowRow; caption: string }) {
  const institutions = flow.nodes.filter((n) => n.column === 1).sort((a, b) => b.value - a.value);
  const sectors = flow.nodes.filter((n) => n.column === 2).sort((a, b) => b.value - a.value);
  if (institutions.length === 0) return null;
  const share = (v: number) => (flow.total > 0 ? `${((v / flow.total) * 100).toFixed(1)}%` : "n/a");
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {[
        { title: "Institution", rows: institutions },
        { title: "Sector", rows: sectors },
      ].map(({ title, rows }) => (
        <table key={title} className="w-full border-collapse text-xs">
          <caption className="pb-2 text-left text-[11px] text-muted-foreground">{caption}</caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH}>
                {title}
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Value
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Share
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((n) => (
              <tr key={n.id}>
                <th scope="row" className={cn(TD, "text-left font-normal")}>
                  <span className="inline-flex items-center gap-1.5">
                    {n.kind ? <KindDot kind={n.kind} /> : null}
                    {n.slug ? (
                      <Link href={`/ownership/${n.slug}`} prefetch={false} className="text-primary hover:underline">
                        {n.label}
                      </Link>
                    ) : (
                      n.label
                    )}
                  </span>
                </th>
                <td className={cn(TD, NUM)}>{formatAud(n.value)}</td>
                <td className={cn(TD, NUM)}>{share(n.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}

/** The heatmap as a table: one row per sector, one column per bucket, the measure's figure in each cell. */
export function HeatmapTable({ heatmap, measure, bucket }: { heatmap: InsightHeatmapRow; measure: InsightMeasure; bucket: "week" | "month" | "" }) {
  if (heatmap.rows.length === 0 || heatmap.buckets.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-[11px]">
        <thead className="border-b border-border">
          <tr>
            <th scope="col" className={TH}>
              Sector
            </th>
            {heatmap.buckets.map((b) => (
              <th key={b.start} scope="col" className={cn(TH, "text-right")}>
                <time dateTime={b.start} title={`${b.start} to ${b.end}`}>
                  {bucketLabel(b.start, bucket)}
                </time>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {heatmap.rows.map((row) => (
            <tr key={row.sector}>
              <th scope="row" className={cn(TD, "whitespace-nowrap text-left font-normal")}>
                {row.label}
              </th>
              {row.cells.map((c, i) => (
                <td key={i} className={cn(TD, NUM)}>
                  {measure === "funds" ? formatSignedAud(c.fundFlow) : c.notices > 0 ? formatPp(c.noticeNetPp) : "n/a"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EVENT_TEXT: Readonly<Record<string, string>> = {
  increased: "rose",
  decreased: "fell",
  became: "became substantial",
  ceased: "ceased",
  changed: "changed",
  nz: "NZ disclosure",
};

/** The window's largest stated moves: a notice's present less its previous figure, both stated. */
export function MovesList({ moves, empty }: { moves: readonly InsightMoveRow[]; empty: string }) {
  if (moves.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <ol className="divide-y divide-border/60 text-xs">
      {moves.map((m) => (
        <li key={m.url} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-1.5">
          <span className="min-w-0">
            <Link href={registerHref(m.code)} prefetch={false} className="font-medium text-primary hover:underline">
              {m.code}
            </Link>{" "}
            <span className="inline-flex items-center gap-1">
              <KindDot kind={m.kind} />
              {m.holderHref ? (
                <Link href={m.holderHref} prefetch={false} className="hover:underline">
                  {m.holder}
                </Link>
              ) : (
                <span>{m.holder}</span>
              )}
            </span>
            <span className="block text-[10px] text-muted-foreground">
              {EVENT_TEXT[m.event] ?? m.event}, now {m.votingPower}, as at <time dateTime={m.date}>{m.date}</time>
            </span>
          </span>
          <span className={NUM}>{m.change || "n/a"}</span>
        </li>
      ))}
    </ol>
  );
}

/** A chart's table form, folded under its chart: the same figures, readable without the chart. */
export function ChartTable({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Disclosure title={<span className="text-xs">{title}</span>} className="rounded-md border border-border/60 px-3 py-2">
      <div className="pt-3 text-foreground">{children}</div>
    </Disclosure>
  );
}

export { DISCLOSED_CAPTION };
