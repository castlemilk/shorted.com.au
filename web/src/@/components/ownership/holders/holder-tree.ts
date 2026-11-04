/**
 * The holders workspace as plain data (spec 14.3, Holders; 14.2 for the logos):
 * one holder's disclosed interests grouped by sector, each company's ribbon by
 * estimated exposure, the holder's inspector content, and the URL codec the
 * holders page and the institution page read (`?holder=`, and the selection in
 * `?sel=`).
 *
 * PURE. No React, no DOM, no Connect and no generated code (a structural type
 * stands for each message): the server actions build these rows, the islands
 * draw them, and the tests read them without a browser.
 *
 * ESTIMATES, NOT CASH. An exposure is voting power times market cap, which assumes
 * the voting power is of the shares on issue. A company with no market cap on
 * record has no exposure: it is drawn as a hairline and says so, never as zero.
 */

import { industryLabel } from "@/lib/industry-placeholder";
import { formatAmount, formatDate } from "~/@/lib/fundamentals/format";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { formatHeadlinePct, isInstitutionSlug, kindInfo } from "~/@/lib/ownership/kinds";
import type {
  InspectorContent,
  InspectorLink,
  InspectorSection,
} from "~/@/components/ownership/workspace/inspector-types";
import { holderReading } from "../workspace/inspectors/holder-reading";
import { noticesByWeekSection, type WeekNotices } from "../workspace/week-strip";
import type { Selection } from "~/@/components/ownership/workspace/selection";

/* ------------------------------------------------------------------ */
/* Plain rows                                                         */
/* ------------------------------------------------------------------ */

/** One holder of the directory, with the count of its current disclosed positions. */
export interface HolderRow {
  key: string;
  name: string;
  kind: string;
  website: string;
  /** Current substantial holdings (5% or more), as the register counts them. */
  positions: number;
  latestNoticeDate: string;
}

/**
 * A directory row: the holder's row and, from the register, how many of its current positions became
 * substantial in the default window (backlog C3b). Optional so a row without the count reads as none.
 */
export type DirectoryHolder = HolderRow & { positionsGained?: number };

/** One current substantial holding of one holder, with the stock's market cap when on record. */
export interface HolderPosition {
  stockCode: string;
  companyName: string;
  industry: string;
  votingPowerPct: number;
  eventDate: string;
  /** The release date ASX carries for the notice; the fallback when the event date is missing. */
  announcedOn?: string;
  /** The latest notice's form: "603", "604", "605" or "nz". Read by the reading's "new this quarter" clause. */
  form?: string;
  announcementUrl: string;
  marketCap: number | null;
}

/** The raw fields a position carries before its market cap is joined (so `form` is carried too). */
export type RawPosition = Omit<HolderPosition, "marketCap">;

/** One index fund or super option the holder runs, for the inspector's Funds and products tab. */
export interface HolderFundRow {
  key: string;
  name: string;
  asxCode: string;
  fundType: string;
  /** Null when the fund states no size (never zero). */
  sizeAud: number | null;
}

export interface HoldersDirectoryPage {
  ok: boolean;
  /** Why the read was refused; "" for an outage or a served answer. */
  error: string;
  holders: HolderRow[];
  total: number;
}

export interface HolderConnectionsPage {
  ok: boolean;
  error: string;
  holder: HolderRow | null;
  positions: HolderPosition[];
  funds: HolderFundRow[];
  /** False when the market caps could not be read: every width is then a hairline, and the page says so. */
  capsOk: boolean;
  /**
   * The holder's notice dates for its "Notices by week" strip (backlog C6). Null, or absent, when they
   * could not be read whole, so the strip is dropped rather than drawn over unread weeks.
   */
  weekNotices?: WeekNotices | null;
}

/** The fields of an institution a holder row is made from (structural: no generated type). */
export interface InstitutionFields {
  slug: string;
  name: string;
  kind: string;
  website: string;
  substantialPositions: number;
  latestNoticeDate: string;
}

/** The fields of an institution's fund a holder's fund row is made from (structural). */
export interface InstitutionFundFields {
  fundKey: string;
  name: string;
  asxCode: string;
  fundType: string;
  hasSize: boolean;
  sizeAud: number;
}

