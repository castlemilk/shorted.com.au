"use client";

import { useCallback, useState, Suspense, useMemo } from "react";
import { Responsive, WidthProvider, type Layout } from "react-grid-layout";
import { type WidgetConfig, type WidgetProps } from "~/@/types/dashboard";
import { widgetRegistry } from "@/lib/widget-registry";
import { WidgetWrapper } from "./widget-wrapper";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Button } from "~/@/components/ui/button";
import {
  Grid3x3,
  AlignHorizontalJustifyCenter,
  AlignVerticalJustifyCenter,
  Maximize2,
} from "lucide-react";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import "~/styles/dashboard-grid.css";

const ResponsiveGridLayout = WidthProvider(Responsive);

// Predefined snap sizes for easier widget sizing
const SNAP_SIZES = {
  small: { w: 4, h: 6 },
  medium: { w: 8, h: 10 },
  large: { w: 12, h: 16 },
  extraLarge: { w: 12, h: 24 },
};

interface DashboardGridProps {
  widgets: WidgetConfig[];
  isEditMode: boolean;
  onLayoutChange: (widgets: WidgetConfig[]) => void;
  onRemoveWidget: (widgetId: string) => void;
  onEditWidget: (widgetId: string) => void;
  onUpdateWidgetSettings?: (
    widgetId: string,
    settings: Record<string, unknown>,
  ) => void;
}

