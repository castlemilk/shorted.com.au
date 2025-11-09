"use client";

import React, { type FC, useEffect, useState, Suspense, useRef } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/@/components/ui/select";
import { Label } from "~/@/components/ui/label";
import { Card, CardTitle } from "~/@/components/ui/card";
import { Treemap, hierarchy, stratify, treemapSquarify } from "@visx/hierarchy";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { type IndustryTreeMap } from "~/gen/stocks/v1alpha1/stocks_pb";
import { getIndustryTreeMapClient } from "../actions/client/getIndustryTreeMap";
import { type PlainMessage } from "@bufbuild/protobuf";
import { useRouter } from "next/navigation";
import { ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { Skeleton } from "~/@/components/ui/skeleton";
import { TreemapTooltip } from "~/@/components/widgets/treemap-tooltip";

interface TreeMapProps {
  initialTreeMapData?: PlainMessage<IndustryTreeMap>; // Optional initial data
  initialPeriod?: string; // Add initial period prop
  initialViewMode?: ViewMode; // Add initial view mode prop
}

interface TreeMapDatum {
  id: string;
  parent?: string;
  size?: number;
}

const PADDING = 5;

export const IndustryTreeMapView: FC<TreeMapProps> = ({
  initialTreeMapData,
  initialPeriod = "3m",
  initialViewMode = ViewMode.CURRENT_CHANGE,
}) => {
  const firstUpdate = useRef(!initialTreeMapData); // If no initial data, fetch on mount
  const router = useRouter();
  const [period, setPeriod] = useState<string>(initialPeriod);
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
  const [treeMapData, setTreeMapData] =
    useState<PlainMessage<IndustryTreeMap> | null>(initialTreeMapData ?? null);
  const [loading, setLoading] = useState<boolean>(!initialTreeMapData);

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
    if (firstUpdate.current && initialTreeMapData) {
      firstUpdate.current = false;
      return;
    }

    if (firstUpdate.current) {
      firstUpdate.current = false;
    }

    setLoading(true);
    getIndustryTreeMapClient(period, 10, viewMode)
      .then((data) => {
        setTreeMapData(data);
        setLoading(false);
      })
      .catch((e) => {
        console.error("Error fetching data: ", e);
        setLoading(false);
      });
  }, [period, viewMode, initialTreeMapData]);

  if (loading || !treeMapData) {
    return (
      <Card className="m-2 w-full">
        <div className="flex align-middle justify-between">
          <CardTitle className="self-center m-5">Industry Tree Map</CardTitle>
        </div>
        <div className="p-2">
          <Skeleton className="h-[700px] w-full rounded-xl" />
        </div>
      </Card>
    );
  }

  const industryTreeMap = stratify<TreeMapDatum>()
    .id((d) => d.id)
    .parentId((d) => d.parent)([
      { id: "root", parent: undefined }, // Add a dummy root node
      ...treeMapData.industries.map((industry) => ({
        id: industry,
        parent: "root",
      })),
      ...treeMapData.stocks.map((stock) => ({
        id: stock.productCode,
        parent: stock.industry,
        size: stock.shortPosition,
      })),
    ])
    .sum((d) => d.size ?? 0);

  const colorScale = scaleLinear({
    domain: [0, Math.max(...treeMapData.stocks.map((d) => d.shortPosition))],
    range: ["#33B074", "#EC5D5E"],
  });

  const root = hierarchy(industryTreeMap).sort(
    (a, b) => (b.value ?? 0) - (a.value ?? 0),
  );

  const handleMouseEnter = (event: React.MouseEvent, productCode: string) => {
    // Clear any pending hide timeout
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }

    const stock = treeMapData?.stocks.find(
      (s) => s.productCode === productCode,
    );
    if (!stock) return;

    const svgRect = (event.target as SVGRectElement)
      .closest("svg")!
      .getBoundingClientRect();

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

  const handleMouseLeave = () => {
    // Add a small delay before hiding to prevent flickering
    hideTimeoutRef.current = setTimeout(() => {
      setTooltipState(null);
    }, 100);
  };

  const handleRectClick = (stockCode: string) => {
    router.push(`/shorts/${stockCode}`);
  };

  return (
    <Card className="m-2 w-full">
      <div className="flex align-middle justify-between">
        <CardTitle className="self-center m-5">Industry Tree Map</CardTitle>
        <div className="flex flex-col sm:flex-row m-2 gap-2">
          <div className="w-48">
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
            <div className="w-48">
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
            <Skeleton className="h-[700px] w-full rounded-xl" />
          </div>
        }
      >
        <ParentSize>
          {({ width }) => (
            <div style={{ position: "relative" }}>
              <svg width={width} height={700}>
                <Treemap<typeof industryTreeMap>
                  top={0}
                  root={root}
                  size={[width, 700]}
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
                            (isTopEdge ? PADDING * 4 : 0) -
                            (isBottomEdge ? PADDING : 0);

                          const top = node.y0 + (isTopEdge ? PADDING * 4 : 0);
                          const left = node.x0 + (isLeftEdge ? PADDING : 0);

                          if (nodeHeight < 0 || nodeWidth < 0) {
                            return null;
                          }

                          return (
                            <Group
                              key={`node-${i}`}
                              top={top}
                              left={left}
                              onMouseEnter={(e) =>
                                handleMouseEnter(e, node.data?.id ?? "")
                              }
                              onMouseLeave={handleMouseLeave}
                              pointerEvents={"all"}
                              onClick={() =>
                                handleRectClick(node.data?.id ?? "")
                              }
                            >
                              <rect
                                width={nodeWidth}
                                height={nodeHeight}
                                stroke="#114b5f"
                                fill={colorScale(node.value ?? 0)}
                                pointerEvents={"all"}
                                cursor={"pointer"}
                              />
                              {nodeWidth > 20 && (
                                <>
                                  <text
                                    x={nodeWidth / 2}
                                    y={nodeHeight / 2}
                                    dy=".33em"
                                    fontSize={10}
                                    textAnchor="middle"
                                    pointerEvents="none"
                                    fill="hsl(var(--foreground))"
                                  >
                                    {node.data.id}
                                  </text>
                                </>
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

                          return (
                            <Group
                              key={`node-${i}`}
                              top={node.y0}
                              left={node.x0}
                            >
                              <text
                                x={5}
                                y={5}
                                dy=".66em"
                                fontSize={12}
                                textAnchor="start"
                                pointerEvents="none"
                                fill="hsl(var(--foreground))"
                              >
                                {`${node.data.id?.substring(0, nodeWidth / 10)}${(node.data.id?.length ?? 0) > nodeWidth / 10 ? "..." : ""}`}
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
                />
              )}
            </div>
          )}
        </ParentSize>
      </Suspense>
    </Card>
  );
};