export function holderRowFrom(inst: InstitutionFields): HolderRow {
  return {
    key: inst.slug,
    name: inst.name,
    kind: inst.kind,
    website: inst.website,
    positions: inst.substantialPositions,
    latestNoticeDate: inst.latestNoticeDate,
  };
}

export function holderFundRow(fund: InstitutionFundFields): HolderFundRow {
  return {
    key: fund.fundKey,
    name: fund.name,
    asxCode: fund.asxCode,
    fundType: fund.fundType,
    sizeAud: fund.hasSize && Number.isFinite(fund.sizeAud) ? fund.sizeAud : null,
  };
}

/** A stock's market cap, by code, from the map (null where the register holds none). */
export function marketCapsOf(
  stocks: readonly { code: string; marketCap: number | null }[],
): ReadonlyMap<string, number | null> {
  const caps = new Map<string, number | null>();
  for (const stock of stocks) {
    const cap = stock.marketCap;
    caps.set(stock.code, cap !== null && Number.isFinite(cap) && cap > 0 ? cap : null);
  }
  return caps;
}

/**
 * A holder's positions with each stock's market cap joined. A stock missing from
 * the map has no cap on record. With no map (`caps` null) every cap is null.
 */
export function holderPositions(
  rows: readonly RawPosition[],
  caps: ReadonlyMap<string, number | null> | null,
): HolderPosition[] {
  return rows.map((row) => ({
    stockCode: row.stockCode,
    companyName: row.companyName,
    industry: row.industry,
    votingPowerPct: row.votingPowerPct,
    eventDate: row.eventDate,
    announcedOn: row.announcedOn,
    form: row.form,
    announcementUrl: row.announcementUrl,
    marketCap: caps?.get(row.stockCode) ?? null,
  }));
}

/** The connections page of a holder that was read: the one shape the actions and the static page share. */
export function connectionsPage(
  holder: HolderRow,
  rows: readonly RawPosition[],
  caps: ReadonlyMap<string, number | null> | null,
  funds: readonly HolderFundRow[] = [],
): HolderConnectionsPage {
  return {
    ok: true,
    error: "",
    holder,
    positions: holderPositions(rows, caps),
    funds: [...funds],
    capsOk: caps !== null,
  };
}

/* ------------------------------------------------------------------ */
/* Exposure and the tree                                              */
/* ------------------------------------------------------------------ */

/** Voting power times market cap, in AUD; null when either is missing (never zero). */
export function exposureOf(votingPowerPct: number, marketCap: number | null): number | null {
  if (marketCap === null || !Number.isFinite(marketCap) || marketCap <= 0) return null;
  if (!Number.isFinite(votingPowerPct)) return null;
  return (votingPowerPct / 100) * marketCap;
}

/** A sector's name, as the market map groups it: a placeholder industry is "Other". */
export function sectorLabel(industry: string | null | undefined): string {
  return industryLabel(industry) || "Other";
}

export interface TreeCompany {
  code: string;
  name: string;
  votingPowerPct: number;
  /** Null when the stock has no market cap on record. */
  exposureAud: number | null;
  eventDate: string;
  announcementUrl: string;
}

export interface TreeSector {
  label: string;
  /** The sector's industry as the register states it ("" for a placeholder), for its icon. */
  industry: string;
  /** Sum of the companies' known exposures; 0 when none is priced. */
  exposureAud: number;
  /** Largest exposure first; unpriced companies last, by code. */
  companies: TreeCompany[];
}

export interface HolderTree {
  /** Largest exposure first; a sector with no priced company last, by label. */
  sectors: TreeSector[];
  totalExposureAud: number;
  unpricedCount: number;
}

/** Companies shown per sector before the rest fold under "Other companies" (spec 14.2). */
export const SECTOR_SHOWN = 6;

/** Sectors shown before the rest fold into one "Other sectors" node, so a large holder's map stays bounded. */
export const SECTORS_SHOWN = 5;

/** The label of the folded sector node. No industry is named this: a placeholder industry is "Other". */
export const OTHER_SECTORS_LABEL = "Other sectors";