export function DashboardGrid({
  widgets,
  isEditMode,
  onLayoutChange,
  onRemoveWidget,
  onEditWidget,
  onUpdateWidgetSettings,
}: DashboardGridProps) {
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  const [showGridLines, setShowGridLines] = useState(false);

  const layouts = useMemo(() => {
    const baseLayout = widgets.map((widget) => ({
      i: widget.id,
      x: widget.layout.x,
      y: widget.layout.y,
      w: widget.layout.w,
      h: widget.layout.h,
      minW: widget.layout.minW ?? 2,
      maxW: widget.layout.maxW ?? 12,
      minH: widget.layout.minH ?? 3,
      maxH: widget.layout.maxH ?? 40, // Increased from 20 to 40 to allow taller widgets
    }));

    // Generate responsive layouts for all breakpoints
    // This allows the grid to reflow properly at different screen sizes
    return {
      lg: baseLayout,
      md: baseLayout.map((item) => ({
        ...item,
        // Scale down width for medium screens (10 cols instead of 12)
        w: Math.min(item.w, 10),
        x: Math.min(item.x, Math.max(0, 10 - item.w)),
      })),
      sm: baseLayout.map((item) => ({
        ...item,
        // Scale down for small screens (6 cols)
        w: Math.min(item.w, 6),
        x: Math.min(item.x, Math.max(0, 6 - item.w)),
      })),
      xs: baseLayout.map((item) => ({
        ...item,
        // Stack vertically on extra small screens (4 cols)
        w: Math.min(item.w, 4),
        x: 0, // Force to left edge
      })),
      xxs: baseLayout.map((item) => ({
        ...item,
        // Full width on tiny screens (2 cols)
        w: 2,
        x: 0,
      })),
    };
  }, [widgets]);

  const handleLayoutChange = useCallback(
    (currentLayout: Layout[], allLayouts: Record<string, Layout[]>) => {
      // Only update from the lg (desktop) layout to preserve user's intended layout
      // Smaller breakpoints are auto-calculated from lg
      const lgLayout = allLayouts.lg ?? currentLayout;

      const updatedWidgets = widgets.map((widget) => {
        const layoutItem = lgLayout.find((item) => item.i === widget.id);
        if (layoutItem) {
          return {
            ...widget,
            layout: {
              ...widget.layout,
              x: layoutItem.x,
              y: layoutItem.y,
              w: layoutItem.w,
              h: layoutItem.h,
            },
          };
        }
        return widget;
      });

      onLayoutChange(updatedWidgets);
    },
    [widgets, onLayoutChange],
  );

  // Quick alignment functions
  const alignWidgets = useCallback(
    (alignment: "left" | "center" | "right" | "top" | "distribute") => {
      if (!selectedWidgetId) return;

      const selectedWidget = widgets.find((w) => w.id === selectedWidgetId);
      if (!selectedWidget) return;

      const updatedWidgets = [...widgets];
      const selectedIndex = updatedWidgets.findIndex(
        (w) => w.id === selectedWidgetId,
      );

      switch (alignment) {
        case "left":
          updatedWidgets[selectedIndex] = {
            ...selectedWidget,
            layout: { ...selectedWidget.layout, x: 0 },
          };
          break;
        case "center":
          updatedWidgets[selectedIndex] = {
            ...selectedWidget,
            layout: {
              ...selectedWidget.layout,
              x: Math.max(0, 6 - Math.floor(selectedWidget.layout.w / 2)),
            },
          };
          break;
        case "right":
          updatedWidgets[selectedIndex] = {
            ...selectedWidget,
            layout: {
              ...selectedWidget.layout,
              x: Math.max(0, 12 - selectedWidget.layout.w),
            },
          };
          break;
        case "top":
          updatedWidgets[selectedIndex] = {
            ...selectedWidget,
            layout: { ...selectedWidget.layout, y: 0 },
          };
          break;
        case "distribute":
          // Auto-arrange all widgets with optimal spacing
          const sortedWidgets = [...updatedWidgets].sort(
            (a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x,
          );
          let currentY = 0;
          sortedWidgets.forEach((widget, index) => {
            const widgetIndex = updatedWidgets.findIndex(
              (w) => w.id === widget.id,
            );
            const cols = Math.floor(12 / widget.layout.w);
            const col = index % cols;
            const x = col * widget.layout.w;

            if (col === 0 && index > 0) {
              currentY += Math.max(
                ...sortedWidgets
                  .slice(index - cols, index)
                  .map((w) => w.layout.h),
              );
            }

            updatedWidgets[widgetIndex] = {
              ...widget,
              layout: { ...widget.layout, x, y: currentY },
            };
          });
          break;
      }

      onLayoutChange(updatedWidgets);
    },
    [selectedWidgetId, widgets, onLayoutChange],
  );

  // Quick resize functions
  const resizeWidget = useCallback(
    (size: keyof typeof SNAP_SIZES) => {
      if (!selectedWidgetId) return;

      const selectedWidget = widgets.find((w) => w.id === selectedWidgetId);
      if (!selectedWidget) return;

      const newSize = SNAP_SIZES[size];
      const updatedWidgets = widgets.map((widget) =>
        widget.id === selectedWidgetId
          ? {
              ...widget,
              layout: {
                ...widget.layout,
                w: Math.min(newSize.w, 12),
                h: newSize.h,
                // Ensure widget doesn't go outside grid
                x: Math.min(widget.layout.x, 12 - Math.min(newSize.w, 12)),
              },
            }
          : widget,
      );

      onLayoutChange(updatedWidgets);
    },
    [selectedWidgetId, widgets, onLayoutChange],
  );

  return (
    <div className="relative">
      {/* Grid Alignment Toolbar */}
      {isEditMode && (
        <div className="mb-4 p-3 bg-muted/50 rounded-lg border border-dashed">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground font-medium">
              Grid Tools:
            </span>

            <Button
              variant={showGridLines ? "default" : "outline"}
              size="sm"
              onClick={() => setShowGridLines(!showGridLines)}
            >
              <Grid3x3 className="mr-1 h-3 w-3" />
              Grid
            </Button>

            {selectedWidgetId && (
              <>
                <div className="h-4 w-px bg-border mx-1" />
                <span className="text-xs text-muted-foreground">Align:</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => alignWidgets("left")}
                >
                  Left
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => alignWidgets("center")}
                >
                  <AlignHorizontalJustifyCenter className="h-3 w-3" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => alignWidgets("right")}
                >
                  Right
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => alignWidgets("top")}
                >
                  <AlignVerticalJustifyCenter className="h-3 w-3" />
                </Button>

                <div className="h-4 w-px bg-border mx-1" />
                <span className="text-xs text-muted-foreground">Size:</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => resizeWidget("small")}
                >
                  S
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => resizeWidget("medium")}
                >
                  M
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => resizeWidget("large")}
                >
                  L
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => resizeWidget("extraLarge")}
                >
                  <Maximize2 className="h-3 w-3" />
                </Button>
              </>
            )}

            <div className="h-4 w-px bg-border mx-1" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => alignWidgets("distribute")}
            >
              Auto Arrange
            </Button>
          </div>

          {selectedWidgetId && (
            <div className="mt-2 text-xs text-muted-foreground">
              Selected: {widgets.find((w) => w.id === selectedWidgetId)?.title}
            </div>
          )}
        </div>
      )}

      {/* Enhanced Grid Layout */}
      <div
        className={`relative ${showGridLines && isEditMode ? "grid-overlay" : ""} ${isEditMode ? "edit-mode" : ""}`}
      >
        <ResponsiveGridLayout
          className="layout"
          layouts={layouts}
          onLayoutChange={handleLayoutChange}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
          cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
          rowHeight={60}
          isDraggable={isEditMode}
          isResizable={isEditMode}
          margin={[16, 16]}
          containerPadding={[0, 0]}
          // Enhanced snapping
          compactType="vertical"
          preventCollision={false}
          // Improved drag behavior
          useCSSTransforms={true}
          transformScale={1}
          // Better resize handles
          resizeHandles={["se", "sw", "ne", "nw", "n", "s", "e", "w"]}
          // Snap to grid
          onDragStart={(layout, oldItem, newItem) => {
            setSelectedWidgetId(newItem.i);
          }}
          onResizeStart={(layout, oldItem, newItem) => {
            setSelectedWidgetId(newItem.i);
          }}
        >
          {widgets.map((widget) => (
            <div
              key={widget.id}
              className={`h-full transition-all duration-200 ${
                selectedWidgetId === widget.id
                  ? "ring-2 ring-primary ring-offset-2"
                  : ""
              }`}
              onClick={() => isEditMode && setSelectedWidgetId(widget.id)}
              onKeyDown={(e) => {
                if (isEditMode && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  setSelectedWidgetId(widget.id);
                }
              }}
              role={isEditMode ? "button" : undefined}
              tabIndex={isEditMode ? 0 : undefined}
              aria-label={isEditMode ? `Select ${widget.type} widget` : undefined}
            >
              <WidgetRenderer
                widget={widget}
                isEditMode={isEditMode}
                isSelected={selectedWidgetId === widget.id}
                onRemove={() => onRemoveWidget(widget.id)}
                onEdit={() => onEditWidget(widget.id)}
                onUpdateSettings={
                  onUpdateWidgetSettings
                    ? (settings) => onUpdateWidgetSettings(widget.id, settings)
                    : undefined
                }
              />
            </div>
          ))}
        </ResponsiveGridLayout>

        {/* Grid Overlay */}
        {showGridLines && isEditMode && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="grid grid-cols-12 h-full opacity-20">
              {Array.from({ length: 48 }, (_, i) => (
                <div
                  key={i}
                  className="border border-dashed border-primary/30"
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <style jsx global>{`
        .grid-overlay .react-grid-item.react-grid-placeholder {
          background: rgba(59, 130, 246, 0.15) !important;
          border: 2px dashed rgba(59, 130, 246, 0.5) !important;
          border-radius: 8px !important;
        }

        .react-grid-item {
          transition: all 200ms ease;
        }

        .react-grid-item.react-draggable-dragging {
          transition: none;
          z-index: 3;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
        }

        .react-resizable-handle {
          opacity: 0;
          transition: opacity 200ms ease;
        }

        .react-grid-item:hover .react-resizable-handle,
        .react-grid-item.react-resizable-resizing .react-resizable-handle {
          opacity: 1;
        }

        .react-resizable-handle::after {
          border-color: hsl(var(--primary)) !important;
          border-width: 2px !important;
        }
      `}</style>
    </div>
  );
}

interface WidgetRendererProps {
  widget: WidgetConfig;
  isEditMode: boolean;
  isSelected: boolean;
  onRemove: () => void;
  onEdit: () => void;
  onUpdateSettings?: (settings: Record<string, unknown>) => void;
}

function WidgetRenderer({
  widget,
  isEditMode,
  isSelected,
  onRemove,
  onEdit,
  onUpdateSettings,
}: WidgetRendererProps) {
  const [Component, setComponent] =
    useState<React.ComponentType<WidgetProps> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Load widget component dynamically
  useState(() => {
    widgetRegistry
      .getComponent(widget.type)
      .then((comp) => {
        setComponent(() => comp);
        setIsLoading(false);
      })
      .catch((err: Error) => {
        setError(err);
        setIsLoading(false);
      });
  });

  if (error) {
    return (
      <WidgetWrapper
        config={widget}
        isEditMode={isEditMode}
        isSelected={isSelected}
        onRemove={onRemove}
        onEdit={onEdit}
        error={error}
      >
        <div />
      </WidgetWrapper>
    );
  }

  if (isLoading || !Component) {
    return (
      <WidgetWrapper
        config={widget}
        isEditMode={isEditMode}
        isSelected={isSelected}
        onRemove={onRemove}
        onEdit={onEdit}
        isLoading
      >
        <div />
      </WidgetWrapper>
    );
  }

  return (
    <WidgetWrapper
      config={widget}
      isEditMode={isEditMode}
      isSelected={isSelected}
      onRemove={onRemove}
      onEdit={onEdit}
    >
      <Suspense fallback={<Skeleton className="h-full w-full" />}>
        <Component config={widget} onSettingsChange={onUpdateSettings} />
      </Suspense>
    </WidgetWrapper>
  );
}
