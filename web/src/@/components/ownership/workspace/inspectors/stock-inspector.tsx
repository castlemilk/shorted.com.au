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

import type { StockFundSeriesPage } from "~/app/actions/ownershipDesk";
import type { StockPanelPage } from "../../desk/stock-panel";
import type { DeskLens } from "../../desk/desk-state";
import { fundHref, formLabel, formatVotingPower, registerHref } from "~/@/lib/ownership/kinds";
import { fundLabel } from "../../funds/fund-model";
import { shortSector } from "~/@/lib/ownership/kinds";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import type { InspectorContent, InspectorSection } from "../inspector-types";

/** The holders the rail names: the three largest, as the panel gives them. */
const HOLDER_BARS = 3;
/** The notices the rail lists: the five latest, as the panel gives them. */
const RECENT_NOTICES = 5;

/** The notices feed filtered to one company, over every notice read. */
export function stockNoticesHref(code: string): string {
  return `/ownership/notices?${new URLSearchParams({ stock: code, window: "all" }).toString()}`;
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

/**
 * The company's rail. Null when the panel did not answer or nothing is on record:
 * the caller reports a failed read as an outage, and this never draws an empty
 * company in its place.
 */
export function stockInspectorContent(
  panel: StockPanelPage,
  series: StockFundSeriesPage | null,
  lens: DeskLens = "disclosed",
): InspectorContent | null {
  if (!panel.ok) return null;
  const code = panel.code;
  // The big figure is the lens's (spec 14.3): the index lens reads the tracked index funds' share, every other the notices.
  const indexLens = lens === "index";
  const sections: InspectorSection[] = [];

  const holders = panel.largest.slice(0, HOLDER_BARS);
  const holderMax = Math.max(0, ...holders.map((holder) => holder.votingPowerPct ?? 0));
  if (holders.length > 0) {
    sections.push({
      title: "Reported interests",
      kind: "bars",
      items: holders.map((holder) => ({
        label: holder.name,
        value: formatVotingPower(holder.votingPowerPct),
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
        value: `${formatVotingPower(latest.pct)} at ${latest.asAt}`,
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
    // The name and the sector, as the wireframe prints them (spec 14.8); a stock with no industry reads "Other".
    subtitle: panel.companyName ? [panel.companyName, shortSector(panel.industry)].join(" · ") : undefined,
    logo: { kind: "stock", code },
    badges: ["Company"],
    figure: indexLens
      ? { value: formatVotingPower(panel.index.pct), caption: "Held by tracked index funds" }
      : {
          value: panel.disclosedPct > 0 ? formatVotingPower(panel.disclosedPct) : "n/a",
          caption: "Disclosed by notices",
        },
    // The figure the lens does not draw sits beside it, so the two readings are both on the rail.
    rows: [
      indexLens
        ? { label: "Disclosed by notices", value: panel.disclosedPct > 0 ? formatVotingPower(panel.disclosedPct) : "n/a" }
        : { label: "Index funds tracked", value: formatVotingPower(panel.index.pct) },
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