function byExposure(a: TreeCompany, b: TreeCompany): number {
  if (a.exposureAud === null || b.exposureAud === null) {
    if (a.exposureAud === b.exposureAud) return a.code.localeCompare(b.code);
    return a.exposureAud === null ? 1 : -1;
  }
  return b.exposureAud - a.exposureAud || a.code.localeCompare(b.code);
}

/** The holder's positions grouped by sector, sorted by exposure at each level. */
export function buildHolderTree(positions: readonly HolderPosition[]): HolderTree {
  const groups = new Map<string, TreeSector>();
  let unpriced = 0;
  for (const position of positions) {
    const label = sectorLabel(position.industry);
    const exposure = exposureOf(position.votingPowerPct, position.marketCap);
    if (exposure === null) unpriced += 1;
    const group: TreeSector = groups.get(label) ?? {
      label,
      industry: industryLabel(position.industry),
      exposureAud: 0,
      companies: [],
    };
    group.companies.push({
      code: position.stockCode,
      name: position.companyName,
      votingPowerPct: position.votingPowerPct,
      exposureAud: exposure,
      eventDate: position.eventDate,
      announcementUrl: position.announcementUrl,
    });
    group.exposureAud += exposure ?? 0;
    groups.set(label, group);
  }
  const sectors = [...groups.values()];
  for (const sector of sectors) sector.companies.sort(byExposure);
  sectors.sort((a, b) => b.exposureAud - a.exposureAud || a.label.localeCompare(b.label));
  return {
    sectors,
    totalExposureAud: sectors.reduce((sum, sector) => sum + sector.exposureAud, 0),
    unpricedCount: unpriced,
  };
}

/** Whether the collapsed map folds anything: a sector past the shown five, or a sector past its six companies. */
export function hasFoldedRows(tree: HolderTree): boolean {
  return tree.sectors.length > SECTORS_SHOWN || tree.sectors.some((s) => s.companies.length > SECTOR_SHOWN);
}

/* ------------------------------------------------------------------ */
/* Geometry                                                           */
/* ------------------------------------------------------------------ */

/**
 * The map's geometry. Columns are percentages of the map's width (the ribbons'
 * SVG is `preserveAspectRatio="none"` in that unit); rows are CSS pixels.
 */
export const TREE_LAYOUT = {
  rowHeight: 40,
  rowGap: 6,
  sectorGap: 16,
  sectorNodeHeight: 44,
  holderNodeHeight: 56,
  holderRight: 24,
  sectorLeft: 38,
  sectorRight: 60,
  companyLeft: 76,
  /** The thickest ribbon, which is the whole holder's exposure, in pixels. */
  maxRibbon: 44,
  /** The thinnest priced ribbon, so a small holding stays visible. */
  minRibbon: 2,
  /** A ribbon with no exposure to draw: a hairline. */
  hairline: 1,
} as const;

/** One company row, or the "Other companies" row that folds the rest of a sector. */
export interface TreeNode {
  id: string;
  /** The company's code, or null for the folded row. */
  code: string | null;
  sector: string;
  /** Centre, in pixels from the top of the map. */
  y: number;
  exposureAud: number | null;
  votingPowerPct: number | null;
  /** The companies behind the row: one for a company, the folded ones for "Other companies". */
  members: TreeCompany[];
  title: string;
}

export interface TreeSectorNode {
  id: string;
  label: string;
  industry: string;
  /** Centre, in pixels from the top of the map. */
  y: number;
  exposureAud: number;
  companies: TreeNode[];
  /** True for the "Other sectors" node, which opens the sectors it folds rather than selecting one. */
  folded: boolean;
  title: string;
}

export interface TreeRibbon {
  id: string;
  /** The SVG path of the ribbon, in the map's percentage columns. */
  path: string;
  thickness: number;
  priced: boolean;
  /** The sector the ribbon belongs to (its company ribbons carry it too). */
  sector: string;
  code: string | null;
  title: string;
}

export interface HolderLayout {
  /** The map's height in pixels. */
  height: number;
  holderY: number;
  sectors: TreeSectorNode[];
  ribbons: TreeRibbon[];
}

