import React, { useRef, useEffect, useState } from "react";
import * as d3 from "d3";
import {
  TimeSeriesData,
  TimeSeriesPoint,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import { PlainMessage, Timestamp } from "@bufbuild/protobuf";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";

interface SparklineProps {
  data: PlainMessage<TimeSeriesData>;
}

interface TooltipState {
  visible: boolean;
  shortPosition: number;
  timestamp: Timestamp;
  x: number;
  y: number;
  pastMidpoint: boolean; // Add this to your state
}

const findClosestPoint = (mouseX, dataPoints, xScale) => {
  // Convert the mouseX position back to the data space
  const date = xScale.invert(mouseX - 20);

  // Find the closest date in the data array
  const bisectDate = d3.bisector((d: TimeSeriesPoint) => 
    new Date(d.timestamp ? Number(d.timestamp.seconds) * 1000 : 0)
  ).left;
  const index = bisectDate(dataPoints, date, 1);

  // Find the two data points closest to the mouse position
  const d0 = dataPoints[index - 1];
  const d1 = dataPoints[index];

  // Compare which one is closer to the mouse position
  return (d1 && d0) && (date - d0.timestamp) > (d1.timestamp - date) ? d1 : d0;
};


const Sparkline: React.FC<SparklineProps> = ({ data }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: true,
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
    const width = 250 - margin.left - margin.right;
    const height = 100 - margin.top - margin.bottom;

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
      .domain([0, d3.max(data.points, (d) => d.shortPosition ?? 0) as number])
      .range([height, 0]);

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
      .attr("width", width)
      .attr("height", height)
      .attr("fill", "transparent")
      .on("mouseover", () => {
        setTooltip({ ...tooltip, visible: true }); // Show tooltip when mouse is over the chart
      })
      .on("mouseout", () => {
        setTooltip({ ...tooltip, visible: false }); // Hide tooltip when mouse is out
        hoverCircle.style("opacity", 0); // Hide the hover circle
      })
      .on("mousemove", (event) => {
        const mouseX = d3.pointer(event, this)[0]; // Get the mouse x position within the chart
        const closestPoint = findClosestPoint(mouseX, data.points, xScale);
        const svgRect = svgRef?.current?.getBoundingClientRect();
        const midpoint = width / 2; // Midpoint of the chart
        // Determine whether the mouse is before or past the midpoint
        const pastMidpoint = mouseX > midpoint;

        // Calculate offsets to position the tooltip left or right of the cursor
        const tooltipOffsetX = pastMidpoint ? 50 : -100; // Horizontal offset from the cursor
        const tooltipOffsetY = -130; // Vertical offset to position the tooltip above the cursor

        // Calculate the tooltip position
        const tooltipX = pastMidpoint
          ? event.clientX - tooltipOffsetX // If past midpoint, position to the left of the cursor
          : event.clientX + tooltipOffsetX; // If before midpoint, position to the right of the cursor

        const tooltipY = event.clientY + tooltipOffsetY;
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
      .datum(data.points)
      .attr("fill", "none")
      .attr("stroke", "blue")
      .attr("stroke-width", 2)
      .attr("d", lineGenerator as any)
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
    // .on("mouseover", (event, d) => {
    //   const svgRect = svgRef.current?.getBoundingClientRect(); // Get the bounding box of the SVG element
    //   const [x, y] = d3.pointer(event); // Get the coordinates relative to the SVG element
    //   setTooltip({
    //     visible: true,
    //     content: `Short Position: ${d.shortPosition}%`,
    //     x: (svgRect?.left ?? 0) + x,
    //     y: (svgRect?.top ?? 0) + y,
    //   });
    // })
    // .on("mouseout", () => {
    //   setTooltip({ ...tooltip, visible: false });
    // });
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
              <CardTitle className="text-xs">
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

export default Sparkline;
