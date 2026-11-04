"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { ScreenReaderTable } from "~/@/components/politicians/explorer/screen-reader-table";
import { SectorIcon } from "~/@/components/ownership/workspace/sector-icon";
import { StockLogoBox } from "~/@/components/ownership/workspace/stock-logo-box";
import { parseSelection, type Selection } from "~/@/components/ownership/workspace/selection";
import { formatHeadlinePct, kindInfo } from "~/@/lib/ownership/kinds";
import { sectionTitle } from "@/lib/typography";
import { formatAmount } from "~/@/lib/fundamentals/format";
import {
  HOLDER_PARAM,
  TREE_LAYOUT,
  buildHolderTree,
  layoutHolderTree,
  hasFoldedRows,
  resolveHolderKey,
  withSearch,
  type HolderConnectionsPage,
  type HolderLayout,
  type HolderTree,
  type TreeSectorNode,
} from "./holder-tree";

export interface HolderConnectionsMapProps {
  /** The holder shown when the URL names none. */
  defaultKey: string;
  /** A page that shows one holder (the institution page) pins it and ignores `?holder=`. */
  fixedKey?: string;
  /** The connections of the holder the page read, already loaded. */
  initial: HolderConnectionsPage;
  /** Reads another holder's connections (a server action), for a holder the browser picks. */
  loadConnections: (key: string) => Promise<HolderConnectionsPage>;
}

const NOOP = (): void => undefined;
/** The column captions sit above the map, in the same percentage columns the nodes use. */
const CAPTION_TOP = 32;

/**
 * The holder's disclosed connections (spec 14.3): a three-column tree of the
 * holder, its sectors (icon and name) and its companies (logo and code), with a
 * ribbon per link, its width the estimated disclosed exposure. Six companies show
 * per sector and the rest fold under "Other companies", which "Expand other
 * companies" opens. A click selects a company (`stock:`) or a sector
 * (`connection:`), which the inspector reads from `?sel=`.
 *
 * The URL is read under a Suspense boundary. The fallback draws the initial
 * holder with nothing selected, so the static HTML and the first paint agree.
 */
export function HolderConnectionsMap(props: HolderConnectionsMapProps) {
  const fallbackKey = props.fixedKey ?? props.defaultKey;
  return (
    <Suspense
      fallback={
        <MapBody {...props} requested={fallbackKey} selection={null} onSelect={NOOP} onClear={NOOP} />
      }
    >
      <MapReader {...props} />
    </Suspense>
  );
}

/** The only reader of the URL: the holder and the selection, then the map drawn from them. */
function MapReader(props: HolderConnectionsMapProps) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const params = useSearchParams();
  const search = params?.toString() ?? "";
  const requested = props.fixedKey ?? resolveHolderKey(params?.get(HOLDER_PARAM), props.defaultKey);
  const selection = parseSelection(params?.get("sel") ?? "");
  const onSelect = (sel: string) => {
    router.replace(withSearch(pathname, search, { sel }), { scroll: false });
  };
  const onClear = () => {
    router.replace(withSearch(pathname, search, { sel: null }), { scroll: false });
  };
  return (
    <MapBody {...props} requested={requested} selection={selection} onSelect={onSelect} onClear={onClear} />
  );
}

/** The map for one holder. It reads no URL itself, so the fallback can draw it too. */
function MapBody(props: HolderConnectionsMapProps & {
  requested: string;
  selection: Selection | null;
  onSelect: (sel: string) => void;
  onClear: () => void;
}) {
  const { initial, loadConnections, requested, selection, onSelect, onClear } = props;
  const defaultKey = props.defaultKey;
  const initialKey = initial.holder?.key ?? defaultKey;

  // Another holder's connections are read once per holder shown, never per render.
  const [loaded, setLoaded] = useState<{ key: string; page: HolderConnectionsPage } | null>(null);
  const loader = useRef(loadConnections);
  loader.current = loadConnections;
  useEffect(() => {
    if (requested === initialKey) return;
    let live = true;
    loader
      .current(requested)
      .then((page) => {
        if (live) setLoaded({ key: requested, page });
      })
      .catch(() => {
        if (live) setLoaded({ key: requested, page: unreadable() });
      });
    return () => {
      live = false;
    };
  }, [requested, initialKey]);

  const page = requested === initialKey ? initial : loaded?.key === requested ? loaded.page : null;
  // Keyed on the holder: a new holder starts collapsed, not with the last one's expansion.
  return (
    <HolderConnectionsView
      key={page?.holder?.key ?? ""}
      page={page}
      selection={selection}
      onSelect={onSelect}
      onClear={onClear}
    />
  );
}

function unreadable(): HolderConnectionsPage {
  return { ok: false, error: "", holder: null, positions: [], funds: [], capsOk: false };
}

