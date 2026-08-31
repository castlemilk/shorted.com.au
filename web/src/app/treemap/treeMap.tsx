"use client";

import React, { type FC, useEffect, useState, useMemo, Suspense, useRef } from "react";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/@/components/ui/select";
import { Label } from "~/@/components/ui/label";
import { Card, CardTitle } from "~/@/components/ui/card";
// Lazy load @visx modules to reduce initial bundle size
import { Treemap, hierarchy, stratify, treemapSquarify } from "@visx/hierarchy";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { type IndustryTreeMap, IndustryTreeMapSchema } from "~/gen/stocks/v1alpha1/stocks_pb";
import { getIndustryTreeMapClient } from "../actions/client/getIndustryTreeMap";
import { useRouter } from "next/navigation";
import { ViewMode } from "~/gen/shorts/v1alpha1/market_pb";
import { Skeleton } from "~/@/components/ui/skeleton";
import { TreemapTooltip } from "~/@/components/widgets/treemap-tooltip";
import { cn } from "~/@/lib/utils";
import { getSectorImagePath } from "~/@/lib/sector-images";
import {
  LEAF_CHAR_WIDTH_RATIO,
  clamp,
  headerHeightFor,
  isMobileWidth,
  leafLabelFontSize,
  treemapHeightFor,
} from "./treemap-labels";

interface TreeMapProps {
  initialTreeMapData?: IndustryTreeMap; // Optional initial data
  // RSC-safe serialized form (protobuf JSON) for server-side prefetch — converted
  // back to IndustryTreeMap on the client so the homepage can seed the first
  // render from data already fetched server-side, skipping the mount fetch.
  initialTreeMapDataJson?: JsonValue;
  initialPeriod?: string; // Add initial period prop
  initialViewMode?: ViewMode; // Add initial view mode prop
  className?: string; // Allow custom class name
}

interface TreeMapDatum {
  id: string;
  parent?: string;
  size?: number;
}

const PADDING = 3;

type TreeMapDataType = IndustryTreeMap | null | undefined;

