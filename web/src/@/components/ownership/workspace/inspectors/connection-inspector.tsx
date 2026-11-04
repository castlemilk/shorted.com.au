/**
 * The inspector's content for a connection (spec 14.3, Connections): one holder
 * kind to one sector, as the sankey's band names it. The companies on the
 * connection are the band's own data (spec 14.7): the current positions of that
 * kind in that sector, read from the registers, sorted by the kind's estimated
 * exposure, the ten largest first. Never the notice feed's recent window.
 *
 * A pure builder over plain rows: the resolver reads the registers and passes them
 * here, so the page and the tests share one answer.
 */

import { OTHER_SECTOR } from "~/@/components/ownership/desk/map-layout";
import { formatAmount, NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { FOLDED_SECTOR_LABEL, formatHeadlinePct, holderHref, kindInfo, registerHref, shortSector } from "~/@/lib/ownership/kinds";
import type { InspectorContent, InspectorLink, InspectorSection } from "../inspector-types";
import { windowNetText } from "./window-net";

/** The companies the rail draws: the ten largest, as the band's own list is. */
export const COMPANY_LIMIT = 10;

/** One company on a connection: the kind's estimated exposure in it, and its newest notice. */
export interface ConnectionCompany {
  code: string;
  name: string;
  /** The kind's share of the company as the notices disclose it; null when it states none. */
  pct: number | null;
  /** The company's market capitalisation; null when the register has none. */
  marketCap?: number | null;
  /** The newest notice release date behind the company's figure; "" when none. */
  latestNotice: string;
}

/**
 * The kind's estimated exposure in a company: its share of the company times the
 * market capitalisation (spec 14.7). Null when either figure is missing; a company
 * with no market cap is ranked by its share alone, after the ranked ones.
 */
export function estimatedExposure(company: ConnectionCompany): number | null {
  if (company.pct === null || company.marketCap == null) return null;
  return (company.pct / 100) * company.marketCap;
}

/** The register list for one connection: the same filters the register page reads. */
export function connectionRegisterHref(holderKind: string, sector: string): string {
  const params = new URLSearchParams({ sort: "disclosed", kind: holderKind, industry: sector });
  return `/ownership/stocks?${params.toString()}`;
}

/** The notice window a connection's links carry: the chips' days, or a brushed pair (spec 14.8). */
export interface ConnectionSpan {
  window: string;
  since: string;
  until: string;
}

/**
 * A notice the Change view lists: the release date, the company and the holder. `changePp` is the notice's own
 * change in points, null (or absent) when it states none; the window's net is printed only when every notice has one.
 */
export interface ConnectionNotice {
  released: string;
  code: string;
  holder: string;
  changePp?: number | null;
}

/** One holder of the band, as the flows name it (spec 14.10): its page's slug, exposure and holdings. */
export interface BandHolder {
  slug: string;
  name: string;
  /** The holder's estimated exposure in the band; null when it cannot be estimated. */
  exposureAud: number | null;
  holdings: number;
}

/** The holders the rail lists: at most this many, as the band names them. */
export const HOLDER_LIMIT = 10;

/** The notices feed for one connection: the holder kind and the sector, over the link's window. */
export function connectionNoticesHref(
  holderKind: string,
  sector: string,
  span: ConnectionSpan = { window: "91", since: "", until: "" },
): string {
  const params = new URLSearchParams({ kind: holderKind, industry: sector });
  if (span.since !== "" && span.until !== "") {
    params.set("since", span.since);
    params.set("until", span.until);
  } else {
    params.set("window", span.window || "91");
  }
  return `/ownership/notices?${params.toString()}`;
}

/** Whether the companies carry more than one notice date: the connection's figures are not one date. */
export function hasMixedDates(companies: readonly ConnectionCompany[]): boolean {
  return new Set(companies.map((company) => company.latestNotice).filter((date) => date !== "")).size > 1;
}

/**
 * The band's companies in the order the rail lists them (spec 14.7): by estimated exposure, then by the
 * kind's share, then by code. A company with no exposure sorts after the ranked ones.
 */
export function rankedCompanies(companies: readonly ConnectionCompany[]): ConnectionCompany[] {
  return [...companies].sort(
    (a, b) =>
      (estimatedExposure(b) ?? -1) - (estimatedExposure(a) ?? -1) ||
      (b.pct ?? -1) - (a.pct ?? -1) ||
      a.code.localeCompare(b.code),
  );
}

/**
 * The connection's reading (spec 14.1, backlog C1): the band's company count and its largest company by
 * exposure. In the Change view it is the window's notice count, with the window's net change when every notice
 * is listed and states its change (the net is summed from the notices' own points, as the grid sums them).
 * A withheld band (no registers, Other, the folded tail) has no reading.
 */
export function connectionReading({
  holderKind,
  sector,
  companies,
  total = 0,
  view = "positions",
  notices = null,
}: {
  holderKind: string;
  sector: string;
  companies: readonly ConnectionCompany[] | null;
  total?: number;
  view?: "positions" | "changes";
  notices?: { rows: readonly ConnectionNotice[]; total: number } | null;
}): string | undefined {
  if (companies === null || sector === OTHER_SECTOR || sector === FOLDED_SECTOR_LABEL) return undefined;
  if (view === "changes" && notices !== null && notices.total > 0) {
    const net = windowNetText(notices.rows, notices.total);
    const head = `${notices.total} ${notices.total === 1 ? "notice" : "notices"} in the window`;
    return `${head}${net === undefined ? "" : `, net ${net}`}.`;
  }
  const count = Math.max(total, companies.length);
  if (count === 0) return undefined;
  const ranked = rankedCompanies(companies);
  const largest = ranked[0];
  const largestText =
    largest !== undefined && estimatedExposure(largest) !== null
      ? `${largest.code} largest at ${formatAmount(estimatedExposure(largest), "AUD")}`
      : undefined;
  const head = `${kindInfo(holderKind).plural} hold ${count} ${count === 1 ? "company" : "companies"} in ${shortSector(sector)}`;
  return `${[head, largestText].filter((part) => part !== undefined).join(", ")}.`;
}

/**
 * The connection's rail. `companies` is null when the registers could not be read
 * for the band (the caller reports the outage); `total` is the register's count of
 * companies on the connection, which may be more than the list carries.
 * `selectedCode` is the company the workspace has selected, if it is on the connection.
 */
export function connectionInspectorContent({
  holderKind,
  sector,
  companies,
  total = 0,
  selectedCode = "",
  view = "positions",
  span = { window: "91", since: "", until: "" },
  notices = null,
  holders = null,
}: {
  holderKind: string;
  sector: string;
  companies: readonly ConnectionCompany[] | null;
  total?: number;
  selectedCode?: string;
  /** The Connections view: current positions, or the window's notices (spec 14.7). */
  view?: "positions" | "changes";
  span?: ConnectionSpan;
  /** The window's notices for this kind and sector, read for the Change view; null when unread. */
  notices?: { rows: readonly ConnectionNotice[]; total: number } | null;
  /** The band's largest holders from the flows; null when they were not read (no section is drawn). */
  holders?: readonly BandHolder[] | null;
}): InspectorContent {
  const holder = kindInfo(holderKind).plural;
  // The folded tail (spec 14.9) is several sectors, not one industry: it names no register filter, so nothing links to one.
  if (sector === FOLDED_SECTOR_LABEL) {
    return {
      heading: `${holder} → ${FOLDED_SECTOR_LABEL}`,
      subtitle: `${kindInfo(holderKind).label} to the sectors past the six largest`,
      badges: [holder],
      rows: [{ label: "Companies on this connection", value: "n/a" }],
      note: "The sectors past the six largest are folded. Expand Other + to inspect one of them.",
      footnote: "Click a band on the connections map to select it.",
    };
  }
  // The placeholder sector is not a register filter: the Other connection's companies are withheld, never the whole market's.
  if (sector === OTHER_SECTOR || companies === null) {
    return {
      heading: `${holder} → ${shortSector(sector)}`,
      subtitle: `${kindInfo(holderKind).label} to ${sector}`,
      badges: [holder],
      rows: [{ label: "Companies on this connection", value: "n/a" }],
      note: "Other's companies are not filtered by sector, so they are withheld.",
      footnote: "Click a band on the connections map to select it.",
    };
  }

  // Ranked by estimated exposure, then by the kind's share, then by code (spec 14.7).
  const ranked = rankedCompanies(companies);
  const listed = ranked.slice(0, COMPANY_LIMIT);
  // The bars are the exposure when the register gives market caps, else the kind's share alone.
  const byExposure = listed.some((company) => estimatedExposure(company) !== null);
  const measure = (company: ConnectionCompany) => (byExposure ? (estimatedExposure(company) ?? 0) : (company.pct ?? 0));
  const largest = Math.max(0, ...listed.map(measure));
  const sections: InspectorSection[] = [];
  const changes = view === "changes";
  if (changes) {
    // The Change view lists the window's notices, not the register's positions (spec 14.7).
    // A window with no notice says so; an unread window draws no line (never "none"). Each
    // notice names its company, and the company links to its register page (spec 14.8).
    if (notices === null) {
      sections.push({ title: "Notices in this window", kind: "list", items: [] });
    } else if (notices.rows.length === 0) {
      sections.push({ title: "Notices in this window", kind: "rows", items: [{ label: "No notices in this window.", value: "" }] });
    } else {
      sections.push({
        title: "Notices in this window",
        kind: "list",
        items: notices.rows.map((notice) => ({
          label: `${notice.released} ${notice.code} · ${notice.holder}`,
          href: registerHref(notice.code),
        })),
      });
    }
  } else if (listed.length > 0) {
    const ordered = [...listed].sort((a, b) => Number(b.code === selectedCode) - Number(a.code === selectedCode));
    sections.push({
      title: "Companies on this connection",
      kind: "bars",
      items: ordered.map((company) => ({
        // Each company row links to its register page (spec 14.8).
        href: registerHref(company.code),
        label: company.code === selectedCode ? `${company.code} (selected)` : company.code,
        // The figure is the bar's own measure: the exposure when the bars draw it, else the share.
        value: byExposure
          ? estimatedExposure(company) === null
            ? NOT_AVAILABLE
            : formatAmount(estimatedExposure(company), "AUD")
          : formatHeadlinePct(company.pct),
        share: largest > 0 ? measure(company) / largest : 0,
      })),
    });
  }

  // The band's holders, largest exposure first, each named by its page (spec 14.10).
  if (holders && holders.length > 0) {
    const listedHolders = holders.slice(0, HOLDER_LIMIT);
    const largestExposure = Math.max(0, ...listedHolders.map((holder) => holder.exposureAud ?? 0));
    sections.push({
      title: "Holders on this connection",
      kind: "bars",
      items: listedHolders.map((holder) => ({
        label: holder.name,
        href: holderHref(holder.slug) ?? undefined,
        value: formatAmount(holder.exposureAud, "AUD"),
        detail: `${holder.holdings} ${holder.holdings === 1 ? "holding" : "holdings"}`,
        share: largestExposure > 0 && holder.exposureAud !== null ? holder.exposureAud / largestExposure : 0,
      })),
    });
  }

  const evidence: InspectorLink[] = [
    { label: "Holder notices", href: connectionNoticesHref(holderKind, sector, span) },
    { label: "Calculation method", href: "/ownership#method" },
  ];
  sections.push({ title: "Evidence", kind: "list", items: evidence });

  // The primary opens the band's largest company (spec 14.8); a band with none has no primary.
  const largestCompany = ranked[0];
  const notes = [
    hasMixedDates(companies) ? "Underlying notices have different dates." : "",
    "Reported interests may overlap.",
  ].filter((line) => line !== "");
  const more = total > listed.length || companies.length > listed.length
    ? [{ label: `All ${Math.max(total, companies.length)} companies on the register →`, href: connectionRegisterHref(holderKind, sector) }]
    : [];
  const viewMore = changes && notices !== null && notices.total > notices.rows.length
    ? [{ label: `All ${notices.total} notices in this window →`, href: connectionNoticesHref(holderKind, sector, span) }]
    : [];
  return {
    heading: `${holder} → ${shortSector(sector)}`,
    subtitle: `${kindInfo(holderKind).label} to ${sector}`,
    reading: connectionReading({ holderKind, sector, companies, total, view, notices }),
    badges: [holder],
    // A served band with no company is a real zero, not an unknown.
    rows: [{ label: "Companies on this connection", value: String(Math.max(total, companies.length)) }],
    sections,
    note: notes.join(" "),
    primary: largestCompany ? { label: `Open ${largestCompany.code} →`, href: registerHref(largestCompany.code) } : undefined,
    links: [
      { label: "View contributing records →", href: connectionNoticesHref(holderKind, sector, span) },
      ...viewMore,
      ...more,
    ],
    footnote: "Click a band on the connections map to select it.",
  };
}