function HolderConnectionsView({
  page,
  selection,
  onSelect,
  onClear,
}: {
  page: HolderConnectionsPage | null;
  selection: Selection | null;
  onSelect: (sel: string) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const holder = page?.holder ?? null;
  const tree = useMemo<HolderTree | null>(() => (page ? buildHolderTree(page.positions) : null), [page]);
  const layout = useMemo<HolderLayout | null>(
    () => (tree ? layoutHolderTree(tree, { expanded }) : null),
    [tree, expanded],
  );
  const headingId = "holder-connections-heading";
  const hasFolded = tree !== null && hasFoldedRows(tree);

  const selectedCode = selection?.kind === "stock" ? selection.code : null;
  const selectedSector =
    selection?.kind === "connection" && holder && selection.holderKind === holder.kind ? selection.sector : null;
  // A stock folded under "Other companies" lights that row and its sector, as an open company does.
  const codeSector =
    selectedCode === null
      ? null
      : (layout?.sectors.find((s) =>
          s.companies.some((c) => c.code === selectedCode || c.members.some((m) => m.code === selectedCode)),
        )?.label ?? null);
  const activeSector = selectedSector ?? codeSector;

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className={sectionTitle}>
          {holder ? `${holder.name}’s disclosed connections` : "Disclosed connections"}
        </h2>
        <span className="rounded-[var(--radius)] border border-border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          Substantial notices
        </span>
      </div>

      {page === null ? (
        <div role="status" aria-busy="true" aria-label="Loading the connections" className="h-72 rounded-sm bg-muted/40" />
      ) : !page.ok || holder === null ? (
        <p className="text-sm text-muted-foreground">
          {page.error || "The connections could not be read just now. Nothing here is missing from the register: this is our end."}
        </p>
      ) : layout === null || layout.sectors.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {holder.name} has no current disclosed connection to draw.
        </p>
      ) : (
        <>
          {!page.capsOk ? (
            <p className="text-xs text-muted-foreground">
              Market caps could not be read just now, so every width is a hairline. The positions are unchanged.
            </p>
          ) : null}
          <div className="-mx-1 overflow-x-auto px-1">
            <div className="relative min-w-[36rem]" style={{ height: layout.height + CAPTION_TOP }}>
              <div className="absolute inset-x-0 top-0 h-6 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                <span className="absolute left-0 w-[24%] text-center">Holder</span>
                <span className="absolute w-[22%] text-center" style={{ left: `${TREE_LAYOUT.sectorLeft}%` }}>
                  Sectors
                </span>
                <span className="absolute w-[24%] text-center" style={{ left: `${TREE_LAYOUT.companyLeft}%` }}>
                  Companies
                </span>
              </div>
              <div className="absolute inset-x-0 bottom-0" style={{ top: CAPTION_TOP, height: layout.height }}>
                <svg
                  aria-hidden="true"
                  className="absolute inset-0 h-full w-full"
                  viewBox={`0 0 100 ${Math.max(1, layout.height)}`}
                  preserveAspectRatio="none"
                >
                  {layout.ribbons.map((ribbon) => {
                    const isHolder = ribbon.id.startsWith("ribbon:holder>");
                    const active = isHolder
                      ? activeSector !== null && ribbon.sector === activeSector
                      : ribbon.code !== null
                        ? ribbon.code === selectedCode
                        : activeSector !== null && ribbon.sector === activeSector;
                    return (
                      <path
                        key={ribbon.id}
                        d={ribbon.path}
                        className={cn(
                          "pointer-events-auto transition-colors motion-safe:duration-200",
                          !ribbon.priced
                            ? "fill-muted-foreground/50"
                            : active
                              ? "fill-primary/75"
                              : "fill-primary/30",
                        )}
                      >
                        <title>{ribbon.title}</title>
                      </path>
                    );
                  })}
                </svg>

                <div
                  className="absolute flex flex-col justify-center rounded-[var(--radius)] border border-primary/40 bg-primary px-3 py-2 text-primary-foreground"
                  style={nodeStyle(0, 24, TREE_LAYOUT.holderNodeHeight, layout.holderY)}
                >
                  <span className="truncate font-mono text-sm font-semibold leading-tight">{holder.name}</span>
                  <span className="truncate font-mono text-[11px] opacity-80">{kindInfo(holder.kind).label}</span>
                </div>

                {layout.sectors.map((sector) => (
                  <SectorNode
                    key={sector.id}
                    sector={sector}
                    kind={holder.kind}
                    active={sector.label === activeSector}
                    selectedCode={selectedCode}
                    onSelect={onSelect}
                    expanded={expanded}
                    onExpand={() => setExpanded((v) => !v)}
                  />
                ))}
              </div>
            </div>
          </div>

          <SrConnectionsTable tree={tree} name={holder.name} />
        </>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-border pt-3 text-sm">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="mt-1 block h-2 w-6 rounded-full bg-primary/60" />
          <div>
            <p>Width: estimated disclosed exposure</p>
            <p className="text-xs text-muted-foreground">Based on reported voting power and market value</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {hasFolded || expanded ? (
            <button
              type="button"
              aria-pressed={expanded}
              onClick={() => setExpanded((v) => !v)}
              className="rounded-[var(--radius)] border border-border px-3 py-1.5 font-mono text-xs hover:bg-muted/40"
            >
              {expanded ? "Collapse other companies −" : "Expand other companies +"}
            </button>
          ) : null}
          {selection !== null ? (
            <button type="button" onClick={onClear} className="text-muted-foreground underline underline-offset-4">
              Clear selection
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function nodeStyle(leftPct: number, widthPct: number, height: number, centre: number): CSSProperties {
  return {
    left: `${leftPct}%`,
    width: `${widthPct}%`,
    height,
    top: centre - height / 2,
  };
}

function SectorNode({
  sector,
  kind,
  active,
  selectedCode,
  onSelect,
  expanded,
  onExpand,
}: {
  sector: TreeSectorNode;
  kind: string;
  active: boolean;
  selectedCode: string | null;
  onSelect: (sel: string) => void;
  expanded: boolean;
  onExpand: () => void;
}) {
  const sectorStyle = nodeStyle(TREE_LAYOUT.sectorLeft, 22, TREE_LAYOUT.sectorNodeHeight, sector.y);
  return (
    <>
      <button
        type="button"
        aria-pressed={sector.folded ? expanded : active}
        title={sector.title}
        onClick={sector.folded ? onExpand : () => onSelect(`connection:${kind}>${sector.label}`)}
        className={cn(
          "absolute flex items-center gap-2 rounded-[var(--radius)] border px-2.5 text-left text-sm transition-colors hover:bg-muted/50",
          active ? "border-primary bg-primary/15" : "border-border bg-card",
        )}
        style={sectorStyle}
      >
        <SectorIcon industry={sector.industry} size={16} />
        <span className="min-w-0 truncate">{sector.label}</span>
      </button>
      {sector.companies.map((node) => {
        const selected = node.code !== null && node.code === selectedCode;
        const style = nodeStyle(TREE_LAYOUT.companyLeft, 24, TREE_LAYOUT.rowHeight, node.y);
        if (node.code === null) {
          return (
            <button
              key={node.id}
              type="button"
              aria-pressed={expanded}
              title={node.title}
              onClick={onExpand}
              className={cn(
                "absolute flex items-center rounded-[var(--radius)] border border-dashed px-2.5 text-left text-xs hover:bg-muted/50",
                node.members.some((m) => m.code === selectedCode) ? "border-primary bg-primary/15" : "border-border bg-card",
              )}
              style={style}
            >
              <span className="min-w-0 truncate">
                Other companies ({node.members.length})
              </span>
            </button>
          );
        }
        return (
          <button
            key={node.id}
            type="button"
            aria-pressed={selected}
            title={node.title}
            onClick={() => onSelect(`stock:${node.code}`)}
            className={cn(
              "absolute flex items-center gap-2 rounded-[var(--radius)] border px-2 text-left transition-colors hover:bg-muted/50",
              selected ? "border-primary bg-primary/15" : "border-border bg-card",
            )}
            style={style}
          >
            <StockLogoBox code={node.code} size={28} />
            <span className="font-mono text-sm font-semibold tabular-nums">{node.code}</span>
            {node.votingPowerPct !== null ? (
              <span className="ml-auto whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground">
                {formatHeadlinePct(node.votingPowerPct)}
              </span>
            ) : null}
          </button>
        );
      })}
    </>
  );
}

/** The map's figures for a reader who cannot see the diagram: every company, its sector and its figures. */
function SrConnectionsTable({ tree, name }: { tree: HolderTree | null; name: string }) {
  if (tree === null) return null;
  return (
    <ScreenReaderTable ariaLabel={`${name}'s disclosed connections, sector by sector`}>
      <thead>
        <tr>
          <th scope="col">Sector</th>
          <th scope="col">Company</th>
          <th scope="col">Voting power</th>
          <th scope="col">Estimated exposure</th>
        </tr>
      </thead>
      <tbody>
        {tree.sectors.flatMap((sector) =>
          sector.companies.map((company) => (
            <tr key={`${sector.label}:${company.code}`}>
              <td>{sector.label}</td>
              <td>{company.code}</td>
              <td>{formatHeadlinePct(company.votingPowerPct)}</td>
              <td>{company.exposureAud === null ? "n/a" : formatAmount(company.exposureAud, "AUD")}</td>
            </tr>
          )),
        )}
      </tbody>
    </ScreenReaderTable>
  );
}
