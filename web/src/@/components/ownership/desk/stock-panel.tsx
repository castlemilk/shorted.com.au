/**
 * The stock panel beside the map (spec 13.2, amended by 13.8): one stock's register
 * as the desk reads it, opened by a click on its cell. The code and name, the
 * disclosed bar by kind, the three largest holders with their figures and dates, the
 * index fund share with its file dates, the five latest notices, and the links to
 * the record. The short position is never a figure here: kinds and short interest
 * do not share a panel (sections 11 and 12), so the panel links it instead.
 *
 * A PLAIN MODULE with hooks, drawn by the map island; it reaches no protobuf,
 * Connect or action at run time. The register arrives through `loadPanel`, a
 * prop, so the island never imports a loader. The panel is a labelled region with
 * its own close button, not a dialog: the map stays in reach beside it.
 *
 * EDITORIAL. Every sum is what the notices disclose, not a share of the company;
 * a figure the page does not hold is n/a, never 0; a date is printed in a time
 * element with its own ISO value.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { DisclosedBar, type DisclosedSegment } from "~/@/components/ownership/disclosed-bar";
import { HolderName } from "~/@/components/ownership/ownership-parts";
import { formatDate, formatPct, NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { formLabel, formatVotingPower, kindInfo, registerHref } from "~/@/lib/ownership/kinds";
import { defaultNoticeQuery, NOTICE_WINDOW_ALL, serialiseNoticeParams } from "~/@/lib/ownership/query";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { OUTAGE_AFTER_MS, LOADING_COPY } from "./ownership-map-static";

/** One holder of the stock, as the panel prints it. */
export interface PanelHolder {
  name: string;
  slug: string;
  /** The holder key the institution link is built from (`asx:CODE` for a listed holder). */
  holderKey: string;
  kind: string;
  votingPowerPct: number | null;
  /** The notice's own date, YYYY-MM-DD; "" when the notice states none. */
  asAt: string;
}

/** One notice of the stock, newest first. */
export interface PanelNotice {
  announcedOn: string;
  form: string;
  ceased: boolean;
  holderName: string;
}

/** One stock's register as the panel prints it. */
export interface StockPanelPage {
  ok: boolean;
  code: string;
  companyName: string;
  /** The disclosed segments by kind, and their total, as the bar draws them. */
  disclosed: DisclosedSegment[];
  disclosedPct: number;
  /** The largest holders, at most three, by voting power. */
  largest: PanelHolder[];
  /** The index-fund share, with the file dates it was read across (optional: a page without them still draws). */
  index: { pct: number | null; asAt: string; asAtFrom?: string; files?: number };
  notices: PanelNotice[];
}

export interface StockPanelProps {
  code: string;
  /** The register for one stock. Resolves ok: false on an outage, never throws. */
  loadPanel: (code: string) => Promise<StockPanelPage>;
  /** The bar's scale: the largest disclosed total on the page, so the bars compare. */
  scaleMax: number;
  onClose: () => void;
}

/** panel.outage: one stock's register could not be read; nothing is missing from the register. */
const PANEL_OUTAGE_COPY =
  "This stock's register could not be read just now. Nothing here is missing from the register: this is our end.";

/** panel.ceased (register.ceased, shortened): no current holder read for the stock. */
function noHolderCopy(code: string): string {
  return `No current substantial holder read for ${code}.`;
}

/** A date as a time element; n/a when there is none. */
function DateText({ iso }: { iso: string }) {
  if (iso === "") return <span>{NOT_AVAILABLE}</span>;
  const printed = formatDate(iso);
  return printed === "" ? <span>{NOT_AVAILABLE}</span> : <time dateTime={iso}>{printed}</time>;
}

type PanelStatus = "loading" | "ready" | "error";

/**
 * The panel. It reads its stock when the code changes, ignores an answer that
 * arrives after the code has moved on or the panel has closed, and says it is
 * slow after OUTAGE_AFTER_MS.
 */
