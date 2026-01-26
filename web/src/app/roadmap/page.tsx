"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { cn } from "~/@/lib/utils";
import Dither from "~/@/components/marketing/dither";

type FeatureStatus = "done" | "in-progress" | "planned" | "exploring";

interface Feature {
  id: string;
  name: string;
  description?: string;
  status: FeatureStatus;
  x?: number;
  y?: number;
  children?: Feature[];
}

const roadmapData: Feature = {
  id: "root",
  name: "Shorted",
  status: "done",
  children: [
    {
      id: "analytics",
      name: "Analytics",
      description:
        "Comprehensive charting and analytics tools for visualizing ASX short positions and trends",
      status: "done",
      children: [
        {
          id: "short-charts",
          name: "Short Charts",
          description:
            "Interactive time-series charts tracking short interest positions over time for ASX stocks",
          status: "done",
        },
        {
          id: "price-data",
          name: "Price Data",
          description:
            "Historical candlestick charts with OHLC (Open, High, Low, Close) data and trading volume",
          status: "done",
        },
        {
          id: "treemap",
          name: "Treemap",
          description:
            "Visual treemap showing short positions organized by industry sectors for easy exploration",
          status: "done",
        },
        {
          id: "indicators",
          name: "Indicators",
          description:
            "Advanced technical indicators including RSI, MACD, Bollinger Bands, and more",
          status: "planned",
        },
      ],
    },
    {
      id: "company",
      name: "Company Intel",
      description:
        "AI-powered company insights and comprehensive metadata for ASX-listed companies",
      status: "done",
      children: [
        {
          id: "ai-insights",
          name: "AI Insights",
          description:
            "Machine learning powered company analysis and summaries providing intelligent insights",
          status: "done",
        },
        {
          id: "key-people",
          name: "Key People",
          description:
            "Executive and board member information including leadership team details",
          status: "done",
        },
        {
          id: "reports",
          name: "Reports",
          description:
            "Access to annual reports, financial statements, and company filings",
          status: "done",
        },
        {
          id: "news",
          name: "News",
          description:
            "Real-time news feeds and ASX announcements for companies",
          status: "planned",
        },
      ],
    },
    {
      id: "discovery",
      name: "Discovery",
      description:
        "Powerful search and discovery tools to find and explore ASX stocks efficiently",
      status: "done",
          children: [
            {
          id: "search",
          name: "Search",
              description:
            "Advanced search functionality to find ASX stocks by code, company name, or industry",
          status: "done",
        },
        {
          id: "top-shorts",
          name: "Top Shorts",
          description:
            "Live ranking of the most shorted ASX stocks with real-time updates",
          status: "done",
        },
      ],
    },
    {
      id: "portfolio",
      name: "Portfolio",
      description:
        "Track your stock holdings and monitor short interest exposure across your portfolio",
      status: "done",
    },
    {
      id: "api",
      name: "API",
      description: "Developer tools and programmatic access to Shorted data",
      status: "done",
      children: [
        {
          id: "rest-api",
          name: "REST API",
          description:
            "RESTful API endpoints for programmatic access to short position and stock data",
          status: "done",
        },
        {
          id: "llm-docs",
          name: "LLM Docs",
          description:
            "AI-optimized documentation designed for LLM agents and copilots",
          status: "done",
        },
      ],
    },
    {
      id: "personal",
      name: "Personal",
      description:
        "Personalized experience with custom views, alerts, and preferences",
      status: "in-progress",
      children: [
        {
          id: "auth",
          name: "Auth",
          description:
            "Secure OAuth authentication with multiple provider support",
          status: "done",
        },
        {
          id: "alerts",
          name: "Alerts",
          description:
            "Customizable notifications for short position changes and stock movements",
          status: "planned",
        },
        {
          id: "watchlists",
          name: "Watchlists",
          description:
            "Create and manage personalized watchlists for tracking specific stocks",
          status: "exploring",
        },
      ],
    },
  ],
};

const statusColors: Record<
  FeatureStatus,
  { fill: string; stroke: string; text: string }
