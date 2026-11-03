import Link from "next/link";
import { ScreenReaderTable } from "~/@/components/politicians/explorer/screen-reader-table";
import { NOT_AVAILABLE, formatProseAmount } from "~/@/lib/fundamentals/format";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { formatVotingPower, kindInfo } from "~/@/lib/ownership/kinds";
import { cn } from "~/@/lib/utils";
import type { FlowChangeRow, FlowLayout, FlowNode } from "./flows-layout";
import { changeFlows, positionFlows } from "./flows-layout";
import { OTHER_SECTOR, sectorOf } from "./map-layout";
import type { OwnershipFlowsPage } from "~/app/actions/ownershipDesk";
import {
  WindowChips,
  WindowPhrase,
  deskParamHref,
  hrefWithParams,
  noticeWindowHref,
  type NoticeWindow,
} from "./window-chips";

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
// zooms the map. The drawing is aria-hidden with its links out of the tab order,
// and the sr-only table carries the keyboard path to each one.

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
export const FLOWS_OUTAGE =
  "The flows could not be read just now. Nothing here is missing from the register: this is our end.";

/** A kind's category colour: the hex its swatch names, or the ink when it names none. */
export function kindColour(kind: string): string {
  const hex = /#[0-9A-Fa-f]{6}/.exec(kindInfo(kind).swatch)?.[0];
  return hex ?? "hsl(var(--foreground))";
}

/** The kind a holder node's key names. */
export function kindOfNode(node: FlowNode): string {
  return node.key.slice("holder:".length);
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
export function positionBandTitle(row: PositionBandFigures): string {
  const holdings = noun(row.holdings, "holding", "holdings");
  const largest =
    row.largestCode !== "" && row.largestPct !== null && Number.isFinite(row.largestPct)
      ? `; largest ${row.largestCode} at ${formatVotingPower(row.largestPct)}`
      : "";
  return `${kindInfo(row.kind).label} in ${industryLabel(row.industry) || OTHER_SECTOR}: ${formatProseAmount(row.exposureAud, "AUD")} disclosed exposure, estimated, across ${holdings}${largest}`;
}

/** A change band's figures, as its tooltip and its accessible name state them. */
export function changeBandTitle(row: FlowChangeRow): string {
  const direction = row.direction === "up" ? "increases" : "decreases";
  return `${kindInfo(row.kind).label}, ${direction} in ${industryLabel(row.industry) || OTHER_SECTOR}: ${formatProseAmount(row.exposureAud, "AUD")} change in disclosed exposure, estimated, across ${noun(row.notices, "notice", "notices")}`;
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
}

/**
 * One sankey drawing. Labels sit in the gutters beside the nodes, and a node too
 * short to hold its label carries it in its title only. The paths are the layout's,
 * moved right by the left gutter.
 */
function FlowsDrawing({ page, mode, variant, basePath, params }: DrawingProps) {
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
        const fill =
          mode === "positions"
            ? kindColour(kind)
            : item.direction === "up"
              ? "hsl(var(--primary))"
              : "hsl(var(--foreground))";
        const opacity = mode === "positions" ? 0.42 : item.direction === "up" ? 0.55 : 0.35;
        const title =
          mode === "positions"
            ? positionBandTitle({
                kind,
                industry: sector,
                exposureAud: item.value,
                holdings: item.holdings,
                largestCode: item.largestCode,
                largestPct: item.largestPct,
              })
            : changeBandTitle({
                kind,
                industry: sector,
                direction: item.direction ?? "up",
                exposureAud: item.value,
                notices: item.notices,
              });
        return (
          <Link
            key={index}
            href={flowRegisterHref(kind, sector)}
            prefetch={false}
            rel="nofollow"
            tabIndex={-1}
            aria-hidden="true"
          >
            <path
              transform={`translate(${size.left} 0)`}
              d={item.path}
              fill={fill}
              fillOpacity={opacity}
              stroke="none"
            >
              <title>{title}</title>
            </path>
          </Link>
        );
      })}
      {layout.nodes.map((node) => {
        const isHolder = node.kind === "holder";
        const x = size.left + node.x0;
        const width = node.x1 - node.x0;
        const height = Math.max(node.y1 - node.y0, 0);
        const label = isHolder ? kindInfo(kindOfNode(node)).label : sectorOfNode(node);
        const amount = formatProseAmount(node.value, "AUD");
        const title = `${label}: ${amount} estimated across its bands`;
        const href = isHolder
          ? flowDirectoryHref(kindOfNode(node))
          : deskParamHref(basePath, params, { sector: sectorOfNode(node) });
        const textY = node.y0 + height / 2;
        const showLabel = height >= size.font * 0.9;
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
            {showLabel ? (
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
            ) : null}
          </Link>
        );
      })}
    </svg>
  );
}

