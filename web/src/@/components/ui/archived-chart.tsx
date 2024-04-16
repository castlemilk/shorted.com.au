"use client";
import React, { useRef, useEffect, useState } from "react";
import * as d3 from "d3";
import {
  type TimeSeriesData,
  type TimeSeriesPoint,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import { type PlainMessage, Timestamp } from "@bufbuild/protobuf";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import useWindowSize from "~/@/hooks/use-window-size";

interface SparklineProps {
  data: PlainMessage<TimeSeriesData>;
}

interface TooltipState {
  visible: boolean;
  shortPosition: number;
  timestamp: PlainMessage<Timestamp> | undefined;
  x: number;
  y: number;
  pastMidpoint: boolean; // Add this to your state
}

const findClosestPoint = (
  mouseX: number,
  dataPoints: PlainMessage<TimeSeriesPoint>[],
  xScale: d3.ScaleTime<number, number, never>,
) => {
  const date = xScale.invert(mouseX - 20);
  // Convert the mouseX position back to the data space
  const bisectDate = (data: TimeSeriesPoint[], targetDate: Date) =>
    d3
      .bisector(
        (d: TimeSeriesPoint) =>
          new Date(d.timestamp ? Number(d.timestamp.seconds) * 1000 : 0),
      )
      .left(data, targetDate, 1);

  const index = bisectDate(dataPoints as TimeSeriesPoint[], date);

  const d0: PlainMessage<TimeSeriesPoint> | undefined = dataPoints[index - 1];
  const d1: PlainMessage<TimeSeriesPoint> | undefined = dataPoints[index];

  // Compare which one is closer to the mouse position
  return d1 &&
    d0 &&
    Number(date) - Number(d0?.timestamp) > Number(d1?.timestamp) - Number(date)
    ? d1
    : d0;
};

const Chart: React.FC<SparklineProps> = ({ data }) => {
  const windowSize = useWindowSize();
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    shortPosition: 0,
    timestamp: new Timestamp(),
    x: 0,
    y: 0,
    pastMidpoint: false,
  });
  useEffect(() => {
    if (!data || data.points.length === 0) {
      return;
    }

    const margin = { top: 20, right: 20, bottom: 20, left: 20 };
    const width = 700 - margin.left - margin.right;
    const height = 300 - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove(); // Clear previous SVG content
    svg
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom);

    const g = svg
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    const xScale = d3
      .scaleTime()
      .domain(
        d3.extent(data.points, (d) =>
          d.timestamp
            ? new Date(Number(d.timestamp.seconds) * 1000)
            : new Date(),
        ) as [Date, Date],
      )
      .range([0, width]);

    const yScale = d3
      .scaleLinear()
      .domain([0, d3.max(data.points, (d) => d.shortPosition ?? 0)!])
      .range([height, 0]);

    // Define the axes
    const xAxis = d3.axisBottom(xScale).ticks(5); // Adjust tick count as needed
    const yAxis = d3.axisLeft(yScale).ticks(5); // Adjust tick count as needed

    // Append x-axis
    g.append("g").attr("transform", `translate(0,${height})`).call(xAxis);

    // Append y-axis
    g.append("g").call(yAxis);

    // Append a circle that moves along the line as you hover over the chart
    const hoverCircle = g
      .append("circle")
      .attr("r", 5) // Radius of the hover circle
      .attr("fill", "blue") // Fill color of the circle
      .style("opacity", 0); // Initially invisible

    const lineGenerator = d3
      .line<TimeSeriesPoint>()
      .x((d) =>
        xScale(new Date(d.timestamp ? Number(d.timestamp.seconds) * 1000 : 0)),
      )
      .y((d) => yScale(d.shortPosition))
      .curve(d3.curveMonotoneX);
    svg
      .append("rect") // Append a rectangle over the entire graph to capture mouse movements
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom)
      .attr("fill", "transparent")
      .on("mouseover", () => {
        setTooltip({ ...tooltip, visible: true }); // Show tooltip when mouse is over the chart
      })
      .on("mouseout", () => {
        setTooltip({ ...tooltip, visible: false }); // Hide tooltip when mouse is out
        hoverCircle.style("opacity", 0); // Hide the hover circle
      })
      .on("mousemove", (event: MouseEvent) => {
        const mouseX = d3.pointer(event, this)[0]; // Get the mouse x position within the chart
        const closestPoint = findClosestPoint(mouseX, data.points, xScale);
        if (!closestPoint) return;
        const svgRect = svgRef?.current?.getBoundingClientRect();
        const chartRightEdge = svgRect ? svgRect.right : 0;
        const midpoint = width / 2; // Midpoint of the chart
        // Determine whether the mouse is before or past the midpoint
        const pastMidpoint = mouseX > midpoint;
        // Calculate offsets to position the tooltip left or right of the cursor
        // ( 50 is the maximum offset to the right, -100 is the maximum offset to the left)
        const tooltipOffsetX =
          (windowSize.width ?? 1019) > 1018
            ? pastMidpoint
              ? -100
              : -70
            : pastMidpoint
              ? -100
              : 0; // Adjust for smaller screens
        const tooltipOffsetY = 70; // Vertical offset to position the tooltip above the cursor
        // Calculate the tooltip's potential X position based on cursor position and offset
        let tooltipX: number = event.clientX + tooltipOffsetX;
        // Prevent the tooltip from leaving the chart area
        if (tooltipX + 150 > chartRightEdge) {
          // Assuming tooltip width of around 200px
          tooltipX =
            (windowSize.width ?? 0) >= 1018
              ? chartRightEdge - 150
              : chartRightEdge - 250;
        } else if (tooltipX - 50 < (svgRect?.left ?? 0)) {
          tooltipX = (svgRect?.left ?? 0) + 50;
        }
        // // Calculate the tooltip position
        // const tooltipX: number = pastMidpoint
        //   ? event.clientX - tooltipOffsetX // If past midpoint, position to the left of the cursor
        //   : event.clientX + tooltipOffsetX; // If before midpoint, position to the right of the cursor

        const tooltipY: number = event.clientY + tooltipOffsetY;
        // Update the position and visibility of the hover circle
        hoverCircle
          .attr(
            "cx",
            xScale(
              new Date(
                closestPoint.timestamp
                  ? Number(closestPoint.timestamp.seconds) * 1000
                  : 0,
              ),
            ),
          )
          .attr("cy", yScale(closestPoint.shortPosition))
          .style("opacity", 1); // Make the circle visible
        setTooltip({
          visible: true && !!svgRect,
          shortPosition: closestPoint.shortPosition,
          timestamp: closestPoint.timestamp,
          x: tooltipX, // Tooltip follows the mouse, but displays the closest point
          y: tooltipY,
          pastMidpoint: pastMidpoint,
        });
      });
    svg
      .append("path")
      .datum(data.points as TimeSeriesPoint[]) // Cast data.points to TimeSeriesPoint[]
      .attr("fill", "none")
      .attr("stroke", "blue")
      .attr("stroke-width", 2)
      .attr("d", lineGenerator)
      .attr("transform", `translate(${margin.left},${margin.top})`);
    svg
      .selectAll(".data-point")
      .data(data.points)
      .enter()
      .append("circle")
      .attr("cx", (d) =>
        xScale(new Date(d.timestamp ? Number(d.timestamp.seconds) * 1000 : 0)),
      )
      .attr("cy", (d) => yScale(d.shortPosition))
      .attr("r", 4)
      .attr("fill", "transparent");
  }, [data]);
  return (
    <>
      <svg ref={svgRef} className="sparkline-chart"></svg>
      {tooltip.visible && (
        <div
          className="absolute"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: tooltip.pastMidpoint
              ? "translate(50%, -100%)"
              : "translate(-50%, -100%)", // Adjusts horizontal alignment dynamically,
            zIndex: 1000, // Increased z-index
          }}
        >
          <Card>
            <CardHeader className="text-xs m-2 p-0">
              <CardTitle className="text-xs" suppressHydrationWarning={true}>
                {new Date(
                  tooltip.timestamp
                    ? Number(tooltip.timestamp.seconds) * 1000
                    : 0,
                ).toLocaleDateString()}
              </CardTitle>
              <CardDescription className="text-xs">
                {tooltip.shortPosition}%
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      )}
    </>
  );
};

export default Chart;
