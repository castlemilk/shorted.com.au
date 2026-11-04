/**
 * The inspector's content for a company (spec 14.3, Market map and Overview): the
 * reported interests (the three largest holders, latest notice per holder), the
 * weight in each tracked fund (the latest weight per fund), the recent notices and
 * the links the wireframe names. A pure builder: it takes the two reads as plain
 * rows and returns the plain contract the rail draws, so the page's resolver (a
 * server action) and the tests share one answer.
 *
 * A disclosed figure is what the notices state, each interest counted once, never
 * a share of the company. The short position is never printed here (spec 13.8):
 * the rail links it, and the page owns that link.
 */

import type { FundSeriesRow, StockFundSeriesPage } from "~/app/actions/ownershipDesk";
import type { StockPanelPage } from "../../desk/stock-panel";
import type { DeskLens } from "../../desk/desk-state";
import { formatAmount, NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { fundHref, formLabel, formatHeadlinePct, kindInfo, registerHref } from "~/@/lib/ownership/kinds";
import { fundLabel } from "../../funds/fund-model";
import { shortSector } from "~/@/lib/ownership/kinds";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import type { InspectorContent, InspectorSection } from "../inspector-types";

/** The holders the rail names: the three largest, as the panel gives them. */
const HOLDER_BARS = 3;

/** The notices the rail lists: the five latest, as the panel gives them. */
const RECENT_NOTICES = 5;

/**
 * The notice window a stock's reading counts over, as dates. The desk resolves it the way the connections do
 * (the chip's days counted back from the newest notice the market read, or the brushed pair), so the count
 * is the one the map's instruments show for the same link. `days` is the chip's count, null for a brushed pair.
 */
export interface StockNoticeWindow {
  since: string;
  until: string;
  days: number | null;
}

/**
 * A fund's line under its weight (spec 14.10): its value in AUD at its own end file, and its change
 * in shares since its start file. Each part is n/a where the files do not state it. The value is the
 * point at the end file the fund's comparison names, never the newest point of the fund. A stock the
 * end file does not list is held there at zero shares (the series' rule), so a position that has left
 * the fund is worth A$0, not n/a.
 */
function fundDetail(fund: FundSeriesRow): string {
  const endDate = fund.change.endDate;
  // Without a comparison (a super option, or one file) the value is the newest point's that states one.
  const end =
    endDate === null
      ? latestValuedPoint(fund.points)
      : (fund.points.find((point) => point.asAt === endDate) ?? null);
  let value = end?.valueAud ?? null;
  if (endDate !== null && end === null && fund.change.endUnits === 0) value = 0;
  const valueText = value === null || !Number.isFinite(value) ? NOT_AVAILABLE : formatAmount(value, "AUD");
  return `Value ${valueText} · ${formatSharesSince(fund.change.unitsChange, fund.change.startDate)}`;
}

/** The notices feed filtered to one company, over every notice read. */
export function stockNoticesHref(code: string): string {
  return `/ownership/notices?${new URLSearchParams({ stock: code, window: "all" }).toString()}`;
}

/** A change in shares as the rail prints it: a true minus, thousands grouped, "n/a" when unknown. */
export function formatShareChange(shares: number | null): string {
  if (shares === null || !Number.isFinite(shares)) return NOT_AVAILABLE;
  const rounded = Math.round(shares);
  if (rounded === 0) return "0 shares";
  const magnitude = Math.abs(rounded).toLocaleString("en-AU", { maximumFractionDigits: 0 });
  return `${rounded > 0 ? "+" : "−"}${magnitude} shares`;
}

/**
 * A fund's change in shares with the date it runs from (spec 14.10): "+250,000 shares since
 * 2026-08-03". n/a when the change is unknown, and the date is left out with it.
 */
export function formatSharesSince(shares: number | null, since: string | null): string {
  if (shares === null || !Number.isFinite(shares)) return NOT_AVAILABLE;
  return since === null ? formatShareChange(shares) : `${formatShareChange(shares)} since ${since}`;
}

/** The newest point that states a value, or null when none does. */
function latestValuedPoint(points: FundSeriesRow["points"]): FundSeriesRow["points"][number] | null {
  let latest: FundSeriesRow["points"][number] | null = null;
  for (const point of points) {
    if (point.valueAud === null || !Number.isFinite(point.valueAud)) continue;
    if (latest === null || point.asAt > latest.asAt) latest = point;
  }
  return latest;
}

/** The latest weight a fund states for the stock, or null when no point carries one. */
export function latestFundWeight(
  points: StockFundSeriesPage["funds"][number]["points"],
): { pct: number; asAt: string } | null {
  let latest: { pct: number; asAt: string } | null = null;
  for (const point of points) {
    if (point.weightPct === null || !Number.isFinite(point.weightPct)) continue;
    if (latest === null || point.asAt > latest.asAt) latest = { pct: point.weightPct, asAt: point.asAt };
  }
  return latest;
}

function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The fund whose shares moved the most over its window, by the size of the change (spec 14.10). */
function largestUnitsMover(series: StockFundSeriesPage | null): { fund: FundSeriesRow; units: number } | null {
  if (series === null || !series.ok) return null;
  let best: { fund: FundSeriesRow; units: number } | null = null;
  for (const fund of series.funds) {
    const units = fund.change.unitsChange;
    if (units === null || !Number.isFinite(units) || Math.round(units) === 0) continue;
    if (best === null || Math.abs(units) > Math.abs(best.units)) best = { fund, units };
  }
  return best;
}

/**
 * The notices clause: how many of the rail's notices fall in the window, and the latest of them. The window
 * is the desk's dated window (see StockNoticeWindow); a window that could not be dated has no clause. The
 * panel carries the five latest only, so a full list whose oldest notice is still inside the window may hide
 * more of them: the count is then withheld rather than printed short.
 */
function noticesClause(panel: StockPanelPage, window: StockNoticeWindow | null): string | undefined {
  if (window === null || !isIsoDate(window.since) || !isIsoDate(window.until) || window.since > window.until) {
    return undefined;
  }
  const { since: from, until: to } = window;
  const listed = panel.notices;
  const inWindow = listed.filter((notice) => isIsoDate(notice.announcedOn) && notice.announcedOn >= from && notice.announcedOn <= to);
  // The oldest and the newest are taken by comparison, not by where the list happens to put them.
  const oldest = listed.reduce<string | null>(
    (min, notice) => (isIsoDate(notice.announcedOn) && (min === null || notice.announcedOn < min) ? notice.announcedOn : min),
    null,
  );
  const complete = listed.length < RECENT_NOTICES || (oldest !== null && oldest < from);
  if (!complete || inWindow.length === 0) return undefined;
  const last = inWindow.reduce((latest, notice) => (notice.announcedOn > latest ? notice.announcedOn : latest), "");
  const count = inWindow.length;
  const when = window.days === null ? `between ${from} and ${to}` : `in ${window.days} days`;
  return `${count} ${count === 1 ? "notice" : "notices"} ${when}, the last on ${last}`;
}

/**
 * The company's reading (spec 14.1, backlog C1): one plain sentence that leads the rail. Its clauses are the
 * big figure (the index share under the index lens, the disclosed share otherwise), the fund whose shares
 * moved most over its window, and the notices in the window. A missing figure drops its clause; with none
 * left there is no reading. The index funds' change is not a clause: the fund series states each fund's
 * weight in its portfolio, not the index's share of the company, so no change in that share is known here.
 */
export function stockReading(
  panel: StockPanelPage,
  series: StockFundSeriesPage | null,
  lens: DeskLens,
  notices: StockNoticeWindow | null,
): string | undefined {
  if (!panel.ok) return undefined;
  const indexLens = lens === "index";
  let figure: string | undefined;
  if (indexLens) {
    if (panel.index.pct !== null && Number.isFinite(panel.index.pct)) {
      figure = `Index funds hold ${formatHeadlinePct(panel.index.pct)}`;
    }
  } else if (panel.disclosedPct > 0) {
    figure = `Notices disclose ${formatHeadlinePct(panel.disclosedPct)}`;
  }
  const clauses: string[] = [];
  if (figure !== undefined) clauses.push(figure);
  const mover = largestUnitsMover(series);
  if (mover !== null) {
    // The manager names the move (Vanguard added ...); the ticker is the fallback for a fund with no manager on record.
    const subject = mover.fund.institutionName || fundLabel({ ticker: mover.fund.fundCode, name: mover.fund.fundName });
    // The magnitude is grouped as the rail's own share rows group it (1,200,000), never a compact form.
    const amount = Math.abs(Math.round(mover.units)).toLocaleString("en-AU", { maximumFractionDigits: 0 });
    const verb = mover.units > 0 ? `added ${amount} shares` : `reduced by ${amount} shares`;
    const since = mover.fund.change.startDate;
    clauses.push(`${subject} ${verb}${isIsoDate(since) ? ` since ${since}` : ""}`);
  }
  const noticeText = noticesClause(panel, notices);
  if (noticeText !== undefined) clauses.push(noticeText);
  return clauses.length > 0 ? `${clauses.join("; ")}.` : undefined;
}

/**
 * The company's rail. Null when the panel did not answer or nothing is on record:
 * the caller reports a failed read as an outage, and this never draws an empty
 * company in its place.
 */
export function stockInspectorContent(
  panel: StockPanelPage,
  series: StockFundSeriesPage | null,
  lens: DeskLens = "disclosed",
  notices: StockNoticeWindow | null = null,
): InspectorContent | null {
  if (!panel.ok) return null;
  const code = panel.code;
  // The big figure is the lens's (spec 14.3): the index lens reads the tracked index funds' share, every other the notices.
  const indexLens = lens === "index";
  const sections: InspectorSection[] = [];

  // The disclosed segments by kind, as the panel's bar draws them (spec 14.10).
  if (panel.disclosed.length > 0) {
    const kindMax = Math.max(0, ...panel.disclosed.map((segment) => segment.pct));
    sections.push({
      title: "By kind",
      kind: "bars",
      items: panel.disclosed.map((segment) => ({
        label: kindInfo(segment.kind).label,
        value: formatHeadlinePct(segment.pct),
        share: kindMax > 0 ? segment.pct / kindMax : 0,
        detail: `${segment.holders} ${segment.holders === 1 ? "holder" : "holders"}`,
      })),
    });
  }

  const holders = panel.largest.slice(0, HOLDER_BARS);
  const holderMax = Math.max(0, ...holders.map((holder) => holder.votingPowerPct ?? 0));
  if (holders.length > 0) {
    sections.push({
      title: "Reported interests",
      kind: "bars",
      items: holders.map((holder) => ({
        label: holder.name,
        value: formatHeadlinePct(holder.votingPowerPct),
        share:
          holderMax > 0 && holder.votingPowerPct !== null ? holder.votingPowerPct / holderMax : 0,
      })),
    });
  }

  const funds = (series?.funds ?? []).flatMap((fund) => {
    const latest = latestFundWeight(fund.points);
    return latest === null ? [] : [{ fund, latest }];
  });
  const fundMax = Math.max(0, ...funds.map((row) => row.latest.pct));
  if (funds.length > 0) {
    sections.push({
      // The wireframe's heading (spec 14.3). Each row is the fund by its ticker, else its name (spec 14.7),
      // with the institution as the row's title.
      title: "Fund contributions",
      kind: "bars",
      items: funds.map(({ fund, latest }) => ({
        label: fundLabel({ ticker: fund.fundCode, name: fund.fundName }),
        href: fundHref(fund.fundKey),
        title: fund.institutionName,
        value: `${formatHeadlinePct(latest.pct)} at ${latest.asAt}`,
        // The fund's value in AUD, and its change in shares since its start file (spec 14.10).
        detail: fundDetail(fund),
        share: fundMax > 0 ? latest.pct / fundMax : 0,
      })),
    });
  }

  if (panel.notices.length > 0) {
    sections.push({
      title: "Recent activity",
      kind: "series",
      items: panel.notices.slice(0, RECENT_NOTICES).map((notice) => ({
        label: notice.announcedOn,
        value: `${notice.holderName} · ${formLabel(notice.form, notice.ceased)}`,
      })),
    });
  }

  return {
    // The code is the name the rail carries, the company's name beneath it (spec 14.3).
    heading: code,
    reading: stockReading(panel, series, lens, notices),
    // The name and the sector, as the wireframe prints them (spec 14.8); a stock with no industry reads "Other".
    subtitle: panel.companyName ? [panel.companyName, shortSector(panel.industry)].join(" · ") : undefined,
    logo: { kind: "stock", code },
    badges: ["Company"],
    figure: indexLens
      ? { value: formatHeadlinePct(panel.index.pct), caption: "Held by tracked index funds" }
      : {
          value: panel.disclosedPct > 0 ? formatHeadlinePct(panel.disclosedPct) : "n/a",
          caption: "Disclosed by notices",
        },
    // The figure the lens does not draw sits beside it, so the two readings are both on the rail.
    rows: [
      indexLens
        ? { label: "Disclosed by notices", value: panel.disclosedPct > 0 ? formatHeadlinePct(panel.disclosedPct) : "n/a" }
        : { label: "Index funds tracked", value: formatHeadlinePct(panel.index.pct) },
    ],
    sections,
    // The lens's own line (spec 14.8), then the bars' caption: what the notices disclose is never a share of the company.
    note: `${indexLens ? "Holdings dates vary." : "Latest notice per holder."} What the notices disclose, each interest counted once; not a share of the company.`,
    primary: { label: "Open ownership →", href: registerHref(code) },
    links: [
      { label: `All notices for ${code} →`, href: stockNoticesHref(code), nofollow: true },
      { label: "Stock overview →", href: stockTabHref(code, "overview") },
      { label: "Short interest →", href: stockTabHref(code, "short-interest") },
      { label: "View source files", href: `${registerHref(code)}#funds` },
    ],
    footnote: "Selection highlights this company and sector across the workspace.",
  };
}
