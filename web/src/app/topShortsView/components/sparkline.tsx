import React, { useRef, useEffect } from "react";
import * as d3 from "d3";
import { TimeSeriesData, TimeSeriesPoint } from "~/gen/stocks/v1alpha1/stocks_pb";
import { PlainMessage } from "@bufbuild/protobuf";

interface SparklineProps {
  data: PlainMessage<TimeSeriesData>;
}

const Sparkline: React.FC<SparklineProps> = ({ data }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<SVGTextElement | null>(null);

  useEffect(() => {
    if (!data || data.points.length === 0) {
      return;
    }

    const margin = { top: 5, right: 5, bottom: 5, left: 5 };
    const width = 250 - margin.left - margin.right;
    const height = 100 - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.attr("width", width + margin.left + margin.right).attr("height", height + margin.top + margin.bottom);

    if (!tooltipRef.current) {
      tooltipRef.current = svg.append("text")
        .attr("opacity", 0)
        .attr("text-anchor", "middle")
        .attr("alignment-baseline", "middle")
        .style("pointer-events", "none")
        .node();
    }

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3
      .scaleTime()
      .domain(
        d3.extent(data.points, (d: PlainMessage<TimeSeriesPoint>) => d.timestamp ? new Date(Number(d.timestamp.seconds) * 1000) : new Date()) as [Date, Date]
      )
      .range([0, width]);

    const y = d3
      .scaleLinear()
      .domain([0, d3.max(data.points, (d: PlainMessage<TimeSeriesPoint>) => d.shortPosition ?? 0) as number])
      .range([height, 0]);

    const line = d3
      .line<PlainMessage<TimeSeriesPoint>>()
      .x((d) => x(d.timestamp ? new Date(Number(d.timestamp.seconds) * 1000) : new Date()))
      .y((d) => y(d.shortPosition ?? 0))
      .curve(d3.curveMonotoneX);

    const bisectDate = d3.bisector((d: PlainMessage<TimeSeriesPoint>) => d.timestamp ? new Date(Number(d.timestamp.seconds) * 1000) : new Date()).left;

    g.append("path")
      .datum(data.points)
      .attr("fill", "none")
      .attr("stroke", "blue")
      .attr("stroke-width", 1.5)
      .attr("d", line)
      .on("mousemove", function(event) {
        const [xPos] = d3.pointer(event);
        const x0 = x.invert(xPos);
        const i = bisectDate(data.points, x0, 1);
        const d0 = data.points[i - 1];
        const d1 = data.points[i];
        if (!d0 || !d1) return; // Exit if no data
        const d = x0.getTime() - new Date(Number(d0.timestamp?.seconds) * 1000).getTime() > new Date(Number(d1.timestamp?.seconds) * 1000).getTime() - x0.getTime() ? d1 : d0;
        const tooltipX = x(d.timestamp ? new Date(Number(d.timestamp.seconds) * 1000) : new Date());
        const tooltipY = y(d.shortPosition ?? 0);
        d3.select(tooltipRef.current)
          .attr("opacity", 1)
          .attr("x", tooltipX)
          .attr("y", tooltipY - 10)
          .text(`${d.shortPosition}%`);
      })
      .on("mouseout", function() {
        d3.select(tooltipRef.current).attr("opacity", 0);
      });
  }, [data]);

  return <svg ref={svgRef}></svg>;
};

export default Sparkline;