/** The ribbon of an exposure, drawn against the whole holder's exposure. */
export function ribbonThickness(exposure: number | null, total: number): number {
  if (exposure === null || exposure <= 0 || total <= 0) return TREE_LAYOUT.hairline;
  return Math.max(TREE_LAYOUT.minRibbon, (TREE_LAYOUT.maxRibbon * exposure) / total);
}

/** A cubic ribbon between two column edges, `thickness` tall at both ends. */
export function ribbonPath(x1: number, y1: number, x2: number, y2: number, thickness: number): string {
  const h = thickness / 2;
  const mx = (x1 + x2) / 2;
  const f = (n: number) => Math.round(n * 100) / 100;
  return [
    `M${f(x1)} ${f(y1 - h)}`,
    `C${f(mx)} ${f(y1 - h)} ${f(mx)} ${f(y2 - h)} ${f(x2)} ${f(y2 - h)}`,
    `L${f(x2)} ${f(y2 + h)}`,
    `C${f(mx)} ${f(y2 + h)} ${f(mx)} ${f(y1 + h)} ${f(x1)} ${f(y1 + h)}`,
    "Z",
  ].join(" ");
}

function formatExposure(exposure: number): string {
  return formatAmount(exposure, "AUD");
}

/**
 * The sectors the collapsed map draws: the largest SECTORS_SHOWN as they are, and
 * the rest merged into one "Other sectors" node whose companies all fold. Expanded,
 * every sector is drawn as it is.
 */
function sectorsToDraw(tree: HolderTree, expanded: boolean): TreeSector[] {
  if (expanded || tree.sectors.length <= SECTORS_SHOWN) return tree.sectors;
  const rest = tree.sectors.slice(SECTORS_SHOWN);
  const merged: TreeSector = {
    label: OTHER_SECTORS_LABEL,
    industry: "",
    exposureAud: rest.reduce((total, sector) => total + sector.exposureAud, 0),
    companies: rest.flatMap((sector) => sector.companies).sort(byExposure),
  };
  return [...tree.sectors.slice(0, SECTORS_SHOWN), merged];
}

/**
 * The map's layout for a tree. A sector shows its six largest companies and folds
 * the rest into one "Other companies" row, unless `expanded`; past five sectors the
 * rest fold into one "Other sectors" node. Ribbons stack at each node so the widths
 * add up where they meet.
 */