export const IndustryTreeMapView: FC<TreeMapProps> = ({
  initialTreeMapData,
  initialTreeMapDataJson,
  initialPeriod = "3m",
  initialViewMode = ViewMode.CURRENT_CHANGE,
  className,
}) => {
  // Prefer pre-parsed data; otherwise deserialize the RSC-safe JSON once.
  const initialData = useMemo<IndustryTreeMap | undefined>(() => {
    if (initialTreeMapData) return initialTreeMapData;
    if (initialTreeMapDataJson)
      return fromJson(IndustryTreeMapSchema, initialTreeMapDataJson);
    return undefined;
  }, [initialTreeMapData, initialTreeMapDataJson]);

  // Always true on the first effect run. When seeded with initialData the mount
  // effect bails before fetching. (Previously useRef(!initialTreeMapData) was
  // inverted, so seeded data fell through to the else branch and fetched anyway.)
  const firstUpdate = useRef(true);
  const router = useRouter();
  const [period, setPeriod] = useState<string>(initialPeriod);
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
  const [treeMapData, setTreeMapData] = useState<TreeMapDataType>(
    initialData ?? null,
  );
  const [loading, setLoading] = useState<boolean>(!initialData);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const [tooltipState, setTooltipState] = useState<{
    productCode: string;
    shortPosition: number;
    industry: string;
    x: number;
    y: number;
    containerWidth: number;
    containerHeight: number;
    containerX: number;
    containerY: number;
  } | null>(null);

  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Fetch data on mount if no initial data, or when period/viewMode changes
    if (firstUpdate.current && initialData) {
      firstUpdate.current = false;
      return;
    }

    if (firstUpdate.current) {
      firstUpdate.current = false;
      setLoading(true);
    } else {
      // Subsequent updates are refreshes, not initial loads
      setIsRefreshing(true);
    }

    // Slightly fewer tiles -> larger cells + more legible labels.
    getIndustryTreeMapClient(period, 8, viewMode)
      .then((data) => {
        setTreeMapData(data);
        setLoading(false);
        setIsRefreshing(false);
      })
      .catch((e) => {
        console.error("Error fetching data: ", e);
        setLoading(false);
        setIsRefreshing(false);
      });
  }, [period, viewMode, initialData]);

  if (loading || !treeMapData) {
    return (
      <Card className={cn("m-2 w-full", className)}>
        <div className="flex align-middle justify-between">
          <CardTitle className="self-center m-5">Industry Tree Map</CardTitle>
        </div>
        <div className="p-2">
          <Skeleton className="h-[440px] sm:h-[700px] w-full rounded-xl" />
        </div>
      </Card>
    );
  }

  // Type assertion after null check
  const industries: string[] = treeMapData.industries ?? [];
  type TreemapStock = IndustryTreeMap["stocks"][number];
  const stocks: TreemapStock[] = treeMapData.stocks ?? [];

  const treeMapDataArray: TreeMapDatum[] = [
    { id: "root", parent: undefined }, // Add a dummy root node
    ...industries.map(
      (industry: string): TreeMapDatum => ({
        id: industry,
        parent: "root",
      }),
    ),
    ...stocks.map(
      (stock: TreemapStock): TreeMapDatum => ({
        id: stock.productCode,
        parent: stock.industry,
        size: stock.shortPosition,
      }),
    ),
  ];

  const industryTreeMap = stratify<TreeMapDatum>()
    .id((d) => d.id)
    .parentId((d) => d.parent)(treeMapDataArray)
    .sum((d) => d.size ?? 0);

  const stockPositions = stocks.map((d: TreemapStock) => d.shortPosition);
  const maxPosition =
    stockPositions.length > 0 ? Math.max(...stockPositions) : 0;
  const colorScale = scaleLinear({
    domain: [0, maxPosition],
    range: ["#33B074", "#EC5D5E"],
  });

  const root = hierarchy(industryTreeMap).sort(
    (a, b) => (b.value ?? 0) - (a.value ?? 0),
  );

  const stockByCode = new Map(
    stocks.map((stock: TreemapStock) => [stock.productCode, stock]),
  );

  const clearHideTimeout = () => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  };

  const handleMouseEnter = (event: React.MouseEvent, productCode: string) => {
    // Clear any pending hide timeout
    clearHideTimeout();

    const stock = stockByCode.get(productCode);
    if (!stock) return;

    const svg = (event.currentTarget as SVGGElement).closest("svg");
    if (!svg) return;
    const svgRect = svg.getBoundingClientRect();

    // Use mouse position directly (clientX/Y are viewport coordinates)
    setTooltipState({
      productCode: stock.productCode,
      shortPosition: stock.shortPosition,
      industry: stock.industry,
      x: event.clientX,
      y: event.clientY,
      containerWidth: svgRect.width,
      containerHeight: svgRect.height,
      containerX: svgRect.left,
      containerY: svgRect.top,
    });
  };

  const handleMouseMove = (event: React.MouseEvent) => {
    const svg = (event.currentTarget as SVGGElement).closest("svg");
    if (!svg) return;
    const svgRect = svg.getBoundingClientRect();

    setTooltipState((current) => {
      if (!current) return current;
      return {
        ...current,
        x: event.clientX,
        y: event.clientY,
        containerWidth: svgRect.width,
        containerHeight: svgRect.height,
        containerX: svgRect.left,
        containerY: svgRect.top,
      };
    });
  };

  const handleMouseLeave = () => {
    // Add a small delay before hiding to prevent flickering
    hideTimeoutRef.current = setTimeout(() => {
      setTooltipState(null);
    }, 250);
  };

  const handleRectClick = (stockCode: string) => {
    router.push(`/shorts/${stockCode}`);
  };

  return (
    <Card className={cn("m-2 w-full", className)}>
      {/* flex-wrap + responsive select width: fixed-width controls otherwise
          force horizontal page scroll on mobile viewports */}
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <CardTitle className="self-center m-5">Industry Tree Map</CardTitle>
        <div className="flex flex-col sm:flex-row m-2 gap-2">
          <div className="w-36 sm:w-48">
            <Label htmlFor="viewMode">View Mode</Label>
            <Select
              onValueChange={(e) => setViewMode(parseInt(e, 10))}
              defaultValue={ViewMode.CURRENT_CHANGE.toString()}
            >
              <SelectTrigger id="viewMode">
                <SelectValue placeholder="Select" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ViewMode.CURRENT_CHANGE.toString()}>
                  Latest
                </SelectItem>
                <SelectItem value={ViewMode.PERCENTAGE_CHANGE.toString()}>
                  Percentage Change
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {viewMode === ViewMode.PERCENTAGE_CHANGE && (
            <div className="w-36 sm:w-48">
              <Label htmlFor="period">Time</Label>
              <Select onValueChange={(e) => setPeriod(e)} defaultValue={"max"}>
                <SelectTrigger id="period">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3m">3 months</SelectItem>
                  <SelectItem value="6m">6 months</SelectItem>
                  <SelectItem value="1y">1 year</SelectItem>
                  <SelectItem value="2y">2 years</SelectItem>
                  <SelectItem value="5y">5 years</SelectItem>
                  <SelectItem value="max">max</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </div>
      <Suspense
        fallback={
          <div className="p-2">
            <Skeleton className="h-[440px] sm:h-[700px] w-full rounded-xl" />
          </div>
        }
      >
        <div className="relative overflow-hidden">
          {isRefreshing && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/70 backdrop-blur-sm m-2 rounded-xl">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              <p className="text-sm text-muted-foreground">Updating data…</p>
            </div>
          )}
          <ParentSize>
            {({ width }) => {
              const isMobile = isMobileWidth(width);
              const headerHeight = headerHeightFor(width);
              return (
              <div style={{ position: "relative" }}>
                <svg
                  width={width}
                  height={treemapHeightFor(width)}
                  data-testid="treemap"
                  role="img"
                  aria-label="Industry short position heatmap"
                >
                  <Treemap<typeof industryTreeMap>
                    top={0}
                    root={root}
                    size={[width, treemapHeightFor(width)]}
                    tile={treemapSquarify}
                    round
                  >
                    {(treemap) => (
                      <Group>
                        {/* Render child nodes first */}
                        {treemap.descendants().map((node, i) => {
                          if (node.depth > 1) {
                            const isTopEdge = node.y0 === node.parent?.y0;
                            const isBottomEdge = node.y1 === node.parent?.y1;
                            const isLeftEdge = node.x0 === node.parent?.x0;
                            const isRightEdge = node.x1 === node.parent?.x1;

                            const nodeWidth =
                              node.x1 -
                              node.x0 -
                              (isLeftEdge ? PADDING : 0) -
                              (isRightEdge ? PADDING : 0);
                            const nodeHeight =
                              node.y1 -
                              node.y0 -
                              (isTopEdge ? headerHeight + PADDING : 0) -
                              (isBottomEdge ? PADDING : 0);

                            const top =
                              node.y0 +
                              (isTopEdge ? headerHeight + PADDING : 0);
                            const left = node.x0 + (isLeftEdge ? PADDING : 0);

                            if (nodeHeight < 0 || nodeWidth < 0) {
                              return null;
                            }

                            const leafLabel = node.data.id ?? "";
                            const leafFontSize = leafLabelFontSize(
                              nodeWidth,
                              nodeHeight,
                              leafLabel,
                              width,
                            );

                            return (
                              <Group
                                key={`node-${i}`}
                                top={top}
                                left={left}
                                onMouseEnter={(e) =>
                                  handleMouseEnter(e, node.data?.id ?? "")
                                }
                                onMouseMove={handleMouseMove}
                                onMouseLeave={handleMouseLeave}
                                pointerEvents={"all"}
                                onClick={() =>
                                  handleRectClick(node.data?.id ?? "")
                                }
                                role="link"
                                aria-label={`${node.data?.id ?? ""} — ${(node.value ?? 0).toFixed(1)}% short interest`}
                              >
                                <rect
                                  width={nodeWidth}
                                  height={nodeHeight}
                                  stroke="hsl(var(--border))"
                                  fill={colorScale(node.value ?? 0)}
                                  pointerEvents={"all"}
                                  cursor={"pointer"}
                                />
                                {leafFontSize !== null && (
                                  <text
                                    x={nodeWidth / 2}
                                    y={nodeHeight / 2}
                                    dy=".33em"
                                    fontSize={leafFontSize}
                                    fontWeight={600}
                                    textAnchor="middle"
                                    pointerEvents="none"
                                    fill="hsl(var(--foreground))"
                                  >
                                    {leafLabel}
                                  </text>
                                )}
                              </Group>
                            );
                          }
                          return null;
                        })}

                        {/* Render parent nodes and their text last to bring them to the front */}
                        {treemap.descendants().map((node, i) => {
                          if (node.depth === 1) {
                            const nodeWidth = node.x1 - node.x0;
                            const nodeHeight = node.y1 - node.y0;
                            const parentFontSize = clamp(
                              isMobile ? 9 : 11,
                              Math.floor(nodeWidth / 22),
                              14,
                            );

                            // Don't render label if section is too small
                            if (
                              nodeWidth < (isMobile ? 40 : 60) ||
                              nodeHeight < (isMobile ? 28 : 40)
                            )
                              return null;

                            const iconSize = isMobile ? 12 : 16;
                            const showIcon = nodeWidth >= 80;
                            const textX = showIcon
                              ? iconSize + (isMobile ? 6 : 10)
                              : 8;
                            const maxChars = Math.floor(
                              (nodeWidth - textX - 4) /
                                (parentFontSize * LEAF_CHAR_WIDTH_RATIO),
                            );

                            return (
                              <Group
                                key={`node-${i}`}
                                top={node.y0}
                                left={node.x0}
                              >
                                {/* Background bar for sector label */}
                                <rect
                                  x={0}
                                  y={0}
                                  width={nodeWidth}
                                  height={headerHeight}
                                  fill="hsl(var(--background))"
                                  opacity={0.85}
                                />
                                {/* Bottom border line */}
                                <line
                                  x1={0}
                                  y1={headerHeight}
                                  x2={nodeWidth}
                                  y2={headerHeight}
                                  stroke="hsl(var(--border))"
                                  strokeWidth={1}
                                />
                                {/* Sector icon */}
                                {showIcon && (
                                  <image
                                    href={getSectorImagePath(
                                      node.data.id ?? "",
                                    )}
                                    x={4}
                                    y={(headerHeight - iconSize) / 2}
                                    width={iconSize}
                                    height={iconSize}
                                  />
                                )}
                                <text
                                  x={textX}
                                  y={headerHeight / 2}
                                  dy=".35em"
                                  fontSize={parentFontSize}
                                  fontWeight={600}
                                  textAnchor="start"
                                  pointerEvents="none"
                                  fill="hsl(var(--foreground))"
                                >
                                  {`${node.data.id?.substring(0, maxChars)}${(node.data.id?.length ?? 0) > maxChars ? "..." : ""}`}
                                </text>
                              </Group>
                            );
                          }
                          return null;
                        })}
                      </Group>
                    )}
                  </Treemap>
                </svg>

                {/* Render rich tooltip */}
                {tooltipState && (
                  <TreemapTooltip
                    productCode={tooltipState.productCode}
                    shortPosition={tooltipState.shortPosition}
                    industry={tooltipState.industry}
                    x={tooltipState.x}
                    y={tooltipState.y}
                    containerWidth={tooltipState.containerWidth}
                    containerHeight={tooltipState.containerHeight}
                    containerX={tooltipState.containerX}
                    containerY={tooltipState.containerY}
                    onMouseEnter={clearHideTimeout}
                    onMouseLeave={handleMouseLeave}
                  />
                )}
              </div>
              );
            }}
          </ParentSize>
        </div>
      </Suspense>
    </Card>
  );
};
