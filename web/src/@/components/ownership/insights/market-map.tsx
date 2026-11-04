"use client";

/**
 * The market map: the ASX by sector, then stock, as a treemap. Area is the
 * measure (what index funds hold, or the disclosed stakes); colour is the change
 * over the window on the diverging rust to avocado scale, hatched where the
 * window cannot state a change.
 *
 * A sector's header (or its "more" tile) zooms into that sector; a stock opens
 * its panel. The map is one tab stop: the arrow keys walk the tiles in reading
 * order, Enter or Space opens one, and the focused tile shows the same readout
 * as a hovered one. The sector table under the map holds every figure.
 *
 * Loaded lazily by insights-charts-lazy.tsx, so d3-hierarchy never reaches the
 * page's first load.
 */

import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { sectorLabel, formatAud } from "~/@/lib/ownership/insights/format";
import { BIN_STYLES, NA_HATCH_STROKE, NA_STYLE, divergingBin, divergingDomain } from "~/@/lib/ownership/insights/scale";
import { layoutMarketMap, readingOrder, tileLabelLevel, type MapTile } from "~/@/lib/ownership/insights/treemap";
import type {
  InsightMeasure,
  InsightRemainderRow,
  InsightSectorRow,
  InsightStockRow,
} from "~/@/lib/ownership/insights/types";
import { cn } from "~/@/lib/utils";

import { ChangeLegend, changeText } from "./insights-parts";
import { useElementSize } from "./use-element-size";

export interface MarketMapProps {
  sectors: readonly InsightSectorRow[];
  stocks: readonly InsightStockRow[];
  remainders: readonly InsightRemainderRow[];
  measure: InsightMeasure;
  /** The sector filling the map; null for every sector. */
  focus: string | null;
  /** The stock whose panel is open; "" for none. */
  selected: string;
  onFocusSector: (sector: string | null) => void;
  onSelectStock: (code: string) => void;
}

/** The map's height for its width: wide enough to read, never taller than a screen. */
export function mapHeight(width: number): number {
  return Math.round(Math.min(620, Math.max(340, width * 0.56)));
}

function tileSummary(tile: MapTile, measure: InsightMeasure, stock: InsightStockRow | undefined): string {
  const size = measure === "funds" ? `index funds hold ${formatAud(tile.value)}` : `disclosed stakes ${formatAud(tile.value)}`;
  if (tile.kind === "rest") {
    return `${tile.stocks} more ${sectorLabel(tile.sector)} stocks, ${size}. Open the sector to see them.`;
  }
  const change =
    measure === "funds"
      ? tile.change == null
        ? "change n/a: no fund compared"
        : `change in shares ${changeText(measure, tile.change)}`
      : stock && stock.notices > 0
        ? `notices state ${changeText(measure, tile.change)} net, ${stock.notices} notices`
        : "no notice in the window";
  return `${tile.code}, ${tile.name || tile.code}, ${sectorLabel(tile.sector)}: ${size}, ${change}.`;
}

