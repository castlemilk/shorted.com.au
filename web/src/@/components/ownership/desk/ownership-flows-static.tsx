import Link from "next/link";
import type { ReactNode } from "react";
import { ScreenReaderTable } from "~/@/components/politicians/explorer/screen-reader-table";
import { NOT_AVAILABLE, formatProseAmount } from "~/@/lib/fundamentals/format";
import { parseSelection, serializeSelection } from "../workspace/selection";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { FOLDED_SECTOR_LABEL, formatVotingPower, kindInfo, shortSector } from "~/@/lib/ownership/kinds";
import { cn } from "~/@/lib/utils";
import type { FlowChangeRow, FlowLayout, FlowNode } from "./flows-layout";
import { changeFlows, positionFlows } from "./flows-layout";
import { OTHER_SECTOR, sectorOf } from "./map-layout";
import type { OwnershipFlowsPage } from "~/app/actions/ownershipDesk";
import { Toolbar, type ToolbarFold } from "../workspace/toolbar";
import { WindowPhrase, deskParamHref, hrefWithParams, type NoticeWindow } from "./window-chips";
import { WindowSelect } from "../workspace/window-select";

// The flows as drawn (spec 13.3): a sankey from the holder kinds on the left to
// the industries on the right, its bands the disclosed exposure, estimated. The
// layouts are pure (flows-layout.ts); this module draws them and names them. A
// PLAIN MODULE, so the server draws the default view (positions) into the HTML and
// the island draws either mode for a window.
//
// COLOUR. A kind keeps its category colour (kinds.ts), so a position band takes
// its kind's hue. A change band is ink or amber by direction: an increase is
// amber, a decrease ink. Neither is red or green, because a notice flow is not a
// market direction.
//
// EVERY MARK IS A LINK, AND THE TABLE HAS THE SAME LINKS. A band opens the
// registers filtered to its kind and industry; a kind opens the directory; a sector
// zooms the map. The drawing is aria-hidden with its links out of the tab order;
// the sr-only table carries the keyboard path to each one, including a Select link
// that writes the same connection selection a band click does.

export type FlowMode = "positions" | "changes";

/** The desktop and phone drawings. The phone's gutters hold the labels at a size a phone reads. */
export const FLOW_SIZES = {
  phone: { width: 360, height: 330, left: 92, right: 96, font: 10.5, maxChars: 13 },
  full: { width: 600, height: 400, left: 150, right: 150, font: 12, maxChars: 20 },
} as const;

/** The caption the positions carry (spec 13.3), verbatim. */
export const FLOW_POSITIONS_CAPTION =
  "Disclosed exposure, estimated: voting power x market cap, what the notices disclose; banks' and brokers' notices are often securities lending.";
/**
 * The directory's group for one kind (spec 13.8: the hub gives each kind's group the
 * id `directory-<kind>`). A kind opens its own group, not the whole directory.
 */
export function flowDirectoryHref(kind: string): string {
  return `/ownership#directory-${kind}`;
}
const REGISTERS_PATH = "/ownership/stocks";
export const FLOWS_LOADING = "Loading…";
/** The band tooltip's last line: the record one click away from a band (spec 14.1, 14.3). */
export const INSPECT_NOTICES = "Inspect underlying notices →";
/** The legend line under the positions drawing (spec 14.3, Connections). */
export const RIBBON_LEGEND = "Ribbon width = estimated disclosed exposure. Exposure estimates, not investment cash flows.";
export const FLOWS_OUTAGE =
  "The flows could not be read just now. Nothing here is missing from the register: this is our end.";

/** How many sectors the sankey draws before the tail folds into "Other sectors" (spec 14.9). */
export const FLOW_SECTOR_KEEP = 6;

/**
 * A kind's category colour: the hex its swatch names, or the ink when it names none.
 * The unclassified holders are muted ink, never the brightest node (spec 14.9).
 */
export function kindColour(kind: string): string {
  if (kind === "unclassified") return "hsl(var(--muted-foreground))";
  const hex = /#[0-9A-Fa-f]{6}/.exec(kindInfo(kind).swatch)?.[0];
  return hex ?? "hsl(var(--foreground))";
}

/**
 * The page with its sectors folded (spec 14.9): the `keep` largest sectors by their
 * magnitude in the list, and every other sector's rows under FOLDED_SECTOR_LABEL. Both
 * lists fold on their own totals. A page with no more sectors than `keep` is unchanged.
 */
