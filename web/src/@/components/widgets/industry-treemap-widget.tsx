"use client";

import { useEffect, useState } from "react";
import { type WidgetProps } from "@/types/dashboard";
import { type PlainMessage } from "@bufbuild/protobuf";
import { type IndustryTreeMap } from "~/gen/stocks/v1alpha1/stocks_pb";
import { ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { getIndustryTreeMap } from "~/app/actions/getIndustryTreeMap";
import { Treemap, hierarchy, stratify, treemapSquarify } from "@visx/hierarchy";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { useRouter } from "next/navigation";

interface TreeMapDatum {
  id: string;
  parent?: string;
  size?: number;
  industry?: string;
}

export function IndustryTreemapWidget({ config }: WidgetProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [treeMapData, setTreeMapData] = useState<PlainMessage<IndustryTreeMap> | null>(null);
  
  const period = (config.settings?.period as string) || "3m";
  const viewMode = config.settings?.viewMode === "PERCENTAGE_CHANGE" 
    ? ViewMode.PERCENTAGE_CHANGE 
    : ViewMode.CURRENT_CHANGE;
  const showSectorGrouping = config.settings?.showSectorGrouping ?? true; // Default to true like the main treemap

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const data = await getIndustryTreeMap(period, 10, viewMode);
        setTreeMapData(data);
      } catch (error) {
        console.error("Error fetching treemap data:", error);
      } finally {
        setLoading(false);
      }
    };

    void fetchData();
    
    if (config.dataSource.refreshInterval) {
      const interval = setInterval(() => void fetchData(), config.dataSource.refreshInterval * 1000);
      return () => clearInterval(interval);
    }
  }, [period, viewMode, config.dataSource.refreshInterval]);

  if (loading || !treeMapData) {
    return <div className="animate-pulse">Loading industry data...</div>;
  }

  // Build tree data based on whether sector grouping is enabled
  const treeData = showSectorGrouping
    ? [
        { id: "root", parent: undefined },
        ...treeMapData.industries.map((industry) => ({
          id: industry,
          parent: "root",
        })),
        ...treeMapData.stocks.map((stock) => ({
          id: stock.productCode,
          parent: stock.industry,
          size: stock.shortPosition,
          industry: stock.industry,
        })),
      ]
    : [
        { id: "root", parent: undefined },
        ...treeMapData.stocks.map((stock) => ({
          id: stock.productCode,
          parent: "root",
          size: stock.shortPosition,
          industry: stock.industry,
        })),
      ];

  const industryTreeMap = stratify<TreeMapDatum>()
    .id((d) => d.id)
    .parentId((d) => d.parent)(treeData)
    .sum((d) => d.size ?? 0);

  const colorScale = scaleLinear({
    domain: [0, Math.max(...treeMapData.stocks.map((d) => d.shortPosition))],
    range: ["#33B074", "#EC5D5E"],
  });

  const root = hierarchy(industryTreeMap).sort(
    (a, b) => (b.value ?? 0) - (a.value ?? 0)
  );

  const PADDING = 5;

  return (
    <ParentSize>
      {({ width, height }) => (
        <Treemap
          root={root}
          size={[width, height]}
          tile={treemapSquarify}
          round
        >
          {(treemap) => (
            <svg width={width} height={height}>
              <Group>
                {/* Render stocks */}
                {treemap
                  .descendants()
                  .filter((node) => showSectorGrouping ? node.depth > 1 : node.depth === 1)
                  .map((node, i) => {
                    const nodeWithPath = node as {
                      x0: number;
                      y0: number;
                      x1: number;
                      y1: number;
                      data: { data: { id: string; industry?: string } };
                    };

                    const stock = treeMapData.stocks.find(
                      (s) => s.productCode === node.data.data.id
                    );
                    if (!stock) return null;

                    // Apply padding for sector grouped view
                    let nodeX = nodeWithPath.x0;
                    let nodeY = nodeWithPath.y0;
                    let nodeWidth = nodeWithPath.x1 - nodeWithPath.x0;
                    let nodeHeight = nodeWithPath.y1 - nodeWithPath.y0;

                    if (showSectorGrouping && node.parent) {
                      const parentNode = node.parent as {
                        x0: number;
                        y0: number;
                        x1: number;
                        y1: number;
                      };
                      const isTopEdge = nodeWithPath.y0 === parentNode.y0;
                      const isBottomEdge = nodeWithPath.y1 === parentNode.y1;
                      const isLeftEdge = nodeWithPath.x0 === parentNode.x0;
                      const isRightEdge = nodeWithPath.x1 === parentNode.x1;

                      nodeX = nodeWithPath.x0 + (isLeftEdge ? PADDING : 0);
                      nodeY = nodeWithPath.y0 + (isTopEdge ? PADDING * 4 : 0);
                      nodeWidth = nodeWithPath.x1 - nodeWithPath.x0 - (isLeftEdge ? PADDING : 0) - (isRightEdge ? PADDING : 0);
                      nodeHeight = nodeWithPath.y1 - nodeWithPath.y0 - (isTopEdge ? PADDING * 4 : 0) - (isBottomEdge ? PADDING : 0);

                      if (nodeHeight < 0 || nodeWidth < 0) {
                        return null;
                      }
                    }

                    return (
                      <g
                        key={`stock-${i}`}
                        onClick={() => router.push(`/shorts/${stock.productCode}`)}
                        style={{ cursor: "pointer" }}
                      >
                        <rect
                          x={nodeX}
                          y={nodeY}
                          width={nodeWidth}
                          height={nodeHeight}
                          fill={colorScale(stock.shortPosition)}
                          stroke="white"
                          strokeWidth={1}
                          className="transition-opacity hover:opacity-80"
                        />
                        {nodeWidth > 50 && (
                          <text
                            x={nodeX + nodeWidth / 2}
                            y={nodeY + nodeHeight / 2}
                            dy=".35em"
                            textAnchor="middle"
                            fontSize={12}
                            fill="white"
                            fontWeight="600"
                          >
                            {stock.productCode}
                          </text>
                        )}
                      </g>
                    );
                  })}

                {/* Render sector labels if grouping is enabled */}
                {showSectorGrouping &&
                  treemap
                    .descendants()
                    .filter((node) => node.depth === 1)
                    .map((node, i) => {
                      const nodeWithPath = node as {
                        x0: number;
                        y0: number;
                        x1: number;
                        y1: number;
                        data: { data: { id: string } };
                      };
                      const nodeWidth = nodeWithPath.x1 - nodeWithPath.x0;

                      return (
                        <Group
                          key={`sector-label-${i}`}
                          top={nodeWithPath.y0}
                          left={nodeWithPath.x0}
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
                            {`${node.data.data.id.substring(0, nodeWidth / 10)}${
                              node.data.data.id.length > nodeWidth / 10 ? "..." : ""
                            }`}
                          </text>
                        </Group>
                      );
                    })}
              </Group>
            </svg>
          )}
        </Treemap>
      )}
    </ParentSize>
  );
}