"use client";

import React, { type FC, useEffect, useState, useCallback } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Card, CardTitle } from "@/components/ui/card";
import { Treemap, hierarchy, stratify, treemapSquarify } from "@visx/hierarchy";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { type IndustryTreeMap } from "~/gen/stocks/v1alpha1/stocks_pb";
import { getIndustryTreeMap } from "../actions/getIndustryTreeMap";
import { type PlainMessage } from "@bufbuild/protobuf";

const getPeriodString = (period: string) => {
  switch (period) {
    case "1m":
      return "1 month";
    case "3m":
      return "3 months";
    case "6m":
      return "6 months";
    case "1y":
      return "1 year";
    case "2y":
      return "2 years";
    case "max":
      return "maximum window";
    default:
      return "6 months";
  }
};

interface TreeMapProps {
  initialTreeMapData: PlainMessage<IndustryTreeMap>;
}

const PADDING = 5;
const TEXT_HEIGHT = 20;

export const IndustryTreeMapView: FC<TreeMapProps> = ({
  initialTreeMapData,
}) => {
  const [period, setPeriod] = useState<string>("3m");
  const [loading, setLoading] = useState<boolean>(false);
  const [treeMapData, setTreeMapData] =
    useState<PlainMessage<IndustryTreeMap> | null>(initialTreeMapData);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const newData = await getIndustryTreeMap(period, 10);
      setTreeMapData(newData);
    } catch (e) {
      console.error("Error fetching data: ", e);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    setLoading(true);
    getIndustryTreeMap(period, 10)
      .then((data) => {
        setTreeMapData(data);
        setLoading(false);
      })
      .catch((e) => {
        console.error("Error fetching data: ", e);
        setLoading(false);
      });
  }, [period]);

  if (!treeMapData) {
    return <div>Loading...</div>;
  }

  const industryTreeMap = stratify()
    .id((d) => d.id)
    .parentId((d) => d.parent)([
      { id: "root", parent: null, name: "Root" }, // Add a dummy root node
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
    range: ["#f3e5ab", "#eec900"],
  });

  const root = hierarchy(industryTreeMap).sort(
    (a, b) => (b.value || 0) - (a.value || 0),
  );

  return (
    <Card className="m-3 w-full">
      <div className="flex align-middle justify-between">
        <CardTitle className="self-center m-5">Tree Map</CardTitle>
        <div className="flex flex-row-reverse m-2">
          <div className="w-48">
            <Label htmlFor="period">Time</Label>
            <Select onValueChange={(e) => setPeriod(e)} defaultValue={"3m"}>
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
        </div>
      </div>
      <ParentSize>
        {({ width, height }) => (
          <svg width={width} height={600}>
            <Treemap<typeof industryTreeMap>
              top={0}
              root={root}
              size={[width, 600]}
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

                      return (
                        <Group key={`node-${i}`} top={top} left={left}>
                          <rect
                            width={nodeWidth}
                            height={nodeHeight}
                            stroke="#114b5f"
                            fill={colorScale(node.value || 0)}
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
                                fill="#fff"
                              >
                                {node.data.id}
                              </text>
                              <text
                                x={nodeWidth / 2}
                                y={nodeHeight / 2}
                                dy="2em"
                                fontSize={10}
                                textAnchor="middle"
                                pointerEvents="none"
                                fill="#fff"
                              >
                                {node.data.value}
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
                      const nodeHeight = node.y1 - node.y0;

                      return (
                        <Group key={`node-${i}`} top={node.y0} left={node.x0}>
                          <rect
                            width={nodeWidth}
                            height={nodeHeight}
                            stroke="#114b5f"
                            strokeWidth={4}
                            fill="transparent"
                          />
                          <text
                            x={5}
                            y={5}
                            dy=".66em"
                            fontSize={12}
                            textAnchor="start"
                            pointerEvents="none"
                            fill="#000"
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
        )}
      </ParentSize>
    </Card>
  );
};
