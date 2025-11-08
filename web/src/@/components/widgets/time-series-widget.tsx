"use client";

import { useEffect, useState, useMemo } from "react";
import { type WidgetProps } from "~/@/types/dashboard";
import { ParentSize } from "@visx/responsive";
import { scaleTime, scaleLinear } from "@visx/scale";
import { LinePath } from "@visx/shape";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows, GridColumns } from "@visx/grid";
import { Group } from "@visx/group";
import { getStockData } from "~/app/actions/getStockData";
import { type PlainMessage } from "@bufbuild/protobuf";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { curveLinear } from "@visx/curve";
import { Skeleton } from "~/@/components/ui/skeleton";
import { format } from "date-fns";

const margin = { top: 20, right: 20, bottom: 40, left: 60 };

const colors = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#ea580c", // orange
  "#7c3aed", // purple
  "#0891b2", // cyan
];

export function TimeSeriesWidget({ config }: WidgetProps) {
  const stocks = (config.settings?.stocks as string[]) || [];
  const period = (config.settings?.period as string) || "3m";

  const [loading, setLoading] = useState(true);
  const [stockData, setStockData] = useState<
    Map<string, PlainMessage<TimeSeriesData>>
  >(new Map());

  useEffect(() => {
    if (stocks.length === 0) {
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      const newData = new Map<string, PlainMessage<TimeSeriesData>>();

      try {
        await Promise.all(
          stocks.map(async (stockCode) => {
            const data = await getStockData(stockCode, period);
            if (data) {
              newData.set(stockCode, data);
            }
          }),
        );
        setStockData(newData);
      } catch (error) {
        console.error("Error fetching stock data:", error);
      } finally {
        setLoading(false);
      }
    };

    void fetchData();
  }, [stocks, period]);

  const chartData = useMemo(() => {
    const allDataPoints: { date: Date; values: Map<string, number> }[] = [];
    const dateMap = new Map<string, Map<string, number>>();

    stockData.forEach((seriesData, stockCode) => {
      if (seriesData.points) {
        seriesData.points.forEach((point) => {
          if (point.timestamp) {
            // Convert protobuf Timestamp to Date
            const seconds = Number(point.timestamp.seconds || 0);
            const nanos = Number(point.timestamp.nanos || 0);
            const date = new Date(seconds * 1000 + nanos / 1000000);
            const dateStr = date.toISOString();

            if (!dateMap.has(dateStr)) {
              dateMap.set(dateStr, new Map());
            }
            dateMap.get(dateStr)!.set(stockCode, point.shortPosition);
          }
        });
      }
    });

    dateMap.forEach((values, dateStr) => {
      allDataPoints.push({
        date: new Date(dateStr),
        values,
      });
    });

    return allDataPoints.sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [stockData]);

  if (loading) {
    return (
      <div className="h-full p-4">
        <Skeleton className="h-full w-full" />
      </div>
    );
  }

  if (stocks.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-sm font-medium">Time Series Analysis</p>
          <p className="text-xs mt-2">Select stocks to analyze</p>
        </div>
      </div>
    );
  }

  return (
    <ParentSize>
      {({ width, height }) => {
        const xMax = width - margin.left - margin.right;
        const yMax = height - margin.top - margin.bottom;

        const xScale = scaleTime<number>({
          domain: [
            chartData[0]?.date ?? new Date(),
            chartData[chartData.length - 1]?.date ?? new Date(),
          ],
          range: [0, xMax],
        });

        const yScale = scaleLinear<number>({
          domain: [
            0,
            Math.max(
              ...chartData.flatMap((d) => Array.from(d.values.values())),
            ) * 1.1,
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
              <GridColumns
                scale={xScale}
                height={yMax}
                strokeDasharray="3,3"
                stroke="currentColor"
                strokeOpacity={0.1}
              />
              {stocks.map((stockCode, index) => {
                const stockDataPoints = chartData
                  .filter((d) => d.values.has(stockCode))
                  .map((d) => ({
                    date: d.date,
                    value: d.values.get(stockCode)!,
                  }));

                return (
                  <LinePath
                    key={stockCode}
                    data={stockDataPoints}
                    x={(d) => xScale(d.date) ?? 0}
                    y={(d) => yScale(d.value) ?? 0}
                    stroke={colors[index % colors.length]}
                    strokeWidth={2}
                    curve={curveLinear}
                  />
                );
              })}
              <AxisBottom
                top={yMax}
                scale={xScale}
                numTicks={width > 520 ? 10 : 5}
                tickLabelProps={() => ({
                  fill: "currentColor",
                  fontSize: 11,
                  textAnchor: "middle",
                })}
                tickFormat={(d) => {
                  const date = d instanceof Date ? d : new Date(d.valueOf());
                  return format(date, "MMM d");
                }}
              />
              <AxisLeft
                scale={yScale}
                numTicks={5}
                tickLabelProps={() => ({
                  fill: "currentColor",
                  fontSize: 11,
                  textAnchor: "end",
                  x: -8,
                  y: 3,
                })}
                tickFormat={(d) => `${d as number}%`}
              />
            </Group>
            {/* Legend */}
            <Group left={margin.left} top={height - 20}>
              {stocks.map((stockCode, index) => (
                <Group key={stockCode} left={index * 80}>
                  <rect
                    width={12}
                    height={12}
                    fill={colors[index % colors.length]}
                    y={-6}
                  />
                  <text
                    x={16}
                    fontSize={12}
                    fill="currentColor"
                    alignmentBaseline="middle"
                  >
                    {stockCode}
                  </text>
                </Group>
              ))}
            </Group>
          </svg>
        );
      }}
    </ParentSize>
  );
}
