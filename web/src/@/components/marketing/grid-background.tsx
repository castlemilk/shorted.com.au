"use client";

import { useEffect, useRef } from "react";

export function GridBackground() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Create animated grid using CSS
    const grid = document.createElement("div");
    grid.className = "absolute inset-0 opacity-20";
    grid.style.backgroundImage = `
      linear-gradient(rgba(59, 130, 246, 0.1) 1px, transparent 1px),
      linear-gradient(90deg, rgba(59, 130, 246, 0.1) 1px, transparent 1px)
    `;
    grid.style.backgroundSize = "50px 50px";
    grid.style.animation = "grid-move 20s linear infinite";

    container.appendChild(grid);

    // Add keyframes if not already present
    if (!document.getElementById("grid-animation-style")) {
      const style = document.createElement("style");
      style.id = "grid-animation-style";
      style.textContent = `
        @keyframes grid-move {
          0% { transform: translate(0, 0); }
          100% { transform: translate(50px, 50px); }
        }
      `;
      document.head.appendChild(style);
    }

    return () => {
      if (container.contains(grid)) {
        container.removeChild(grid);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 pointer-events-none z-0"
      aria-hidden="true"
    />
  );
}