export function layoutHolderTree(tree: HolderTree, options: { expanded: boolean }): HolderLayout {
  const L = TREE_LAYOUT;
  // Each sector's rows first, so the heights are known before anything is placed.
  const blocks = sectorsToDraw(tree, options.expanded).map((sector) => {
    const merged = !options.expanded && sector.label === OTHER_SECTORS_LABEL;
    const folds = !options.expanded && sector.companies.length > SECTOR_SHOWN;
    const shown = folds ? sector.companies.slice(0, SECTOR_SHOWN) : sector.companies;
    const rows: Array<{ members: TreeCompany[]; folded: boolean }> = merged
      ? [{ members: sector.companies, folded: true }]
      : [
          ...shown.map((company) => ({ members: [company], folded: false })),
          ...(folds ? [{ members: sector.companies.slice(SECTOR_SHOWN), folded: true }] : []),
        ];
    const height = rows.length * L.rowHeight + Math.max(0, rows.length - 1) * L.rowGap;
    return { sector, rows, height, merged };
  });

  let top = 0;
  const sectors: TreeSectorNode[] = [];
  for (const block of blocks) {
    const sectorY = top + block.height / 2;
    const companies: TreeNode[] = block.rows.map((row, index) => {
      const y = top + index * (L.rowHeight + L.rowGap) + L.rowHeight / 2;
      return nodeOf(block.sector.label, row.members, y, row.folded);
    });
    sectors.push({
      id: `sector:${block.sector.label}`,
      label: block.sector.label,
      industry: block.sector.industry,
      y: sectorY,
      exposureAud: block.sector.exposureAud,
      companies,
      folded: block.merged,
      title: block.merged ? foldedSectorTitle(block.sector) : sectorTitle(block.sector),
    });
    top += block.height + L.sectorGap;
  }
  const height = blocks.length > 0 ? top - L.sectorGap : 0;
  const holderY = height / 2;

  const ribbons: TreeRibbon[] = [];
  // The holder's ribbons, stacked on the holder node, in sector order.
  const sectorThickness = sectors.map((sector) =>
    ribbonThickness(sector.exposureAud > 0 ? sector.exposureAud : null, tree.totalExposureAud),
  );
  let holderCursor = holderY - sum(sectorThickness) / 2;
  sectors.forEach((sector, index) => {
    const thickness = sectorThickness[index] ?? L.hairline;
    const startY = holderCursor + thickness / 2;
    ribbons.push({
      id: `ribbon:holder>${sector.id}`,
      path: ribbonPath(L.holderRight, startY, L.sectorLeft, sector.y, thickness),
      thickness,
      priced: sector.exposureAud > 0,
      sector: sector.label,
      code: null,
      title: sector.title,
    });
    holderCursor += thickness;
  });

  // Each sector's ribbons to its companies, stacked on the sector node's right edge.
  for (const sector of sectors) {
    const thicknesses = sector.companies.map((node) => ribbonThickness(node.exposureAud, tree.totalExposureAud));
    let cursor = sector.y - sum(thicknesses) / 2;
    sector.companies.forEach((node, index) => {
      const thickness = thicknesses[index] ?? L.hairline;
      const startY = cursor + thickness / 2;
      ribbons.push({
        id: `ribbon:${sector.id}>${node.id}`,
        path: ribbonPath(L.sectorRight, startY, L.companyLeft, node.y, thickness),
        thickness,
        priced: node.exposureAud !== null && node.exposureAud > 0,
        sector: sector.label,
        code: node.code,
        title: node.title,
      });
      cursor += thickness;
    });
  }

  return { height, holderY, sectors, ribbons };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function nodeOf(sector: string, members: TreeCompany[], y: number, folded: boolean): TreeNode {
  if (folded || members.length !== 1) {
    const priced = members.filter((m) => m.exposureAud !== null);
    const exposure = priced.length > 0 ? sum(priced.map((m) => m.exposureAud ?? 0)) : null;
    return {
      id: `folded:${sector}:${members[0]?.code ?? ""}`,
      code: null,
      sector,
      y,
      exposureAud: exposure,
      votingPowerPct: null,
      members,
      title: foldedTitle(sector, members.length, exposure),
    };
  }
  const company = members[0]!;
  return {
    id: `company:${company.code}`,
    code: company.code,
    sector,
    y,
    exposureAud: company.exposureAud,
    votingPowerPct: company.votingPowerPct,
    members,
    title: companyTitle(company, sector),
  };
}

function companyTitle(company: TreeCompany, sector: string): string {
  if (company.exposureAud === null) {
    return `${company.code}, ${sector}: market cap not available, so the width is not estimated`;
  }
  return `${company.code}, ${sector}: ${formatHeadlinePct(company.votingPowerPct)} voting power, about ${formatExposure(company.exposureAud)} estimated exposure`;
}

function foldedTitle(sector: string, count: number, exposure: number | null): string {
  const noun = count === 1 ? "company" : "companies";
  if (exposure === null) {
    return `${count} other ${noun} in ${sector}: market cap not available, so the width is not estimated`;
  }
  return `${count} other ${noun} in ${sector}: about ${formatExposure(exposure)} estimated exposure`;
}

function sectorTitle(sector: TreeSector): string {
  const count = sector.companies.length;
  const noun = count === 1 ? "company" : "companies";
  if (sector.exposureAud <= 0) {
    return `${sector.label}: ${count} ${noun}, market cap not available, so the width is not estimated`;
  }
  return `${sector.label}: ${count} ${noun}, about ${formatExposure(sector.exposureAud)} estimated exposure`;
}

function foldedSectorTitle(sector: TreeSector): string {
  const count = sector.companies.length;
  const noun = count === 1 ? "company" : "companies";
  const figure =
    sector.exposureAud <= 0
      ? "market cap not available, so the width is not estimated"
      : `about ${formatExposure(sector.exposureAud)} estimated exposure`;
  return `${sector.label}: ${count} ${noun} in sectors past the first ${SECTORS_SHOWN}, ${figure}. Expand other companies to draw them.`;
}

/* ------------------------------------------------------------------ */
/* The inspector's content                                            */
/* ------------------------------------------------------------------ */

/**
 * The holder inspector's content (spec 14.3): the holder's plain rows, its
 * disclosed interests and its funds. A company selection shows that holding's
 * connection with its notice; a connection (the holder's kind to a sector) lists
 * the sector's companies by exposure. Nothing is estimated that the record does not carry.
 */
export interface HolderInspectorContent extends InspectorContent {
  /** The holder's two summary lines under its name, as the wireframe words them (spec 14.3). */
  summary?: string[];
  /** The holder's index funds and super options, for the Funds and products tab. */
  funds: HolderFundRow[];
  /** The selected connection's notice, drawn beneath its card (null when none is selected). */
  connectionLink: InspectorLink | null;
  /** The heading above the selected company's card ("Selected connection"), when a company is selected. */
  selectionHeading?: string;
}

/**
 * The feed link of one week of a holder's strip (backlog C6): the holder's notices released in that
 * Monday to Sunday.
 */
export function holderWeekHref(slug: string, weekStart: string, weekEnd: string): string {
  return `/ownership/notices?${new URLSearchParams({ holder: slug, since: weekStart, until: weekEnd }).toString()}`;
}

export function holderInspectorContent(
  holder: HolderRow,
  positions: readonly HolderPosition[],
  selection: Selection | null,
  funds: readonly HolderFundRow[] = [],
  weekNotices: WeekNotices | null = null,
): HolderInspectorContent {
  const tree = buildHolderTree(positions);
  const kind = kindInfo(holder.kind).label;
  const sections: InspectorSection[] = [];
  let connectionLink: InspectorLink | null = null;
  let selectionHeading: string | undefined;
  let note: string | undefined;

  if (selection?.kind === "stock") {
    const position = positions.find((p) => p.stockCode === selection.code);
    if (position) {
      const exposure = exposureOf(position.votingPowerPct, position.marketCap);
      // The notice's event date, else the release date ASX carries for it, else n/a (never blank).
      const noticeDate = formatDate(position.eventDate);
      const releaseDate = formatDate(position.announcedOn);
      const dateRow = noticeDate
        ? { label: "Notice date", value: noticeDate }
        : releaseDate
          ? { label: "Release date", value: releaseDate }
          : { label: "Notice date", value: "n/a" };
      selectionHeading = "Selected connection";
      // The card prints the rail's figure (two decimals, backlog A4);
      // the notice's stated precision stays on the register's row and in the notices list.
      sections.push({
        title: `${position.stockCode} · ${sectorLabel(position.industry)}`,
        kind: "rows",
        items: [
          { label: "Company", value: position.companyName || position.stockCode },
          { label: "Voting power", value: formatHeadlinePct(position.votingPowerPct) },
          { label: "Estimated exposure", value: exposure === null ? "n/a" : formatExposure(exposure) },
          dateRow,
        ],
      });
      // A stored URL that is not safe keeps its label as text, with no href (spec 14.7).
      const noticeHref = safeExternalHref(position.announcementUrl);
      if (noticeHref) {
        connectionLink = { label: "View the underlying notice", href: noticeHref, external: true };
      } else if (position.announcementUrl) {
        connectionLink = { label: "View the underlying notice", href: "", external: true };
      }
    } else {
      note = `${selection.code} is not among ${holder.name}'s current disclosed interests.`;
    }
  } else if (selection?.kind === "connection" && selection.holderKind === holder.kind) {
    const sector = tree.sectors.find((s) => s.label === selection.sector);
    if (sector) {
      const largest = sector.companies.find((c) => c.exposureAud !== null)?.exposureAud ?? 0;
      sections.push({
        title: "Companies on this connection",
        kind: "bars",
        items: sector.companies.map((company) => ({
          label: `${company.code} ${company.name}`.trim(),
          value: company.exposureAud === null ? "n/a" : formatExposure(company.exposureAud),
          share: company.exposureAud === null || largest <= 0 ? 0 : company.exposureAud / largest,
        })),
      });
    }
  }

  // The holder's strip comes after its positions (backlog C6); a failed read (null) drops it.
  const byWeek = noticesByWeekSection(weekNotices, (weekStart, weekEnd) => holderWeekHref(holder.key, weekStart, weekEnd));
  if (byWeek !== null) sections.push(byWeek);

  const unpriced = tree.unpricedCount;
  if (!note && unpriced > 0) {
    note = `${unpriced} ${unpriced === 1 ? "interest is" : "interests are"} drawn without a width: no market cap on record. Reported interests may overlap.`;
  }

  return {
    heading: holder.name,
    reading: holderReading({ count: holder.positions, positions }),
    logo: {
      kind: "holder",
      name: holder.name,
      holderKind: holder.kind,
      website: holder.website,
      holderKey: holder.key,
    },
    badges: [kind],
    rows: [],
    summary: [
      `${holder.positions} disclosed ${holder.positions === 1 ? "position" : "positions"}`,
      `Latest notice: ${formatDate(holder.latestNoticeDate) || "n/a"}`,
    ],
    sections,
    note,
    primary: { label: "Open holder profile →", href: `/ownership/${holder.key}` },
    links: [{ label: "Source: Method & coverage", href: "/ownership#method" }],
    footnote: "Manager-level notices are separate from individual fund portfolios.",
    funds: [...funds],
    connectionLink,
    selectionHeading,
  };
}

/** The size of a fund for the Funds and products tab: a figure, or "n/a" when it states none. */
export function fundSizeLabel(fund: HolderFundRow): string {
  return fund.sizeAud === null ? "n/a" : formatAmount(fund.sizeAud, "AUD");
}

/* ------------------------------------------------------------------ */
/* The URL                                                            */
/* ------------------------------------------------------------------ */

/** The query parameter that names the holder the map, the browser and the inspector show. */
export const HOLDER_PARAM = "holder";

/** The holder a `?holder=` value names: an institution slug the register lists, or null. */
export function parseHolderParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return isInstitutionSlug(raw) ? raw : null;
}

