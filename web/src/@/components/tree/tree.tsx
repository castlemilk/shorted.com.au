"use client";
import React, { useRef, useEffect } from "react";
import { select } from "d3-selection";
import {
  hierarchy,
  tree,
  type HierarchyNode,
  type HierarchyLink,
} from "d3-hierarchy";
import { createRoot } from "react-dom/client"; // Add this import

interface TreeItem {
  id: string;
  name: string;
  description?: string;
  icon?: string; // URL to the icon image
  imageComponent?: React.ReactNode; // New prop for custom image component
  children?: TreeItem[];
  status?: string; // Change this line
}

interface TreeProps {
  data: TreeItem;
}

const Tree: React.FC<TreeProps> = ({ data }) => {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    // Clear the SVG before rendering
    select(svgRef.current).selectAll("*").remove();

    // Set dimensions and margins
    const margin = { top: 60, right: 120, bottom: 80, left: 120 };
    const width = 1000 - margin.left - margin.right; // Increased width
    const height = 800 - margin.top - margin.bottom; // Increased height

    // Create the SVG container
    const svg = select(svgRef.current)
      .attr("width", width + margin.right + margin.left)
      .attr("height", height + margin.top + margin.bottom)
      .attr(
        "viewBox",
        `0 0 ${width + margin.right + margin.left} ${height + margin.top + margin.bottom}`,
      )
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // Create root hierarchy node
    const root = hierarchy(data);

    // Create tree layout with increased node separation
    const treeLayout = tree<TreeItem>()
      .size([width, height])
      .separation((a, b) => (a.parent === b.parent ? 2 : 3)); // Increased separation

    // Generate the tree data
    treeLayout(root);

    // Update color variables
    const colors = {
      text: "hsl(var(--foreground))",
      background: "hsl(var(--background))",
      link: "hsl(var(--muted-foreground))",
      nodeComplete: "#16a34a",
      nodeIncomplete: "hsl(var(--muted-foreground))",
      tooltipBorder: "hsl(var(--border))",
      nodeCompleteGlow: "rgba(22, 163, 74, 0.4)", // Add this line for the glow effect
    };

    // Helper function to check if a node is complete
    const isNodeComplete = (node: HierarchyNode<TreeItem>): boolean => {
      return (
        node.data.status === "DONE" ||
        (node.children ? node.children.some(isNodeComplete) : false)
      );
    };

    // Separate links into complete and incomplete
    const links = root.links();
    const incompleteLinks = links.filter((d) => !isNodeComplete(d.target));
    const completeLinks = links.filter((d) => isNodeComplete(d.target));

    // Add a glow filter definition
    const defs = svg.append("defs");
    const filter = defs
      .append("filter")
      .attr("id", "glow")
      .attr("x", "-50%")
      .attr("y", "-50%")
      .attr("width", "200%")
      .attr("height", "200%");

    filter
      .append("feGaussianBlur")
      .attr("stdDeviation", "3")
      .attr("result", "coloredBlur");

    const feMerge = filter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    // Function to render links (remove glow and keep consistent stroke width)
    const renderLinks = (
      linkData: HierarchyLink<TreeItem>[],
      className: string,
      colorFn: (d: HierarchyLink<TreeItem>) => string,
    ) => {
      svg
        .selectAll(`.${className}`)
        .data(linkData)
        .enter()
        .append("path")
        .attr("class", className)
        .attr("d", (d) => {
          const sourceX = d.source === root ? root.x : d.source.x;
          const sourceY = d.source === root ? root.y : d.source.y;
          return `M${sourceX},${sourceY ?? 0}
                  L${sourceX},${((sourceY ?? 0) + (d.target.y ?? 0)) / 2}
                  L${d.target.x},${((sourceY ?? 0) + (d.target.y ?? 0)) / 2}
                  L${d.target.x},${d.target.y ?? 0}`;
        })
        .attr("fill", "none")
        .attr("stroke", colorFn)
        .attr("stroke-width", 2); // Consistent stroke width for all links
    };

    // Render incomplete links first
    renderLinks(incompleteLinks, "incomplete-link", () => colors.link);

    // Render complete links last (on top)
    renderLinks(completeLinks, "complete-link", (d) =>
      d.source === root || d.target.data.status === "DONE"
        ? colors.nodeComplete
        : colors.link,
    );

    // Update the tooltip creation
    const tooltip = select("body")
      .append("div")
      .attr("class", "node-tooltip")
      .style("position", "absolute")
      .style("text-align", "left")
      .style("padding", "8px")
      .style("font", "12px var(--font-sans)")
      .style("background", colors.background)
      .style("color", colors.text)
      .style("border", `1px solid ${colors.tooltipBorder}`)
      .style("border-radius", "var(--radius)")
      .style("pointer-events", "none")
      .style("opacity", 0)
      .style("width", "200px") // Fixed width
      .style("word-wrap", "break-word")
      .style("z-index", "1000"); // Ensure the tooltip is on top

    // Render nodes
    const node = svg
      .selectAll(".node")
      .data(root.descendants())
      .enter()
      .append("g")
      .attr(
        "class",
        (d) => "node" + (d.children ? " node--internal" : " node--leaf"),
      )
      .attr("transform", (d) => `translate(${d.x},${d.y})`);

    node.each(function (d) {
      const currentNode = select(this);
      const isComplete = d.data.status === "DONE";
      const isRootNode = !d.parent; // Check if it's the root node

      if (isRootNode) {
        // For root node, only render the image component or icon without a circle
        if (d.data.imageComponent) {
          const foreignObject = currentNode
            .append("foreignObject")
            .attr("x", -25)
            .attr("y", -20)
            .attr("width", 50)
            .attr("height", 50);

          const div = foreignObject
            .append("xhtml:div")
            .style("width", "100%")
            .style("height", "100%")
            .style("display", "flex")
            .style("align-items", "center")
            .style("justify-content", "center");

          const divNode = div.node();
          if (divNode instanceof Element) {
            const root = createRoot(divNode);
            root.render(d.data.imageComponent);
          }
        } else if (d.data.icon) {
          currentNode
            .append("image")
            .attr("xlink:href", d.data.icon)
            .attr("x", -20)
            .attr("y", -20)
            .attr("width", 50)
            .attr("height", 50);
        }
      } else {
        // For non-root nodes
        if (d.data.imageComponent) {
          // Render custom image component
          const foreignObject = currentNode
            .append("foreignObject")
            .attr("x", -20)
            .attr("y", -20)
            .attr("width", 40)
            .attr("height", 40);

          const div = foreignObject
            .append("xhtml:div")
            .style("width", "100%")
            .style("height", "100%")
            .style("display", "flex")
            .style("align-items", "center")
            .style("justify-content", "center");

          const divNode = div.node();
          if (divNode instanceof Element) {
            const root = createRoot(divNode);
            root.render(d.data.imageComponent);
          }

          // Add colored circle around the image component
          currentNode
            .insert("circle", "foreignObject")
            .attr("r", 22)
            .attr("fill", isComplete ? colors.nodeComplete : colors.background)
            .attr(
              "stroke",
              isComplete ? colors.nodeComplete : colors.nodeIncomplete,
            )
            .attr("stroke-width", 2)
            .attr("stroke-dasharray", isComplete ? "none" : "3,3") // Add dotted line for incomplete nodes
            .attr("filter", isComplete ? "url(#glow)" : null);
        } else if (!d.children && d.data.icon) {
          // Render image icon for leaf nodes with an icon
          currentNode
            .append("image")
            .attr("xlink:href", d.data.icon)
            .attr("x", -20)
            .attr("y", -20)
            .attr("width", 50)
            .attr("height", 50);

          // Add colored circle around the icon
          currentNode
            .insert("circle", "image")
            .attr("r", 22)
            .attr("fill", isComplete ? colors.nodeComplete : colors.background)
            .attr(
              "stroke",
              isComplete ? colors.nodeComplete : colors.nodeIncomplete,
            )
            .attr("stroke-width", 2)
            .attr("stroke-dasharray", isComplete ? "none" : "3,3") // Add dotted line for incomplete nodes
            .attr("filter", isComplete ? "url(#glow)" : null);
        } else {
          // Render circle for other nodes
          currentNode
            .append("circle")
            .attr("r", 20)
            .attr("fill", isComplete ? colors.nodeComplete : colors.background)
            .attr(
              "stroke",
              isComplete ? colors.nodeComplete : colors.nodeIncomplete,
            )
            .attr("stroke-width", 2)
            .attr("stroke-dasharray", isComplete ? "none" : "3,3") // Add dotted line for incomplete nodes
            .attr("filter", isComplete ? "url(#glow)" : null);
        }
      }

      // Update the mouseover and mouseout events
      currentNode
        .on(
          "mouseover",
          function (this: SVGGElement, event: MouseEvent, d: unknown) {
            const node = d as HierarchyNode<TreeItem>;
            if (!isRootNode && (node.data.name || node.data.description)) {
              const svgRect = svgRef.current!.getBoundingClientRect();
              const nodeRect = this.getBoundingClientRect();

              const nodeCenterX = (nodeRect.left + nodeRect.right) / 2;
              const nodeCenterY = (nodeRect.top + nodeRect.bottom) / 2;

              const tooltipX = nodeCenterX - svgRect.left + 30; // 30px to the right of node center
              const tooltipY = nodeCenterY - svgRect.top + 20; // 60px above node center

              tooltip.transition().duration(200).style("opacity", 0.9);
              tooltip
                .html(
                  `
                ${node.data.name ? `<strong>${node.data.name}</strong>` : ""}
                ${node.data.description ? `<br>${node.data.description}` : ""}
              `,
                )
                .style("left", `${tooltipX}px`)
                .style("top", `${tooltipY}px`);
            }
          },
        )
        .on("mouseout", function () {
          tooltip.transition().duration(500).style("opacity", 0);
        });
    });

    // Labels
    node
      .append("foreignObject")
      .attr("x", -50) // Adjust this value if needed
      .attr("y", -60) // Move the label closer to the node
      .attr("width", 100)
      .attr("height", 30) // Reduce the height
      .append("xhtml:div")
      .style("width", "100%")
      .style("height", "100%")
      .style("display", "flex")
      .style("align-items", "center")
      .style("justify-content", "center")
      .style("text-align", "center")
      .style("font", "12px var(--font-sans)")
      .style("color", colors.text)
      .style("overflow", "hidden")
      .style("word-wrap", "break-word")
      .style("background-color", colors.background)
      .style("padding", "2px 4px") // Add some minimal padding
      .style("border-radius", "4px") // Optional: add rounded corners
      .style("line-height", "12px") // Adjust line height for better readability
      .text((d) => d.data.name);

    // Clean up on unmount
    return () => {
      select(svgRef.current).selectAll("*").remove();
      tooltip.remove();
    };
  }, [data]);

  return (
    <svg ref={svgRef} style={{ background: "hsl(var(--background))" }}></svg>
  );
};

export default Tree;