export function foldSectors(page: OwnershipFlowsPage, keep = FLOW_SECTOR_KEEP): OwnershipFlowsPage {
  const fold = <T extends { industry: string; exposureAud: number | null }>(rows: readonly T[]): T[] => {
    const totals = new Map<string, number>();
    for (const row of rows) {
      const sector = sectorOf(row.industry);
      totals.set(sector, (totals.get(sector) ?? 0) + Math.abs(row.exposureAud ?? 0));
    }
    if (totals.size <= keep) return [...rows];
    const top = new Set([...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, keep).map(([name]) => name));
    return rows.map((row) => (top.has(sectorOf(row.industry)) ? row : { ...row, industry: FOLDED_SECTOR_LABEL }));
  };
  return { ...page, positions: fold(page.positions), changes: fold(page.changes) };
}

/** The kind a holder node's key names. */
export function kindOfNode(node: FlowNode): string {
  return node.key.slice("holder:".length);
}

/** Whether the workspace selection names this connection (a holder kind to a sector), as the band draws it. */
export function connectionIsSelected(params: URLSearchParams, kind: string, sector: string): boolean {
  const selection = parseSelection(params.get("sel") ?? "");
  return selection?.kind === "connection" && selection.holderKind === kind && selection.sector === sector;
}

/**
 * The Market map filtered to a sector (spec 14.7): the Overview's compact pane does not zoom,
 * so a sector opens the full map with the sector set.
 */
export function sectorMapHref(sector: string): string {
  return `/ownership/map?sector=${encodeURIComponent(sector)}`;
}

/** The sector a sector node's key names. */
export function sectorOfNode(node: FlowNode): string {
  return node.key.slice("sector:".length);
}

