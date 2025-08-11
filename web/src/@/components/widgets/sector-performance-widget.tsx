"use client";

import { useEffect, useState } from "react";
import { type WidgetProps } from "@/types/dashboard";
import { ParentSize } from "@visx/responsive";
import { Pie } from "@visx/shape";
import { Group } from "@visx/group";
import { scaleBand, scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { Skeleton } from "@/components/ui/skeleton";
import { getSectorPerformance, type SectorPerformance } from "@/lib/stock-data-service";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown } from "lucide-react";

const margin = { top: 20, right: 20, bottom: 40, left: 60 };

const sectorColors = {
  Financials: "#2563eb",
  Materials: "#dc2626",
  Healthcare: "#16a34a",
  "Consumer Staples": "#ea580c",
  Energy: "#7c3aed",
  Technology: "#0891b2",
} as const;

export function SectorPerformanceWidget({ config }: WidgetProps) {
  const period = (config.settings?.period as string) || "1w";
  const displayType = (config.settings?.displayType as string) || "pie";
  
  const [loading, setLoading] = useState(true);
  const [sectorData, setSectorData] = useState<SectorPerformance[]>([]);

  useEffect(() => {
    const fetchSectorData = async () => {
      setLoading(true);
      try {
        const data = await getSectorPerformance(period);
        setSectorData(data);
      } catch (error) {
        console.error("Error fetching sector performance:", error);
      } finally {
        setLoading(false);
      }
    };

    void fetchSectorData();
    
    // Refresh every 5 minutes
    const interval = setInterval(() => void fetchSectorData(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [period]);

  if (loading) {
    return (
      <div className="p-4">
        <Skeleton className="h-full w-full" />
      </div>
    );
  }

  if (sectorData.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <p className="text-sm">No sector data available</p>
      </div>
    );
  }

  const formatPercent = (value: number) => {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  };

  if (displayType === "heatmap") {
    return (
      <div className="p-4 h-full">
        <h3 className="text-sm font-semibold mb-4">Sector Performance</h3>
        <div className="grid grid-cols-2 gap-2 h-[calc(100%-2rem)]">
          {sectorData.map((sector) => {
            const intensity = Math.abs(sector.performance);
            const isPositive = sector.performance >= 0;
            const bgColor = isPositive 
              ? `rgba(34, 197, 94, ${Math.min(intensity / 5, 1) * 0.8})`
              : `rgba(239, 68, 68, ${Math.min(intensity / 5, 1) * 0.8})`;
            
            return (
              <div
                key={sector.sector}
                className="relative p-3 rounded-md border transition-all hover:scale-105"
                style={{ backgroundColor: bgColor }}
              >
                <p className="text-xs font-medium">{sector.sector}</p>
                <p className={`text-sm font-bold mt-1 ${isPositive ? 'text-green-700' : 'text-red-700'}`}>
                  {formatPercent(sector.performance)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Vol: {(sector.volume / 1e9).toFixed(1)}B
                </p>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (displayType === "bar") {
    return (
      <ParentSize>
        {({ width, height }) => {
          const xMax = width - margin.left - margin.right;
          const yMax = height - margin.top - margin.bottom;

          const xScale = scaleBand<string>({
            domain: sectorData.map(d => d.sector),
            range: [0, xMax],
            padding: 0.2,
          });

          const yScale = scaleLinear<number>({
            domain: [
              Math.min(...sectorData.map(d => d.performance), 0),
              Math.max(...sectorData.map(d => d.performance), 0),
            ],
            range: [yMax, 0],
            nice: true,
          });

          return (
            <svg width={width} height={height}>
              <Group left={margin.left} top={margin.top}>
                <GridRows
                  scale={yScale}
                  width={xMax}
                  strokeDasharray="3,3"
                  stroke="currentColor"
                  strokeOpacity={0.1}
                />
                {sectorData.map((sector) => {
                  const barHeight = yMax - (yScale(sector.performance) ?? 0);
                  const barY = sector.performance >= 0 
                    ? yScale(sector.performance) ?? 0
                    : yScale(0) ?? 0;
                  
                  return (
                    <rect
                      key={sector.sector}
                      x={xScale(sector.sector)}
                      y={barY}
                      width={xScale.bandwidth()}
                      height={Math.abs(barHeight - (yScale(0) ?? 0))}
                      fill={sectorColors[sector.sector as keyof typeof sectorColors] ?? "#888"}
                      opacity={0.8}
                    />
                  );
                })}
                <line
                  x1={0}
                  x2={xMax}
                  y1={yScale(0)}
                  y2={yScale(0)}
                  stroke="currentColor"
                  strokeWidth={1}
                />
                <AxisBottom
                  top={yMax}
                  scale={xScale}
                  tickLabelProps={() => ({
                    fill: "currentColor",
                    fontSize: 10,
                    textAnchor: "middle",
                  })}
                />
                <AxisLeft
                  scale={yScale}
                  numTicks={5}
                  tickLabelProps={() => ({
                    fill: "currentColor",
                    fontSize: 10,
                    textAnchor: "end",
                  })}
                  tickFormat={(value) => `${Number(value)}%`}
                />
              </Group>
            </svg>
          );
        }}
      </ParentSize>
    );
  }

  // Pie chart (default)
  const pieData = sectorData.map(d => ({
    ...d,
    absPerformance: Math.abs(d.performance),
  }));


  return (
    <div className="h-full flex flex-col">
      <div className="p-4 pb-2">
        <h3 className="text-sm font-semibold">Sector Performance</h3>
        <p className="text-xs text-muted-foreground">Period: {period}</p>
      </div>
      
      <div className="flex-1 relative">
        <ParentSize>
          {({ width, height }) => {
            const radius = Math.min(width, height) / 2 - 20;
            const centerX = width / 2;
            const centerY = height / 2;

            return (
              <svg width={width} height={height}>
                <Group left={centerX} top={centerY}>
                  <Pie
                    data={pieData}
                    pieValue={(d) => d.absPerformance}
                    outerRadius={radius}
                    innerRadius={radius * 0.6}
                  >
                    {(pie) => (
                      <>
                        {pie.arcs.map((arc, index) => {
                          const [centroidX, centroidY] = pie.path.centroid(arc);
                          const sector = arc.data.sector;
                          const color = sectorColors[sector as keyof typeof sectorColors] ?? "#888";
                          
                          return (
                            <g key={`arc-${index}`}>
                              <path
                                d={pie.path(arc) ?? ""}
                                fill={color}
                                opacity={0.8}
                                stroke="white"
                                strokeWidth={2}
                              />
                              {arc.endAngle - arc.startAngle > 0.25 && (
                                <text
                                  x={centroidX}
                                  y={centroidY}
                                  dy=".33em"
                                  fill="white"
                                  fontSize={11}
                                  textAnchor="middle"
                                  fontWeight="bold"
                                >
                                  {formatPercent(arc.data.performance)}
                                </text>
                              )}
                            </g>
                          );
                        })}
                      </>
                    )}
                  </Pie>
                </Group>
              </svg>
            );
          }}
        </ParentSize>
      </div>
      
      <div className="p-4 pt-2">
        <div className="space-y-1">
          {sectorData.map((sector) => (
            <div key={sector.sector} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <div 
                  className="w-3 h-3 rounded"
                  style={{ 
                    backgroundColor: sectorColors[sector.sector as keyof typeof sectorColors] ?? "#888" 
                  }}
                />
                <span>{sector.sector}</span>
              </div>
              <Badge
                variant={sector.performance >= 0 ? "default" : "destructive"}
                className="text-xs h-5"
              >
                <span className="inline-flex items-center gap-1">
                  {sector.performance >= 0 ? (
                    <TrendingUp className="h-3 w-3" />
                  ) : (
                    <TrendingDown className="h-3 w-3" />
                  )}
                  {formatPercent(sector.performance)}
                </span>
              </Badge>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}