/**
 * The holder every island shows for a `?holder=` value: the named one when it is a
 * valid slug, otherwise the default. The map, the browser and the inspector all read
 * the URL through this one rule, so they can never disagree about the holder.
 */
export function resolveHolderKey(raw: string | null | undefined, defaultKey: string): string {
  return parseHolderParam(raw) ?? defaultKey;
}

/** The kind chips of the browser, in the wireframe's order. "Other" is every kind the chips do not name. */
export const HOLDER_CHIPS: readonly { value: string; label: string }[] = [
  { value: "all", label: "All holders" },
  { value: "index_manager", label: "Index managers" },
  { value: "super_fund", label: "Super funds" },
  { value: "active_manager", label: "Active managers" },
  { value: "hedge_fund", label: "Hedge funds" },
  { value: "bank_broker", label: "Banks and brokers" },
  { value: "other", label: "Other" },
];

const NAMED_CHIP_KINDS = new Set(["index_manager", "super_fund", "active_manager", "hedge_fund", "bank_broker"]);

/** Whether a holder of this kind is under the chip. */
export function chipCovers(chip: string, kind: string): boolean {
  if (chip === "all") return true;
  if (chip === "other") return !NAMED_CHIP_KINDS.has(kind);
  return chip === kind;
}

/** The directory filtered by a kind chip and a name query, in the directory's order. */
export function filterHolders(holders: readonly HolderRow[], chip: string, query: string): HolderRow[] {
  const needle = query.trim().toLowerCase();
  return holders.filter(
    (holder) =>
      chipCovers(chip, holder.kind) && (needle === "" || holder.name.toLowerCase().includes(needle)),
  );
}

/**
 * A pathname with one or more query parameters set (a string) or removed (null),
 * every other parameter kept in order. The islands write the URL with it.
 */
export function withSearch(pathname: string, search: string, changes: Record<string, string | null>): string {
  const params = new URLSearchParams(search);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null || value === "") params.delete(name);
    else params.set(name, value);
  }
  const query = params.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}