export function MarketMap({
  sectors,
  stocks,
  remainders,
  measure,
  focus,
  selected,
  onFocusSector,
  onSelectStock,
}: MarketMapProps) {
  const id = useId();
  const hatchId = `${id}-hatch`.replace(/:/g, "");
  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const width = box.width;
  const height = mapHeight(width);
  const layout = useMemo(
    () => layoutMarketMap({ sectors, stocks, remainders, measure, width, height, focus }),
    [sectors, stocks, remainders, measure, width, height, focus],
  );
  const stockBy = useMemo(() => new Map(stocks.map((s) => [s.code, s])), [stocks]);
  const domain = useMemo(() => divergingDomain(layout.tiles.map((t) => t.change)), [layout.tiles]);
  const order = useMemo(() => readingOrder(layout.tiles), [layout.tiles]);
  const [active, setActive] = useState(0);
  const [hover, setHover] = useState<{ tile: MapTile; x: number; y: number } | null>(null);
  const tileRefs = useRef(new Map<string, SVGGElement>());
  const activeIndex = Math.min(active, Math.max(0, order.length - 1));

  const openTile = (tile: MapTile) => {
    if (tile.kind === "rest") onFocusSector(tile.sector);
    else onSelectStock(tile.code);
  };

  const onKeyDown = (event: KeyboardEvent<SVGGElement>, index: number) => {
    const move = (to: number) => {
      event.preventDefault();
      const next = Math.max(0, Math.min(order.length - 1, to));
      setActive(next);
      const tile = order[next];
      if (tile) tileRefs.current.get(tile.id)?.focus();
    };
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        move(index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(order.length - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const tile = order[index];
        if (tile) openTile(tile);
        break;
      }
      case "Escape":
        if (focus !== null) {
          event.preventDefault();
          onFocusSector(null);
        }
        break;
    }
  };

  const pointerAt = (event: PointerEvent<SVGGElement>, tile: MapTile) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({ tile, x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  const focusedTile = hover?.tile;
  const sizeTitle = measure === "funds" ? "Area: what the index funds tracked hold" : "Area: disclosed stakes times market cap";
  const colourTitle =
    measure === "funds"
      ? "Colour: change in the shares the compared index funds hold over the window"
      : "Colour: net change in voting power the window's notices state";

  return (
    <div className="space-y-3">
      <nav aria-label="Market map level" className="flex flex-wrap items-center gap-1 text-xs">
        <button
          type="button"
          onClick={() => onFocusSector(null)}
          aria-current={focus === null ? "page" : undefined}
          className={cn(
            "hit-target rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            focus === null ? "font-semibold text-foreground" : "text-primary hover:underline",
          )}
        >
          All sectors
        </button>
        {focus !== null ? (
          <>
            <span aria-hidden className="text-muted-foreground">
              /
            </span>
            <span aria-current="page" className="px-1.5 font-semibold text-foreground">
              {sectorLabel(focus)}
            </span>
          </>
        ) : null}
      </nav>

      <div ref={boxRef} className="relative w-full" style={{ height }}>
        {width > 0 && layout.tiles.length === 0 ? (
          <p className="absolute inset-0 grid place-items-center text-center text-xs text-muted-foreground">
            {measure === "funds"
              ? "No index fund file on record holds a stock in this view at the window's end."
              : "No disclosed stake with a market cap on record in this view."}
          </p>
        ) : null}
        {width > 0 ? (
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="group"
            aria-label={`Market map: ${focus === null ? "every sector" : sectorLabel(focus)}. ${sizeTitle}. ${colourTitle}. Use the arrow keys to move between stocks.`}
            className="block select-none font-mono"
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" className={NA_STYLE.fill} />
                <line x1="0" y1="0" x2="0" y2="6" strokeWidth="2" className={NA_HATCH_STROKE} />
              </pattern>
            </defs>

            {layout.groups.map((g) =>
              g.header ? (
                <g key={g.sector}>
                  <foreignObject x={g.x0} y={g.y0} width={g.x1 - g.x0} height={18}>
                    <button
                      type="button"
                      onClick={() => onFocusSector(g.sector)}
                      title={`Open ${g.label}`}
                      className="flex h-[18px] w-full items-center gap-1.5 overflow-hidden px-1 text-left text-[10px] text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="truncate font-semibold uppercase tracking-[0.06em]">{g.label}</span>
                      <span className="shrink-0 font-normal tabular-nums text-muted-foreground">
                        {formatAud(g.value)}
                        {g.change != null ? ` ${changeText(measure, g.change)}` : ""}
                      </span>
                    </button>
                  </foreignObject>
                </g>
              ) : null,
            )}

            {order.map((tile, index) => {
              const bin = divergingBin(tile.change, domain);
              const style = bin == null ? NA_STYLE : BIN_STYLES[bin];
              const w = tile.x1 - tile.x0;
              const h = tile.y1 - tile.y0;
              const level = tileLabelLevel(tile);
              const isSelected = tile.kind === "stock" && tile.code === selected;
              const stock = stockBy.get(tile.code);
              return (
                <g
                  key={tile.id}
                  ref={(el) => {
                    if (el) tileRefs.current.set(tile.id, el);
                    else tileRefs.current.delete(tile.id);
                  }}
                  role="button"
                  tabIndex={index === activeIndex ? 0 : -1}
                  aria-label={tileSummary(tile, measure, stock)}
                  aria-pressed={tile.kind === "stock" ? isSelected : undefined}
                  className="cursor-pointer outline-none [&:focus-visible>rect.tile-ring]:opacity-100"
                  onClick={() => openTile(tile)}
                  onKeyDown={(e) => onKeyDown(e, index)}
                  onFocus={() => {
                    setActive(index);
                    setHover({ tile, x: tile.x0 + w / 2, y: tile.y0 + h });
                  }}
                  onBlur={() => setHover(null)}
                  onPointerMove={(e) => pointerAt(e, tile)}
                >
                  <rect
                    x={tile.x0}
                    y={tile.y0}
                    width={w}
                    height={h}
                    rx={Math.min(3, w / 4, h / 4)}
                    className={cn(bin == null ? undefined : style.fill, "transition-opacity duration-150 hover:opacity-90")}
                    fill={bin == null ? `url(#${hatchId})` : undefined}
                  />
                  <rect
                    className={cn(
                      "tile-ring pointer-events-none fill-none stroke-primary",
                      isSelected ? "opacity-100" : "opacity-0",
                    )}
                    x={tile.x0 + 1}
                    y={tile.y0 + 1}
                    width={Math.max(0, w - 2)}
                    height={Math.max(0, h - 2)}
                    strokeWidth={2}
                    rx={Math.min(3, w / 4, h / 4)}
                  />
                  {level > 0 ? (
                    <text
                      x={tile.x0 + 4}
                      y={tile.y0 + 13}
                      className={cn("pointer-events-none text-[11px] font-semibold", style.text)}
                    >
                      {tile.kind === "rest" ? tile.name : tile.code}
                    </text>
                  ) : null}
                  {level > 1 ? (
                    <text
                      x={tile.x0 + 4}
                      y={tile.y0 + 26}
                      className={cn("pointer-events-none text-[10px] tabular-nums", style.text)}
                    >
                      {tile.kind === "rest"
                        ? formatAud(tile.value)
                        : measure === "disclosed" && stock && stock.notices === 0
                          ? formatAud(tile.value)
                          : changeText(measure, tile.change)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        ) : null}

        {hover && focusedTile ? (
          <div
            role="presentation"
            className="pointer-events-none absolute z-10 w-max max-w-[260px] rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-none"
            style={{
              left: Math.min(Math.max(0, hover.x + 12), Math.max(0, width - 260)),
              top: Math.min(hover.y + 12, height - 8),
            }}
          >
            <MapReadout tile={focusedTile} measure={measure} stock={stockBy.get(focusedTile.code)} />
          </div>
        ) : null}
      </div>

      <ChangeLegend
        measure={measure}
        domain={domain}
        title={`${sizeTitle}. ${colourTitle}.`}
        naText={measure === "funds" ? "n/a: no fund compared" : undefined}
        naOnly={measure === "funds" && layout.tiles.length > 0 && layout.tiles.every((t) => t.change == null)}
      />
    </div>
  );
}

function MapReadout({ tile, measure, stock }: { tile: MapTile; measure: InsightMeasure; stock: InsightStockRow | undefined }) {
  if (tile.kind === "rest") {
    return (
      <>
        <p className="font-semibold">{tile.name}</p>
        <p className="text-muted-foreground">{sectorLabel(tile.sector)}</p>
        <p className="tabular-nums">{formatAud(tile.value)}</p>
        <p className="mt-1 text-[10px] text-muted-foreground">Open the sector to see every stock.</p>
      </>
    );
  }
  return (
    <>
      <p className="tabular-nums">
        <span className="text-sm font-semibold">{changeText(measure, tile.change)}</span>{" "}
        <span className="text-muted-foreground">{measure === "funds" ? "shares held" : "net, notices"}</span>
      </p>
      <p className="font-semibold">
        {tile.code} <span className="font-normal text-muted-foreground">{tile.name}</span>
      </p>
      <p className="text-muted-foreground">{sectorLabel(tile.sector)}</p>
      {stock ? (
        <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 tabular-nums">
          <dt className="text-muted-foreground">Index funds hold</dt>
          <dd className="text-right">{formatAud(stock.fundValue)}</dd>
          <dt className="text-muted-foreground">Disclosed stakes</dt>
          <dd className="text-right">{formatAud(stock.disclosedValue)}</dd>
          <dt className="text-muted-foreground">Notices in window</dt>
          <dd className="text-right">{stock.notices.toLocaleString("en-AU")}</dd>
        </dl>
      ) : null}
    </>
  );
}
