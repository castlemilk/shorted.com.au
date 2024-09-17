"use client";
import React, { useRef, useEffect } from 'react';
import * as d3 from 'd3';
import Image from 'next/image'; // Add this import
import ReactDOM from 'react-dom';

interface TreeItem {
  id: string;
  name: string;
  description?: string;
  icon?: string;  // URL to the icon image
  imageComponent?: React.ReactNode; // New prop for custom image component
  children?: TreeItem[];
  status?: 'DONE' | 'PLANNED'; // Add this line
}

interface TreeProps {
  data: TreeItem;
}

const Tree: React.FC<TreeProps> = ({ data }) => {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    // Clear the SVG before rendering
    d3.select(svgRef.current).selectAll('*').remove();

    // Set dimensions and margins
    const margin = { top: 40, right: 120, bottom: 40, left: 120 };
    const width = 1000 - margin.left - margin.right; // Increased width
    const height = 800 - margin.top - margin.bottom; // Increased height

    // Create the SVG container
    const svg = d3
      .select(svgRef.current)
      .attr('width', width + margin.right + margin.left)
      .attr('height', height + margin.top + margin.bottom)
      .attr('viewBox', `0 0 ${width + margin.right + margin.left} ${height + margin.top + margin.bottom}`)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Create root hierarchy node
    const root = d3.hierarchy(data);

    // Create tree layout with increased node separation
    const treeLayout = d3.tree<TreeItem>()
      .size([width, height])
      .separation((a, b) => (a.parent === b.parent ? 2 : 3)); // Increased separation

    // Generate the tree data
    treeLayout(root);

    // Links
    svg
      .selectAll('.link')
      .data(root.links())
      .enter()
      .append('path')
      .attr('class', 'link')
      .attr('d', d => {
        return `M${d.source.x},${d.source.y}
                L${d.source.x},${(d.source.y + d.target.y) / 2}
                L${d.target.x},${(d.source.y + d.target.y) / 2}
                L${d.target.x},${d.target.y}`;
      })
      .attr('fill', 'none')
      .attr('stroke', d => d.target.data.status === 'DONE' ? '#4CAF50' : '#ccc') // Update this line
      .attr('stroke-width', 2);

    // Nodes
    const node = svg
      .selectAll('.node')
      .data(root.descendants())
      .enter()
      .append('g')
      .attr('class', d => 'node' + (d.children ? ' node--internal' : ' node--leaf'))
      .attr('transform', d => `translate(${d.x},${d.y})`);

    // Tooltip
    const tooltip = d3
      .select('body')
      .append('div')
      .attr('class', 'node-tooltip')
      .style('position', 'absolute')
      .style('text-align', 'left')
      .style('padding', '8px')
      .style('font', '12px sans-serif')
      .style('background', 'rgba(255, 255, 255, 0.9)')
      .style('border', '1px solid #ccc')
      .style('border-radius', '4px')
      .style('pointer-events', 'none')
      .style('opacity', 0)
      .style('max-width', '200px') // Add max-width
      .style('word-wrap', 'break-word'); // Enable word wrapping

    // Render nodes
    node.each(function (d) {
      const currentNode = d3.select(this);
      const isComplete = d.data.status === 'DONE';

      if (d.data.imageComponent) {
        // Render custom image component
        const foreignObject = currentNode
          .append('foreignObject')
          .attr('x', -20)
          .attr('y', -20)
          .attr('width', 40)
          .attr('height', 40);

        const div = foreignObject.append('xhtml:div')
          .style('width', '100%')
          .style('height', '100%')
          .style('display', 'flex')
          .style('align-items', 'center')
          .style('justify-content', 'center');

        ReactDOM.render(d.data.imageComponent, div.node());

        // Add colored circle around the image component
        currentNode
          .insert('circle', 'foreignObject')
          .attr('r', 22)
          .attr('fill', 'none')
          .attr('stroke', isComplete ? '#4CAF50' : '#ccc')
          .attr('stroke-width', 2);
      } else if (!d.children && d.data.icon) {
        // Render image icon for leaf nodes with an icon
        currentNode
          .append('image')
          .attr('xlink:href', d.data.icon)
          .attr('x', -20)
          .attr('y', -20)
          .attr('width', 40)
          .attr('height', 40);

        // Add colored circle around the icon
        currentNode
          .insert('circle', 'image')
          .attr('r', 22)
          .attr('fill', 'none')
          .attr('stroke', isComplete ? '#4CAF50' : '#ccc')
          .attr('stroke-width', 2);
      } else {
        // Render circle for other nodes
        currentNode
          .append('circle')
          .attr('r', 20)
          .attr('fill', isComplete ? '#4CAF50' : '#69b3a2');
      }

      // Add mouseover and mouseout events
      currentNode
        .on('mouseover', function (event) {
          // Show tooltip
          if (d.data.description) {
            tooltip.transition().duration(200).style('opacity', 0.9);
            tooltip
              .html(d.data.description)
              .style('left', '10px') // Fixed position on the left
              .style('top', '10px'); // Fixed position at the top
          }
        })
        .on('mouseout', function () {
          // Hide tooltip
          tooltip.transition().duration(500).style('opacity', 0);
        });
    });

    // Labels
    node
      .append('text')
      .attr('dy', '.35em')
      .attr('y', d => (d.children ? -30 : 30)) // Adjust label position
      .style('text-anchor', 'middle')
      .text(d => d.data.name);

    // Clean up on unmount
    return () => {
      d3.select(svgRef.current).selectAll('*').remove();
      tooltip.remove();
    };
  }, [data]);

  return <svg ref={svgRef} ></svg>;
};

export default Tree;