export function StockPanel({ code, loadPanel, scaleMax, onClose }: StockPanelProps) {
  const [status, setStatus] = useState<PanelStatus>("loading");
  const [slow, setSlow] = useState(false);
  const [page, setPage] = useState<StockPanelPage | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    const ticket = (sequence.current += 1);
    setStatus("loading");
    setSlow(false);
    const timer = setTimeout(() => {
      if (sequence.current === ticket) setSlow(true);
    }, OUTAGE_AFTER_MS);
    loadPanel(code).then(
      (result) => {
        if (sequence.current !== ticket) return;
        clearTimeout(timer);
        setPage(result.ok ? result : null);
        setStatus(result.ok ? "ready" : "error");
      },
      () => {
        if (sequence.current !== ticket) return;
        clearTimeout(timer);
        setPage(null);
        setStatus("error");
      },
    );
    return () => {
      clearTimeout(timer);
      sequence.current += 1;
    };
  }, [code, loadPanel]);

  const headingId = `stock-panel-${code}`;
  return (
    <aside
      aria-labelledby={headingId}
      className="mt-6 min-w-0 space-y-4 border-t pt-4 lg:mt-0 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="text-sm font-semibold [overflow-wrap:anywhere]">
            {page?.companyName ? page.companyName : code}
          </h3>
          <p className="font-mono text-[11px] tabular-nums text-muted-foreground">ASX:{code}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${code}`}
          className="hit-target shrink-0 rounded-sm border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          Close
        </button>
      </div>

      {status === "loading" ? (
        <p role="status" aria-busy="true" aria-label="Loading" className="text-sm text-muted-foreground">
          {slow ? PANEL_OUTAGE_COPY : LOADING_COPY}
        </p>
      ) : null}

      {status === "error" ? (
        <p role="status" className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {PANEL_OUTAGE_COPY}
        </p>
      ) : null}

      {status === "ready" && page ? <PanelBody page={page} scaleMax={scaleMax} /> : null}

      <nav aria-label={`${code} links`} className="flex flex-wrap gap-x-4 gap-y-2 border-t pt-3 text-xs">
        <Link href={registerHref(code)} prefetch={false} className="text-primary underline-offset-4 hover:underline">
          Full register
        </Link>
        <Link href={stockTabHref(code, "overview")} prefetch={false} className="text-primary underline-offset-4 hover:underline">
          Overview
        </Link>
        <Link href={stockTabHref(code, "short-interest")} prefetch={false} className="text-primary underline-offset-4 hover:underline">
          Short interest →
        </Link>
        <Link
          href={`/ownership/notices?${serialiseNoticeParams({ ...defaultNoticeQuery(), windowDays: NOTICE_WINDOW_ALL, stockCode: code }).toString()}`}
          prefetch={false}
          rel="nofollow"
          className="text-primary underline-offset-4 hover:underline"
        >
          All notices for {code}
        </Link>
      </nav>
    </aside>
  );
}

/** The panel's figures, drawn from a register that answered. */
function PanelBody({ page, scaleMax }: { page: StockPanelPage; scaleMax: number }) {
  return (
    <div className="space-y-5">
      <DisclosedBar
        segments={page.disclosed}
        total={page.disclosedPct}
        scaleMax={scaleMax}
        caption="What the notices disclose, each interest counted once; not a share of the company."
      />

      <section aria-label="Largest holders" className="space-y-2">
        <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground">Largest holders</h4>
        {page.largest.length === 0 ? (
          <p className="text-sm text-muted-foreground">{noHolderCopy(page.code)}</p>
        ) : (
          <ol className="space-y-2">
            {page.largest.map((holder) => (
              <li key={`${holder.holderKey}-${holder.name}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-sm">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <HolderName name={holder.name} slug={holder.slug} holderKey={holder.holderKey} />
                  <span className="block text-[11px] text-muted-foreground">{kindInfo(holder.kind).label}</span>
                </span>
                <span className="text-right tabular-nums">
                  {formatVotingPower(holder.votingPowerPct)}
                  <span className="block text-[11px] text-muted-foreground">
                    <DateText iso={holder.asAt} />
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
        <dt className="text-muted-foreground">Index funds tracked</dt>
        <dd className="text-right tabular-nums">
          {page.index.pct === null ? (
            <span>
              {NOT_AVAILABLE}
              <span className="block text-[11px] text-muted-foreground">no file tracked holds it</span>
            </span>
          ) : (
            <span>
              {formatPct(page.index.pct, { digits: 2 })}
              {/* The qualifier sits under the figure: beside it, it wrapped the narrow column
                  into four lines (the visual pass of 2026-11-03). */}
              <span className="block text-[11px] text-muted-foreground">
                of shares on issue, as at <DateText iso={page.index.asAt} />
              </span>
            </span>
          )}
        </dd>
      </dl>

      <section aria-label="Latest notices" className="space-y-2">
        <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground">Latest notices</h4>
        {page.notices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No substantial holding notice read for {page.code}.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {page.notices.slice(0, 5).map((notice, index) => (
              <li key={`${notice.announcedOn}-${index}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
                <span className="tabular-nums text-muted-foreground">
                  <DateText iso={notice.announcedOn} />
                </span>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {formLabel(notice.form, notice.ceased)}: {notice.holderName}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