> = {
  // Slightly muted accents so the "smoky" node styling carries the look.
  done: { fill: "var(--green)", stroke: "var(--green)", text: "hsl(var(--foreground))" },
  "in-progress": {
    fill: "hsl(var(--primary))",
    stroke: "hsl(var(--primary))",
    text: "hsl(var(--foreground))",
  },
  planned: {
    fill: "hsl(var(--muted-foreground))",
    stroke: "hsl(var(--muted-foreground))",
    text: "hsl(var(--foreground))",
  },
  exploring: {
    fill: "var(--line-stroke)",
    stroke: "var(--line-stroke)",
    text: "hsl(var(--foreground))",
  },
};

const NODE_RADIUS = 28;
const LEVEL_HEIGHT = 140;
const NODE_SPACING = 100;
const ROOT_NODE_ID = "root";

function calculateLayout(
  node: Feature,
  level = 0,
  startX = 0,
): { node: Feature; width: number } {
  if (!node.children || node.children.length === 0) {
    node.x = startX + NODE_SPACING / 2;
    node.y = level * LEVEL_HEIGHT + 100;
    return { node, width: NODE_SPACING };
  }

  let totalWidth = 0;
  const childResults: { node: Feature; width: number }[] = [];

  for (const child of node.children) {
    const result = calculateLayout(child, level + 1, startX + totalWidth);
    childResults.push(result);
    totalWidth += result.width;
  }

  // Center parent above children
  const firstChild = childResults[0]!.node;
  const lastChild = childResults[childResults.length - 1]!.node;
  node.x = (firstChild.x! + lastChild.x!) / 2;
  node.y = level * LEVEL_HEIGHT + 100;

  return { node, width: totalWidth };
}

function TreeNode({
  node,
  onHover,
  onLeave,
}: {
  node: Feature;
  onHover: (node: Feature, x: number, y: number) => void;
  onLeave: () => void;
}) {
  const colors = statusColors[node.status];
  const isRoot = node.id === ROOT_NODE_ID;
  const clipId = `clip-${node.id}`;
  const isDone = node.status === "done";

  const handleMouseEnter = (e: React.MouseEvent) => {
    if (!isRoot) {
      onHover(node, e.clientX, e.clientY);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isRoot) {
      onHover(node, e.clientX, e.clientY);
    }
  };

  return (
    <g
      className="cursor-pointer transition-transform hover:scale-110"
      style={{ transformOrigin: `${node.x}px ${node.y}px` }}
      data-node-id={node.id}
      data-testid={`node-${node.id}`}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={onLeave}
    >
      {!isRoot && (
        /* Invisible hit target to make pointer interactions reliable */
        <circle
          cx={node.x}
          cy={node.y}
          r={NODE_RADIUS + 14}
          fill="transparent"
          pointerEvents="all"
          data-hit-target="true"
        />
      )}

      {/* Outer glow for all nodes */}
      <circle
        cx={node.x}
        cy={node.y}
        r={NODE_RADIUS + 12}
        fill={colors.fill}
        filter="url(#nodeGlow)"
        opacity={isDone ? 0.5 : 0.2}
        pointerEvents="none"
      />

      {/* Animated pulse ring for done items */}
      {isDone && (
        <circle
          cx={node.x}
          cy={node.y}
          r={NODE_RADIUS + 6}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
          opacity={0.3}
          className="animate-pulse"
          pointerEvents="none"
        />
      )}

      {/* Main circle with glow */}
      <circle
        cx={node.x}
        cy={node.y}
        r={NODE_RADIUS}
        fill="url(#nodeSmokeFill)"
        stroke={colors.stroke}
        strokeWidth={isDone ? 3.5 : 3}
        strokeOpacity={isDone ? 0.95 : 0.75}
        filter="url(#nodeShadow)"
        pointerEvents="none"
      />

      {/* Inner ring */}
      <circle
        cx={node.x}
        cy={node.y}
        r={NODE_RADIUS - 6}
        fill="none"
        stroke="hsl(var(--foreground))"
        strokeWidth={1.5}
        opacity={0.16}
        pointerEvents="none"
      />

      {isRoot ? (
        <>
          <defs>
            <clipPath id={clipId}>
              <circle cx={node.x} cy={node.y} r={NODE_RADIUS - 8} />
            </clipPath>
          </defs>
          <image
            href="/logo.png"
            x={(node.x ?? 0) - (NODE_RADIUS - 8)}
            y={(node.y ?? 0) - (NODE_RADIUS - 8)}
            width={(NODE_RADIUS - 8) * 2}
            height={(NODE_RADIUS - 8) * 2}
            preserveAspectRatio="xMidYMid meet"
            clipPath={`url(#${clipId})`}
            pointerEvents="none"
          />
        </>
      ) : (
        /* Status indicator dot with glow */
        <>
          <circle 
            cx={node.x} 
            cy={node.y} 
            r={8} 
            fill={colors.fill}
            filter="url(#dotGlow)"
            pointerEvents="none"
          />
          <circle 
            cx={node.x} 
            cy={node.y} 
            r={4} 
            fill="hsl(var(--background))"
            opacity={0.8}
            pointerEvents="none"
          />
        </>
      )}

      {/* Label */}
      <text
        x={node.x}
        y={node.y! + NODE_RADIUS + 28}
        textAnchor="middle"
        fill="#ffffff"
        fontSize={16}
        fontWeight={900}
        fontFamily="system-ui"
        filter="url(#textGlow)"
        paintOrder="stroke"
        stroke="rgba(0,0,0,0.75)"
        strokeWidth={3.5}
        letterSpacing="0.6px"
        pointerEvents="none"
      >
        {node.name}
      </text>

      {/* Native SVG tooltip fallback */}
      {!isRoot && (
        <title>
          {node.description ? `${node.name}: ${node.description}` : node.name}
        </title>
      )}
    </g>
  );
}