/** Shortens a label to the room its gutter has. The full name is in the node's title. */
export function shortenLabel(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** The registers filtered to one kind and one industry: a band's link. */
export function flowRegisterHref(kind: string, sector: string): string {
  const params = new URLSearchParams();
  if (sector !== OTHER_SECTOR) params.set("industry", sector);
  params.set("kind", kind);
  return hrefWithParams(REGISTERS_PATH, params);
}

function noun(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A position band's figures. A band carries its largest holding as a null when it has none. */
export interface PositionBandFigures {
  kind: string;
  industry: string;
  exposureAud: number | null;
  holdings: number;
  largestCode: string;
  largestPct: number | null;
}

/** A position band's figures, as its tooltip and its accessible name state them. */
export function positionBandTitle(row: PositionBandFigures, measure: FlowMeasure = "exposure"): string {
  const holdings = noun(row.holdings, "holding", "holdings");
  const largest =
    row.largestCode !== "" && row.largestPct !== null && Number.isFinite(row.largestPct)
      ? `; largest ${row.largestCode} at ${formatVotingPower(row.largestPct)}`
      : "";
  const sector = industryLabel(row.industry) || OTHER_SECTOR;
  if (measure === "count") return `${kindInfo(row.kind).label} in ${sector}: ${holdings} disclosed${largest}`;
  return `${kindInfo(row.kind).label} in ${sector}: ${formatProseAmount(row.exposureAud, "AUD")} disclosed exposure, estimated, across ${holdings}${largest}`;
}

/** A change band's figures, as its tooltip and its accessible name state them. */
export function changeBandTitle(row: FlowChangeRow, measure: FlowMeasure = "exposure"): string {
  const direction = row.direction === "up" ? "increases" : "decreases";
  const sector = industryLabel(row.industry) || OTHER_SECTOR;
  if (measure === "count") {
    return `${kindInfo(row.kind).label}, ${direction} in ${sector}: ${noun(row.notices, "notice", "notices")} released`;
  }
  return `${kindInfo(row.kind).label}, ${direction} in ${sector}: ${formatProseAmount(row.exposureAud, "AUD")} change in disclosed exposure, estimated, across ${noun(row.notices, "notice", "notices")}`;
}

/** The layout a mode and a size draw. Positions and changes split their rows the same way. */
export function flowLayout(
  page: OwnershipFlowsPage,
  mode: FlowMode,
  size: (typeof FLOW_SIZES)[keyof typeof FLOW_SIZES],
): FlowLayout {
  const inner = size.width - size.left - size.right;
  if (mode === "positions") {
    const rows = [...page.positions].sort((a, b) => (b.exposureAud ?? 0) - (a.exposureAud ?? 0));
    return positionFlows(rows, inner, size.height);
  }
  const rows = [...page.changes].sort((a, b) => (b.exposureAud ?? 0) - (a.exposureAud ?? 0));
  return changeFlows(rows, inner, size.height);
}

interface DrawingProps {
  page: OwnershipFlowsPage;
  mode: FlowMode;
  variant: "phone" | "full";
  basePath: string;
  params: URLSearchParams;
  measure: FlowMeasure;
  /** The island's selection writer: a band selects in place, with no navigation (spec 14.7). */
  onSelect?: (sel: string) => void;
  /** The island's drilldown: a kind or sector node narrows the drawing to its bands. */
  onDrill?: (patch: DrillPatch) => void;
  /** The island's tail toggle: "Other sectors" opens the folded tail, as Expand Other + does. */
  onExpandTail?: () => void;
}

/** A drilldown step: a holder kind, a sector, or both (spec 14.3, Connections' breadcrumb). */
export interface DrillPatch {
  kind?: string;
  sector?: string;
}

/**
 * The page narrowed to one drilldown: the bands of one holder kind, of one sector, or of
 * both. A band is kept when every part the drill names is its own. Pure.
 */
export function drillPage(page: OwnershipFlowsPage, drill: DrillPatch): OwnershipFlowsPage {
  const kind = drill.kind ?? "";
  const sector = drill.sector ?? "";
  if (kind === "" && sector === "") return page;
  const keep = <T extends { kind: string; industry: string }>(rows: readonly T[]) =>
    rows.filter((row) => (kind === "" || row.kind === kind) && (sector === "" || row.industry === sector));
  return { ...page, positions: keep(page.positions), changes: keep(page.changes) };
}

/**
 * One sankey drawing. Labels sit in the gutters beside the nodes, and a node too
 * short to hold its label carries it in its title only. The paths are the layout's,
 * moved right by the left gutter.
 */
function FlowsDrawing({ page, mode, variant, basePath, params, measure, onSelect, onDrill, onExpandTail }: DrawingProps) {
  const size = FLOW_SIZES[variant];
  const layout = flowLayout(page, mode, size);
  if (layout.empty) return null;
  return (
    <svg
      viewBox={`0 0 ${size.width} ${size.height}`}
      focusable="false"
      aria-hidden="true"
      className={cn("block h-auto w-full", variant === "phone" ? "sm:hidden" : "hidden sm:block")}
    >
      {layout.bands.map((item, index) => {
        const source = layout.nodes[item.source]!;
        const target = layout.nodes[item.target]!;
        const kind = kindOfNode(source);
        const sector = sectorOfNode(target);
        // The folded tail is several sectors under one label: its band opens the tail, it never selects (spec 14.9).
        const foldedBand = sector === FOLDED_SECTOR_LABEL;
        const selected = !foldedBand && connectionIsSelected(params, kind, sector);
        // Unselected ribbons are neutral at about 15% in both modes; the selected band is amber (spec 14.9). A change's
        // direction is named in its band's title, not in its colour.
        const fill = selected ? "hsl(var(--primary))" : "hsl(var(--foreground))";
        const opacity = selected ? 0.8 : 0.15;
        const title =
          mode === "positions"
            ? positionBandTitle(
                {
                  kind,
                  industry: sector,
                  exposureAud: item.value,
                  holdings: item.holdings,
                  largestCode: item.largestCode,
                  largestPct: item.largestPct,
                },
                measure,
              )
            : changeBandTitle(
                {
                  kind,
                  industry: sector,
                  direction: item.direction ?? "up",
                  exposureAud: item.value,
                  notices: item.notices,
                },
                measure,
              );
        const sel = serializeSelection({ kind: "connection", holderKind: kind, sector });
        return (
          <Link
            key={index}
            href={deskParamHref(basePath, params, foldedBand ? {} : { sel })}
            replace
            scroll={false}
            prefetch={false}
            rel="nofollow"
            onClick={(event) => {
              if (foldedBand) {
                event.preventDefault();
                onExpandTail?.();
                return;
              }
              if (onSelect === undefined) return;
              event.preventDefault();
              onSelect(sel);
            }}
            aria-label={title}
            tabIndex={-1}
            data-selected={selected || undefined}
          >
            <path
              transform={`translate(${size.left} 0)`}
              d={item.path}
              fill={fill}
              fillOpacity={opacity}
              stroke={selected ? "hsl(var(--foreground))" : "none"}
            >
              <title>{`${title}. ${INSPECT_NOTICES}`}</title>
            </path>
          </Link>
        );
      })}
      {layout.nodes.map((node) => {
        const isHolder = node.kind === "holder";
        const x = size.left + node.x0;
        const width = node.x1 - node.x0;
        const height = Math.max(node.y1 - node.y0, 0);
        const folded = !isHolder && sectorOfNode(node) === FOLDED_SECTOR_LABEL;
        const label = isHolder ? kindInfo(kindOfNode(node)).label : shortSector(sectorOfNode(node));
        // The title names the full group, the drawn label its short name (spec 14.9).
        const fullLabel = isHolder ? kindInfo(kindOfNode(node)).label : sectorOfNode(node);
        const title =
          measure === "count"
            ? `${fullLabel}: ${noun(node.value, mode === "positions" ? "interest" : "notice", mode === "positions" ? "interests" : "notices")} across its bands`
            : `${fullLabel}: ${formatProseAmount(node.value, "AUD")} estimated across its bands`;
        // The compact pane (no drilldown) opens the full map for a sector; the connections page drills in place.
        const href = isHolder
          ? flowDirectoryHref(kindOfNode(node))
          : folded
            ? "/ownership/map"
            : onDrill === undefined
            ? sectorMapHref(sectorOfNode(node))
            : deskParamHref(basePath, params, { sector: sectorOfNode(node) });
        const drillTo: DrillPatch = isHolder ? { kind: kindOfNode(node) } : { sector: sectorOfNode(node) };
        const textY = node.y0 + height / 2;
        // Every drawn node is labelled (spec 14.9), a short node's label included: it sits on the node's middle.
        const labelX = isHolder ? size.left - 6 : size.width - size.right + 6;
        return (
          <Link
            key={node.key}
            href={href}
            prefetch={false}
            rel="nofollow"
            replace={!isHolder}
            scroll={false}
            tabIndex={-1}
            aria-hidden="true"
            onClick={
              folded
                ? (event) => {
                    // The island opens the tail in place; the server's pane has no toggle, so its node links to the map.
                    if (onExpandTail === undefined) return;
                    event.preventDefault();
                    onExpandTail();
                  }
                : onDrill === undefined
                  ? undefined
                  : (event) => {
                      event.preventDefault();
                      onDrill(drillTo);
                    }
            }
          >
            <rect
              x={x}
              y={node.y0}
              width={width}
              height={height}
              fill={isHolder ? kindColour(kindOfNode(node)) : "hsl(var(--foreground))"}
            >
              <title>{title}</title>
            </rect>
            <text
              x={labelX}
              y={textY}
              dominantBaseline="middle"
              textAnchor={isHolder ? "end" : "start"}
              fontSize={size.font}
              fill="hsl(var(--foreground))"
            >
              {shortenLabel(label, size.maxChars)}
            </text>
          </Link>
        );
      })}
    </svg>
  );
}

/** The sr-only table: every row of the mode, with a link on its kind, its industry and its exposure. */
function FlowsTable({
  page,
  mode,
  basePath,
  params,
  measure,
  onDrill,
}: {
  page: OwnershipFlowsPage;
  mode: FlowMode;
  basePath: string;
  params: URLSearchParams;
  measure: FlowMeasure;
  /** The connections page's drilldown: the kind and sector cells drill in place, from the keyboard too. */
  onDrill?: (patch: DrillPatch) => void;
}) {
  const counted = measure === "count";
  if (mode === "positions") {
    const name = "Disclosed exposure by holder kind and industry";
    return (
      <ScreenReaderTable ariaLabel={name}>
        <caption>{name}</caption>
        <thead>
          <tr>
            <th scope="col">Holder kind</th>
            <th scope="col">Industry</th>
            <th scope="col">Holdings</th>
            <th scope="col">Largest holding</th>
            <th scope="col">{counted ? "Number of interests" : "Exposure, estimated"}</th>
            <th scope="col">Select</th>
          </tr>
        </thead>
        <tbody>
          {page.positions.map((row) => {
            const sector = sectorOf(row.industry);
            return (
            <tr key={`${row.kind}-${row.industry}`}>
              <th scope="row">
                {onDrill === undefined ? (
                <Link href={flowDirectoryHref(row.kind)} prefetch={false} rel="nofollow">
                  {kindInfo(row.kind).label}
                </Link>
                ) : (
                <button type="button" className="underline underline-offset-4" onClick={() => onDrill({ kind: row.kind })}>
                  {kindInfo(row.kind).label}
                </button>
                )}
              </th>
              <td>
                {onDrill === undefined ? (
                <Link href={sectorMapHref(sector)} prefetch={false} rel="nofollow">
                  {sector}
                </Link>
                ) : (
                <button type="button" className="underline underline-offset-4" onClick={() => onDrill({ sector })}>
                  {sector}
                </button>
                )}
              </td>
              <td>{row.holdings}</td>
              <td>
                {row.largestCode !== "" && row.largestPct !== null
                  ? `${row.largestCode} ${formatVotingPower(row.largestPct)}`
                  : NOT_AVAILABLE}
              </td>
              <td>
                <Link href={flowRegisterHref(row.kind, sector)} prefetch={false} rel="nofollow">
                  {counted ? String(row.holdings) : formatProseAmount(row.exposureAud, "AUD")}
                </Link>
              </td>
              <td>
                <Link
                  href={deskParamHref(basePath, params, {
                    sel: serializeSelection({ kind: "connection", holderKind: row.kind, sector }),
                  })}
                  replace
                  scroll={false}
                  prefetch={false}
                  rel="nofollow"
                >
                  Select
                </Link>
              </td>
            </tr>
            );
          })}
        </tbody>
      </ScreenReaderTable>
    );
  }
  const name = "Change in disclosed exposure by holder kind and industry";
  return (
    <ScreenReaderTable ariaLabel={name}>
      <caption>{name}</caption>
      <thead>
        <tr>
          <th scope="col">Holder kind</th>
          <th scope="col">Industry</th>
          <th scope="col">Direction</th>
          <th scope="col">Notices</th>
          <th scope="col">{counted ? "Number of notices" : "Change in exposure, estimated"}</th>
          <th scope="col">Select</th>
        </tr>
      </thead>
      <tbody>
        {page.changes.map((row) => {
          const sector = sectorOf(row.industry);
          return (
          <tr key={`${row.kind}-${row.industry}-${row.direction}`}>
            <th scope="row">
              {onDrill === undefined ? (
              <Link href={flowDirectoryHref(row.kind)} prefetch={false} rel="nofollow">
                {kindInfo(row.kind).label}
              </Link>
              ) : (
              <button type="button" className="underline underline-offset-4" onClick={() => onDrill({ kind: row.kind })}>
                {kindInfo(row.kind).label}
              </button>
              )}
            </th>
            <td>
              {onDrill === undefined ? (
              <Link href={sectorMapHref(sector)} prefetch={false} rel="nofollow">
                {sector}
              </Link>
              ) : (
              <button type="button" className="underline underline-offset-4" onClick={() => onDrill({ sector })}>
                {sector}
              </button>
              )}
            </td>
            <td>{row.direction === "up" ? "Increases" : "Decreases"}</td>
            <td>{row.notices}</td>
            <td>
              <Link href={flowRegisterHref(row.kind, sector)} prefetch={false} rel="nofollow">
                {counted ? String(row.notices) : formatProseAmount(row.exposureAud, "AUD")}
              </Link>
            </td>
            <td>
                <Link
                  href={deskParamHref(basePath, params, {
                    sel: serializeSelection({ kind: "connection", holderKind: row.kind, sector }),
                  })}
                  replace
                  scroll={false}
                  prefetch={false}
                  rel="nofollow"
                >
                  Select
                </Link>
              </td>
          </tr>
          );
        })}
      </tbody>
    </ScreenReaderTable>
  );
}

export interface OwnershipFlowsViewProps {
  page: OwnershipFlowsPage;
  mode: FlowMode;
  state: NoticeWindow;
  basePath: string;
  /** The reader's other parameters, kept on every link. */
  params: URLSearchParams;
  /** The mode switch the island draws. Absent on the server, which draws positions only. */
  onModeChange?: (mode: FlowMode) => void;
  /** A window is being read: the view says so and keeps what it drew. */
  busy?: boolean;
  /** The workspace's own controls (Measure, Show largest, Reset), drawn above the drawings. */
  controls?: ReactNode;
  /** The band's measure: estimated exposure (the default) or the number of interests. */
  measure?: FlowMeasure;
  /** The island's band selection and drilldown writers. Absent on the server, where the links navigate. */
  onSelect?: (sel: string) => void;
  onDrill?: (patch: DrillPatch) => void;
  /** The folded tail is open: every sector is drawn, not the six largest and "Other sectors" (spec 14.9). */
  expandOther?: boolean;
  /** The island's tail toggle, the same as Expand Other +; absent on the server, where the node links to the map. */
  onFoldOther?: () => void;
  /** Whether the island draws the Expand Other + / Fold toggle beneath the drawings (the Connections page). */
  tailToggle?: boolean;
  onExpandOther?: () => void;
  /** The window control beside the switch. The Overview's pane has none (spec 14.9): absent is shown. */
  windowControl?: boolean;
  /** The island's phone fold of the toolbar; absent on the server. */
  toolbarFold?: ToolbarFold;
  /** Writes the window in place (the Window select); absent on the server, where the select is drawn disabled. */
  onWindowChange?: (next: NoticeWindow) => void;
}

/** What a band's width states: the estimated disclosed exposure, or the count of interests (spec 14.3). */
export type FlowMeasure = "exposure" | "count";

/** The "Show largest connections" choices (spec 14.3): the N largest bands, or every band. */
export const LARGEST_CHOICES = ["10", "20", "all"] as const;
export type LargestChoice = (typeof LARGEST_CHOICES)[number];

/**
 * The page with only its N largest bands (by the measure it draws), in the API's
 * order within the cut. "all" keeps every band. The folded tail is the rest; it is
 * never drawn as a band of its own.
 */
export function largestConnections(page: OwnershipFlowsPage, choice: LargestChoice): OwnershipFlowsPage {
  if (choice === "all") return page;
  const n = Number(choice);
  const weight = (value: number | null) => (value === null ? -1 : Math.abs(value));
  const keep = <T extends { exposureAud: number | null }>(rows: readonly T[]) => {
    const top = new Set([...rows].sort((a, b) => weight(b.exposureAud) - weight(a.exposureAud)).slice(0, n));
    return rows.filter((row) => top.has(row));
  };
  return { ...page, positions: keep(page.positions), changes: keep(page.changes) };
}

/**
 * The page the measure draws: in count mode each band's width is its number of
 * interests (holdings for a position, notices for a change), else its exposure.
 * The rows keep the API's order. Pure, so the drawings and the tests share it.
 */
export function measurePage(page: OwnershipFlowsPage, measure: FlowMeasure): OwnershipFlowsPage {
  if (measure === "exposure") return page;
  return {
    ...page,
    positions: page.positions.map((row) => ({ ...row, exposureAud: row.holdings })),
    changes: page.changes.map((row) => ({ ...row, exposureAud: row.notices })),
  };
}

/**
 * The mode switch: two chips, pressed for the mode shown. The server and the
 * Suspense fallback draw them disabled, so the row holds its height before the
 * island mounts and a phone's caption and drawing do not move when it does.
 */
function ModeChips({ mode, onModeChange }: { mode: FlowMode; onModeChange?: (mode: FlowMode) => void }) {
  const options: readonly { mode: FlowMode; label: string }[] = [
    { mode: "positions", label: "Positions" },
    { mode: "changes", label: "Changes" },
  ];
  return (
    <div role="group" aria-label="What the bands show" className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const on = option.mode === mode;
        return (
          <button
            key={option.mode}
            type="button"
            aria-pressed={on}
            disabled={!onModeChange}
            onClick={() => onModeChange?.(option.mode)}
            className={cn(
              "inline-flex h-9 items-center rounded-md border px-3 text-xs transition-colors duration-150 motion-reduce:transition-none disabled:cursor-default",
              on
                ? "border-primary/60 bg-primary/10 font-semibold text-primary"
                : "border-border text-muted-foreground hover:border-input hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The flows as drawn: the switch and the chips, the caption, the drawings and the table. */
export function OwnershipFlowsView({
  page,
  mode,
  state,
  basePath,
  params,
  onModeChange,
  busy = false,
  controls,
  measure = "exposure",
  onSelect,
  onDrill,
  expandOther = false,
  onExpandOther,
  onFoldOther,
  tailToggle = false,
  windowControl = true,
  toolbarFold,
  onWindowChange,
}: OwnershipFlowsViewProps) {
  if (!page.ok) return <p role="status" className="text-sm text-muted-foreground">{FLOWS_OUTAGE}</p>;
  if (page.error !== "") {
    return <p role="status" className="text-sm text-muted-foreground">{page.error}</p>;
  }
  // The drawings fold the tail; the table keeps every row, the record is never folded.
  const drawn = expandOther ? page : foldSectors(page);
  const phone = flowLayout(drawn, mode, FLOW_SIZES.phone);
  const full = flowLayout(drawn, mode, FLOW_SIZES.full);
  const empty = phone.empty && full.empty;
  const captionChanges = (
    <>
      Change in disclosed exposure, estimated: the change in voting power x market cap across the notices
      released <WindowPhrase state={state} asOf={page.asOf} />. Each band's title says whether its exposure rose or fell. What the
      notices disclose, not a share of the company.
    </>
  );
  return (
    <div className="space-y-4" aria-busy={busy || undefined}>
      {/* One toolbar row (spec 14.9): the source, the measure, the positions or change, the window and the
          reset, labelled. The Overview's pane has no controls, so its row is the switch alone, unfolded. */}
      <Toolbar fold={controls === undefined ? undefined : toolbarFold}>
        {controls}
        <div className="flex flex-wrap items-center gap-2">
          {controls === undefined ? null : <span className="text-xs text-muted-foreground">Show</span>}
          <ModeChips mode={mode} onModeChange={onModeChange} />
        </div>
        {windowControl ? <WindowSelect active={state} onWindowChange={onWindowChange} /> : null}
      </Toolbar>
      <p className="text-sm text-muted-foreground">
        {mode === "positions" ? FLOW_POSITIONS_CAPTION : captionChanges}
        {measure === "count" ? " Band widths are the number of interests, not their exposure." : null}
      </p>
      <p className="text-xs text-muted-foreground">
        {page.asOf !== "" ? (
          <>
            Notices read to <time dateTime={page.asOf} className="tabular-nums">{page.asOf}</time>.
          </>
        ) : (
          <>Notices read to {NOT_AVAILABLE}.</>
        )}
        {/* Always mounted: a status region announces the text that enters it, not one that appears with it. */}
        <span role="status" className="ml-2">
          {busy ? FLOWS_LOADING : null}
        </span>
      </p>
      {empty ? (
        <p className="text-sm text-muted-foreground">
          {mode === "positions"
            ? "No disclosed holding has a market cap to estimate it from, so nothing is drawn."
            : "No notice released in this window changed a holding with an estimate."}
        </p>
      ) : (
        <div className="space-y-2">
          <FlowsDrawing page={drawn} mode={mode} variant="phone" basePath={basePath} params={params} measure={measure} onSelect={onSelect} onDrill={onDrill} onExpandTail={onExpandOther} />
          <FlowsDrawing page={drawn} mode={mode} variant="full" basePath={basePath} params={params} measure={measure} onSelect={onSelect} onDrill={onDrill} onExpandTail={onExpandOther} />
          {mode === "positions" && measure === "exposure" ? (
            <p className="text-[11px] text-muted-foreground">{RIBBON_LEGEND}</p>
          ) : null}
          {tailToggle && onExpandOther !== undefined ? (
            // The folded tail's toggle sits under the drawings, beside the legend, not in the toolbar row (spec 14.9).
            <div className="flex justify-end">
              <button
                type="button"
                aria-expanded={expandOther}
                onClick={() => (expandOther ? onFoldOther?.() : onExpandOther())}
                className="text-xs text-primary underline-offset-4 hover:underline"
              >
                {expandOther ? "Fold to six sectors" : "Expand Other +"}
              </button>
            </div>
          ) : null}
          {mode === "changes" ? (
            <p className="text-[11px] text-muted-foreground">Each band is named with its direction; the selected band is amber.</p>
          ) : null}
        </div>
      )}
      <FlowsTable page={page} mode={mode} basePath={basePath} params={params} measure={measure} onDrill={onDrill} />
    </div>
  );
}

/** The server's default view: the positions, the newest notice window, no switch. */
export function OwnershipFlowsStatic({
  page,
  state,
  basePath,
}: {
  page: OwnershipFlowsPage;
  state: NoticeWindow;
  basePath: string;
}) {
  return (
    <OwnershipFlowsView
      page={page}
      mode="positions"
      state={state}
      basePath={basePath}
      params={new URLSearchParams()}
    />
  );
}