/** The sr-only table: every row of the mode, with a link on its kind, its industry and its exposure. */
function FlowsTable({ page, mode, basePath, params }: { page: OwnershipFlowsPage; mode: FlowMode; basePath: string; params: URLSearchParams }) {
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
            <th scope="col">Exposure, estimated</th>
          </tr>
        </thead>
        <tbody>
          {page.positions.map((row) => {
            const sector = sectorOf(row.industry);
            return (
            <tr key={`${row.kind}-${row.industry}`}>
              <th scope="row">
                <Link href={flowDirectoryHref(row.kind)} prefetch={false} rel="nofollow">
                  {kindInfo(row.kind).label}
                </Link>
              </th>
              <td>
                <Link href={deskParamHref(basePath, params, { sector })} replace scroll={false} prefetch={false} rel="nofollow">
                  {sector}
                </Link>
              </td>
              <td>{row.holdings}</td>
              <td>
                {row.largestCode !== "" && row.largestPct !== null
                  ? `${row.largestCode} ${formatVotingPower(row.largestPct)}`
                  : NOT_AVAILABLE}
              </td>
              <td>
                <Link href={flowRegisterHref(row.kind, sector)} prefetch={false} rel="nofollow">
                  {formatProseAmount(row.exposureAud, "AUD")}
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
          <th scope="col">Change in exposure, estimated</th>
        </tr>
      </thead>
      <tbody>
        {page.changes.map((row) => {
          const sector = sectorOf(row.industry);
          return (
          <tr key={`${row.kind}-${row.industry}-${row.direction}`}>
            <th scope="row">
              <Link href={flowDirectoryHref(row.kind)} prefetch={false} rel="nofollow">
                {kindInfo(row.kind).label}
              </Link>
            </th>
            <td>
              <Link href={deskParamHref(basePath, params, { sector })} replace scroll={false} prefetch={false} rel="nofollow">
                {sector}
              </Link>
            </td>
            <td>{row.direction === "up" ? "Increases" : "Decreases"}</td>
            <td>{row.notices}</td>
            <td>
              <Link href={flowRegisterHref(row.kind, sector)} prefetch={false} rel="nofollow">
                {formatProseAmount(row.exposureAud, "AUD")}
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
}

/**
 * The mode switch: two chips, pressed for the mode shown. The server and the
 * Suspense fallback draw them disabled, so the row holds its height before the
 * island mounts and a phone's caption and drawing do not move when it does.
 */
function ModeChips({ mode, onModeChange }: { mode: FlowMode; onModeChange?: (mode: FlowMode) => void }) {
  const options: readonly { mode: FlowMode; label: string }[] = [
    { mode: "positions", label: "Positions" },
    { mode: "changes", label: "Changes in the window" },
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
}: OwnershipFlowsViewProps) {
  if (!page.ok) return <p role="status" className="text-sm text-muted-foreground">{FLOWS_OUTAGE}</p>;
  if (page.error !== "") {
    return <p role="status" className="text-sm text-muted-foreground">{page.error}</p>;
  }
  const phone = flowLayout(page, mode, FLOW_SIZES.phone);
  const full = flowLayout(page, mode, FLOW_SIZES.full);
  const empty = phone.empty && full.empty;
  const captionChanges = (
    <>
      Change in disclosed exposure, estimated: the change in voting power x market cap across the notices
      released <WindowPhrase state={state} asOf={page.asOf} />. Increases are amber and decreases ink. What the
      notices disclose, not a share of the company.
    </>
  );
  return (
    <div className="space-y-4" aria-busy={busy || undefined}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ModeChips mode={mode} onModeChange={onModeChange} />
        <WindowChips
          label="Window of change"
          active={state}
          hrefFor={(next) => noticeWindowHref(basePath, params, next)}
        />
      </div>
      <p className="text-sm text-muted-foreground">{mode === "positions" ? FLOW_POSITIONS_CAPTION : captionChanges}</p>
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
          <FlowsDrawing page={page} mode={mode} variant="phone" basePath={basePath} params={params} />
          <FlowsDrawing page={page} mode={mode} variant="full" basePath={basePath} params={params} />
          {mode === "changes" ? (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <li className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm bg-primary" />
                Increases in disclosed exposure
              </li>
              <li className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm bg-foreground" />
                Decreases in disclosed exposure
              </li>
            </ul>
          ) : null}
        </div>
      )}
      <FlowsTable page={page} mode={mode} basePath={basePath} params={params} />
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