function TreeLinks({ node }: { node: Feature }) {
  if (!node.children) return null;

  return (
    <>
      {node.children.map((child) => {
        const childColors = statusColors[child.status];
        const isDone = child.status === "done";
        const pathD = `M ${node.x} ${node.y! + NODE_RADIUS} 
                  L ${node.x} ${node.y! + LEVEL_HEIGHT / 2}
                  L ${child.x} ${node.y! + LEVEL_HEIGHT / 2}
                  L ${child.x} ${child.y! - NODE_RADIUS}`;
        return (
          <g key={child.id}>
            {/* Glow layer for done connections */}
            {isDone && (
              <path
                d={pathD}
                fill="none"
                stroke={childColors.stroke}
                strokeWidth={8}
                strokeLinecap="round"
                strokeLinejoin="round"
                filter="url(#lineGlow)"
                opacity={0.4}
              />
            )}
            {/* Main connection line */}
            <path
              d={pathD}
              fill="none"
              stroke={isDone ? childColors.stroke : "hsl(var(--muted-foreground))"}
              strokeWidth={isDone ? 3.5 : 2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={isDone ? 1 : 0.65}
              filter="url(#lineSoftGlow)"
            />
            <TreeLinks node={child} />
          </g>
        );
      })}
    </>
  );
}

function getAllNodes(node: Feature): Feature[] {
  const nodes: Feature[] = [node];
  if (node.children) {
    for (const child of node.children) {
      nodes.push(...getAllNodes(child));
    }
  }
  return nodes;
}

export default function Roadmap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomInBtnRef = useRef<HTMLButtonElement>(null);
  const zoomOutBtnRef = useRef<HTMLButtonElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [lastPos, setLastPos] = useState({ x: 0, y: 0 });
  const [tooltip, setTooltip] = useState<{
    node: Feature;
    x: number;
    y: number;
  } | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  // Calculate layout immediately
  const initialData = JSON.parse(JSON.stringify(roadmapData)) as Feature;
  const { width: treeWidth } = calculateLayout(initialData);
  const [layoutData] = useState<Feature>(initialData);

  // SVG size is based on container size, with minimum for tree content
  const svgSize = useMemo(() => ({
    width: Math.max(containerSize.width, treeWidth + 100, 800),
    height: Math.max(containerSize.height, 500),
  }), [containerSize.width, containerSize.height, treeWidth]);

  // Update container size on mount and resize
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerSize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  // Center the view when container size changes
  useEffect(() => {
    if (containerSize.width > 0 && containerSize.height > 0) {
      setTransform({
        x: (containerSize.width - treeWidth) / 2,
        y: 20,
        scale: 1,
      });
    }
  }, [containerSize.width, containerSize.height, treeWidth]);

  const zoomTo = useCallback(
    (newScale: number, pointX: number, pointY: number) => {
      const clampedScale = Math.min(Math.max(newScale, 0.5), 3);
      setTransform((prev) => {
        const ratio = clampedScale / prev.scale;
        return {
          scale: clampedScale,
          x: pointX - (pointX - prev.x) * ratio,
          y: pointY - (pointY - prev.y) * ratio,
        };
      });
    },
    [],
  );

  const zoomAtContainerCenter = useCallback(
    (multiplier: number) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      zoomTo(transform.scale * multiplier, cx, cy);
    },
    [transform.scale, zoomTo],
  );

  // Scroll/trackpad wheel zoom (zoom at cursor).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      // Make wheel always zoom while hovering the roadmap canvas.
      e.preventDefault();

      const rect = container.getBoundingClientRect();
      const pointX = e.clientX - rect.left;
      const pointY = e.clientY - rect.top;

      // Smooth zoom curve; supports mouse wheel + trackpad.
      const zoomFactor = Math.exp(-e.deltaY * 0.002);
      zoomTo(transform.scale * zoomFactor, pointX, pointY);
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [transform.scale, zoomTo]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    setLastPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - lastPos.x;
      const dy = e.clientY - lastPos.y;
      setLastPos({ x: e.clientX, y: e.clientY });
      setTransform((prev) => ({
        ...prev,
        x: prev.x + dx,
        y: prev.y + dy,
      }));
    },
    [isDragging, lastPos],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleNodeHover = useCallback((node: Feature, x: number, y: number) => {
    setTooltip({ node, x, y });
  }, []);

  const handleNodeLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  const allNodes = getAllNodes(layoutData);
  const nodeById = useMemo(() => {
    const map = new Map<string, Feature>();
    for (const n of allNodes) map.set(n.id, n);
    return map;
  }, [allNodes]);

  const findNodeIdFromEventTarget = (target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) return null;
    const group = target.closest("g[data-node-id]");
    return group?.getAttribute("data-node-id") ?? null;
  };

  const handleSvgMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const nodeId = findNodeIdFromEventTarget(e.target);
      if (!nodeId || nodeId === ROOT_NODE_ID) {
        if (tooltip) setTooltip(null);
        return;
      }
      const node = nodeById.get(nodeId);
      if (!node) return;
      setTooltip({ node, x: e.clientX, y: e.clientY });
    },
    [nodeById, tooltip],
  );

  const handleSvgMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const nodeId = findNodeIdFromEventTarget(e.target);
      if (!nodeId || nodeId === ROOT_NODE_ID) return;
      const node = nodeById.get(nodeId);
      if (!node) return;
      // Prevent starting a drag when clicking a node; keep tooltip visible.
      e.stopPropagation();
      setIsDragging(false);
      setTooltip({ node, x: e.clientX, y: e.clientY });
    },
    [nodeById],
  );

  const handleSvgMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  const tooltipStyle = useMemo(() => {
    if (!tooltip) return null;
    const w = containerSize.width || 1200;
    const h = containerSize.height || 800;
    const maxWidth = 280;
    const left = Math.min(Math.max(tooltip.x + 14, 12), w - maxWidth - 12);
    const top = Math.min(Math.max(tooltip.y - 96, 12), h - 160);
    return { left, top, maxWidth };
  }, [tooltip, containerSize.height, containerSize.width]);

  return (
    <div className="relative bg-transparent text-foreground flex flex-col min-h-[calc(100dvh-3.5rem)] overflow-hidden">
      <Dither
        isFixed={false}
        className="opacity-100"
        waveColor={[0.5, 0.5, 0.5]}
        disableAnimation={false}
        enableMouseInteraction
        mouseRadius={0.3}
        colorNum={4}
        waveAmplitude={0.3}
        waveFrequency={3}
        waveSpeed={0.05}
        pixelSize={2}
      />
      <div className="relative z-10 flex flex-col min-h-[calc(100dvh-3.5rem)]">

      {/* Header (transparent; readable over dither) */}
      <div className="text-center pt-8 pb-4 flex-shrink-0 bg-transparent">
        <h1 className="text-5xl sm:text-6xl font-black tracking-tight text-white drop-shadow-[0_10px_30px_rgba(0,0,0,0.85)]">
          Roadmap Tree
        </h1>
        <p className="text-sm mt-2 text-white/80 drop-shadow-[0_6px_18px_rgba(0,0,0,0.75)]">
          Drag to pan • Use +/- to zoom • Hover nodes for details
        </p>
      </div>

      {/* Tree visualization */}
      <div
        ref={containerRef}
        className={cn(
          "w-full flex-1 cursor-grab relative overflow-hidden",
          isDragging && "cursor-grabbing",
        )}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <svg
          data-testid="roadmap-svg"
          width={svgSize.width}
          height={svgSize.height}
          style={{ minWidth: svgSize.width, minHeight: svgSize.height }}
          onMouseMove={handleSvgMouseMove}
          onMouseDown={handleSvgMouseDown}
          onMouseLeave={handleSvgMouseLeave}
        >
          <defs>
            {/* Dither pattern - 8x8 Bayer matrix with visible dots */}
            <pattern id="ditherPattern" width="8" height="8" patternUnits="userSpaceOnUse">
              {/* Row 0 */}
              <rect x="0" y="0" width="2" height="2" fill="hsl(var(--foreground))" opacity="0.08" />
              <rect x="4" y="0" width="2" height="2" fill="hsl(var(--foreground))" opacity="0.15" />
              {/* Row 1 */}
              <rect x="6" y="2" width="2" height="2" fill="hsl(var(--foreground))" opacity="0.12" />
              <rect x="2" y="2" width="2" height="2" fill="hsl(var(--foreground))" opacity="0.05" />
              {/* Row 2 */}
              <rect x="4" y="4" width="2" height="2" fill="hsl(var(--foreground))" opacity="0.1" />
              <rect x="0" y="4" width="2" height="2" fill="hsl(var(--foreground))" opacity="0.18" />
              {/* Row 3 */}
              <rect x="2" y="6" width="2" height="2" fill="hsl(var(--foreground))" opacity="0.14" />
              <rect x="6" y="6" width="2" height="2" fill="hsl(var(--foreground))" opacity="0.06" />
            </pattern>

            {/* Larger wave-like dither for depth */}
            <pattern id="ditherWave" width="32" height="32" patternUnits="userSpaceOnUse">
              <rect width="32" height="32" fill="url(#ditherPattern)" />
              {/* Add some accent color dots */}
              <rect x="8" y="8" width="2" height="2" fill="hsl(var(--primary))" opacity="0.15" />
              <rect x="24" y="8" width="2" height="2" fill="hsl(var(--primary))" opacity="0.12" />
              <rect x="0" y="16" width="2" height="2" fill="hsl(var(--primary))" opacity="0.1" />
              <rect x="16" y="16" width="2" height="2" fill="hsl(var(--primary))" opacity="0.18" />
              <rect x="8" y="24" width="2" height="2" fill="hsl(var(--primary))" opacity="0.08" />
              <rect x="24" y="24" width="2" height="2" fill="hsl(var(--primary))" opacity="0.14" />
            </pattern>


            {/* Glow filter for lines */}
            <filter id="lineGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Soft glow for all lines (readability without neon) */}
            <filter id="lineSoftGlow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Smoky "glass" fill for nodes */}
            <radialGradient id="nodeSmokeFill" cx="35%" cy="35%" r="75%" fx="35%" fy="35%">
              <stop offset="0%" stopColor="hsl(var(--foreground))" stopOpacity="0.08" />
              <stop offset="55%" stopColor="hsl(var(--background))" stopOpacity="0.78" />
              <stop offset="100%" stopColor="hsl(var(--background))" stopOpacity="0.92" />
            </radialGradient>

            {/* Node shadow to lift nodes off the dither */}
            <filter id="nodeShadow" x="-80%" y="-80%" width="260%" height="260%">
              <feDropShadow dx="0" dy="2" stdDeviation="6" floodColor="#000000" floodOpacity="0.55" />
            </filter>

            {/* Glow filter for nodes */}
            <filter id="nodeGlow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="blur" />
              </feMerge>
            </filter>

            {/* Subtle glow for center dots */}
            <filter id="dotGlow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Text glow */}
            <filter id="textGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Backplate blur for labels (helps legibility over high-contrast background) */}
            <filter id="labelPlateBlur" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Radial gradient for vignette */}
            <radialGradient id="vignette" cx="50%" cy="50%" r="70%">
              <stop offset="0%" stopColor="transparent" />
              <stop offset="100%" stopColor="hsl(var(--background))" stopOpacity="0.4" />
            </radialGradient>
          </defs>

          {/* NOTE: Background is provided by the global Dither canvas in `layout.tsx`.
              Keep the SVG background transparent so the dither shows through. */}

          <g
            data-testid="roadmap-stage"
            transform={`matrix(${transform.scale} 0 0 ${transform.scale} ${transform.x} ${transform.y})`}
          >
            {/* Tree connections */}
            <TreeLinks node={layoutData} />

            {/* Tree nodes */}
            {allNodes.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                onHover={handleNodeHover}
                onLeave={handleNodeLeave}
              />
            ))}
          </g>
        </svg>
      </div>

      {/* Tooltip */}
      {tooltip && tooltipStyle && (
        <div
          className={cn(
            "fixed z-[60] pointer-events-none",
            "rounded-2xl p-4 shadow-2xl",
            // Glass
            "bg-background/35 backdrop-blur-xl supports-[backdrop-filter]:bg-background/25",
            // Subtle border + gradient sheen
            "border border-white/10",
            "ring-1 ring-white/10",
          )}
          data-testid="roadmap-tooltip"
          style={{
            left: tooltipStyle.left,
            top: tooltipStyle.top,
            maxWidth: tooltipStyle.maxWidth,
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base font-black tracking-tight text-foreground drop-shadow-[0_8px_18px_rgba(0,0,0,0.35)]">
                {tooltip.node.name}
              </h3>
              <div className="mt-1 flex items-center gap-2">
                <span
                  className="inline-flex h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: statusColors[tooltip.node.status].fill }}
                />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70">
                  {tooltip.node.status.replace("-", " ")}
                </span>
              </div>
            </div>
          </div>
          {tooltip.node.description && (
            <p className="mt-3 text-sm leading-relaxed text-foreground/80">
              {tooltip.node.description}
            </p>
          )}
        </div>
      )}

      {/* Debug: last hovered/clicked node (hidden visually, used for automated checks) */}
      <div className="sr-only" data-testid="roadmap-tooltip-debug">
        {tooltip?.node?.id ?? "none"}
      </div>

      {/* Legend */}
      <div className="fixed bottom-6 right-6 z-[50] bg-card/90 backdrop-blur border border-border rounded-lg p-4">
        <h4 className="text-sm font-bold text-foreground mb-3">TREE KEY</h4>
        <div className="space-y-2">
          {Object.entries(statusColors).map(([status, colors]) => (
            <div key={status} className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: colors.fill }}
              />
              <span className="text-xs text-muted-foreground uppercase">
                {status.replace("-", " ")}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Zoom controls */}
      <div className="fixed bottom-6 left-6 z-[50] flex gap-2 pointer-events-auto">
        <button
          ref={zoomInBtnRef}
          onClick={() => zoomAtContainerCenter(1.2)}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          data-testid="roadmap-zoom-in"
          className="w-10 h-10 bg-card/90 backdrop-blur border border-border rounded-lg text-foreground hover:bg-accent transition-colors text-xl font-bold pointer-events-auto"
        >
          +
        </button>
        <button
          ref={zoomOutBtnRef}
          onClick={() => zoomAtContainerCenter(0.8)}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          data-testid="roadmap-zoom-out"
          className="w-10 h-10 bg-card/90 backdrop-blur border border-border rounded-lg text-foreground hover:bg-accent transition-colors text-xl font-bold pointer-events-auto"
        >
          −
        </button>
      </div>
      </div>
    </div>
  );
}
